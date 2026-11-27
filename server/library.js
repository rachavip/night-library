/*
 * Library scanner & scraper.
 * Walks BOOKS_DIR, pulls metadata out of the books themselves, falls back to
 * filename parsing, and writes a stable index to DATA_DIR/library.json.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const iconv = require('iconv-lite');
const { execFile } = require('child_process');
const mobiMeta = require('./mobi');

const SUPPORTED = new Set(['pdf', 'epub', 'mobi', 'azw3', 'txt']);

/* Bump whenever the metadata extraction changes in a way that would produce a
 * different result for files that have not been touched. Records written by an
 * older extractor are re-scraped once; after that they carry the new number and
 * settle back into the instant "nothing changed" path. */
const META_VERSION = 2;

function hashId(rel) {
  return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
}

function clean(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntity(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const CN_NUM = '\\d〇零一二三四五六七八九十百千两';

/* Parenthesised "how many volumes / which edition" text is part of the title,
 * not an author. Treating 「(共16册)」 as a person is how the shelf ended up
 * with books credited to a volume count. */
const DESC_PAREN = new RegExp(
  '^(共|全|第)?\\s*[' + CN_NUM + ']+\\s*(册|卷|部|集|篇|章|页|本|版|年|月|期|种)$' +
  '|^(上|中|下)\\s*(册|卷|部|篇)?$' +
  '|^(修订|珍藏|插图|彩图|精装|平装|典藏|新版|旧版|全集|套装|微课|双语|注释|白话|全译|节选|增订|彩绘|漫画)(版|本|全译|插图本)?$' +
  '|^(典藏|丛书|系列|文集|文库|精选|读本|书系|全集|套装)(版|集)?$' +
  '|^第[' + CN_NUM + ']+版$'
);
const YEAR_PAREN = /^(1[89]|20)\d{2}([.\-/年]\d{1,2})?([.\-/月]\d{1,2})?日?$/;

/* Download-site tags and file-format suffixes carry no meaning on a shelf. */
const NOISE_TAIL = /[\(（\[【]\s*(z-?lib(\.\w+)?|www\.[^\)）\]】]+|[^\)）\]】]*\.(com|net|org|cn)|扫描版|高清版?|文字版|精校版|epub|pdf|mobi|azw3|txt|\d{1,5})\s*[\)）\]】]\s*$/i;

function isDescParen(s) {
  const t = String(s || '').replace(/\s+/g, '');
  return DESC_PAREN.test(t) || YEAR_PAREN.test(t) ||
    /^(扫描版|高清|高清版|文字版|扫描|ocr)$/i.test(t);
}

/* Does this parenthesised chunk read like a person (or a list of people)? */
function authorLike(s) {
  const raw = String(s || '').trim();
  const t = raw.replace(/\s+/g, '');
  if (!t || t.length > 26) return false;
  if (isDescParen(t)) return false;
  if (/(著|编著|主编|副主编|编|译|绘|口述|整理|校点|校注|点评|评点|注|著译)$/.test(t)) return true;
  // A credit list carrying a dynasty/nationality prefix or a credit verb with
  // brackets, e.g. （清）陈士斌，（清）刘一明著；盛克琦编校 or (汉)刘向 (汉)刘歆
  if (/^[\(（][\u4e00-\u9fa5]{1,3}[\)）]/.test(raw) && t.length <= 26) return true;
  if (/[\(（][^\)）]*[\)）]/.test(raw) && /[著译编绘评校注]/.test(t) && t.length <= 26) return true;
  if (/[·•]/.test(raw) && t.length <= 20) return true;
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(t)) return true;
  if (/^[A-Za-z][A-Za-z.'\- ]{2,30}$/.test(raw) && raw.trim().split(/\s+/).length <= 3) return true;
  if (/[,，、]/.test(raw) && t.length <= 24 && /^[\u4e00-\u9fa5A-Za-z·•.,，、\s]+$/.test(raw)) return true;
  if (/等等$/.test(t)) return true;
  return false;
}

/* The trailing bracket group, matched by pairing brackets so that nested
 * parentheses such as (（清）陈士斌，（清）刘一明著) stay in one piece. */
function lastParenGroup(s) {
  const text = String(s || '').trimEnd();
  const close = text[text.length - 1];
  const open = { ')': '(', '）': '（', ']': '[', '】': '【' }[close];
  if (!open) return null;
  let depth = 0;
  let start = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === close) depth++;
    else if (ch === open) {
      depth--;
      if (depth === 0) { start = i; break; }
    }
  }
  if (start <= 0) return null;
  return {
    inner: text.slice(start + 1, text.length - 1).trim(),
    head: text.slice(0, start).trim()
  };
}

/* Title first, author in trailing brackets: 「书名 (陈磊 · 半小时漫画团队)」.
 * Volume counts, editions, years and long blurb brackets stay in the title. */
function splitTailParen(title) {
  let s = String(title || '').trim();
  let author = '';
  for (let i = 0; i < 3; i++) {
    const g = lastParenGroup(s);
    if (!g || !g.head) break;
    const inner = g.inner;
    if (YEAR_PAREN.test(inner)) { s = g.head; continue; }
    if (isDescParen(inner)) break;
    if (!author && authorLike(inner)) { author = inner; s = g.head; continue; }
    // Long marketing blurb in brackets: drop it, it is not part of a name.
    if (inner.length > 12 && /[!！,，]/.test(inner)) { s = g.head; continue; }
    break;
  }
  return { title: s, author };
}

/* Trailing bracket that reads like an author means the title still carries the
 * credit — an older scan swallowed it, so the record needs one more scrape. */
function tailParenIsAuthor(title) {
  const g = lastParenGroup(title);
  return g ? authorLike(g.inner) : false;
}

/* Scripts that never show up in a Chinese shelf title unless the bytes were
 * decoded with the wrong codec: Hangul, Myanmar, Thai, Indic, Cyrillic, Arabic,
 * Hebrew, Armenian. Japanese kana are deliberately absent - a Japanese title is
 * legitimate, and mixing kana with the rest is caught by the ratio rule below. */
const MOJIBAKE_SCRIPTS = /[\u0400-\u06FF\u0900-\u0DFF\u0E00-\u0EFF\u1000-\u109F\u1100-\u11FF\u3130-\u318F\u3200-\u33FF\uAC00-\uD7AF]/g;

/* 「ぜ湑桕ႋ휰଀」 is what a broken PDF Info dictionary looks like: two valid
 * CJK characters keep it out of every mojibake check, while the Hangul,
 * Myanmar and compatibility glyphs around them give it away. One stray letter
 * is tolerated, a third of the string is not. */
function looksForeignMojibake(s) {
  const t = String(s || '');
  if (!t) return false;
  const hits = t.match(MOJIBAKE_SCRIPTS);
  // Two Hangul letters inside a nine-character name never happens by accident,
  // but two inside a forty-character blurb is just a coincidence of bytes.
  if (hits && hits.length >= 2 && (hits.length / t.length >= 0.3 || t.length <= 12)) {
    return true;
  }
  // CJK Extension A holds the rare characters; a name that is mostly rare
  // characters is a mis-decoded byte stream, not a title.
  const rare = t.match(/[\u3400-\u4DBF]/g);
  if (rare && t.length >= 6 && rare.length / t.length >= 0.4) return true;
  return false;
}

/* 「封神演义(独一无二的中式奇幻」 lost its closing bracket when a blurb was cut
 * off; drop the dangling part so the shelf shows a clean name. */
function closeBrackets(s) {
  const t = String(s || '').trim();
  let depth = 0;
  let openAt = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '（' || c === '[' || c === '【') {
      if (depth === 0) openAt = i;
      depth++;
    } else if (c === ')' || c === '）' || c === ']' || c === '】') {
      if (depth > 0) depth--;
    }
  }
  if (depth > 0 && openAt > 0) return t.slice(0, openAt).trim();
  return t;
}

/* Book-list exports glue a sales pitch to the title with a full-width bar:
 * 「水浒传｜抑텗⍓쑎͓䅖⳿尉」, 「金庸作品集：书剑恩仇录｜扥끏䣿尉｜扑栀㉑賿尉」. When the
 * tail is mojibake the head is the whole title. Real prose after the bar is
 * left alone - only garbage is worth throwing away. */
function splitBlurb(s) {
  const t = String(s || '').trim();
  const m = t.match(/^([^｜|]{1,60})[｜|]([\s\S]*)$/);
  if (!m) return t;
  const head = m[1].trim();
  const tail = m[2].trim();
  if (!head || !tail) return t;
  if (looksForeignMojibake(tail) || /[\uFFFD\u0000-\u0008\u000e-\u001f]/.test(tail)) {
    return closeBrackets(head);
  }
  return t;
}

/* Embedded metadata is not always trustworthy: PDFs carry a page header or the
 * authoring software's default string, and some are outright mojibake. A junk
 * value must not outrank a filename the user cleaned up by hand. */
function isJunkMeta(s, isAuthor) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (t.length === 1) return true;
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) return true;
  if (/^[!|\\\/\-–—.。·•_=~*#\s]+$/.test(t)) return true;
  if (/^\\\d{2,3}/.test(t)) return true;
  if (/[\uFFFD\u0000-\u0008\u000e-\u001f]/.test(t)) return true;
  if (/[\u2E80-\u2EFF\u3190-\u31EF\u31F0-\u31FF]/.test(t)) return true;
  if (looksForeignMojibake(t)) return true;
  if (/^(unknown|untitled( document)?|document\d*|无标题|未命名|未知|copyright|index|cover|contents)$/i.test(t)) return true;
  // Printer / scanner output defaults. A whole set scanned and printed at once
  // ends up titled 「SSReader Print.」 with author 「wanqan」; the value is legal
  // text, so only an explicit list keeps it from pinning the books forever.
  if (/^(ss\s*reader(\s*print)?\.?|ssreader\s*print\.?|e-?book\s*print(ed)?|camscanner|扫描全能王|扫描仪|打印(机)?|printed|print|scanned|scan|microsoft\s+(word|powerpoint|excel)\s*-\s*.*)$/i.test(t)) return true;
  if (isAuthor && /^(administrator|admin|user|owner|微软用户|microsoft|dell|hp|lenovo|asus|wanqan|ss\s*reader|ssreader|scanner|scan|camscanner|canon|epson|brother|kyocera|ricoh|windows(\s*user)?)$/i.test(t)) return true;
  if (/^(版权信息|版权页|目录|前言|序言|扉页|封面|正文|第[一二三四五六七八九十\d]+页)$/.test(t)) return true;
  return false;
}

/* An embedded title that is just a volume marker (「中国史.1」「第2册」) while
 * the filename names the set: the set name is what belongs on the shelf. */
function onlyVolumeMarker(title) {
  return /[.．]\d{1,2}$|第[\d一二三四五六七八九十]+[册卷部篇]$/.test(String(title || ''));
}

function volumeStem(title) {
  return String(title || '').replace(/[.．]\d{1,2}$|第[\d一二三四五六七八九十]+[册卷部篇]$/, '');
}

/* Scanned sets often ship as 「【全宋诗】72册/01[652].pdf」: the folder carries
 * the series name and the file keeps only a running number plus a page count.
 * Turn that folder name into a series title, but only when it really looks like
 * one (…72册 / …12卷), so an ordinary folder like 「小说」 never becomes a title. */
function seriesFromDir(dirName) {
  const d = String(dirName || '').trim();
  if (!d) return '';
  const m = d.match(/^[【《]?\s*([^】》]{2,30}?)\s*[】》]?\s*[\(（]?\s*\d{1,3}\s*(册|卷|部|集|本|篇)\s*[\)）]?$/);
  return m ? m[1].trim() : '';
}

function guessFromFilename(base, dirName) {
  const original = String(base || '').trim();
  let s = original;
  for (let i = 0; i < 3 && NOISE_TAIL.test(s); i++) s = s.replace(NOISE_TAIL, '').trim();
  if (!s) s = original;
  // 「水浒传｜抑텗⍓쑎͓䅖⳿尉」 — the part after the bar is a broken sales pitch.
  s = splitBlurb(s);

  // Bare running number in a numbered set: 01[652] → 「全宋诗 01」.
  const bare = s.match(/^0*(\d{1,3})\s*(?:[\[【\(（]|$)/);
  if (bare) {
    const series = seriesFromDir(dirName);
    if (series) {
      return { title: series + ' ' + String(Number(bare[1])).padStart(2, '0'), author: '' };
    }
  }

  // Calibre-style export names: 书名_作者_年份_版本
  const under = original.split('_').map(x => x.trim()).filter(Boolean);
  if (under.length >= 3 && authorLike(under[1])) {
    return { title: under[0], author: under[1] };
  }

  // 《书名》01 — the brackets wrap the title itself and the trailing digits are
  // the volume, e.g. 【全唐诗】30册/《全唐诗》01.PDF.
  let m = s.match(/^[《〈]([^》〉]{1,60})[》〉]\s*([^《》]{0,12})\s*$/);
  if (m) {
    const vol = m[2].trim();
    return { author: '', title: vol ? m[1].trim() + ' ' + vol : m[1].trim() };
  }

  // [作者] 书名 / (作者) 书名 — only round/square brackets; 【】 is usually a
  // series or column name, not a person.
  m = s.match(/^[\[\(（]\s*([^\[\]\(\)（）]+?)\s*[\]\)）]\s*[-—–\s]*\s*(.+)$/);
  if (m && authorLike(m[1]) && m[2].trim()) {
    return { author: m[1].trim(), title: m[2].trim() };
  }

  // 作者《书名》 — only when the whole name is that shape, so a title that
  // itself contains 《…》 (e.g. 合刊) is not chopped in half.
  m = s.match(/^([^《》]{1,20})《([^》]{1,60})》\s*$/);
  if (m && authorLike(m[1])) return { author: m[1].trim(), title: m[2].trim() };

  // 书名 (作者)
  const tail = splitTailParen(s);
  if (tail.author) return { title: closeBrackets(tail.title), author: tail.author };

  // 书名 - 作者
  const parts = tail.title.split(/\s+[-—–]+\s+|\s*[-—–]{1,}\s*/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0];
    const b = parts.slice(1).join(' - ');
    // A bare 2-4 character Chinese name is the strongest signal there is; use
    // it before the looser heuristics, otherwise a title containing 注/编 (e.g.
    // 「西游记注释插画版」) can be mistaken for the author side.
    const aPlain = /^[\u4e00-\u9fa5]{2,4}$/.test(a);
    const bPlain = /^[\u4e00-\u9fa5]{2,4}$/.test(b);
    if (bPlain && !aPlain) return { title: a, author: b };
    if (aPlain && !bPlain) return { title: b, author: a };
    const aAuthor = authorLike(a);
    const bAuthor = authorLike(b);
    if (aAuthor && !bAuthor) return { author: a, title: b };
    if (bAuthor && !aAuthor) return { author: b, title: a };
    if (aAuthor && bAuthor) {
      // Both sides are short Chinese strings: Chinese editions usually put
      // the author first. When the right side ends in 著/译/编, it is the author.
      if (/(著|译|编|作)$/.test(b)) return { author: b, title: a };
      return { author: a, title: b };
    }
  }
  return { author: '', title: closeBrackets(tail.title) };
}


function tagValue(xml, tag) {
  const local = tag.replace('dc:', '');
  const re = new RegExp('<(?:dc:)?' + local + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:dc:)?' + local + '>', 'i');
  const m = xml.match(re);
  return m ? clean(decodeEntity(m[1])) : '';
}

/* Read selected entries from an EPUB zip without unpacking the whole book. */
function readZipEntries(file, matcher) {
  return new Promise(resolve => {
    const out = new Map();
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return resolve(out);
      zip.readEntry();
      zip.on('entry', entry => {
        if (!matcher(entry)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e) return zip.readEntry();
          const chunks = [];
          stream.on('data', c => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', () => zip.readEntry());
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', () => resolve(out));
    });
  });
}

async function scrapeEpub(file, coverDir, id) {
  const meta = {};
  const first = await readZipEntries(
    file,
    e => e.fileName === 'META-INF/container.xml' || /\.opf$/i.test(e.fileName)
  );
  const container = first.get('META-INF/container.xml');
  let opfPath = [...first.keys()].find(k => /\.opf$/i.test(k)) || '';
  if (container) {
    const m = container.toString('utf8').match(/full-path=["']([^"']+)["']/i);
    if (m) opfPath = decodeURIComponent(m[1]);
  }
  let opfXml = first.get(opfPath);
  if (!opfXml && first.size) opfXml = first.values().next().value;
  if (opfXml) {
    const xml = opfXml.toString('utf8');
    meta.title = tagValue(xml, 'dc:title');
    meta.author = tagValue(xml, 'dc:creator');
    meta.language = tagValue(xml, 'dc:language');
    meta.description = tagValue(xml, 'dc:description').slice(0, 600);
    const coverMatch = xml.match(/<item[^>]*\bid=["']([^"']*cover[^"']*)["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
      || xml.match(/<item[^>]*\bhref=["']([^"']+)["'][^>]*\bproperties=["'][^"']*cover-image[^"']*["'][^>]*>/i);
    if (coverMatch) {
      const href = decodeURIComponent(coverMatch[2] || coverMatch[1]);
      const base = path.posix.dirname(opfPath);
      const full = base && base !== '.' ? path.posix.join(base, href) : href;
      const imgMap = await readZipEntries(file, e => e.fileName === full);
      const img = imgMap.get(full);
      if (img && (/\.jpe?g$/i.test(full) || /\.png$/i.test(full) || /\.webp$/i.test(full))) {
        const ext = path.extname(full).slice(1).toLowerCase();
        const out = path.join(coverDir, id + '.' + ext);
        await fsp.writeFile(out, img);
        meta.coverFile = path.basename(out);
      }
    }
  }
  return meta;
}

/* PDF metadata strings are often UTF-16BE with a FE FF BOM. Node has no
 * 'utf16be' Buffer encoding, so decode code units by hand. */
function decodePdfText(bytes) {
  if (!bytes || bytes.length < 2) return '';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const out = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out.push(String.fromCharCode(bytes.readUInt16BE(i)));
    }
    return clean(out.join(''));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const out = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out.push(String.fromCharCode(bytes.readUInt16LE(i)));
    }
    return clean(out.join(''));
  }
  const utf8 = bytes.toString('utf8').replace(/^\uFEFF/, '');
  // A PDF literal without a BOM is usually UTF-8 already; when it is not, its
  // bytes are Latin-1 and decoding as UTF-8 would hallucinate CJK characters.
  if (isValidUtf8(bytes)) return clean(utf8);
  return clean(bytes.toString('latin1'));
}

/* Undo PDF string escapes: \134 octal, \( \) \\, \n \r \t \b \f, and the
 * backslash-newline line continuation. Without this a title written as
 * (\376\377\...octal...) decodes to mojibake and gets thrown away. */
function pdfUnescape(raw) {
  const out = Buffer.alloc(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out[n++] = raw.charCodeAt(i) & 0xff; continue; }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next;
      let j = i + 2;
      while (j < raw.length && oct.length < 3 && raw[j] >= '0' && raw[j] <= '7') {
        oct += raw[j];
        j++;
      }
      out[n++] = parseInt(oct, 8) & 0xff;
      i = j - 1;
      continue;
    }
    const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (next === '\n') { i++; continue; }
    if (next === '\r') { i += raw[i + 2] === '\n' ? 2 : 1; continue; }
    out[n++] = map[next] !== undefined ? map[next] : (next.charCodeAt(0) & 0xff);
    i++;
  }
  return out.subarray(0, n);
}

/* The document Info dictionary is the same source a PDF viewer shows under
 * "Properties". Reading the first /Title in the file instead picks up the
 * first bookmark, which is usually a chapter heading such as 总目录 - that is
 * exactly how a 莫言 box set ended up titled 总目录. Follow the trailer's
 * /Info reference and parse only that object. */
function pdfInfoDict(s) {
  const refs = [...s.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)];
  for (let k = refs.length - 1; k >= 0; k--) {
    const num = refs[k][1];
    const gen = refs[k][2];
    const re = new RegExp('(?:^|[\\s\\r\\n>])' + num + '\\s+' + gen + '\\s+obj\\b');
    const m = re.exec(s);
    if (!m) continue;
    const start = m.index + m[0].length;
    const seg = s.slice(start, start + 8000);
    const end = seg.indexOf('endobj');
    const body = end > 0 ? seg.slice(0, end) : seg;
    // Guard against an object that only happens to carry the same number.
    if (/\/Title|\/Author|\/Producer/.test(body)) return body;
  }
  return '';
}

function dictField(dict, key) {
  if (!dict) return '';
  const re = new RegExp('/' + key + '\\s*(\\((?:[^()\\\\]|\\\\.)*\\)|<[0-9A-Fa-f\\s]+>)');
  const m = dict.match(re);
  if (!m) return '';
  const v = m[1];
  if (v[0] === '<') {
    const hex = v.slice(1, -1).replace(/\s+/g, '');
    if (!hex || hex.length % 2) return '';
    try { return decodePdfText(Buffer.from(hex, 'hex')); } catch (e) { return ''; }
  }
  return decodePdfText(pdfUnescape(v.slice(1, -1)));
}

/* XMP is UTF-8 inside an ASCII container, and it is the one place a modern
 * PDF reliably keeps a clean title. */
function xmpField(s, tag) {
  const block = s.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]{0,4000}?)</' + tag + '>'));
  if (!block) return '';
  const inner = block[1];
  const items = [...inner.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map(m => m[1]);
  const raw = items.length ? (items.find(x => x.trim()) || items[0]) : inner;
  const text = decodeEntity(raw.replace(/<[^>]*>/g, '').trim());
  try {
    return clean(Buffer.from(text, 'latin1').toString('utf8'));
  } catch (e) {
    return clean(text);
  }
}

/* A value that looks like mojibake must not block Calibre's correct title. */
function looksGarbled(s) {
  return Boolean(s) && (/^þÿ/.test(s) || /[\u0000-\u0008\u000e-\u001f]/.test(s));
}

/* Read only the head and tail of a PDF. The Info dictionary lives either near
 * the start or in the trailer, so slurping a 160MB file whole (as we used to)
 * was pure IO waste and could stall the whole scan. */
async function readPdfEdges(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const headLen = Math.min(size, 256 * 1024);
    const tailLen = Math.min(size - headLen, 2 * 1024 * 1024);
    const head = Buffer.alloc(headLen);
    if (headLen) await fh.read(head, 0, headLen, 0);
    const tail = Buffer.alloc(tailLen);
    if (tailLen) await fh.read(tail, 0, tailLen, size - tailLen);
    return Buffer.concat([head, tail]);
  } finally {
    await fh.close();
  }
}

function scrapePdf(file) {
  return readPdfEdges(file).then(buf => {
    const s = buf.toString('latin1');
    const info = pdfInfoDict(s);

    let title = dictField(info, 'Title');
    let author = dictField(info, 'Author');
    if (!title || looksGarbled(title) || isJunkMeta(title, false)) {
      const fromXmp = xmpField(s, 'dc:title');
      if (fromXmp && !looksGarbled(fromXmp) && !isJunkMeta(fromXmp, false)) title = fromXmp;
    }
    if (!author || looksGarbled(author)) {
      const fromXmp = xmpField(s, 'dc:creator');
      if (fromXmp && !looksGarbled(fromXmp)) author = fromXmp;
    }
    // Nothing usable in the document properties: fall back to the longest
    // bookmark title, which beats the first one (usually a chapter heading).
    if (!title || looksGarbled(title)) title = longestPdfTitle(s);

    return {
      title: looksGarbled(title) ? '' : title,
      author: looksGarbled(author) ? '' : author
    };
  }).catch(() => ({}));
}

/* Every /Title string in the file, longest plausible one wins. Used only when
 * the Info dictionary and XMP are both missing or broken. */
function longestPdfTitle(s) {
  const re = /\/Title\s*(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]+>)/g;
  let best = '';
  let m;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 400) {
    const v = m[1];
    const text = v[0] === '<'
      ? decodePdfText(Buffer.from(v.slice(1, -1).replace(/\s+/g, ''), 'hex'))
      : decodePdfText(pdfUnescape(v.slice(1, -1)));
    if (!text || looksGarbled(text)) continue;
    if (text.length > best.length) best = text;
  }
  return best;
}

/* Detect a real image from its magic bytes - a cover exported from a book
 * keeps the source format regardless of the filename we give it. */
function imageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return '';
}

/* MOBI / AZW3 metadata, read straight out of the Palm database header. This
 * replaces Calibre's `ebook-meta`, which meant installing ~700MB of Qt to
 * scrape 52 books - see server/mobi.js for the header layout. */
async function scrapeMobi(file, coverDir, id) {
  const m = await mobiMeta.readMeta(file);
  const meta = {};
  if (m.title) meta.title = m.title;
  if (m.author) meta.author = m.author;
  if (m.language) meta.language = m.language;
  if (m.cover && m.coverExt && coverDir) {
    try {
      const out = path.join(coverDir, id + '.' + m.coverExt);
      await fsp.writeFile(out, m.cover);
      meta.coverFile = path.basename(out);
    } catch (e) { /* no writable cover store: the shelf falls back to a text card */ }
  }
  return meta;
}

/* An EPUB whose OPF never declared a cover still usually ships the artwork as
 * images/cover.jpg. Look for a file that calls itself a cover before settling
 * on the first real picture - tiny spacer gifs are skipped by the size floor. */
async function epubAnyCover(file, coverDir, id) {
  if (!coverDir) return '';
  const entries = await readZipEntries(file, e => /\.(jpe?g|png|gif|webp)$/i.test(e.fileName));
  const names = [...entries.keys()].sort((a, b) => {
    const ca = /cover/i.test(a) ? 0 : 1;
    const cb = /cover/i.test(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.length - b.length;
  });
  for (const name of names.slice(0, 4)) {
    const buf = entries.get(name);
    const ext = imageExt(buf);
    if (!ext || buf.length < 3000) continue;
    try {
      const out = path.join(coverDir, id + '.' + ext);
      await fsp.writeFile(out, buf);
      return path.basename(out);
    } catch (e) {
      return '';
    }
  }
  return '';
}

/* TXT files carry no cover of their own, but many NAS libraries keep a
 * matching image next to the book. Pick it up so those shelves are not blank. */
const COVER_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

/* Validate by magic bytes and copy into the cover store. The source extension
 * is not trusted: saved pictures often lie about it. */
async function storeCover(src, coverDir, id) {
  try {
    const stat = await fsp.stat(src);
    if (!stat.isFile() || stat.size < 128) return '';
    const buf = await fsp.readFile(src);
    const ext = path.extname(src).slice(1).toLowerCase();
    const good = imageExt(buf) || (ext === 'jpeg' ? 'jpg' : ext);
    if (!COVER_IMAGE_EXT.includes(good)) return '';
    const out = path.join(coverDir, id + '.' + (good === 'jpeg' ? 'jpg' : good));
    await fsp.writeFile(out, buf);
    return path.basename(out);
  } catch (e) {
    return '';
  }
}

/* A picture next to the book, named after it: 「全唐诗 01.jpg」. */
async function siblingCover(file, coverDir, id) {
  if (!coverDir) return '';
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const candidates = [
    base + '.jpg', base + '.jpeg', base + '.png', base + '.webp',
    path.join(base, 'cover.jpg'), path.join(base, 'cover.png')
  ];
  for (const name of candidates) {
    const got = await storeCover(path.join(dir, name), coverDir, id);
    if (got) return got;
  }
  return '';
}

const FOLDER_COVER_NAMES = [
  'cover.jpg', 'cover.jpeg', 'cover.png',
  'folder.jpg', 'folder.jpeg', 'folder.png',
  'poster.jpg', 'poster.png'
];

/* One picture for a whole folder. A 30-volume set rarely ships 30 separate
 * covers; dropping a single cover.jpg into 【全唐诗】30册/ dresses all of them. */
async function findDirCover(dir) {
  for (const name of FOLDER_COVER_NAMES) {
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile() && st.size >= 128) return path.join(dir, name);
    } catch (e) { /* try the next name */ }
  }
  return '';
}

/* True when a picture exists that the previous scan did not have. Used to force
 * exactly one re-scrape of a coverless book, so dropping a cover.jpg takes
 * effect without deleting the index - and settles back to zero work after. */
async function hasCoverSource(file, dirCoverIndex) {
  const dir = path.dirname(file);
  if (dirCoverIndex && dirCoverIndex.get(dir)) return true;
  const base = path.basename(file, path.extname(file));
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    try {
      const st = await fsp.stat(path.join(dir, base + '.' + ext));
      if (st.isFile() && st.size >= 128) return true;
    } catch (e) { /* try the next extension */ }
  }
  return false;
}

/* Last resort for scanned or encrypted PDFs: they carry no embedded cover at
 * all, but page one of a scanned book is the cover or the title page. poppler
 * renders it once and the result is cached like any other cover. */
function pdfPageCover(file, coverDir, id) {
  return new Promise(resolve => {
    if (!coverDir || (process.platform === 'win32' && !process.env.PDFTOPPM_PATH)) return resolve('');
    const stem = path.join(coverDir, id + '.page1');
    const produced = stem + '.jpg';
    execFile('pdftoppm',
      ['-jpeg', '-f', '1', '-l', '1', '-scale-to', '640', '-singlefile', file, stem],
      { timeout: 30000, maxBuffer: 1024 * 1024 }, async err => {
        if (err) {
          fsp.unlink(produced).catch(() => {});
          return resolve('');
        }
        try {
          const buf = await fsp.readFile(produced);
          if (buf.length < 128) {
            await fsp.unlink(produced).catch(() => {});
            return resolve('');
          }
          const name = id + '.jpg';
          await fsp.writeFile(path.join(coverDir, name), buf);
          await fsp.unlink(produced).catch(() => {});
          resolve(name);
        } catch (e) {
          resolve('');
        }
      });
  });
}

function scrapeTxt(file) {
  return fsp.readFile(file).then(buf => {
    let text;
    if (iconv.encodingExists('utf8') && isValidUtf8(buf)) text = buf.toString('utf8');
    else text = iconv.decode(buf, 'gb18030');
    const firstLine = text.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
    // Only a line that reads like a heading counts as the title: short and
    // free of sentence punctuation. Plenty of novels open straight into a
    // paragraph, and treating that paragraph as the book name was how a whole
    // shelf ended up named after its first sentence.
    const looksLikeTitle = firstLine.length > 0 && firstLine.length <= 24 &&
      !/[，。！？；：、“”‘’「」『』《》,.!?;:]/.test(firstLine);
    return { title: looksLikeTitle ? firstLine : '' };
  }).catch(() => ({}));
}

function isValidUtf8(buf) {
  const s = buf.subarray(0, Math.min(buf.length, 8192)).toString('utf8');
  return !s.includes('\uFFFD');
}

// Directories that never contain user books. Skipping them keeps the index
// clean when the compose project and the data folder live next to the books.
const SKIP_DIRS = new Set([
  'data', 'converted', 'covers', 'node_modules',
  '@eaDir', '#recycle', 'system', 'lost+found'
]);

async function walk(dir, root) {
  const found = [];
  async function recurse(current) {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (SUPPORTED.has(ext)) found.push(full);
      }
    }
  }
  await recurse(dir);
  return found.map(full => ({
    full,
    rel: path.relative(root, full).split(path.sep).join('/')
  }));
}

async function mapLimit(items, limit, worker) {
  const out = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const index = i++;
      out[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function statOf(file) {
  try { return await fsp.stat(file); } catch (e) { return null; }
}

/* One readdir of the cover folder instead of an existsSync per book. On a
 * 500-book shelf those synchronous calls blocked the event loop during the
 * "nothing changed" scan, which is exactly the case that must stay instant.
 * A null result means "unknown", and unknown never counts as a change. */
async function listCovers(coverDir) {
  try { return new Set(await fsp.readdir(coverDir)); }
  catch (e) { return null; }
}

/* True when a previously scraped record can be reused as-is: the file has the
 * same size and mtime, the stored title is not mojibake, and its cover is
 * still on disk. Anything questionable falls through to a real scrape, so a
 * better extractor still repairs books that were indexed badly. */
function canReuse(previous, stat, coverSet, fileGuess) {
  if (!previous || !stat) return false;
  if (!previous.title || looksGarbled(previous.title)) return false;
  if (previous.author && looksGarbled(previous.author)) return false;
  if (previous.size !== stat.size) return false;
  if (previous.addedAt !== stat.mtime.toISOString()) return false;
  // PDF titles used to come from the first bookmark instead of the document
  // properties, so a box set could end up titled 总目录. Re-read each PDF once
  // after the extractor changes; the marker makes that a one-time cost.
  if (previous.format === 'pdf' && previous.metaVersion !== META_VERSION) return false;
  if (previous.coverFile && coverSet && !coverSet.has(previous.coverFile)) return false;
  // A record saved from junk metadata, or one whose title swallowed the author
  // bracket, deserves one more scrape now that both sides are fixed. Each of
  // these conditions disappears once the record is repaired, so an unchanged
  // shelf still settles back to zero work.
  if (isJunkMeta(previous.title, false)) return false;
  if (previous.author && isJunkMeta(previous.author, true)) return false;
  if (tailParenIsAuthor(previous.title)) return false;
  if (fileGuess && onlyVolumeMarker(previous.title)) {
    const stem = volumeStem(previous.title);
    if (fileGuess.title && !fileGuess.title.startsWith(stem)) return false;
  }
  return true;
}

async function buildBook(entry, cfg, folder, previous, preStat, coverSet, preGuess, dirCoverPath) {
  const { full, rel } = entry;
  // Include the folder in the hash so the same filename in two folders
  // stays two distinct books.
  const id = hashId(folder + '|' + rel);
  const ext = path.extname(rel).slice(1).toLowerCase();
  const base = path.basename(rel, path.extname(rel));
  const guessed = preGuess || guessFromFilename(base, path.basename(path.dirname(rel)));

  // The probe pass already stat'ed the file; only pay for it again when this
  // function is called on its own.
  const stat = preStat !== undefined ? preStat : await statOf(full);

  // Incremental rescan: an unchanged file never reaches a parser or Calibre.
  if (canReuse(previous, stat, coverSet, guessed)) {
    return { ...previous, id, format: ext, path: rel, folder };
  }

  let scraped = {};
  try {
    if (ext === 'epub') {
      scraped = await scrapeEpub(full, cfg.coverDir, id);
      // OPF without a declared cover: plenty of files still carry the artwork
      // under images/cover.jpg, which beats rendering nothing.
      if (!scraped.coverFile) scraped.coverFile = await epubAnyCover(full, cfg.coverDir, id);
    } else if (ext === 'pdf') {
      // Document properties only. The cover comes from rendering page one
      // further down, which works for scanned sets that have no artwork at all.
      scraped = await scrapePdf(full);
    } else if (ext === 'mobi' || ext === 'azw3') {
      scraped = await scrapeMobi(full, cfg.coverDir, id);
    } else if (ext === 'txt') {
      scraped = await scrapeTxt(full);
    }
  } catch (e) {
    scraped = {};
  }

  // Cover fallbacks, in order of confidence: a picture dropped next to the
  // file, one cover shared by the whole folder, then the PDF's own first page.
  // Scanned and encrypted PDFs carry no embedded cover at all, so without the
  // last step a 30-volume set shows nothing but generated text cards.
  if (!scraped.coverFile) scraped.coverFile = await siblingCover(full, cfg.coverDir, id);
  if (!scraped.coverFile && dirCoverPath) {
    scraped.coverFile = await storeCover(dirCoverPath, cfg.coverDir, id);
  }
  if (!scraped.coverFile && ext === 'pdf') {
    scraped.coverFile = await pdfPageCover(full, cfg.coverDir, id);
  }

  // Embedded metadata wins when it is real, the filename wins when it is not:
  // junk (page headers, software defaults, mojibake) and bare volume markers
  // are the two cases where the user's own filename is more trustworthy.
  const fileTitle = clean(guessed.title);
  const fileAuthor = clean(guessed.author);
  let title = splitBlurb(clean(scraped.title));
  let author = clean(scraped.author);
  if (isJunkMeta(title, false)) title = fileTitle;
  else if (onlyVolumeMarker(title) && fileTitle && !fileTitle.startsWith(volumeStem(title))) {
    title = fileTitle;
  }
  if (isJunkMeta(author, true)) author = fileAuthor;
  // The title still carries its own credit, e.g. 「传销心理战 (萧荣华著)」, while
  // the author came from elsewhere: drop the duplicate from the title.
  if (title && author && tailParenIsAuthor(title)) {
    const stripped = splitTailParen(title).title;
    if (stripped) title = stripped;
  }

  return {
    id,
    title: title || fileTitle,
    author: author || fileAuthor,
    language: clean(scraped.language || ''),
    description: clean(scraped.description || ''),
    format: ext,
    path: rel,
    folder: folder,
    size: stat ? stat.size : 0,
    addedAt: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    coverFile: scraped.coverFile || '',
    metaVersion: META_VERSION
  };
}

async function scan(cfg, folders) {
  const startedAt = Date.now();
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await fsp.mkdir(cfg.coverDir, { recursive: true });
  await fsp.mkdir(cfg.convertDir, { recursive: true });

  const targets = (folders && folders.length) ? folders : [cfg.booksDir];
  const seen = new Set();
  const books = [];
  const folderStats = [];

  // Index the previously scanned books by id so unchanged files can skip
  // scraping entirely.
  const prevIndex = await loadIndex(cfg);
  const prevBooks = prevIndex.books || [];
  const previous = new Map();
  prevBooks.forEach(b => { if (b && b.id) previous.set(b.id, b); });
  const coverSet = await listCovers(cfg.coverDir);
  // dir → shared cover picture (or ''), resolved once per folder.
  const dirCoverIndex = new Map();

  let reused = 0;
  let added = 0;

  for (const folder of targets) {
    let files = [];
    try {
      const stat = await fsp.stat(folder);
      if (!stat.isDirectory()) {
        folderStats.push({ folder, ok: false, count: 0, error: '不是文件夹' });
        continue;
      }
      files = await walk(folder, folder);
      folderStats.push({ folder, ok: true, count: files.length });
    } catch (e) {
      folderStats.push({ folder, ok: false, count: 0, error: '无法访问：' + e.message });
      continue;
    }
    if (!files.length) continue;

    // One cover lookup per directory instead of one per book.
    await Promise.all([...new Set(files.map(f => path.dirname(f.full)))].map(async dir => {
      if (dirCoverIndex.has(dir)) return;
      dirCoverIndex.set(dir, await findDirCover(dir));
    }));

    // Pass 1 — one stat per file, nothing opened and nothing parsed. The
    // concurrency is high because this is pure metadata IO, and it is the only
    // work an unchanged shelf has to do.
    const probed = await mapLimit(files, 24, async entry => {
      const id = hashId(folder + '|' + entry.rel);
      const stat = await statOf(entry.full);
      const guess = guessFromFilename(
        path.basename(entry.rel, path.extname(entry.rel)),
        path.basename(path.dirname(entry.rel))
      );
      return { entry, id, stat, guess };
    });

    // Books the last scan could not dress get one extra look: the user may have
    // dropped a picture next to the file or into the folder since then. Once
    // found they are repaired, and the next scan settles back to zero work.
    const coverless = probed.filter(p => {
      const prev = previous.get(p.id);
      return prev && !prev.coverFile;
    });
    const coverFound = new Set();
    if (coverless.length) {
      await mapLimit(coverless, 8, async p => {
        if (await hasCoverSource(p.entry.full, dirCoverIndex)) coverFound.add(p.id);
      });
    }

    // Pass 2 — unchanged books are answered straight from the old index; only
    // the new or modified ones reach a parser, at a lower concurrency so
    // pdftoppm renders do not pile up on a small NAS.
    const todo = [];
    const found = new Array(probed.length);
    probed.forEach((p, i) => {
      const prev = previous.get(p.id);
      if (canReuse(prev, p.stat, coverSet, p.guess) && !coverFound.has(p.id)) {
        reused++;
        found[i] = {
          ...prev,
          id: p.id,
          format: path.extname(p.entry.rel).slice(1).toLowerCase(),
          path: p.entry.rel,
          folder
        };
      } else {
        if (!prev) added++;
        // A book re-queued only because a cover appeared still looks reusable
        // from the inside, so hand it no previous record: it must be scraped
        // for real, otherwise the picture would never reach the shelf.
        todo.push({
          index: i, entry: p.entry, id: p.id, stat: p.stat, guess: p.guess,
          prev: coverFound.has(p.id) ? null : prev
        });
      }
    });

    const fresh = await mapLimit(todo, 4, p =>
      buildBook(p.entry, cfg, folder, p.prev, p.stat, coverSet, p.guess,
        dirCoverIndex.get(path.dirname(p.entry.full)) || '')
    );
    todo.forEach((p, k) => { found[p.index] = fresh[k]; });

    for (const book of found) {
      if (!book || seen.has(book.id)) continue;
      seen.add(book.id);
      books.push(book);
    }
  }

  const removed = prevBooks.filter(b => b && b.id && !seen.has(b.id)).length;
  const changed = added > 0 || removed > 0 || reused < books.length;
  const stats = {
    total: books.length,
    reused,
    scraped: books.length - reused,
    added,
    removed,
    changed,
    durationMs: Date.now() - startedAt
  };
  const index = {
    scannedAt: new Date().toISOString(),
    count: books.length,
    folders: folderStats,
    stats,
    books
  };
  // Nothing changed means there is nothing new to persist: keep the NAS disk
  // quiet and let the in-memory scannedAt tell clients the scan did run.
  if (changed || !prevIndex.scannedAt) {
    await fsp.writeFile(path.join(cfg.dataDir, 'library.json'), JSON.stringify(index, null, 2), 'utf8');
  }
  return index;
}

/* Re-scrape exactly one book, consulting no cache at all. The caller asks for
 * the file to be read again, so the previous record is never handed to
 * buildBook (canReuse cannot short-circuit a null record) and the stored
 * picture is deleted first - otherwise a stale cover would survive and the
 * repair would look like it did nothing. */
async function rescrape(cfg, folder, rel, options) {
  const opts = options || {};
  const full = path.join(folder, rel);
  const stat = await statOf(full);
  if (!stat) {
    const err = new Error('文件读不到，可能已被移动或删除：' + rel);
    err.code = 'EBOOKMISSING';
    throw err;
  }
  const id = hashId(folder + '|' + rel);
  const prevIndex = await loadIndex(cfg);
  const prev = (prevIndex.books || []).find(b => b && b.id === id) || null;

  if (prev && prev.coverFile) {
    await fsp.unlink(path.join(cfg.coverDir, prev.coverFile)).catch(() => {});
  }

  const coverSet = await listCovers(cfg.coverDir);
  const guess = guessFromFilename(
    path.basename(rel, path.extname(rel)),
    path.basename(path.dirname(rel))
  );
  const dirCoverPath = opts.ignoreFolderCover ? '' : await findDirCover(path.dirname(full));
  const book = await buildBook({ full, rel }, cfg, folder, null, stat, coverSet, guess, dirCoverPath);
  return { book, previous: prev };
}

async function saveIndex(cfg, index) {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await fsp.writeFile(path.join(cfg.dataDir, 'library.json'), JSON.stringify(index, null, 2), 'utf8');
}

async function loadIndex(cfg) {
  try {
    return JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'library.json'), 'utf8'));
  } catch (e) {
    return { scannedAt: null, count: 0, books: [] };
  }
}

async function loadProgress(cfg) {
  try {
    return JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'progress.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

async function saveProgress(cfg, all) {
  await fsp.writeFile(path.join(cfg.dataDir, 'progress.json'), JSON.stringify(all, null, 2), 'utf8');
}

/* Sorting needs one canonical form for both sides of a comparison, otherwise
 * 「全唐诗 01」and「全唐诗01」land in different places and volumes of one set
 * get interleaved with unrelated books. */
function sortKeyTitle(value) {
  return String(value || '')
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\u3001\u3002\u3008-\u3011\u3014\u3015\u30FB]/g, ' ')
    .replace(/[\s·•・，。、；：！？（）【】《》〈〉「」『』“”‘’\-—–_/\\|｜~～@#$%^&*+=<>()[\]{},.?:;'"!]/g, '')
    .toLowerCase();
}

function sortBooks(books, sort, order) {
  const key = sort || 'title';
  const dir = order === 'desc' ? -1 : 1;
  const primary = b => {
    if (key === 'title') return sortKeyTitle(b.title);
    if (key === 'author') return sortKeyTitle(b.author) || '\uffff';
    if (key === 'path') return sortKeyTitle(path.basename(b.path || ''));
    if (key === 'format') return String(b.format || '');
    if (key === 'size') return b.size || 0;
    return b.addedAt || '';
  };
  const compare = (a, b) => {
    const av = primary(a);
    const bv = primary(b);
    if (typeof av === 'number' || typeof bv === 'number') return (av || 0) - (bv || 0);
    return String(av).localeCompare(String(bv), 'zh-CN', { numeric: true, sensitivity: 'base' });
  };
  return [...books].sort((a, b) => {
    const cmp = compare(a, b);
    if (cmp !== 0) return cmp * dir;
    // Same title: order by file path so a set's volumes stay together and in
    // a stable order, whichever direction the primary sort runs.
    return sortKeyTitle(a.path || '').localeCompare(
      sortKeyTitle(b.path || ''), 'zh-CN', { numeric: true, sensitivity: 'base' }
    );
  });
}

module.exports = {
  SUPPORTED,
  scan,
  rescrape,
  saveIndex,
  loadIndex,
  loadProgress,
  saveProgress,
  sortBooks,
  hashId,
  isValidUtf8,
  guessFromFilename,
  isJunkMeta,
  tailParenIsAuthor
};
