/*
 * Persisted UI settings: system name, subtitle, theme, background, music server.
 * Stored in DATA_DIR/settings.json. Only known keys are merged in to avoid
 * arbitrary data sneaking into the config.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Web players the drawer knows how to embed. Only services with a URL show up
// in the switcher, so an empty preset never becomes a dead menu item.
const MUSIC_SERVICES = [
  { id: 'anylisten', name: 'AnyListen', url: 'http://192.168.0.111:9500', loginUrl: '' },
  { id: 'music-dl', name: 'music-dl', url: '', loginUrl: '' },
  { id: 'songloft', name: 'Songloft', url: '', loginUrl: '' },
  { id: 'melodyhub', name: 'MelodyHub', url: '', loginUrl: '' },
  { id: 'solara', name: 'Solara 光域', url: '', loginUrl: '' }
];

const DEFAULTS = {
  systemName: '夜读',
  subtitle: '我的书房',
  theme: 'night',
  folders: [],
  background: { enabled: false, data: '', blur: 0, dim: 0.55 },
  // Scan schedule is editable in the settings drawer. compose env vars can
  // still force a value for declarative NAS deploys; otherwise the saved
  // value wins. intervalMinutes 0 means scheduled scans are off.
  scan: { onStart: true, intervalMinutes: 60 },
  // AnyListen is embedded as a web page by default - it already has its own
  // player UI, so no audio proxy is needed. "subsonic" keeps the lightweight
  // random-play bar for Navidrome-style servers.
  // Pre-filled with the owner's AnyListen address. Overridable by MUSIC_URL in
  // compose or by the settings drawer. Priority: env > saved value > default.
  music: {
    mode: 'embed', enabled: false,
    url: 'http://192.168.0.111:9500',
    user: '', password: '', volume: 0.8,
    activeId: 'anylisten',
    services: clone(MUSIC_SERVICES)
  }
};

// Environment overrides applied after loading settings.json. Priority:
//   env var > saved settings.json > DEFAULTS
// MUSIC_URL / MUSIC_MODE let a NAS compose file declare the music service
// declaratively, so the address can be changed without touching the database.
function applyEnv(settings, env) {
  const out = clone(settings);
  const e = env || {};
  const url = cleanString(e.MUSIC_URL, 300, '');
  const mode = cleanString(e.MUSIC_MODE, 20, '');
  if (url) {
    out.music.url = url;
    const list = Array.isArray(out.music.services) ? out.music.services : (out.music.services = []);
    const active = list.find(s => s.id === out.music.activeId);
    if (active) active.url = url;
    else if (list.length) list[0].url = url;
  }
  if (MUSIC_MODES.has(mode)) out.music.mode = mode;
  out.music.urlFromEnv = Boolean(url);

  // Scan schedule: env wins when explicitly set, same priority as music.
  const scanOn = cleanString(e.SCAN_ON_START, 4, '');
  if (scanOn === '0' || scanOn === '1') out.scan.onStart = scanOn === '1';
  out.scan.onStartFromEnv = scanOn === '0' || scanOn === '1';
  const intervalRaw = cleanString(e.SCAN_INTERVAL_MINUTES, 10, '');
  const interval = intervalRaw === '' ? null : clampInterval(intervalRaw, null);
  if (interval !== null) out.scan.intervalMinutes = interval;
  out.scan.intervalFromEnv = interval !== null;
  return out;
}

const MUSIC_MODES = new Set(['embed', 'subsonic']);

// Normalize a list of folder paths. Absolute POSIX paths (the NAS/container
// view) and Windows drive paths (local development) are accepted. Relative
// paths and .. are rejected. Duplicates and empty values are dropped.
function isAbsolute(p) {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}
function cleanFolders(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    let p = cleanString(item, 600, '');
    if (!p) continue;
    p = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!isAbsolute(p) || p.includes('..')) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

const THEMES = new Set(['night', 'paper', 'ink', 'tide']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function file(cfg) {
  return path.join(cfg.dataDir, 'settings.json');
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// Minutes between automatic scans. 0 turns the timer off; fractions are kept
// (useful for short test intervals) and 10080 (7 days) is the upper bound.
function clampInterval(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 10080);
}

function cleanString(value, max, fallback) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, max) : fallback;
}

const SERVICE_ID = /^[A-Za-z0-9_-]{1,40}$/;

// Returns null when the field was not supplied, so merge() can leave it alone.
function cleanServices(value, fallback) {
  if (!Array.isArray(value)) return fallback ? clone(fallback) : null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanString(item.id, 40, '');
    if (!SERVICE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: id,
      name: cleanString(item.name, 40, id),
      url: cleanString(item.url, 300, ''),
      loginUrl: cleanString(item.loginUrl, 300, '')
    });
  }
  return out;
}

function cleanActiveId(value, services) {
  const id = cleanString(value, 40, '');
  if (id && services.some(s => s.id === id && s.url)) return id;
  const first = services.find(s => s.url);
  return first ? first.id : '';
}

async function load(cfg) {
  try {
    const raw = JSON.parse(await fsp.readFile(file(cfg), 'utf8'));
    const out = clone(DEFAULTS);
    out.systemName = cleanString(raw.systemName, 40, DEFAULTS.systemName);
    out.subtitle = cleanString(raw.subtitle, 60, DEFAULTS.subtitle);
    if (THEMES.has(raw.theme)) out.theme = raw.theme;
    const folders = cleanFolders(raw.folders);
    out.folders = (folders !== null && folders.length) ? folders : [cfg.booksDir];
    const bg = raw.background || {};
    out.background.enabled = Boolean(bg.enabled);
    out.background.data = cleanString(bg.data, 500, '');
    out.background.blur = clamp(bg.blur, 0, 20, 0);
    out.background.dim = clamp(bg.dim, 0, 0.9, 0.55);
    const scan = raw.scan || {};
    if (Object.prototype.hasOwnProperty.call(scan, 'onStart')) out.scan.onStart = Boolean(scan.onStart);
    out.scan.intervalMinutes = clampInterval(scan.intervalMinutes, DEFAULTS.scan.intervalMinutes);
    const music = raw.music || {};
    out.music.mode = MUSIC_MODES.has(music.mode) ? music.mode : 'embed';
    out.music.enabled = Boolean(music.enabled);
    out.music.services = cleanServices(music.services, MUSIC_SERVICES);
    out.music.activeId = cleanActiveId(music.activeId, out.music.services);
    // Older settings.json had no services list - keep its url as the active one.
    const savedUrl = cleanString(music.url, 300, '');
    const active = out.music.services.find(s => s.id === out.music.activeId);
    if (savedUrl && active) active.url = savedUrl;
    out.music.url = active ? active.url : (savedUrl || DEFAULTS.music.url);
    out.music.user = cleanString(music.user, 120, '');
    out.music.password = String(music.password == null ? '' : music.password).slice(0, 200);
    out.music.volume = clamp(music.volume, 0, 1, 0.8);
    return out;
  } catch (e) {
    const fresh = clone(DEFAULTS);
    fresh.folders = [cfg.booksDir];
    return fresh;
  }
}

async function save(cfg, settings) {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await fsp.writeFile(file(cfg), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

/* Merge user input into current settings. A masked password keeps the old one. */
function merge(current, input) {
  const out = clone(current);
  const src = input || {};
  if (Object.prototype.hasOwnProperty.call(src, 'systemName')) {
    out.systemName = cleanString(src.systemName, 40, DEFAULTS.systemName);
  }
  if (Object.prototype.hasOwnProperty.call(src, 'subtitle')) {
    out.subtitle = cleanString(src.subtitle, 60, DEFAULTS.subtitle);
  }
  if (THEMES.has(src.theme)) out.theme = src.theme;
  const folders = cleanFolders(src.folders);
  if (folders !== null) out.folders = folders;

  const bg = src.background || {};
  if (Object.prototype.hasOwnProperty.call(bg, 'enabled')) out.background.enabled = Boolean(bg.enabled);
  if (Object.prototype.hasOwnProperty.call(bg, 'data')) out.background.data = cleanString(bg.data, 500, '');
  if (Object.prototype.hasOwnProperty.call(bg, 'blur')) out.background.blur = clamp(bg.blur, 0, 20, 0);
  if (Object.prototype.hasOwnProperty.call(bg, 'dim')) out.background.dim = clamp(bg.dim, 0, 0.9, 0.55);

  const scan = src.scan || {};
  if (Object.prototype.hasOwnProperty.call(scan, 'onStart')) out.scan.onStart = Boolean(scan.onStart);
  if (Object.prototype.hasOwnProperty.call(scan, 'intervalMinutes')) {
    out.scan.intervalMinutes = clampInterval(scan.intervalMinutes, out.scan.intervalMinutes);
  }

  const music = src.music || {};
  if (MUSIC_MODES.has(music.mode)) out.music.mode = music.mode;
  if (Object.prototype.hasOwnProperty.call(music, 'enabled')) out.music.enabled = Boolean(music.enabled);
  if (Object.prototype.hasOwnProperty.call(music, 'url')) out.music.url = cleanString(music.url, 300, '');
  const services = cleanServices(music.services, null);
  if (services !== null) {
    out.music.services = services;
    out.music.activeId = cleanActiveId(music.activeId, services);
    const active = services.find(s => s.id === out.music.activeId);
    if (active && active.url) out.music.url = active.url;
  }
  if (Object.prototype.hasOwnProperty.call(music, 'user')) out.music.user = cleanString(music.user, 120, '');
  if (Object.prototype.hasOwnProperty.call(music, 'password') && music.password !== '********') {
    out.music.password = String(music.password || '').slice(0, 200);
  }
  if (Object.prototype.hasOwnProperty.call(music, 'volume')) out.music.volume = clamp(music.volume, 0, 1, 0.8);
  return out;
}

function forBrowser(settings) {
  const out = clone(settings);
  if (out.music.password) out.music.password = '********';
  return out;
}

module.exports = { DEFAULTS, THEMES, clone, load, save, merge, applyEnv, forBrowser };
