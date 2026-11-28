const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dns = require('dns');
const iconv = require('iconv-lite');
const library = require('./library');
const reading = require('./reading');
const collections = require('./collections');
const series = require('./series');
const taste = require('./taste');
const hiddenStore = require('./hidden');
const notes = require('./notes');
const converter = require('./convert');
const transformer = require('./transform');
const guestbook = require('./guestbook');

// 很多 NAS 有 IPv6 地址却没有可用的 IPv6 出口：Node 默认按 DNS 返回顺序挑地址，
// 一旦先挑到 AAAA，连接到 GitHub 就会一直挂着直到超时（curl 会 200ms 后自动退回
// IPv4，所以命令行测着通、程序里却超时）。强制先用 IPv4，这一行解决的就是它。
dns.setDefaultResultOrder('ipv4first');

// Conversion progress is held in memory only. A job lasts seconds, so there
// is nothing worth persisting; after five minutes a stale entry is dropped.
const transformProgress = new Map();
const PROGRESS_TTL = 5 * 60 * 1000;

function transformKey(id, target) {
  return String(id) + '|' + String(target);
}

function reportTransform(id, target, percent, stage) {
  const key = transformKey(id, target);
  const now = Date.now();
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const label = String(stage || '');
  const prev = transformProgress.get(key);
  // A 600-page PDF reports once per page; don't churn objects for a change
  // too small to see on a progress bar.
  if (prev && prev.percent === pct && prev.stage === label) {
    prev.updatedAt = now;
    return;
  }
  transformProgress.set(key, {
    percent: pct,
    stage: label,
    startedAt: prev ? prev.startedAt : now,
    updatedAt: now
  });
  if (transformProgress.size > 500) {
    for (const [k, v] of transformProgress) {
      if (now - v.updatedAt > PROGRESS_TTL) transformProgress.delete(k);
    }
  }
}
const settingsStore = require('./settings');
const music = require('./music');
const musicProxy = require('./musicproxy');
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
// Auto series are folded in so a book shows both the shelves it was filed into
// and the series its title puts it in.
function shelfIndex() {
  const map = new Map();
  const add = (id, shelfId) => {
    const list = map.get(id);
    if (list) list.push(shelfId);
    else map.set(id, [shelfId]);
  };
  shelvesState.collections.forEach(shelf => shelf.bookIds.forEach(id => add(id, shelf.id)));
  autoShelves.forEach(shelf => shelf.bookIds.forEach(id => add(id, shelf.id)));
  return map;
}

function allShelves() {
  return shelvesState.collections.concat(autoShelves);
}

// 一条竖着的分组列表里出现两个「西游记」，读者只会以为自己点错。自动组按书名
// 高频词生成，手动组按读者意愿生成，两边迟早撞名，这里统一收成一条：
// 手动组活下来（它可改可删，自动组写不进去），自动组算出来的书并进去，该关键词
// 同时收起，扫描时不会再长出一个副本。另外两种少见的重名（手动与手动、自动与
// 自动）也一并处理，规则同样是「同名即同一组」。
function consolidateShelves() {
  let changed = false;

  // 手动组之间同名：并进先建的那条，后来者消失，书一本不丢。
  const handByName = new Map();
  shelvesState.collections.slice().forEach(item => {
    const key = collections.nameKey(item.name);
    if (!key) return;
    const first = handByName.get(key);
    if (!first) {
      handByName.set(key, item);
      return;
    }
    const folded = collections.merge(shelvesState, item.id, first.id);
    if (!folded) return;
    handByName.set(key, folded.item);
    changed = true;
    console.log(`[series] 合并同名丛书「${folded.item.name}」，接手 ${folded.moved} 本`);
  });

  const silenced = [];
  const seenAuto = new Map();
  autoShelves.forEach(shelf => {
    const key = collections.nameKey(shelf.name);
    if (!key) return;
    const hand = handByName.get(key);
    if (hand) {
      const set = new Set(hand.bookIds);
      shelf.bookIds.forEach(id => set.add(id));
      if (set.size !== hand.bookIds.length) {
        hand.bookIds = Array.from(set);
        hand.updatedAt = new Date().toISOString();
        // 收编了自动组的书，这个手动组就不再是空的了。
        delete hand.emptySince;
      }
      silenced.push(shelf.keyword);
      console.log(`[series] 「${shelf.name}」自动组并入同名丛书，共 ${hand.bookIds.length} 本`);
      return;
    }
    // 两条自动组撞名（以前版本改过名留下的）：书多的那条留下。
    const twin = seenAuto.get(key);
    if (!twin) {
      seenAuto.set(key, shelf);
      return;
    }
    const keep = shelf.bookIds.length > twin.bookIds.length ? shelf : twin;
    const drop = keep === shelf ? twin : shelf;
    seenAuto.set(key, keep);
    silenced.push(drop.keyword);
    console.log(`[series] 两条自动组都叫「${shelf.name}」，只留「${keep.keyword}」`);
  });

  silenced.forEach(keyword => {
    if (series.mute(seriesState, keyword, true, 'merged')) changed = true;
  });
  return changed;
}

// 合并结果要落盘，否则下次启动又从旧数据算一遍。
async function tidyShelves() {
  if (!consolidateShelves()) return false;
  await collections.save(cfg, shelvesState);
  await series.save(cfg, seriesState);
  refreshSeries();
  return true;
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
    hidden: hiddenStore.has(hiddenState, book.id),
    noteCount: counts,
    collections: (index && index.get(book.id)) || []
  };
}

// 自动丛书完全由书名推出来，所以索引一变就重算。800 册书名扫一遍只要几毫秒，
// 不值得为它做增量。
// 用整柜书名来算，不用管隐藏：隐藏只作用在「藏书」那条线上，收起的书照样属于
// 它所在的丛书，组名和册数都不该因为收起而变。
function refreshSeries() {
  autoShelves = series.build(currentIndex.books, seriesState);
}

// A renamed file gets a new id, so shelf entries can point at books that no
// longer exist. Pruning after every scan keeps the counts honest.
function syncShelves() {
  const valid = new Set(currentIndex.books.map(b => b.id));
  const removed = collections.prune(shelvesState, valid);
  if (removed) console.log(`[shelves] dropped ${removed} stale book id(s)`);
  const hiddenRemoved = hiddenStore.prune(hiddenState, valid);
  if (hiddenRemoved) console.log(`[hidden] dropped ${hiddenRemoved} stale book id(s)`);
  refreshSeries();
  sweepEmptyShelves();
  return { shelves: removed, hidden: hiddenRemoved };
}

// 0 册的分组不该占着左栏：手动组给一小时宽限（见 collections.EMPTY_GRACE_MS）
// ——先建组再挑书是正常用法，建完立刻被删才是真的烦；自动组算不出书来就不生成。
// 启动、扫描后、以及每十分钟各扫一次。
function sweepEmptyShelves() {
  const dropped = collections.dropEmpty(shelvesState);
  if (!dropped) return 0;
  console.log(`[series] 清掉 ${dropped} 个空丛书（0 册超过 1 小时）`);
  collections.save(cfg, shelvesState);
  return dropped;
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
// Series worked out from titles. Rebuilt on every index change; `seriesState`
// only holds the two things a person decides: a new name, and which to hide.
let seriesState = series.emptyState();
let autoShelves = [];
// 搜过的词：只存词与次数，「猜你想看」拿它给相关的书加分。
let tasteState = taste.emptyState();
// Books put away by hand: kept in the index, out of the default shelf.
let hiddenState = hiddenStore.emptyState();
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
  const before = String(settings.guestbookToken || '');
  settings = settingsStore.applyEnv(settingsStore.merge(settings, req.body), process.env);
  try {
    await settingsStore.save(cfg, settings);
    // A changed interval takes effect right away - no container restart.
    applyScanSettings();
    res.json(settingsStore.forBrowser(settings));
  } catch (e) {
    res.status(500).json({ error: '保存设置失败：' + e.message });
  }
  // 刚填进令牌的话，把之前没传上去的留言顺手补一遍。放在响应之后跑，
  // 不让保存按钮等网络；失败了也不吵人，下次还能手动点「补传」。
  const after = String(settings.guestbookToken || '');
  if (after && after !== before) {
    guestbook.resync(cfg, settings)
      .then(r => {
        if (r.pushed) console.log(`[guestbook] 自动补传 ${r.pushed} 条留言`);
        else if (r.error) console.log('[guestbook] 自动补传没成功：' + r.error);
      })
      .catch(err => console.log('[guestbook] 自动补传失败：' + err.message));
  }
});

/* ---------- guestbook ---------- */
// The captcha and per-IP limit live in memory: no database, and a container
// restart simply clears them. Messages themselves persist in data/guestbook.json.
app.get('/api/guestbook/captcha', (req, res) => {
  res.json(guestbook.captcha());
});

app.get('/api/guestbook', async (req, res) => {
  try {
    const entries = await guestbook.readEntries(cfg);
    res.json({
      entries: guestbook.forBrowser(entries),
      configured: Boolean(settings.guestbookToken),
      pending: entries.filter(e => !e.synced).length
    });
  } catch (e) {
    res.status(500).json({ error: '读取留言失败：' + e.message });
  }
});

// 出网体检：DNS、到 api.github.com、令牌能不能读仓库，分三项报。
app.get('/api/guestbook/diag', async (req, res) => {
  try {
    res.json(await guestbook.diag(settings));
  } catch (e) {
    res.status(500).json({ error: '体检失败：' + e.message });
  }
});

// 补传以前没传上去的留言（先留言、后填令牌是正常顺序）。
app.post('/api/guestbook/resync', async (req, res) => {
  try {
    res.json(Object.assign({ ok: true }, await guestbook.resync(cfg, settings)));
  } catch (e) {
    res.status(500).json({ error: '补传失败：' + e.message });
  }
});

app.post('/api/guestbook', async (req, res) => {
  try {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const r = await guestbook.submit(cfg, settings, req.body, ip);
    res.json({ ok: true, entry: r.entry, syncError: r.syncError });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
    // A brand-new image starts centred: the old framing means nothing on a
    // different picture. The framing dialog opens right after the upload.
    settings.background.focus = { x: 50, y: 50 };
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

// `?src=` previews a path that has not been saved yet, so the framing dialog can
// show what the reader just typed. Only images under the books dir, no traversal.
app.get('/api/background', (req, res) => {
  let data = settings.background.data;
  const preview = String(req.query.src || '').trim();
  if (preview) {
    data = preview.replace(/^\/+/, '');
    if (data.includes('..')) return res.status(400).end();
    if (!/\.(png|jpe?g|webp|gif)$/i.test(data)) return res.status(400).end();
  } else if (!settings.background.enabled || !data) {
    return res.status(404).end();
  }
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
  serveFile(req, res, file, type, { 'Cache-Control': preview ? 'no-store' : 'public, max-age=3600' });
});

/* ---------- music proxy (Subsonic compatible) ---------- */
function currentMusic() {
  return settings.music && settings.music.url ? settings.music : null;
}

// The reverse proxy needs the live URL, which changes when settings are saved.
// A getter avoids copying a stale value at startup.
musicProxy.setMusicUrl(function () {
  const svc = currentMusic();
  if (!svc) return '';
  const active = (settings.music.services || []).find(s => s.id === settings.music.activeId);
  return (active && active.url) || svc.url || '';
});

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
  const visibleFormats = {};
  const hiddenFormats = {};
  let hiddenCount = 0;
  currentIndex.books.forEach(b => {
    formats[b.format] = (formats[b.format] || 0) + 1;
    if (hiddenStore.has(hiddenState, b.id)) {
      hiddenCount++;
      hiddenFormats[b.format] = (hiddenFormats[b.format] || 0) + 1;
    } else {
      visibleFormats[b.format] = (visibleFormats[b.format] || 0) + 1;
    }
  });
  res.json({
    count: currentIndex.books.length,
    hiddenCount,
    visibleCount: currentIndex.books.length - hiddenCount,
    scannedAt: currentIndex.scannedAt,
    lastScan: currentIndex.stats || null,
    formats,
    visibleFormats,
    hiddenFormats,
    converter: converter.isAvailable(),
    transform: transformer.available(),
    booksDir: cfg.booksDir,
    folders: currentIndex.folders || [],
    // 左栏有几条丛书。页面每 10 秒轮询这个数，对不上就重新拉一次分组——
    // 空组是后台定时清掉的，没有这个信号，清完了左栏还挂着「0」。
    shelfCount: allShelves().length,
    scanning: scanning,
    scanOnStart: scanOnStart,
    autoScanMinutes: scanIntervalMinutes,
    nextScanAt: nextScanAt,
    lastScanError: lastScanError,
    scanLimits: { min: 1, max: 10080 }
  });
});

app.get('/api/books', (req, res) => {
  const { sort = 'guess', order = 'desc', q = '', format = '', status = '', collection = '',
    hidden = '', limit = '' } = req.query;
  let books = currentIndex.books;
  // 隐藏只管「藏书」这一条线，管不到丛书：点开一个丛书看到的就是这一组的全部书，
  // 收起的也在里面，否则组名旁边写 12、点开只有 0 本，那个数字就成了假账。
  const inShelf = Boolean(collection);
  // Default is the shelf people expect: what they have not put away.
  // `hidden=only` is the "hidden" tab, `hidden=all` is the honest total.
  if (!inShelf) {
    if (hidden === 'only') books = books.filter(b => hiddenStore.has(hiddenState, b.id));
    else if (hidden !== 'all') books = books.filter(b => !hiddenStore.has(hiddenState, b.id));
  }
  if (format) books = books.filter(b => b.format === format);
  if (collection) {
    const found = allShelves().find(c => c.id === collection);
    if (!found) return res.status(404).json({ error: '没有找到这个丛书' });
    const ids = new Set(found.bookIds);
    books = books.filter(b => ids.has(b.id));
  }
  if (status) books = books.filter(b => bookStatus(b) === status);
  if (q) {
    const needle = String(q).toLowerCase();
    books = books.filter(b =>
      [b.title, b.author, b.path].some(v => String(v || '').toLowerCase().includes(needle))
    );
  }
  // 「猜你想看」要用到阅读进度和搜索日志，所以在这里排，不进 library.sortBooks。
  // 高分在前（order=desc 为默认）；同分时最近读过的先，再按书名，同一套分册的
  // 卷次顺序不会被入库时间打乱。
  let ranked = null;
  if (sort === 'guess') {
    ranked = taste.rank(currentIndex.books, tasteState, { stamp: currentIndex.scannedAt || '' });
    const scoreOf = b => (ranked.get(b.id) || {}).score || 0;
    const dir = order === 'asc' ? -1 : 1;
    books = books.slice().sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa !== sb) return (sb - sa) * dir;
      const ta = (progress[a.id] || {}).updatedAt || '';
      const tb = (progress[b.id] || {}).updatedAt || '';
      if (ta !== tb) return tb.localeCompare(ta);
      // 再按书名，同一套的分册保持原本的卷次顺序，而不是入库顺序。
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  } else if (sort === 'recent') {
    // "recent" sorts by when it was last opened, which lives in progress rather
    // than in the book record, so it cannot be handled by library.sortBooks.
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
  res.json({
    count: books.length,
    sort: sort,
    // 只有按「猜你想看」排时才回传理由，别给别的排序平白加几十 KB。
    books: books.map(b => {
      const row = decorate(b, index);
      if (ranked) {
        const hit = ranked.get(b.id);
        row.taste = hit ? { score: Math.round(hit.score * 10) / 10, why: hit.why } : null;
      }
      return row;
    })
  });
});

// Hide or unhide a batch. Ids that are already in the wanted state are
// ignored, so "hide all selected" twice is not a write each time.
app.post('/api/books/hide', async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return res.status(400).json({ error: '没有选中任何书' });
  const want = body.hidden !== false;
  const changed = hiddenStore.setMany(hiddenState, ids, want);
  if (changed) await hiddenStore.save(cfg, hiddenState);
  // 只改了「藏书」那条线的可见性：丛书的成员、册数、空置判定都不受影响，
  // 所以这里不需要重算自动组，也不用碰空组计时。
  res.json({ ok: true, changed, hiddenCount: hiddenStore.count(hiddenState) });
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
    // A corrected title can move this book into or out of a series.
    refreshSeries();

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

// Format conversion, downloaded straight to the browser instead of being
// written back into the library: storing the result would add a duplicate
// record on the next scan, and the point here is "I need this book as a PDF
// for someone else", not "I want two copies on my shelf".
// The download response is one blob, so it cannot stream progress. The sheet
// polls this while the download request is in flight instead.
app.get('/api/transform/progress', (req, res) => {
  const key = transformKey(req.query.book, req.query.target);
  const p = transformProgress.get(key);
  if (!p) return res.json({ active: false });
  const now = Date.now();
  if (now - p.updatedAt > PROGRESS_TTL) {
    transformProgress.delete(key);
    return res.json({ active: false });
  }
  res.json({
    active: p.percent < 100,
    percent: p.percent,
    stage: p.stage,
    elapsedMs: now - p.startedAt
  });
});

app.get('/api/book/:id/transform/:target', async (req, res) => {
  const book = findBook(req.params.id);
  if (!book) return res.status(404).json({ error: '没有找到这本书' });
  const result = await transformer.transform(book, cfg, req.params.target, function (pct, stage) {
    reportTransform(book.id, req.params.target, pct, stage);
  });
  if (!result.ok) return res.status(result.status || 422).json({ error: result.error });
  res.download(result.file, result.name, err => {
    if (err && !res.headersSent) res.status(500).json({ error: '文件传输中断：' + err.message });
  });
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
  // 左栏「在读」「读完」后面的数字就是点下去会看到的册数，所以和书架默认视图一样
  // 不含已隐藏的书，否则按钮写 40、点开只有 37。
  const visible = currentIndex.books.filter(b => !hiddenStore.has(hiddenState, b.id));
  res.json(reading.summary(readingState, { books: visible, progress }));
});

/* ---------- 猜你想看 ---------- */
// 书架默认按这个排：书名高频词 + 搜过的词。这里只暴露「记了什么」，方便在设置
// 里看清楚、也能一键清空——排序是拿读者的行为算的，就该让读者看得见。
app.get('/api/taste', (req, res) => {
  res.json({
    searches: taste.total(tasteState),
    terms: taste.list(tasteState).slice(0, 12),
    keywords: taste.topKeywords(currentIndex.books, 6)
  });
});

app.post('/api/taste/log', async (req, res) => {
  const hit = taste.record(tasteState, (req.body || {}).q);
  if (!hit) return res.json({ ok: false, skipped: true });
  await taste.save(cfg, tasteState);
  res.json({ ok: true, q: hit.q, count: hit.count });
});

app.post('/api/taste/reset', async (req, res) => {
  const removed = taste.clear(tasteState);
  await taste.save(cfg, tasteState);
  res.json({ ok: true, removed });
});

// 分组后面标的册数：这一组有几本书就写几本，收起的也算——隐藏不作用在丛书上。
// 点开看到的册数由 /api/books 保证一致（collection 存在时不过滤隐藏）。
function shownCount(bookIds) {
  return (bookIds || []).length;
}

/* ---------- shelves: hand-built, plus the ones titles suggest ---------- */
app.get('/api/collections', (req, res) => {
  res.json({
    collections: allShelves().map(c => ({
      id: c.id,
      name: c.name,
      count: shownCount(c.bookIds),
      bookIds: c.bookIds,
      auto: !!c.auto,
      keyword: c.keyword || null,
      createdAt: c.createdAt
    })),
    // Keywords the reader folded away, so the rail can offer a way back.
    muted: seriesState.muted.slice(),
    // Empty until the reader actually drags a group; the rail sorts by name.
    order: seriesState.order.slice()
  });
});

app.post('/api/series/restore', async (req, res) => {
  seriesState.muted = [];
  await series.save(cfg, seriesState);
  refreshSeries();
  // 放回来的自动组若与手动组同名，会立刻被再合并一次，左栏不会因此多出一条。
  await tidyShelves();
  res.json({ ok: true, collections: autoShelves.length });
});

// The rail shows groups in name order until somebody drags one. Only then is
// an explicit order stored - keeping a default order in the file would stop
// newly discovered auto groups from finding their alphabetical place.
app.post('/api/series/order', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.map(v => String(v || '')).filter(Boolean)
    : [];
  seriesState.order = Array.from(new Set(ids)).slice(0, 1000);
  await series.save(cfg, seriesState);
  res.json({ ok: true, order: seriesState.order });
});

// Adding books to a series, folding an auto group into a hand-held one, and
// renaming into an existing name all end up here: one group, union of members.
function shelfShape(c) {
  return {
    id: c.id,
    name: c.name,
    count: shownCount(c.bookIds),
    bookIds: c.bookIds,
    auto: !!c.auto,
    keyword: c.keyword || null,
    createdAt: c.createdAt
  };
}

// Anything already on the rail that answers to this name, other than `selfId`.
function clashOf(rawName, selfId) {
  const key = collections.nameKey(rawName);
  if (!key) return null;
  const hit = allShelves().find(s => s.id !== selfId && collections.nameKey(s.name) === key);
  return hit ? { id: hit.id, name: hit.name, count: shownCount(hit.bookIds), auto: !!hit.auto } : null;
}

// A group worked out from titles cannot be written to, so merging *into* one
// means adopting it: the members it has right now become a hand-built series,
// and the keyword stops generating a second copy.
function adoptAuto(keyword, rawName) {
  const shelf = autoShelves.find(s => s.keyword === keyword);
  if (!shelf) return null;
  const name = collections.cleanName(rawName) || shelf.name;
  const item = collections.create(shelvesState, name);
  item.bookIds = shelf.bookIds.slice();
  item.updatedAt = new Date().toISOString();
  // 采纳成手动组是有意整理，不是"先收起、以后可能后悔"，别给它留恢复入口。
  series.mute(seriesState, keyword, true, 'merged');
  return item;
}

app.post('/api/collections', async (req, res) => {
  const body = req.body || {};
  const name = collections.cleanName(body.name);
  const add = Array.isArray(body.add) ? body.add.map(String).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: '丛书名称不能为空' });
  try {
    // 「加入丛书」撞上自动组的名字时走这里：把那组转成手动丛书，再收下新书。
    if (body.adopt) {
      const adopted = adoptAuto(String(body.adopt), name);
      if (!adopted) return res.status(404).json({ error: '没有找到这个分组' });
      if (add.length) collections.members(shelvesState, adopted.id, { add });
      await collections.save(cfg, shelvesState);
      await series.save(cfg, seriesState);
      refreshSeries();
      return res.json({ ok: true, merged: true, collection: shelfShape(adopted) });
    }
    // Same name already hand-built: join it instead of opening a twin.
    const existing = collections.findByName(shelvesState, name);
    if (existing) {
      if (add.length) collections.members(shelvesState, existing.id, { add });
      await collections.save(cfg, shelvesState);
      return res.json({ ok: true, merged: true, collection: shelfShape(existing) });
    }
    const auto = autoShelves.find(s => collections.nameKey(s.name) === collections.nameKey(name));
    if (auto) {
      return res.status(409).json({
        error: '已有「' + auto.name + '」分组（自动归组）',
        code: 'AUTO_NAME',
        match: { id: auto.id, name: auto.name, count: auto.count }
      });
    }
    const item = collections.create(shelvesState, name);
    if (add.length) collections.members(shelvesState, item.id, { add });
    await collections.save(cfg, shelvesState);
    res.json({ ok: true, collection: shelfShape(item) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/collections/:id', async (req, res) => {
  const body = req.body || {};
  const id = req.params.id;
  // An auto series has no stored member list: the only thing worth writing is
  // the name the reader prefers. An empty name falls back to the keyword.
  if (id.indexOf('auto:') === 0) {
    const keyword = id.slice(5);
    const shelf = autoShelves.find(s => s.keyword === keyword);
    if (!shelf) {
      return res.status(404).json({ error: '没有找到这个丛书' });
    }
    try {
      if (body.name !== undefined) {
        const next = collections.cleanName(body.name);
        const clash = clashOf(next, id);
        // Renaming into a name that is already on the rail is a merge request,
        // not an error: answer with what it would join so the reader can decide.
        if (clash) return res.status(409).json({ error: '已有「' + clash.name + '」分组', code: 'DUPLICATE', match: clash });
        series.rename(seriesState, keyword, body.name);
        await series.save(cfg, seriesState);
        refreshSeries();
      }
      const fresh = autoShelves.find(s => s.keyword === keyword);
      res.json({ ok: true, collection: { id, name: fresh.name, count: fresh.count, auto: true } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }
  const item = shelvesState.collections.find(c => c.id === id);
  if (!item) return res.status(404).json({ error: '没有找到这个丛书' });
  try {
    if (body.name !== undefined) {
      const next = collections.cleanName(body.name);
      if (!next) return res.status(400).json({ error: '丛书名称不能为空' });
      const clash = clashOf(next, id);
      if (clash) return res.status(409).json({ error: '已有「' + clash.name + '」分组', code: 'DUPLICATE', match: clash });
      collections.rename(shelvesState, item.id, next);
    }
    // Adding/removing books and renaming in one call keeps the panel's save
    // button to a single request.
    if (body.add || body.remove) collections.members(shelvesState, item.id, body);
    await collections.save(cfg, shelvesState);
    const fresh = shelvesState.collections.find(c => c.id === item.id);
    res.json({ ok: true, collection: shelfShape(fresh) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Books leave every other hand-built series and land in this one.
app.post('/api/collections/:id/move', async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: '没有选中任何书' });
  const result = collections.moveMembers(shelvesState, req.params.id, ids);
  if (!result) return res.status(404).json({ error: '没有找到这个丛书' });
  await collections.save(cfg, shelvesState);
  res.json({ ok: true, removed: result.removed, added: result.added, collection: shelfShape(result.item) });
});

// Fold one group into another. Either side may be an auto group: a computed
// group cannot receive books, so it is adopted as hand-held first.
app.post('/api/collections/merge', async (req, res) => {
  const body = req.body || {};
  const fromId = String(body.from || '');
  const intoId = String(body.into || '');
  if (!fromId || !intoId) return res.status(400).json({ error: '缺少要合并的分组' });
  if (fromId === intoId) return res.status(400).json({ error: '不能把自己合并到自己' });
  const from = allShelves().find(s => s.id === fromId);
  if (!from) return res.status(404).json({ error: '没有找到要合并的分组' });
  try {
    let into = shelvesState.collections.find(c => c.id === intoId);
    if (!into && intoId.indexOf('auto:') === 0) {
      into = adoptAuto(intoId.slice(5), body.name);
      if (!into) return res.status(404).json({ error: '没有找到目标分组' });
    }
    if (!into) return res.status(404).json({ error: '没有找到目标分组' });
    let moved;
    if (from.auto) {
      // Nothing to delete: an auto group has no stored member list, it only has
      // to stop being generated.
      const set = new Set(into.bookIds);
      from.bookIds.forEach(bookId => set.add(bookId));
      moved = from.bookIds.length;
      into.bookIds = Array.from(set);
      into.updatedAt = new Date().toISOString();
      // 接手了书，就别再记着「空置起点」了。
      delete into.emptySince;
      series.mute(seriesState, from.keyword, true, 'merged');
    } else {
      const folded = collections.merge(shelvesState, from.id, into.id);
      if (!folded) return res.status(404).json({ error: '没有找到要合并的分组' });
      moved = folded.moved;
      into = folded.item;
    }
    await collections.save(cfg, shelvesState);
    await series.save(cfg, seriesState);
    refreshSeries();
    res.json({ ok: true, moved, collection: shelfShape(into) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/collections/:id', async (req, res) => {
  const id = req.params.id;
  // Deleting an auto series would only last until the next scan, so it is
  // recorded as "don't show this one" instead.
  if (id.indexOf('auto:') === 0) {
    series.mute(seriesState, id.slice(5), true);
    await series.save(cfg, seriesState);
    refreshSeries();
    return res.json({ ok: true });
  }
  if (!collections.remove(shelvesState, id)) {
    return res.status(404).json({ error: '没有找到这个丛书' });
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

// Forget every book under a folder that is about to be removed from settings.
// Book ids are hashes of folder + relative path, so the folder is the only
// reliable way to find them. Nothing on the NAS itself is touched - only the
// derived files under data/.
app.post('/api/folders/forget', async (req, res) => {
  const raw = String((req.body && req.body.path) || '').trim();
  const folder = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!folder || folder.includes('..')) return res.status(400).json({ error: '文件夹路径无效' });

  const ids = (currentIndex.books || [])
    .filter(b => b && b.id && (b.folder || cfg.booksDir).replace(/\\/g, '/').replace(/\/+$/, '') === folder)
    .map(b => b.id);
  const idSet = new Set(ids);

  let covers = 0;
  let converted = 0;
  let transformed = 0;
  const transformDir = path.join(cfg.dataDir, 'transformed');
  // Covers are stored as <id>.<ext>; list the directory once and match by
  // prefix. Reading it per book made a 800-book folder do 800 readdir calls.
  let coverFiles = [];
  try { coverFiles = await fsp.readdir(cfg.coverDir); } catch (e) { /* no cover dir yet */ }
  let transformFiles = [];
  try { transformFiles = await fsp.readdir(transformDir); } catch (e) { /* nothing converted yet */ }
  for (const id of ids) {
    for (const name of coverFiles) {
      if (name.startsWith(id + '.') || name === id) {
        try {
          await fsp.unlink(path.join(cfg.coverDir, name));
          covers++;
        } catch (e) { /* already gone */ }
      }
    }
    try {
      await fsp.unlink(path.join(cfg.convertDir, id + '.epub'));
      converted++;
    } catch (e) { /* not converted */ }
    // Format conversion output: <id>.epub/.txt/.docx/.pdf
    for (const name of transformFiles) {
      if (name.startsWith(id + '.')) {
        try {
          await fsp.unlink(path.join(transformDir, name));
          transformed++;
        } catch (e) { /* already gone */ }
      }
    }
  }

  // Book ids live in five state files. Prune by id, then persist each one.
  let progressRemoved = 0;
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(progress, id)) {
      delete progress[id];
      progressRemoved++;
    }
  }
  if (progressRemoved) {
    try { await library.saveProgress(cfg, progress); } catch (e) { /* best effort */ }
  }

  let notesRemoved = 0;
  for (const id of ids) {
    if (notesState.books && Object.prototype.hasOwnProperty.call(notesState.books, id)) {
      delete notesState.books[id];
      notesRemoved++;
    }
  }
  if (notesRemoved) {
    try { await notes.save(cfg, notesState); } catch (e) { /* best effort */ }
  }

  let shelvesRemoved = 0;
  (shelvesState.collections || []).forEach(shelf => {
    if (!Array.isArray(shelf.bookIds)) return;
    const before = shelf.bookIds.length;
    shelf.bookIds = shelf.bookIds.filter(id => !idSet.has(id));
    shelvesRemoved += before - shelf.bookIds.length;
  });
  if (shelvesRemoved) {
    try { await collections.save(cfg, shelvesState); } catch (e) { /* best effort */ }
  }

  // A forgotten folder also takes its books out of the hidden list, otherwise
  // the count would keep pointing at files that are no longer indexed.
  const hiddenRemoved = hiddenStore.setMany(hiddenState, ids, false);
  if (hiddenRemoved) {
    try { await hiddenStore.save(cfg, hiddenState); } catch (e) { /* best effort */ }
  }

  // The ledger keeps per-day per-book seconds; drop those book keys too.
  let ledgerRemoved = 0;
  Object.keys(readingState.days || {}).forEach(key => {
    const day = readingState.days[key];
    if (!day || !day.books) return;
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(day.books, id)) {
        delete day.books[id];
        ledgerRemoved++;
      }
    }
  });
  if (ledgerRemoved) {
    try { await reading.save(cfg, readingState); } catch (e) { /* best effort */ }
  }

  console.log(`[folders/forget] ${folder}: ${ids.length} 册 · 封面 ${covers} · 缓存 ${converted} · 转换产物 ${transformed} · 进度 ${progressRemoved} · 笔记 ${notesRemoved} · 书单 ${shelvesRemoved} · 台账 ${ledgerRemoved}`);
  res.json({ ok: true, books: ids.length, covers, converted, transformed, progress: progressRemoved, notes: notesRemoved, shelves: shelvesRemoved, ledger: ledgerRemoved });
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
    const stale = syncShelves();
    if (stale.shelves) await collections.save(cfg, shelvesState);
    if (stale.hidden) await hiddenStore.save(cfg, hiddenState);
    // 新书进来可能给某个手动组凑出同名自动组，扫完顺手合并。
    await tidyShelves();
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

// Same-origin reverse proxy for embedded web players. Mounted before static
// files so /music-proxy/... is never mistaken for a public asset.
app.use(musicProxy.middleware);

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
  seriesState = await series.load(cfg);
  tasteState = await taste.load(cfg);
  hiddenState = await hiddenStore.load(cfg);
  notesState = await notes.load(cfg);
  // Titles are already on disk, so the rail has its series before the first
  // request — no need to wait for a scan.
  refreshSeries();
  // 老数据里可能已经躺着两条同名的分组，启动时先收成一条再对外服务。
  await tidyShelves();
  // 空了一小时以上的手动组顺手清掉；之后每 10 分钟扫一次，不然没人动过
  // 数据就永远等不到下一次保存，那个「0 册」会一直挂在左栏。
  sweepEmptyShelves();
  const emptyTimer = setInterval(sweepEmptyShelves, 10 * 60 * 1000);
  if (emptyTimer.unref) emptyTimer.unref();

  applyScanSettings();

  // Serve the cached shelf immediately, then refresh in the background so a
  // large library never leaves the web UI hanging at startup.
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`${settings.systemName} running at http://localhost:${PORT}`);
    console.log(`books: ${cfg.booksDir}`);
    console.log(`data:  ${cfg.dataDir}`);
    console.log(`books indexed: ${currentIndex.books.length}`);
    console.log(`auto scan: startup=${scanOnStart ? 'on' : 'off'}, interval=${scanIntervalMinutes ? scanIntervalMinutes + 'min' : 'off'}`);
  });
  // AnyListen drives its player over a WebSocket; forward the upgrade so the
  // proxied iframe stays fully functional on our own origin.
  musicProxy.upgrade(httpServer);

  if (scanOnStart || !currentIndex.scannedAt) {
    setImmediate(function () { runScan('startup'); });
  }
  scheduleScans();
}

start().catch(e => {
  console.error(e);
  process.exit(1);
});
