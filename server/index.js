const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const iconv = require('iconv-lite');
const library = require('./library');
const converter = require('./convert');
const settingsStore = require('./settings');
const music = require('./music');

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
let scanning = false;
let settings = settingsStore.clone ? settingsStore.clone(settingsStore.DEFAULTS) : settingsStore.DEFAULTS;

/* ---------- settings ---------- */
app.get('/api/settings', (req, res) => {
  res.json(settingsStore.forBrowser(settings));
});

app.put('/api/settings', async (req, res) => {
  settings = settingsStore.merge(settings, req.body);
  try {
    await settingsStore.save(cfg, settings);
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
    formats,
    calibre: converter.isAvailable(),
    booksDir: cfg.booksDir,
    folders: currentIndex.folders || []
  });
});

app.get('/api/books', (req, res) => {
  const { sort = 'added', order = 'desc', q = '', format = '' } = req.query;
  let books = currentIndex.books;
  if (format) books = books.filter(b => b.format === format);
  if (q) {
    const needle = String(q).toLowerCase();
    books = books.filter(b =>
      [b.title, b.author, b.path].some(v => String(v || '').toLowerCase().includes(needle))
    );
  }
  books = library.sortBooks(books, sort, order).map(b => ({
    ...b,
    progress: progress[b.id] || null
  }));
  res.json({ count: books.length, books });
});

app.get('/api/book/:id', (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  res.json({ ...book, progress: progress[book.id] || null });
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
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
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

app.get('/api/book/:id/read', async (req, res) => {
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
});

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

app.post('/api/book/:id/progress', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const body = req.body || {};
  progress[book.id] = {
    percent: Math.max(0, Math.min(1, Number(body.percent) || 0)),
    location: String(body.location || ''),
    updatedAt: new Date().toISOString()
  };
  try { await library.saveProgress(cfg, progress); } catch (e) { /* best effort */ }
  res.json(progress[book.id]);
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

app.post('/api/rescan', async (req, res) => {
  if (scanning) return res.status(409).json({ error: '正在刮削中，请稍候' });
  scanning = true;
  try {
    const folders = settings.folders && settings.folders.length ? settings.folders : [cfg.booksDir];
    currentIndex = await library.scan(cfg, folders);
    res.json({
      ok: true,
      count: currentIndex.count,
      scannedAt: currentIndex.scannedAt,
      folders: currentIndex.folders
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    scanning = false;
  }
});

app.use(express.static(path.join(ROOT, 'public'), { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/reader', (req, res) => res.sendFile(path.join(ROOT, 'public', 'reader.html')));

async function start() {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  settings = await settingsStore.load(cfg);
  currentIndex = await library.loadIndex(cfg);
  progress = await library.loadProgress(cfg);
  const folders = settings.folders && settings.folders.length ? settings.folders : [cfg.booksDir];
  if (!currentIndex.scannedAt || process.env.SCAN_ON_START === '1') {
    try { currentIndex = await library.scan(cfg, folders); }
    catch (e) { console.warn('[library] initial scan failed:', e.message); }
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`${settings.systemName} running at http://localhost:${PORT}`);
    console.log(`books: ${cfg.booksDir}`);
    console.log(`data:  ${cfg.dataDir}`);
    console.log(`books indexed: ${currentIndex.books.length}`);
  });
}

start().catch(e => {
  console.error(e);
  process.exit(1);
});
