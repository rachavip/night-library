/*
 * App version, shipped with the code. version.json is the single source of
 * truth: bump its "version" on every change, and the shelf header plus the
 * update check both follow automatically.
 *
 * The update check compares the local version (baked into the running image)
 * against the copy on GitHub. It reports three states:
 *   - remote newer  -> a newer image exists, pull it
 *   - equal         -> running the latest uploaded code
 *   - local newer   -> changes exist locally but were not uploaded yet
 * That last state is the "are my uploaded files current?" signal.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');
const REPO = 'rachavip/night-library';
const BRANCH = 'main';
// raw works everywhere; jsDelivr is a fallback for networks blocking raw.
const SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}/version.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/version.json`
];

function clean(value, max, fallback) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, max) : fallback;
}

function normalize(data) {
  const d = data || {};
  return {
    version: clean(d.version, 20, '0.0'),
    date: clean(d.date, 40, ''),
    notes: Array.isArray(d.notes)
      ? d.notes.slice(0, 8).map(n => clean(n, 200, '')).filter(Boolean)
      : [],
    // 首页简介里的本版亮点，单独一份短文案，别把十几条 notes 倒到页面上。
    highlights: Array.isArray(d.highlights)
      ? d.highlights.slice(0, 4).map(n => clean(n, 120, '')).filter(Boolean)
      : []
  };
}

function local() {
  try {
    return normalize(JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')));
  } catch (e) {
    return { version: '0.0', date: '', notes: [], highlights: [] };
  }
}

// Compare dotted versions numerically: 0.10 > 0.9. Non-numeric parts are 0.
function parts(version) {
  return String(version || '').split(/[.\-]/).map(p => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compare(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchOne(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return normalize(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// Never throws - a failed check is a normal UI state, not a server error.
async function checkRemote() {
  const current = local();
  let remote = null;
  for (const url of SOURCES) {
    try {
      remote = await fetchOne(url);
      if (remote.version !== '0.0') break;
      remote = null;
    } catch (e) {
      remote = null;
    }
  }
  if (!remote) {
    return { ok: false, error: '连不上更新源，请稍后再试或到 GitHub 仓库查看', local: current };
  }
  const cmp = compare(remote.version, current.version);
  return {
    ok: true,
    local: current,
    remote: remote,
    state: cmp > 0 ? 'remote-newer' : (cmp < 0 ? 'local-newer' : 'same')
  };
}

module.exports = { local, checkRemote, compare, normalize };
