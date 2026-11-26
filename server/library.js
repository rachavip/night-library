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

const SUPPORTED = new Set(['pdf', 'epub', 'mobi', 'azw3', 'txt']);

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

function looksLikeAuthor(s) {
  if (!s) return false;
  if (/[\u4e00-\u9fa5]/.test(s)) return s.replace(/\s/g, '').length <= 12;
  return s.split(/\s+/).length <= 3 && s.length <= 40;
}

function guessFromFilename(base) {
  const s = base.trim();
  let m = s.match(/^[\[【(（]\s*([^\]】)）]+)\s*[\]】)）]\s*[-—–\s]*\s*(.+)$/);
  if (m) return { author: m[1].trim(), title: m[2].trim() };
  m = s.match(/^(.+?)《([^》]+)》/);
  if (m) return { author: m[1].trim(), title: m[2].trim() };
  const parts = s.split(/\s+[-—–]\s+|\s*[-—–]\s*/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0];
    const b = parts.slice(1).join(' - ');
    const aAuthor = looksLikeAuthor(a);
    const bAuthor = looksLikeAuthor(b);
    if (aAuthor && !bAuthor) return { author: a, title: b };
    if (bAuthor && !aAuthor) return { author: b, title: a };
    if (aAuthor && bAuthor) {
      // Both sides are short Chinese strings: Chinese editions usually put
      // the author first. When the right side ends in 著/译/编, it is the author.
      if (/(著|译|编|作)$/.test(b)) return { author: b, title: a };
      return { author: a, title: b };
    }
  }
  return { author: '', title: s };
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

function scrapePdf(file) {
  return fsp.readFile(file).then(buf => {
    const s = buf.toString('latin1');
    const get = key => {
      let m = s.match(new RegExp('/' + key + '\\s*\\((([^()\\\\]|\\\\.){0,300})\\)'));
      if (m) return clean(m[1].replace(/\\([()\\])/g, '$1'));
      m = s.match(new RegExp('/' + key + '\\s*<([0-9A-Fa-f]{4,600})>'));
      if (m) {
        const hex = m[1];
        try {
          const bytes = Buffer.from(hex, 'hex');
          if (hex.toUpperCase().startsWith('FEFF')) return clean(bytes.toString('utf16be').replace(/^\uFEFF/, ''));
          return clean(bytes.toString('utf8'));
        } catch (e) { /* ignore */ }
      }
      return '';
    };
    return { title: get('Title'), author: get('Author') };
  }).catch(() => ({}));
}

/* Detect a real image from its magic bytes - ebook-meta writes the source
 * format regardless of the filename extension we give it. */
function imageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return '';
}

/* One ebook-meta call reads metadata AND exports the cover, so adding covers
 * does not double the number of processes spawned per book. */
function scrapeWithCalibre(file, coverDir, id) {
  return new Promise(resolve => {
    if (!coverDir || (process.platform === 'win32' && !process.env.CALIBRE_PATH)) {
      return resolve({ coverFile: '' });
    }
    const tmp = path.join(coverDir, id + '.calibre.jpg');
    execFile('ebook-meta', [file, '--get-cover=' + tmp], { timeout: 20000, maxBuffer: 1024 * 1024 }, async (err, stdout) => {
      const meta = { coverFile: '' };
      if (stdout) {
        const get = label => {
          const m = stdout.match(new RegExp('^' + label + '\\s*:\\s*(.+)$', 'im'));
          return m ? clean(m[1]) : '';
        };
        meta.title = get('Title');
        meta.author = get('Author(s)') || get('Author');
        meta.language = get('Language');
      }
      // ebook-meta can exit non-zero yet still have written the cover, so
      // check the file regardless of err.
      try {
        const buf = await fsp.readFile(tmp);
        const ext = imageExt(buf);
        if (ext) {
          const out = path.join(coverDir, id + '.' + ext);
          await fsp.writeFile(out, buf);
          meta.coverFile = path.basename(out);
        }
      } catch (e) { /* this book has no embedded cover */ }
      try { await fsp.unlink(tmp); } catch (e) { /* ignore */ }
      resolve(meta);
    });
  });
}

/* TXT files carry no cover of their own, but many NAS libraries keep a
 * matching image next to the book. Pick it up so those shelves are not blank. */
async function siblingCover(file, coverDir, id) {
  if (!coverDir) return '';
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const candidates = [
    base + '.jpg', base + '.jpeg', base + '.png', base + '.webp',
    path.join(base, 'cover.jpg'), path.join(base, 'cover.png')
  ];
  for (const name of candidates) {
    try {
      const src = path.join(dir, name);
      const stat = await fsp.stat(src);
      if (!stat.isFile() || stat.size < 128) continue;
      const ext = path.extname(src).slice(1).toLowerCase();
      const buf = await fsp.readFile(src);
      const good = imageExt(buf) || (ext === 'jpeg' ? 'jpg' : ext);
      if (!['jpg', 'png', 'webp', 'gif'].includes(good)) continue;
      const out = path.join(coverDir, id + '.' + good);
      await fsp.writeFile(out, buf);
      return path.basename(out);
    } catch (e) { /* try the next candidate */ }
  }
  return '';
}

function scrapeTxt(file) {
  return fsp.readFile(file).then(buf => {
    let text;
    if (iconv.encodingExists('utf8') && isValidUtf8(buf)) text = buf.toString('utf8');
    else text = iconv.decode(buf, 'gb18030');
    const firstLine = text.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
    return { title: firstLine.length <= 60 ? firstLine : '' };
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

async function buildBook(entry, cfg, folder) {
  const { full, rel } = entry;
  // Include the folder in the hash so the same filename in two folders
  // stays two distinct books.
  const id = hashId(folder + '|' + rel);
  const ext = path.extname(rel).slice(1).toLowerCase();
  const base = path.basename(rel, path.extname(rel));
  const guessed = guessFromFilename(base);
  let scraped = {};
  try {
    if (ext === 'epub') {
      scraped = await scrapeEpub(full, cfg.coverDir, id);
      // EPUB without a declared cover: let Calibre render one from page 1.
      if (!scraped.coverFile) {
        const cal = await scrapeWithCalibre(full, cfg.coverDir, id);
        if (cal.coverFile) scraped.coverFile = cal.coverFile;
        if (!scraped.title && cal.title) scraped.title = cal.title;
        if (!scraped.author && cal.author) scraped.author = cal.author;
      }
    } else if (ext === 'pdf') {
      scraped = await scrapePdf(full);
      const cal = await scrapeWithCalibre(full, cfg.coverDir, id);
      if (cal.coverFile) scraped.coverFile = cal.coverFile;
      if (!scraped.title && cal.title) scraped.title = cal.title;
      if (!scraped.author && cal.author) scraped.author = cal.author;
    } else if (ext === 'mobi' || ext === 'azw3') {
      scraped = await scrapeWithCalibre(full, cfg.coverDir, id);
    } else if (ext === 'txt') {
      scraped = await scrapeTxt(full);
      scraped.coverFile = await siblingCover(full, cfg.coverDir, id);
    }
  } catch (e) {
    scraped = {};
  }
  let stat;
  try { stat = await fsp.stat(full); } catch (e) { stat = null; }
  return {
    id,
    title: clean(scraped.title) || guessed.title,
    author: clean(scraped.author) || guessed.author,
    language: clean(scraped.language || ''),
    description: clean(scraped.description || ''),
    format: ext,
    path: rel,
    folder: folder,
    size: stat ? stat.size : 0,
    addedAt: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    coverFile: scraped.coverFile || ''
  };
}

async function scan(cfg, folders) {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await fsp.mkdir(cfg.coverDir, { recursive: true });
  await fsp.mkdir(cfg.convertDir, { recursive: true });

  const targets = (folders && folders.length) ? folders : [cfg.booksDir];
  const seen = new Set();
  const books = [];
  const folderStats = [];

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
    const found = await mapLimit(files, 4, entry => buildBook(entry, cfg, folder));
    for (const book of found) {
      if (seen.has(book.id)) continue;
      seen.add(book.id);
      books.push(book);
    }
  }

  const index = {
    scannedAt: new Date().toISOString(),
    count: books.length,
    folders: folderStats,
    books
  };
  await fsp.writeFile(path.join(cfg.dataDir, 'library.json'), JSON.stringify(index, null, 2), 'utf8');
  return index;
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

function sortBooks(books, sort, order) {
  const key = sort || 'added';
  const dir = order === 'asc' ? 1 : -1;
  const get = b => {
    if (key === 'title') return b.title || '';
    if (key === 'author') return b.author || '';
    if (key === 'format') return b.format || '';
    if (key === 'size') return b.size || 0;
    return b.addedAt || '';
  };
  return [...books].sort((a, b) => {
    const av = get(a), bv = get(b);
    let cmp;
    if (typeof av === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv), 'zh-CN', { numeric: true, sensitivity: 'base' });
    return cmp * dir;
  });
}

module.exports = {
  SUPPORTED,
  scan,
  loadIndex,
  loadProgress,
  saveProgress,
  sortBooks,
  hashId,
  isValidUtf8
};
