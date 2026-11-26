/*
 * Persisted UI settings: system name, subtitle, theme, background, music server.
 * Stored in DATA_DIR/settings.json. Only known keys are merged in to avoid
 * arbitrary data sneaking into the config.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULTS = {
  systemName: '夜读',
  subtitle: '我的书房',
  theme: 'night',
  folders: [],
  background: { enabled: false, data: '', blur: 0, dim: 0.55 },
  // AnyListen is embedded as a web page by default - it already has its own
  // player UI, so no audio proxy is needed. "subsonic" keeps the lightweight
  // random-play bar for Navidrome-style servers.
  music: { mode: 'embed', enabled: false, url: 'http://192.168.0.111:9500', user: '', password: '', volume: 0.8 }
};

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

function cleanString(value, max, fallback) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, max) : fallback;
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
    const music = raw.music || {};
    out.music.mode = MUSIC_MODES.has(music.mode) ? music.mode : 'embed';
    out.music.enabled = Boolean(music.enabled);
    out.music.url = cleanString(music.url, 300, DEFAULTS.music.url);
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

  const music = src.music || {};
  if (MUSIC_MODES.has(music.mode)) out.music.mode = music.mode;
  if (Object.prototype.hasOwnProperty.call(music, 'enabled')) out.music.enabled = Boolean(music.enabled);
  if (Object.prototype.hasOwnProperty.call(music, 'url')) out.music.url = cleanString(music.url, 300, '');
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

module.exports = { DEFAULTS, THEMES, clone, load, save, merge, forBrowser };
