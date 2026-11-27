const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const iconv = require('iconv-lite');
const library = require('./library');
const reading = require('./reading');
const collections = require('./collections');
const notes = require('./notes');
const converter = require('./convert');
const settingsStore = require('./settings');
const music = require('./music');
const versionStore = require('./version');

const ROOT = path.resolve(__dirname, '..');
const cfg = {
  booksDir: path.resolve(process.env.BOOKS_DIR || path.join(ROOT, 'demo-books')),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  coverDir: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'covers'),
  convertDir: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'converted')
};
cfg.coverDir = path.join(cfg.dataDir, 'covers');
cfg.convertDir = path.join(cfg.dataDir, 'converted');
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapTitle(title, perLine) {
  const t = String(title || '').trim();
  const hasCjk = /[\u4e00-\u9fa5]/.test(t);
  const lines = [];
  if (hasCjk) {
    for (let i = 0; i < t.length; i += perLine) lines.push(t.slice(i, i + perLine));
  } else {
    const words = t.split(/\s+/);
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > perLine * 2 && cur) { lines.push(cur); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
  }
  const capped = lines.slice(0, 5);
  if (lines.length > 5) capped[4] = capped[4].slice(0, Math.max(0, perLine - 1)) + '…';
  return capped;
}

function generatedCover(book) {
  const lines = wrapTitle(book.title || '未命名', 6);
  const fontSize = lines.length > 4 ? 30 : 36;
  const startY = 250 - (lines.length - 1) * (fontSize + 14) / 2;
  const text = lines.map((l, i) =>
    `<text x="44" y="${startY + i * (fontSize + 14)}" fill="#EDE6D8" font-size="${fontSize}" font-family="Noto Serif SC, Songti SC, SimSun, serif" letter-spacing="2">${esc(l)}</text>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#16283A"/><stop offset="1" stop-color="#0B121C"/>
  </linearGradient></defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <rect x="0" y="0" width="6" height="600" fill="#E9A23B" opacity="0.85"/>
  <line x1="44" y1="130" x2="356" y2="130" stroke="#2A3A4C" stroke-width="1"/>
  ${text}
  <line x1="44" y1="410" x2="356" y2="410" stroke="#2A3A4C" stroke-width="1"/>
  <text x="44" y="452" fill="#93A0B0" font-size="17" font-family="Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif">${esc(book.author || '佚名')}</text>
  <text x="44" y="552" fill="#E9A23B" font-size="14" letter-spacing="3" font-family="ui-monospace, Consolas, monospace">${esc((book.format || '').toUpperCase())}</text>
</svg>`;
}

function findBook(id) {
  const books = currentIndex.books || [];
  return books.find(b => b.id === id) || null;
}

// bookId -> [shelfId]. Built once per request so a shelf listing does not walk
// every shelf for every book (816 books x 60 shelves would be 49k scans).
function shelfIndex() {
  const map = new Map();
  shelvesState.collections.forEach(shelf => {
    shelf.bookIds.forEach(id => {
      const list = map.get(id);
      if (list) list.push(shelf.id);
      else map.set(id, [shelf.id]);
    });
  });
  return map;
}

function bookStatus(book) {
  return reading.statusOf(book, progress);
}

// Fields the shelf and the detail sheet need, kept in one place so /api/books
// and /api/book/:id never drift apart.
function decorate(book, index) {
  const counts = notes.countFor(notesState, book.id);
  return {
    ...book,
    status: bookStatus(book),
    progress: progress[book.id] || null,
    noteCount: counts,
    collections: (index && index.get(book.id)) || []
  };
}

// A renamed file gets a new id, so shelf entries can point at books that no
// longer exist. Pruning after every scan keeps the counts honest.
function syncShelves() {
  const valid = new Set(currentIndex.books.map(b => b.id));
  const removed = collections.prune(shelvesState, valid);
  if (removed) console.log(`[shelves] dropped ${removed} stale book id(s)`);
  return removed;
}

// Resolve a book's real file. Each book remembers the folder it came from,
// so adding folders in the UI just works without touching compose again.
function bookFile(book) {
  const folder = book.folder || cfg.booksDir;
  const target = path.resolve(folder, book.path);
  const base = path.resolve(folder);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function serveFile(req, res, file, contentType, extraHeaders) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).end('Not found');
    res.setHeader('Accept-Ranges', 'bytes');
    Object.entries(extraHeaders || {}).forEach(([k, v]) => res.setHeader(k, v));
    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(file).pipe(res);
    }
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (Number.isNaN(start)) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end) { res.status(416).setHeader('Content-Range', 'bytes */' + stat.size).end(); return; }
    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

const MIME = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-amazon-azw3',
  txt: 'text/plain; charset=utf-8'
};

let currentIndex = { scannedAt: null, count: 0, books: [] };
let progress = {};
// Reading time per day, hand-built shelves, and highlights/bookmarks.
let readingState = reading.emptyState();
let shelvesState = collections.emptyState();
let notesState = notes.emptyState();
let scanning = false;
// Books being re-scraped on their own. A single-book repair writes the index,
// so it must not overlap with a full scan; the set doubles as the lock.
const bookJobs = new Set();
let lastScanError = '';
let scanIntervalMinutes = 0;
let scanOnStart = true;
let nextScanAt = null;
let scanTimer = null;
let settings = settingsStore.clone ? settingsStore.clone(settingsStore.DEFAULTS) : settingsStore.DEFAULTS;

/* ---------- version ---------- */
// Version is baked into the image via version.json; the header reads this.
app.get('/api/version', (req, res) => {
  res.json(versionStore.local());
});
// Compares the running version against version.json on GitHub. Never fails
// the request - network problems are surfaced as a normal result body.
app.get('/api/version/check', async (req, res) => {
  res.json(await versionStore.checkRemote());
});

/* ---------- settings ---------- */
app.get('/api/settings', (req, res) => {
  res.json(settingsStore.forBrowser(settings));
});

app.put('/api/settings', async (req, res) => {
  // Env vars (from docker-compose.yml) always win over form values.
  settings = settingsStore.applyEnv(settingsStore.merge(settings, req.body), process.env);
  try {
    await settingsStore.save(cfg, settings);
    // A changed interval takes effect right away - no container restart.
    applyScanSettings();
    res.json(settingsStore.forBrowser(settings));
  } catch (e) {
    res.status(500).json({ error: '保存设置失败：' + e.message });
  }
});

/* ---------- background image ---------- */
// Accepts a data URL (image/*) or a plain filename that lives in the books dir.
app.put('/api/settings/background', async (req, res) => {
  const body = req.body || {};
  let data = String(body.data || '').trim();
  const bgDir = path.join(cfg.dataDir, 'backgrounds');

  if (data.startsWith('data:')) {
    const match = data.match(/^data:image\/(png|jpe?g|webp|gif);base64,([\s\S]+)$/i);
    if (!match) return res.status(400).json({ error: '只支持 PNG / JPG / WEBP / GIF 图片' });
    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    let bytes;
    try { bytes = Buffer.from(match[2], 'base64'); }
    catch (e) { return res.status(400).json({ error: '图片数据无法解析' }); }
    if (bytes.length > 15 * 1024 * 1024) return res.status(413).json({ error: '图片不能超过 15MB' });
    await fsp.mkdir(bgDir, { recursive: true });
    const name = 'bg-' + Date.now() + '.' + ext;
    await fsp.writeFile(path.join(bgDir, name), bytes);
    // Remove the previous uploaded image so data/ does not grow forever.
    const old = settings.background.data;
    if (old && old.startsWith('uploaded:')) {
      try { await fsp.unlink(path.join(bgDir, old.slice(9))); } catch (e) { /* ignore */ }
    }
    data = 'uploaded:' + name;
  } else if (data) {
    data = data.replace(/^\/+/, '').slice(0, 500);
    if (data.includes('..')) return res.status(400).json({ error: '图片路径不能包含 ..' });
  }

  settings.background.data = data;
  settings.background.enabled = Boolean(data) && body.enabled !== false;
  try {
    await settingsStore.save(cfg, settings);
    res.json({ ok: true, version: Date.now() });
  } catch (e) {
    res.status(500).json({ error: '保存背景图失败：' + e.message });
  }
});

app.get('/api/background', (req, res) => {
  const data = settings.background.data;
  if (!settings.background.enabled || !data) return res.status(404).end();
  let file;
  if (data.startsWith('uploaded:')) {
    file = path.join(cfg.dataDir, 'backgrounds', data.slice(9));
  } else {
    file = path.join(cfg.booksDir, data);
    const rel = path.relative(cfg.booksDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return res.status(403).end();
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  serveFile(req, res, file, type, { 'Cache-Control': 'public, max-age=3600' });
});

/* ---------- music proxy (Subsonic compatible) ---------- */
function currentMusic() {
  return settings.music && settings.music.url ? settings.music : null;
}

app.get('/api/music/status', async (req, res) => {
  const cfgMusic = currentMusic();
  if (!cfgMusic) return res.json({ configured: false, ok: false });
  try {
    const embed = settings.music.mode === 'embed';
    const result = embed ? await music.probe(cfgMusic.url) : await music.ping(cfgMusic);
    res.json({ configured: true, ok: true, mode: settings.music.mode, ...result });
  } catch (e) {
    res.json({ configured: true, ok: false, mode: settings.music.mode, error: e.message });
  }
});

// Switch the active web player without going through the whole settings form.
app.post('/api/music/active', async (req, res) => {
  const id = String((req.body || {}).id || '').trim();
  const next = settingsStore.clone(settings);
  const service = next.music.services.find(s => s.id === id);
  if (!service) return res.status(400).json({ error: '找不到这个音乐服务，请先在设置里填写地址' });
  if (!service.url) return res.status(400).json({ error: '这个服务还没有填写地址' });
  next.music.activeId = id;
  next.music.url = service.url;
  next.music.mode = 'embed';
  settings = settingsStore.applyEnv(next, process.env);
  try {
    await settingsStore.save(cfg, settings);
    res.json({
      ok: true,
      activeId: settings.music.activeId,
      url: settings.music.url,
      urlFromEnv: Boolean(settings.music.urlFromEnv),
      name: service.name
    });
  } catch (e) {
    res.status(500).json({ error: '切换失败：' + e.message });
  }
});

// Test connection with values from the settings drawer before saving.
app.post('/api/music/test', async (req, res) => {
  const body = req.body || {};
  const mode = body.mode === 'subsonic' ? 'subsonic' : 'embed';
  const candidate = {
    url: String(body.url || '').trim(),
    user: String(body.user || ''),
    password: String(body.password || '')
  };
  if (candidate.password === '********') candidate.password = settings.music.password;
  try {
    const result = mode === 'embed' ? await music.probe(candidate.url) : await music.ping(candidate);
    res.json({ ok: true, mode, ...result });
  } catch (e) {
    res.json({ ok: false, mode, error: e.message });
  }
});

app.get('/api/music/random', async (req, res) => {
  const cfgMusic = currentMusic();
  if (!cfgMusic) return res.status(400).json({ error: '还没有配置音乐服务地址' });
  try {
    const songs = await music.randomSongs(cfgMusic, Number(req.query.size) || 50);
    res.json({ count: songs.length, songs });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

async function pipeUpstream(req, res, url, fallbackType) {
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: '音乐服务返回 HTTP ' + upstream.status });
    }
    const type = upstream.headers.get('content-type') || fallbackType;
    res.status(upstream.status);
    res.setHeader('Content-Type', type);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const range = upstream.headers.get('content-range');
    if (range) res.setHeader('Content-Range', range);
    res.setHeader('Accept-Ranges', 'bytes');
    const arrayBuffer = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (e) {
    res.status(502).json({ error: '音乐流读取失败：' + e.message });
  }
}

app.get('/api/music/stream/:id', (req, res) => {
  const cfgMusic = currentMusic();
  if (!cfgMusic) return res.status(400).json({ error: '还没有配置音乐服务地址' });
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return res.status(400).end();
  pipeUpstream(req, res, music.streamUrl(cfgMusic, id), 'audio/mpeg');
});

app.get('/api/music/cover/:id', (req, res) => {
  const cfgMusic = currentMusic();
  if (!cfgMusic) return res.status(404).end();
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return res.status(404).end();
  pipeUpstream(req, res, music.coverUrl(cfgMusic, id, Number(req.query.size) || 120), 'image/jpeg');
});

app.get('/api/stats', (req, res) => {
  const formats = {};
  currentIndex.books.forEach(b => { formats[b.format] = (formats[b.format] || 0) + 1; });
  res.json({
    count: currentIndex.books.length,
    scannedAt: currentIndex.scannedAt,
    lastScan: currentIndex.stats || null,
    formats,
    converter: converter.isAvailable(),
    booksDir: cfg.booksDir,
    folders: currentIndex.folders || [],
    scanning: scanning,
    scanOnStart: scanOnStart,
    autoScanMinutes: scanIntervalMinutes,
    nextScanAt: nextScanAt,
    lastScanError: lastScanError,
    scanLimits: { min: 1, max: 10080 }
  });
});

app.get('/api/books', (req, res) => {
  const { sort = 'title', order = 'asc', q = '', format = '', status = '', collection = '', limit = '' } = req.query;
  let books = currentIndex.books;
  if (format) books = books.filter(b => b.format === format);
  if (collection) {
    const shelf = shelvesState.collections.find(c => c.id === collection);
    if (!shelf) return res.status(404).json({ error: '没有找到这个书单' });
    const ids = new Set(shelf.bookIds);
    books = books.filter(b => ids.has(b.id));
  }
  if (status) books = books.filter(b => bookStatus(b) === status);
  if (q) {
    const needle = String(q).toLowerCase();
    books = books.filter(b =>
      [b.title, b.author, b.path].some(v => String(v || '').toLowerCase().includes(needle))
    );
  }
  // "recent" sorts by when it was last opened, which lives in progress rather
  // than in the book record, so it cannot be handled by library.sortBooks.
  if (sort === 'recent') {
    books = books.slice().sort((a, b) => {
      const ta = (progress[a.id] || {}).updatedAt || '';
      const tb = (progress[b.id] || {}).updatedAt || '';
      return tb.localeCompare(ta);
    });
  } else {
    books = library.sortBooks(books, sort, order);
  }
  const cap = Number(limit);
  if (Number.isFinite(cap) && cap > 0) books = books.slice(0, cap);
  const index = shelfIndex();
  res.json({ count: books.length, books: books.map(b => decorate(b, index)) });
});

app.get('/api/book/:id', (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  res.json(decorate(book, shelfIndex()));
});

// Force one book through a complete re-scrape. This is the escape hatch for a
// record that came out garbled or coverless: it ignores the incremental cache
// entirely, deletes the cached cover and reads the file from disk again.
app.post('/api/book/:id/rescan', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  if (scanning) return res.status(409).json({ error: '书库正在整理，等它跑完再试' });
  if (bookJobs.has(book.id)) return res.status(409).json({ error: '这本书正在刮削' });
  bookJobs.add(book.id);
  const started = Date.now();
  try {
    const folder = book.folder || cfg.booksDir;
    const result = await library.rescrape(cfg, folder, book.path);
    const at = currentIndex.books.findIndex(b => b.id === book.id);
    if (at >= 0) currentIndex.books[at] = result.book;
    currentIndex.scannedAt = new Date().toISOString();
    await library.saveIndex(cfg, currentIndex);

    const before = result.previous;
    const ms = Date.now() - started;
    console.log(`[rescan/book] ${book.path} · ${ms}ms · ${before ? before.title : '(无旧记录)'} → ${result.book.title}`);
    res.json({
      ok: true,
      book: result.book,
      durationMs: ms,
      before: before ? { title: before.title, author: before.author, coverFile: before.coverFile } : null,
      changed: {
        title: !before || (before.title || '') !== (result.book.title || ''),
        author: !before || (before.author || '') !== (result.book.author || ''),
        cover: !before || (before.coverFile || '') !== (result.book.coverFile || '')
      }
    });
  } catch (e) {
    const msg = String(e.message || e);
    console.warn(`[rescan/book] failed: ${msg}`);
    res.status(e.code === 'EBOOKMISSING' ? 404 : 500).json({ error: msg });
  } finally {
    bookJobs.delete(book.id);
  }
});

app.get('/api/book/:id/cover', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).end();
  if (book.coverFile) {
    const f = path.join(cfg.coverDir, book.coverFile);
    if (fs.existsSync(f)) {
      const ext = path.extname(f).slice(1).toLowerCase();
      return serveFile(req, res, f, ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    }
  }
  // A generated card is a stand-in, not a real cover: keep it on a short lease
  // so a later scrape can replace it without the user clearing the cache.
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(generatedCover(book));
});

app.get('/api/book/:id/text', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).end();
  if (book.format !== 'txt') return res.status(400).end();
  const file = bookFile(book);
  if (!file) return res.status(400).end();
  try {
    const buf = await fsp.readFile(file);
    const text = library.isValidUtf8(buf) ? buf.toString('utf8') : iconv.decode(buf, 'gb18030');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(text);
  } catch (e) {
    res.status(404).end();
  }
});

// MOBI / AZW3 have to be turned into EPUB before the browser can page through
// them, and unpacking a 100MB book takes a few seconds. The reader asks here
// first so a failure can be reported as a sentence instead of an opaque
// "cannot load book" in the epub.js layer.
app.get('/api/book/:id/prepare', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  if (book.format !== 'mobi' && book.format !== 'azw3') {
    return res.json({ ok: true, format: book.format, cached: true });
  }
  const result = await converter.ensureEpub(book, cfg);
  if (!result.ok) return res.status(422).json({ error: result.error });
  res.json({ ok: true, format: 'epub', cached: Boolean(result.cached) });
});

async function serveRead(req, res) {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  if (book.format === 'txt') {
    res.redirect('/api/book/' + book.id + '/text');
    return;
  }
  if (book.format === 'mobi' || book.format === 'azw3') {
    const result = await converter.ensureEpub(book, cfg);
    if (!result.ok) return res.status(422).json({ error: result.error });
    return serveFile(req, res, result.file, MIME.epub, { 'X-Read-Format': 'epub' });
  }
  const file = bookFile(book);
  if (!file) return res.status(400).end();
  serveFile(req, res, file, MIME[book.format] || 'application/octet-stream', {
    'X-Read-Format': book.format
  });
}

app.get('/api/book/:id/read', serveRead);
// Same body, but with an .epub suffix. epub.js chooses how to open a book from
// the URL extension alone: given /read it fell back to "unpacked directory" and
// fetched META-INF/container.xml over HTTP, which 404s and kills every EPUB.
app.get('/api/book/:id/read.epub', serveRead);

app.get('/api/book/:id/file', (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).end();
  const file = bookFile(book);
  if (!file) return res.status(400).end();
  serveFile(req, res, file, MIME[book.format] || 'application/octet-stream');
});

app.get('/api/book/:id/progress', (req, res) => {
  res.json(progress[req.params.id] || null);
});

/* ---------- reading ledger ---------- */
// One writer for progress so status rules live in one place:
//   percent >= 98%          -> 读完
//   manually marked 读完     -> stays 读完 even when flipping back
//   anything else that moved -> 在读
function writeProgress(book, body) {
  const prev = progress[book.id] || {};
  const now = new Date().toISOString();
  const percent = Math.max(0, Math.min(1, Number(body.percent) || 0));
  const location = String(body.location || '').slice(0, 500);
  let manual = prev.manual || '';
  if (manual === 'unread' && (percent > 0 || location)) manual = '';

  let status = 'reading';
  if (percent >= 0.98) status = 'finished';
  else if (manual === 'finished') status = 'finished';
  else if (manual === 'unread' && percent <= 0 && !location) status = 'unread';

  const rec = {
    percent,
    location,
    status,
    manual,
    updatedAt: now,
    openedAt: prev.openedAt || now
  };
  if (status === 'finished') rec.finishedAt = prev.finishedAt || now;
  progress[book.id] = rec;
  return rec;
}

app.post('/api/book/:id/progress', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const rec = writeProgress(book, req.body || {});
  try { await library.saveProgress(cfg, progress); } catch (e) { /* best effort */ }
  res.json(rec);
});

// Manual override from the detail sheet: 未读 / 在读 / 读完.
app.post('/api/book/:id/status', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const want = String((req.body || {}).status || '');
  if (!['unread', 'reading', 'finished'].includes(want)) {
    return res.status(400).json({ error: '状态只能是未读、在读或读完' });
  }
  const prev = progress[book.id] || {};
  const now = new Date().toISOString();
  if (want === 'unread') {
    // Clearing the position is what "unread" means; the cover keeps its place
    // on the shelf, the book just starts from the first page next time.
    progress[book.id] = {
      percent: 0, location: '', status: 'unread', manual: 'unread',
      updatedAt: now, openedAt: prev.openedAt || null
    };
  } else if (want === 'finished') {
    progress[book.id] = {
      ...prev,
      percent: 1,
      status: 'finished',
      manual: 'finished',
      finishedAt: prev.finishedAt || now,
      updatedAt: now,
      openedAt: prev.openedAt || now
    };
  } else {
    progress[book.id] = {
      ...prev,
      status: 'reading',
      manual: 'reading',
      updatedAt: now,
      openedAt: prev.openedAt || now
    };
    delete progress[book.id].finishedAt;
  }
  try { await library.saveProgress(cfg, progress); } catch (e) { /* best effort */ }
  res.json({ ok: true, book: decorate(book, shelfIndex()) });
});

// The reader sends a heartbeat every minute or so. Date is always the server's
// today: a client with a wrong clock must not be able to backfill history.
app.post('/api/reading/ping', async (req, res) => {
  const body = req.body || {};
  const book = findBook(String(body.bookId || ''));
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const seconds = Number(body.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return res.json({ ok: true, ignored: true });
  reading.addTime(readingState, book.id, seconds);
  try { await reading.save(cfg, readingState); } catch (e) { /* best effort */ }
  const today = readingState.days[reading.dayKey(new Date())] || { seconds: 0 };
  res.json({ ok: true, today: today.seconds });
});

app.get('/api/reading/summary', (req, res) => {
  res.json(reading.summary(readingState, { books: currentIndex.books, progress }));
});

/* ---------- hand-built shelves ---------- */
app.get('/api/collections', (req, res) => {
  res.json({
    collections: shelvesState.collections.map(c => ({
      id: c.id,
      name: c.name,
      count: c.bookIds.length,
      bookIds: c.bookIds,
      createdAt: c.createdAt
    }))
  });
});

app.post('/api/collections', async (req, res) => {
  try {
    const item = collections.create(shelvesState, (req.body || {}).name);
    await collections.save(cfg, shelvesState);
    res.json({ ok: true, collection: { ...item, count: 0 } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/collections/:id', async (req, res) => {
  const body = req.body || {};
  const item = shelvesState.collections.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: '没有找到这个书单' });
  try {
    if (body.name !== undefined) collections.rename(shelvesState, item.id, body.name);
    // Adding/removing books and renaming in one call keeps the panel's save
    // button to a single request.
    if (body.add || body.remove) collections.members(shelvesState, item.id, body);
    await collections.save(cfg, shelvesState);
    const fresh = shelvesState.collections.find(c => c.id === item.id);
    res.json({ ok: true, collection: { ...fresh, count: fresh.bookIds.length } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/collections/:id', async (req, res) => {
  if (!collections.remove(shelvesState, req.params.id)) {
    return res.status(404).json({ error: '没有找到这个书单' });
  }
  await collections.save(cfg, shelvesState);
  res.json({ ok: true });
});

/* ---------- highlights, notes, bookmarks ---------- */
app.get('/api/book/:id/notes', (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  res.json(notes.forBook(notesState, book.id));
});

app.post('/api/book/:id/notes', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const body = req.body || {};
  const kind = body.kind === 'bookmark' ? 'bookmark' : 'highlight';
  try {
    const item = notes.add(notesState, book.id, kind, body);
    await notes.save(cfg, notesState);
    res.json({ ok: true, kind, item, count: notes.countFor(notesState, book.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/book/:id/notes/:noteId', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const item = notes.update(notesState, book.id, req.params.noteId, req.body || {});
  if (!item) return res.status(404).json({ error: '没有找到这条笔记' });
  await notes.save(cfg, notesState);
  res.json({ ok: true, item });
});

app.delete('/api/book/:id/notes/:noteId', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  if (!notes.remove(notesState, book.id, req.params.noteId)) {
    return res.status(404).json({ error: '没有找到这条笔记' });
  }
  await notes.save(cfg, notesState);
  res.json({ ok: true, count: notes.countFor(notesState, book.id) });
});

// Markdown keeps the quotes and notes readable in any editor, and is what
// Obsidian / 备忘录 import without asking questions.
app.get('/api/book/:id/notes/export', (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).end();
  const record = notes.forBook(notesState, book.id);
  if (!record.highlights.length && !record.bookmarks.length) {
    return res.status(404).json({ error: '这本书还没有笔记' });
  }
  const body = notes.toMarkdown(book, record);
  const name = (book.title || '未命名').replace(/[\\/:*?"<>|]/g, '_') + '-笔记.md';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name));
  res.end(body);
});

// Check a NAS folder before the user adds it in settings.
app.post('/api/folders/check', async (req, res) => {
  const raw = String((req.body && req.body.path) || '').trim();
  const folder = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = folder.startsWith('/') || /^[A-Za-z]:\//.test(folder);
  if (!absolute || folder.includes('..')) {
    return res.json({ ok: false, error: '请填写以 / 开头的绝对路径（飞牛上是 /vol1/…）' });
  }
  try {
    const stat = await fsp.stat(folder);
    if (!stat.isDirectory()) return res.json({ ok: false, error: '这不是一个文件夹' });
    res.json({ ok: true, path: folder });
  } catch (e) {
    res.json({ ok: false, error: '容器内访问不到：' + e.message });
  }
});

// One scan path for manual, startup and scheduled runs. The lock keeps the
// three from stacking up when a book-heavy NAS is still scanning.
async function runScan(reason) {
  if (scanning) return { ok: false, skipped: true, error: '正在刮削中，请稍候' };
  if (bookJobs.size) return { ok: false, skipped: true, error: '正在单独刮削某本书，请稍候' };
  scanning = true;
  const started = Date.now();
  try {
    const folders = settings.folders && settings.folders.length ? settings.folders : [cfg.booksDir];
    currentIndex = await library.scan(cfg, folders);
    lastScanError = '';
    // A renamed or deleted file leaves stale ids behind in the shelves.
    if (syncShelves()) await collections.save(cfg, shelvesState);
    const st = currentIndex.stats || {};
    console.log(`[scan/${reason}] ${currentIndex.count} 册 · 复用 ${st.reused || 0} · 新刮 ${st.scraped || 0} · ${Date.now() - started}ms`);
    return {
      ok: true,
      count: currentIndex.count,
      scannedAt: currentIndex.scannedAt,
      folders: currentIndex.folders,
      stats: st
    };
  } catch (e) {
    lastScanError = String(e.message || e);
    console.warn(`[scan/${reason}] failed: ${lastScanError}`);
    return { ok: false, error: lastScanError };
  } finally {
    scanning = false;
  }
}

app.post('/api/rescan', async (req, res) => {
  const result = await runScan('manual');
  if (result.skipped) return res.status(409).json({ error: result.error });
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json({ ok: true, count: result.count, scannedAt: result.scannedAt, folders: result.folders, stats: result.stats });
});

app.use(express.static(path.join(ROOT, 'public'), { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/reader', (req, res) => res.sendFile(path.join(ROOT, 'public', 'reader.html')));

// Pull the schedule from persisted settings (compose env values are already
// applied on top). Saving settings calls this so a changed interval takes
// effect immediately; onStart is only acted on at boot.
function applyScanSettings() {
  const scan = settings.scan || {};
  const n = Number(scan.intervalMinutes);
  scanIntervalMinutes = Number.isFinite(n) && n >= 0 ? Math.min(n, 10080) : 60;
  scanOnStart = scan.onStart !== false;
  scheduleScans();
}

function scheduleScans() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  if (!scanIntervalMinutes) { nextScanAt = null; return; }
  const every = scanIntervalMinutes * 60 * 1000;
  nextScanAt = new Date(Date.now() + every).toISOString();
  scanTimer = setInterval(function () {
    // Skip silently if a manual or startup scan is still running.
    if (scanning) return;
    runScan('timer').then(function () {
      nextScanAt = new Date(Date.now() + every).toISOString();
    });
  }, every);
  if (scanTimer.unref) scanTimer.unref();
}

async function start() {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  settings = settingsStore.applyEnv(await settingsStore.load(cfg), process.env);
  currentIndex = await library.loadIndex(cfg);
  progress = await library.loadProgress(cfg);
  readingState = await reading.load(cfg);
  shelvesState = await collections.load(cfg);
  notesState = await notes.load(cfg);

  applyScanSettings();

  // Serve the cached shelf immediately, then refresh in the background so a
  // large library never leaves the web UI hanging at startup.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`${settings.systemName} running at http://localhost:${PORT}`);
    console.log(`books: ${cfg.booksDir}`);
    console.log(`data:  ${cfg.dataDir}`);
    console.log(`books indexed: ${currentIndex.books.length}`);
    console.log(`auto scan: startup=${scanOnStart ? 'on' : 'off'}, interval=${scanIntervalMinutes ? scanIntervalMinutes + 'min' : 'off'}`);
  });

  if (scanOnStart || !currentIndex.scannedAt) {
    setImmediate(function () { runScan('startup'); });
  }
  scheduleScans();
}

start().catch(e => {
  console.error(e);
  process.exit(1);
});
