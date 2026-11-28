/*
 * Format conversion: turn any book in the library into EPUB / TXT / DOCX / PDF
 * and hand the result to the browser as a download.
 *
 * Calibre used to be the obvious answer here - it converts between all six
 * formats the sheet lists - but it costs about 712MB of Qt in the image, which
 * is exactly what 1.9 removed. The four targets below need no native code:
 * JSZip for the two zip containers, pdfkit plus one open CJK font for PDF, and
 * the already-vendored KindleUnpack for MOBI / AZW3 sources.
 *
 * MOBI and AZW3 are intentionally not offered as targets: writing PalmDB /
 * KF8 without Calibre has no maintained implementation, and Amazon's kindlegen
 * stopped shipping in 2017. The UI greys those two buttons out and says why.
 *
 * Every source is parsed into one shape first -
 *   { title, author, chapters: [{ title, paragraphs: [string] }] }
 * - so each writer only has to understand that, not five file formats.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const converter = require('./convert');
const library = require('./library');

let iconv = null;
try { iconv = require('iconv-lite'); } catch (e) { /* optional */ }

/* Targets we can actually write. Order matches the sheet's button row. */
const WRITABLE = ['epub', 'txt', 'docx', 'pdf'];
/* Shown but disabled, so the sheet tells the whole truth instead of hiding the
 * two formats people ask for most. */
const UNSUPPORTED = ['azw3', 'mobi'];
const ALL_TARGETS = ['epub', 'azw3', 'mobi', 'docx', 'pdf', 'txt'];

// The whole source is buffered in memory (and pdf.js keeps its own copy), so a
// 300MB scan would need ~1GB of RAM before it even finds out there is no text.
const MAX_SOURCE_BYTES = 150 * 1024 * 1024;

function isWritable(target) {
  return WRITABLE.indexOf(target) >= 0;
}

/* Which buttons make sense for this book: everything we can write, minus the
 * format it is already in (converting EPUB to EPUB is a no-op download). */
function targetsFor(format) {
  const src = String(format || '').toLowerCase();
  return ALL_TARGETS.map(t => ({
    target: t,
    ok: isWritable(t) && t !== src,
    self: t === src,
    reason: !isWritable(t)
      ? '需要 Calibre 才能写这个格式，本镜像为控制体积没有内置'
      : (t === src ? '已经是这个格式' : '')
  }));
}

/* ------------------------------------------------------------------ *
 * text helpers
 * ------------------------------------------------------------------ */

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  if (library.isValidUtf8(buf)) return buf.toString('utf8');
  if (iconv && iconv.encodingExists('gb18030')) return iconv.decode(buf, 'gb18030');
  return buf.toString('utf8');
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', times: '×', laquo: '«', raquo: '»'
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
    });
}

function safeChar(code) {
  if (!isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch (e) { return ''; }
}

/* HTML -> paragraphs. Two or more newlines separate paragraphs; single
 * newlines are source formatting and collapse into a space. Block-level end
 * tags are what actually create the breaks. */
function htmlToParagraphs(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|svg)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|dd|dt|figcaption)>/gi, '\n\n');
  s = s.replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article|pre|dd|dt)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return splitParagraphs(s);
}

function splitParagraphs(raw) {
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean);
}

/* A line only counts as a heading when it is short and starts with a known
 * marker - otherwise a sentence that merely mentions 第一章 becomes a chapter. */
const HEADING_RE = new RegExp(
  '^\\s*(?:' +
  '第\\s*[0-9０-９〇零一二三四五六七八九十百千两]{1,8}\\s*[章节回卷篇集部]' +
  '|[（(【\\[]?\\s*(?:楔子|序章|序言|前言|引子|引言|尾声|后记|附录|番外|终章)' +
  '|(?:Chapter|CHAPTER|Part|PART)\\s+[0-9IVXLC]+' +
  ')',
  'i'
);

function isHeadingLine(p) {
  if (!p || p.length > 40) return false;
  // A paragraph ending in a full stop is prose, not a title.
  if (/[。！？…]$/.test(p)) return false;
  return HEADING_RE.test(p);
}

function splitChapters(paragraphs) {
  const chapters = [];
  let cur = { title: '', paragraphs: [] };
  for (const p of paragraphs) {
    if (isHeadingLine(p)) {
      if (cur.paragraphs.length || cur.title) chapters.push(cur);
      cur = { title: p, paragraphs: [] };
    } else {
      cur.paragraphs.push(p);
    }
  }
  if (cur.paragraphs.length || cur.title) chapters.push(cur);
  const kept = chapters.filter(c => c.paragraphs.length || c.title);
  return kept.length ? kept : [{ title: '', paragraphs }];
}

/* ------------------------------------------------------------------ *
 * source parsers
 * ------------------------------------------------------------------ */

async function parseTxt(file, report) {
  report(12, '正在读取文本');
  const buf = await fsp.readFile(file);
  const text = decodeText(buf).replace(/\r\n?/g, '\n');
  // In a plain text book one line is one paragraph; blank lines are just
  // spacing. Splitting on blank lines instead would glue whole chapters into
  // a single blob.
  const paragraphs = text.split('\n').map(l => l.replace(/[\t\u00a0]+/g, ' ').trim()).filter(Boolean);
  return { title: '', author: '', chapters: splitChapters(paragraphs) };
}

function zipText(zip, name) {
  const entry = zip.file(name);
  if (!entry) return Promise.resolve('');
  return entry.async('string');
}

function attrOf(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const m = re.exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : '';
}

/* Resolve href against the OPF's own directory, normalising ../ segments. */
function resolveHref(base, href) {
  const clean = decodeURIComponent(String(href || '').split('#')[0]);
  if (!clean) return '';
  return path.posix.normalize(base ? path.posix.join(base, clean) : clean).replace(/^\.\//, '');
}

async function parseEpub(file, report) {
  report(12, '正在打开电子书');
  const zip = await JSZip.loadAsync(await fsp.readFile(file));

  const container = await zipText(zip, 'META-INF/container.xml');
  let opfPath = '';
  const rootfile = /<rootfile\b[^>]*>/i.exec(container);
  if (rootfile) opfPath = attrOf(rootfile[0], 'full-path');
  if (!opfPath || !zip.file(opfPath)) {
    opfPath = Object.keys(zip.files).find(n => /\.opf$/i.test(n)) || '';
  }
  if (!opfPath) return { title: '', author: '', chapters: [{ title: '', paragraphs: [] }] };

  const opf = await zipText(zip, opfPath);
  const base = path.posix.dirname(opfPath);

  let title = '';
  let author = '';
  const t = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  if (t) title = splitParagraphs(decodeEntities(t[1]))[0] || '';
  const c = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf);
  if (c) author = splitParagraphs(decodeEntities(c[1]))[0] || '';

  // Manifest: id -> path
  const manifest = {};
  const itemRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = attrOf(tag, 'id');
    const href = attrOf(tag, 'href');
    if (id && href) manifest[id] = resolveHref(base, href);
  }

  // Spine gives reading order; anything outside it is usually notes or ads.
  const order = [];
  const refRe = /<itemref\b[^>]*>/gi;
  while ((m = refRe.exec(opf))) {
    const idref = attrOf(m[0], 'idref');
    if (idref && manifest[idref]) order.push(manifest[idref]);
  }
  const docs = order.length ? order : Object.keys(manifest).map(k => manifest[k]).filter(p => /\.x?html?$/i.test(p));

  const chapters = [];
  for (const rel of docs) {
    if (!/\.x?html?$/i.test(rel)) continue;
    report(12 + Math.round(48 * (chapters.length + 1) / Math.max(1, docs.length)),
      '正在读取章节 ' + (chapters.length + 1) + ' / ' + docs.length);
    const html = await zipText(zip, rel);
    if (!html) continue;
    // Chapter heading: first h1-h3 inside this document, if any.
    const h = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(html);
    let heading = '';
    if (h) heading = splitParagraphs(decodeEntities(h[2].replace(/<[^>]+>/g, '')))[0] || '';
    const body = htmlToParagraphs(html);
    if (!body.length) continue;
    if (heading && body[0] === heading) body.shift();
    if (heading) chapters.push({ title: heading, paragraphs: body });
    else chapters.push({ title: '', paragraphs: body });
  }

  if (!chapters.length) chapters.push({ title: '', paragraphs: [] });
  return { title, author, chapters };
}

/* pdf.js in Node needs its worker module required up front; otherwise the fake
 * worker path tries a dynamic ESM import of a .js file and throws. */
let _pdfjs = null;
function pdfjsModule() {
  if (_pdfjs) return _pdfjs;
  // pdf.js tries to require the optional `canvas` build for DOMMatrix / Path2D
  // on load and logs a scary "Cannot find module canvas.node" when it is not
  // installed (we build with --omit=optional). Text extraction never touches
  // those classes, so harmless stubs keep the NAS log clean.
  if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = class DOMMatrix {};
  if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};
  if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = class ImageData {};

  const dirs = [
    path.join(ROOT, 'vendor', 'pdfjs'),
    path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build')
  ];
  for (const dir of dirs) {
    const entry = path.join(dir, 'pdf.js');
    if (!fs.existsSync(entry)) continue;
    const lib = require(entry);
    const worker = path.join(dir, 'pdf.worker.js');
    if (fs.existsSync(worker)) {
      try { globalThis.pdfjsWorker = require(worker); } catch (e) { /* fall through */ }
      if (!globalThis.pdfjsWorker) lib.GlobalWorkerOptions.workerSrc = worker;
    }
    _pdfjs = lib;
    return lib;
  }
  return null;
}

/* pdf.js hands back positioned runs, not paragraphs. Group them by baseline
 * and close a paragraph on sentence-final punctuation or when it has grown
 * long enough that the author almost certainly ended a thought. */
function pdfLinesToParagraphs(lines) {
  const paras = [];
  let cur = '';
  const flush = () => { const t = cur.trim(); if (t) paras.push(t); cur = ''; };
  for (const raw of lines) {
    const line = String(raw).replace(/[\t\u00a0]+/g, ' ').trim();
    if (!line) { flush(); continue; }
    cur += line;
    if (/[。！？…”』」；：!?"'】]$/.test(line) || cur.length > 400) flush();
  }
  flush();
  return paras;
}

async function parsePdf(file, report) {
  report(12, '正在读取 PDF 文字层');
  const lib = pdfjsModule();
  if (!lib) throw new Error('镜像里缺少 pdf.js，无法读取 PDF 文字层');
  const data = new Uint8Array(await fsp.readFile(file));
  const task = lib.getDocument({ data, isEvalSupported: false, useSystemFonts: false });
  const pdf = await task.promise;
  // Metadata has to be read before destroy(), and only through the public API -
  // _pdfInfo is an internal that has moved between releases.
  let meta = {};
  try { meta = (await pdf.getMetadata()).info || {}; } catch (e) { meta = {}; }
  const chapters = [];
  const CHUNK = 40;
  let pages = [];
  let chars = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    // Reading the text layer page by page is the slowest part of a PDF job.
    // Report per page so the progress bar actually moves on a big book.
    report(12 + Math.round(58 * (i - 1) / pdf.numPages),
      '正在读取第 ' + i + ' / ' + pdf.numPages + ' 页');
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = [];
    let cur = '';
    let lastY = null;
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && cur) {
        lines.push(cur);
        cur = '';
      }
      cur += item.str;
      if (item.hasEOL) { lines.push(cur); cur = ''; lastY = null; continue; }
      if (y !== null) lastY = y;
    }
    if (cur) lines.push(cur);
    const paras = pdfLinesToParagraphs(lines);
    for (const p of paras) chars += p.length;
    pages.push(paras);
    page.cleanup();
    // getTextContent() is CPU-bound. Without yielding, a 200-page book keeps
    // Node's event loop busy for the whole parse and progress polls (and every
    // other request) only get answered after the job is already finished.
    await new Promise(resolve => setImmediate(resolve));
    // Break long PDFs into readable chapters instead of one endless page.
    if (pages.length >= CHUNK) {
      chapters.push({ title: '第 ' + (chapters.length + 1) + ' 部分', paragraphs: [].concat.apply([], pages) });
      pages = [];
    }
  }
  if (pages.length) {
    const flat = [].concat.apply([], pages);
    if (chapters.length) chapters.push({ title: '第 ' + (chapters.length + 1) + ' 部分', paragraphs: flat });
    else chapters.push({ title: '', paragraphs: flat });
  }
  await pdf.destroy();

  if (!chars) {
    const e = new Error('这本 PDF 里没有文字层（扫描版图片），抽不出字来，转出来会是空的');
    e.code = 'NO_TEXT';
    throw e;
  }
  return {
    title: String(meta.Title || '').trim(),
    author: String(meta.Author || '').trim(),
    chapters
  };
}

/* MOBI / AZW3 go through the reader's own converter first, then the EPUB
 * parser - that way the two paths cannot drift apart. */
async function parseMobi(book, cfg, report) {
  report(10, '正在解包 Kindle 文件');
  const result = await converter.ensureEpub(book, cfg);
  if (!result.ok) throw new Error(result.error || '解包 Kindle 格式失败');
  if (result.cached) report(18, '解包结果已在缓存里');
  return parseEpub(result.file, report);
}

async function parseBook(book, cfg, report) {
  report(6, '正在检查源文件');
  const format = String(book.format || '').toLowerCase();
  const folder = book.folder || cfg.booksDir;
  const abs = path.resolve(folder, book.path);
  if (!abs.startsWith(path.resolve(folder) + path.sep)) throw new Error('书籍路径无效');
  const st = await fsp.stat(abs);
  if (st.size > MAX_SOURCE_BYTES) throw new Error('源文件超过 150MB，转换要把它整个读进内存，先手动处理一下再转');

  let doc;
  if (format === 'txt') doc = await parseTxt(abs, report);
  else if (format === 'epub') doc = await parseEpub(abs, report);
  else if (format === 'pdf') doc = await parsePdf(abs, report);
  else if (format === 'mobi' || format === 'azw3') doc = await parseMobi(book, cfg, report);
  else throw new Error('不支持从 ' + format.toUpperCase() + ' 转换');

  // File metadata is more reliable than anything inside the payload.
  doc.title = book.title || doc.title || path.basename(book.path || '', path.extname(book.path || '')) || '未命名';
  doc.author = book.author || doc.author || '';
  if (!doc.chapters.length) doc.chapters = [{ title: '', paragraphs: [] }];
  // 源文件第一行常常又写一遍书名，照搬过去就是「书名 / 书名」。
  const head = doc.chapters[0];
  if (head && !head.title && head.paragraphs.length &&
      head.paragraphs[0].trim() === String(doc.title).trim()) {
    head.paragraphs.shift();
    if (!head.paragraphs.length && doc.chapters.length > 1) doc.chapters.shift();
  }
  return doc;
}

/* ------------------------------------------------------------------ *
 * writers
 * ------------------------------------------------------------------ */

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most C0 control characters outright.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

async function writeTxt(doc, outFile, report) {
  report(70, '正在写出文本');
  const lines = [doc.title];
  if (doc.author) lines.push(doc.author);
  for (const ch of doc.chapters) {
    lines.push('');
    if (ch.title) {
      lines.push(ch.title);
      lines.push('');
    }
    for (const p of ch.paragraphs) lines.push('　　' + p);
  }
  // CRLF keeps old Windows notepads happy; the whole file must use one style,
  // otherwise the title block renders as a single mangled line.
  await fsp.writeFile(outFile, lines.join('\r\n') + '\r\n', 'utf8');
  report(96, '正在保存文件');
}

function xhtmlPage(doc, ch, idx) {
  const body = ch.paragraphs.map(p => '<p>' + xmlEscape(p) + '</p>').join('\n');
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ' +
    'lang="zh-CN" xml:lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8"/>\n<title>' + xmlEscape(ch.title || doc.title) + '</title>\n' +
    '<link rel="stylesheet" type="text/css" href="style.css"/>\n</head>\n<body>\n' +
    '<section epub:type="chapter">\n' +
    (ch.title ? '<h2>' + xmlEscape(ch.title) + '</h2>\n' : '') +
    body + '\n</section>\n</body>\n</html>\n';
}

const EPUB_CSS = [
  'body { margin: 1.2em 1.1em; line-height: 1.7; }',
  'p { margin: 0 0 0.55em; text-indent: 2em; }',
  'h2 { font-size: 1.25em; margin: 1.4em 0 0.9em; text-align: center; text-indent: 0; }',
  'body { font-family: serif; }'
].join('\n');

async function writeEpub(doc, outFile, report) {
  report(70, '正在生成 EPUB');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles>\n' +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
    '  </rootfiles>\n</container>\n');

  const files = [];
  doc.chapters.forEach((ch, i) => {
    report(70 + Math.round(18 * (i + 1) / doc.chapters.length),
      '正在生成第 ' + (i + 1) + ' / ' + doc.chapters.length + ' 章');
    const name = 'text/ch' + String(i + 1).padStart(4, '0') + '.xhtml';
    files.push(name);
    zip.file('OEBPS/' + name, xhtmlPage(doc, ch, i));
  });
  zip.file('OEBPS/style.css', EPUB_CSS);

  const manifest = files.map((f, i) =>
    '    <item id="c' + (i + 1) + '" href="' + f + '" media-type="application/xhtml+xml"/>'
  ).join('\n');
  const spine = files.map((f, i) => '    <itemref idref="c' + (i + 1) + '"/>').join('\n');
  const nav = files.map((f, i) =>
    '      <li><a href="' + f + '">' + xmlEscape(doc.chapters[i].title || ('第 ' + (i + 1) + ' 节')) + '</a></li>'
  ).join('\n');

  zip.file('OEBPS/content.opf',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    '    <dc:identifier id="bookid">urn:uuid:' + uuidFrom(doc) + '</dc:identifier>\n' +
    '    <dc:title>' + xmlEscape(doc.title) + '</dc:title>\n' +
    (doc.author ? '    <dc:creator>' + xmlEscape(doc.author) + '</dc:creator>\n' : '') +
    '    <dc:language>zh-CN</dc:language>\n' +
    '    <meta property="dcterms:modified">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</meta>\n' +
    '  </metadata>\n  <manifest>\n' +
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
    '    <item id="css" href="style.css" media-type="text/css"/>\n' +
    manifest + '\n  </manifest>\n' +
    '  <spine toc="ncx">\n' + spine + '\n  </spine>\n</package>\n');

  zip.file('OEBPS/nav.xhtml',
    '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">\n' +
    '<head><meta charset="utf-8"/><title>目录</title></head>\n<body>\n' +
    '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n' + nav + '\n</ol></nav>\n</body></html>\n');

  zip.file('OEBPS/toc.ncx',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
    '  <head><meta name="dtb:uid" content="urn:uuid:' + uuidFrom(doc) + '"/></head>\n' +
    '  <docTitle><text>' + xmlEscape(doc.title) + '</text></docTitle>\n  <navMap>\n' +
    files.map((f, i) =>
      '    <navPoint id="n' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' +
      xmlEscape(doc.chapters[i].title || ('第 ' + (i + 1) + ' 节')) + '</text></navLabel>' +
      '<content src="' + f + '"/></navPoint>'
    ).join('\n') +
    '\n  </navMap>\n</ncx>\n');

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await fsp.writeFile(outFile, buf);
  report(96, '正在保存文件');
}

/* Deterministic id so re-converting the same book produces the same identifier
 * and readers keep their bookmarks. */
function uuidFrom(doc) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(String(doc.title) + '|' + String(doc.author)).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '5' + h.slice(13, 16), 'a' + h.slice(17, 20), h.slice(20, 32)].join('-');
}

const DOCX_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  '  <Default Extension="xml" ContentType="application/xml"/>\n' +
  '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n' +
  '  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n' +
  '  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n' +
  '</Types>\n';

const DOCX_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n' +
  '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\n' +
  '</Relationships>\n';

const DOCX_DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n' +
  '</Relationships>\n';

const DOCX_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
  '  <w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>' +
  '<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>\n' +
  '  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:style>\n' +
  '  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>' +
  '<w:rPr><w:rFonts w:eastAsia="SimHei"/><w:b/><w:sz w:val="44"/></w:rPr></w:style>\n' +
  '  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="200"/><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:rFonts w:eastAsia="SimHei"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>\n' +
  '</w:styles>\n';

async function writeDocx(doc, outFile, report) {
  report(70, '正在生成 DOCX');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
  zip.file('_rels/.rels', DOCX_RELS);
  zip.file('word/_rels/document.xml.rels', DOCX_DOC_RELS);
  zip.file('word/styles.xml', DOCX_STYLES);
  zip.file('docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
    '  <dc:title>' + xmlEscape(doc.title) + '</dc:title>\n' +
    (doc.author ? '  <dc:creator>' + xmlEscape(doc.author) + '</dc:creator>\n' : '') +
    '  <dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString() + '</dcterms:created>\n' +
    '</cp:coreProperties>\n');

  const para = (text, style) =>
    '<w:p><w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' +
    '<w:r><w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r></w:p>';

  const body = [];
  body.push(para(doc.title, 'Title'));
  if (doc.author) body.push('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>' + xmlEscape(doc.author) + '</w:t></w:r></w:p>');
  let ci = 0;
  for (const ch of doc.chapters) {
    report(70 + Math.round(18 * (++ci) / doc.chapters.length),
      '正在生成第 ' + ci + ' / ' + doc.chapters.length + ' 章');
    if (ch.title) body.push(para(ch.title, 'Heading1'));
    for (const p of ch.paragraphs) {
      body.push('<w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/></w:pPr>' +
        '<w:r><w:t xml:space="preserve">' + xmlEscape(p) + '</w:t></w:r></w:p>');
    }
  }
  body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>');

  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
    '<w:body>\n' + body.join('\n') + '\n</w:body>\n</w:document>\n');

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await fsp.writeFile(outFile, buf);
  report(96, '正在保存文件');
}

/* One open CJK TrueType face is all PDF needs. Droid Sans Fallback ships in
 * Debian (Apache-2.0) and covers GB2312; SimHei is the Windows stand-in so the
 * feature can be exercised locally without Docker. */
const FONT_CANDIDATES = [
  process.env.PDF_FONT || '',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/truetype/droid/DroidSansFallback.ttf',
  '/usr/share/fonts/truetype/arphic/uming.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/STHeiti Light.ttc'
];

function pdfFont() {
  for (const f of FONT_CANDIDATES) {
    if (!f) continue;
    // .ttc collections are not supported by the PDF font machinery here.
    if (/\.ttc$/i.test(f)) continue;
    if (fs.existsSync(f)) return f;
  }
  return '';
}

function writePdf(doc, outFile, report) {
  let PDFDocument;
  try { PDFDocument = require('pdfkit'); } catch (e) {
    const err = new Error('镜像里缺少 pdfkit，无法生成 PDF');
    err.code = 'NO_PDFKIT';
    throw err;
  }
  const font = pdfFont();
  if (!font) {
    const err = new Error('镜像里没有可用的中文字体，无法生成 PDF');
    err.code = 'NO_FONT';
    throw err;
  }

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A5',
      margins: { top: 46, bottom: 46, left: 44, right: 44 },
      bufferPages: true,
      info: { Title: doc.title, Author: doc.author || undefined, Creator: 'night-library' }
    });
    const stream = fs.createWriteStream(outFile);
    stream.on('error', reject);
    stream.on('finish', function () { report(97, '正在保存文件'); resolve(); });
    pdf.pipe(stream);
    pdf.registerFont('cn', font);
    pdf.font('cn');

    // Title page
    pdf.moveDown(6);
    pdf.fontSize(20).text(doc.title, { align: 'center', lineGap: 4 });
    if (doc.author) {
      pdf.moveDown(1);
      pdf.fontSize(11).fillColor('#555').text(doc.author, { align: 'center' });
      pdf.fillColor('#000');
    }
    pdf.moveDown(6);
    pdf.fontSize(9).fillColor('#888').text('由夜读转换', { align: 'center' });
    pdf.fillColor('#000');

    let pi = 0;
    for (const ch of doc.chapters) {
      report(70 + Math.round(24 * (++pi) / doc.chapters.length),
        '正在排版第 ' + pi + ' / ' + doc.chapters.length + ' 章');
      pdf.addPage();
      pdf.fontSize(15).text(ch.title || '', { align: 'center', lineGap: 6 });
      pdf.moveDown(1.2);
      pdf.fontSize(10.5);
      for (const p of ch.paragraphs) {
        pdf.text('　　' + p, { align: 'justify', lineGap: 6.5, paragraphGap: 5 });
      }
    }

    // Page numbers, bottom centre, after every page exists. Absolute
    // positioning (x,y given) keeps pdfkit from deciding it needs a new page.
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      const label = String(i + 1);
      pdf.fontSize(8).fillColor('#999');
      const w = pdf.widthOfString(label);
      pdf.text(label, (pdf.page.width - w) / 2, pdf.page.height - 32, { lineBreak: false });
    }
    pdf.end();
  });
}

const WRITERS = { txt: writeTxt, epub: writeEpub, docx: writeDocx, pdf: writePdf };

/* ------------------------------------------------------------------ *
 * entry point
 * ------------------------------------------------------------------ */

function outputName(book, target) {
  const base = (book.title || '未命名').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '未命名';
  const author = (book.author || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40);
  const stem = author ? base + ' - ' + author : base;
  return stem + '.' + target;
}

/* Converting a 600-page PDF takes a few seconds; a double click used to start
 * two writers on the same output path. */
const inFlight = new Map();

async function transform(book, cfg, target, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  report(2, '正在准备转换');
  const fmt = String(target || '').toLowerCase();
  if (ALL_TARGETS.indexOf(fmt) < 0) return { ok: false, error: '不认识的目标格式：' + fmt, status: 400 };
  if (!isWritable(fmt)) {
    return { ok: false, error: '转为 ' + fmt.toUpperCase() + ' 需要 Calibre，本镜像为控制体积没有内置。EPUB / TXT / DOCX / PDF 四种可以直接转。', status: 501 };
  }
  if (String(book.format || '').toLowerCase() === fmt) {
    return { ok: false, error: '这本已经是 ' + fmt.toUpperCase() + ' 格式了', status: 400 };
  }

  const dir = path.join(cfg.dataDir, 'transformed');
  const src = path.resolve(book.folder || cfg.booksDir, book.path);
  const outFile = path.join(dir, book.id + '.' + fmt);

  // Cache keyed on the source mtime, same rule the reader-side converter uses.
  try {
    const [s, o] = await Promise.all([fsp.stat(src), fsp.stat(outFile)]);
    if (o.size > 0 && o.mtimeMs >= s.mtimeMs) {
      report(100, '已完成（使用缓存）');
      return { ok: true, file: outFile, name: outputName(book, fmt), cached: true };
    }
  } catch (e) { /* not cached */ }

  if (inFlight.has(outFile)) return inFlight.get(outFile);

  const job = (async () => {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      return { ok: false, error: '无法创建转换目录：' + e.message, status: 500 };
    }
    const tmp = outFile + '.' + process.pid + '.part';
    try {
      const doc = await parseBook(book, cfg, report);
      await WRITERS[fmt](doc, tmp, report);
      const st = await fsp.stat(tmp);
      if (!st.size) {
        await fsp.unlink(tmp).catch(() => {});
        return { ok: false, error: '转换结果是空文件，源文件可能已损坏或加密', status: 422 };
      }
      await fsp.rename(tmp, outFile);
      report(100, '转换完成');
      return { ok: true, file: outFile, name: outputName(book, fmt), cached: false };
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      return {
        ok: false,
        error: e.code === 'NO_TEXT' ? e.message : '转换失败：' + String(e.message || e).slice(0, 200),
        status: 422
      };
    }
  })().finally(() => inFlight.delete(outFile));

  inFlight.set(outFile, job);
  return job;
}

function available() {
  return {
    epub: true,
    txt: true,
    docx: true,
    pdf: (() => { try { require.resolve('pdfkit'); return Boolean(pdfFont()); } catch (e) { return false; } })()
  };
}

module.exports = { transform, targetsFor, available, ALL_TARGETS, WRITABLE, outputName };
