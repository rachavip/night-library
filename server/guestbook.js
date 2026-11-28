/*
 * Guestbook: a small board on the shelf page. Visitors leave a name, email and
 * message; each entry is saved under DATA_DIR and, when a GitHub token has been
 * configured, written to the repository's messages/ folder as a Markdown file.
 *
 * No new dependency: Node 18+ has fetch and crypto built in. The captcha is a
 * one-time arithmetic question held in memory - enough to stop drive-by bots
 * without installing a canvas renderer or shipping a font into the image.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const REPO = 'rachavip/night-library';
const BRANCH = 'main';
const REMOTE_DIR = 'messages';
const MAX_ENTRIES = 500;
const MAX_NAME = 30;
const MAX_EMAIL = 120;
const MAX_SITE = 120;
const MAX_CONTENT = 800;
const CAPTCHA_TTL = 5 * 60 * 1000;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 3;

const captchas = new Map();
const attempts = new Map();

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function file(cfg) {
  return path.join(cfg.dataDir, 'guestbook.json');
}

/* Hide the beginning of the address so later readers cannot copy a full
 * email, while keeping the last few characters to tell people apart.
 * The full address stays in DATA_DIR/guestbook.json on the NAS only. */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 5) return '***' + domain;
  return '***' + local.slice(-3) + domain;
}

function prune() {
  const now = Date.now();
  for (const [k, v] of captchas) if (v.expires < now) captchas.delete(k);
  for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
}

function captcha() {
  prune();
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const nonce = crypto.randomBytes(12).toString('hex');
  captchas.set(nonce, { answer: a + b, expires: Date.now() + CAPTCHA_TTL });
  return { nonce, question: a + ' + ' + b + ' = ?' };
}

async function readEntries(cfg) {
  try {
    const data = JSON.parse(await fsp.readFile(file(cfg), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function forBrowser(entries) {
  return entries.map(e => ({
    id: e.id,
    name: e.name,
    email: maskEmail(e.email),
    site: e.site || '',
    content: e.content,
    createdAt: e.createdAt,
    synced: Boolean(e.synced)
  }));
}

async function writeEntries(cfg, entries) {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  const tmp = file(cfg) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), 'utf8');
  await fsp.rename(tmp, file(cfg));
}

function rateOK(ip) {
  prune();
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, until: now + RATE_WINDOW };
  if (rec.until < now) { rec.count = 0; rec.until = now + RATE_WINDOW; }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count <= RATE_LIMIT;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function markdown(entry) {
  const lines = [
    '# 留言 · ' + entry.name,
    '',
    '- 时间：' + entry.createdAt,
    // The repository is public: never publish a full email address.
    '- 邮箱：' + maskEmail(entry.email)
  ];
  if (entry.site) lines.push('- 网址：' + entry.site);
  lines.push('', entry.content, '');
  return lines.join('\n');
}

/* GitHub Contents API. Each message gets its own file so two submissions can
 * never fight over the same SHA. A token without repo write scope gets a clean
 * error back instead of a stack trace. */
async function pushToGitHub(entry, token) {
  const name = (entry.name || '匿名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 24);
  const remotePath = REMOTE_DIR + '/' + stamp() + '-' + entry.id.slice(0, 6) + '-' + name + '.md';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + REPO + '/contents/' + encodeURI(remotePath),
      {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'night-library-guestbook'
        },
        body: JSON.stringify({
          message: 'guestbook: ' + entry.name + ' ' + entry.createdAt,
          content: Buffer.from(markdown(entry), 'utf8').toString('base64'),
          branch: BRANCH
        }),
        signal: controller.signal
      }
    );
    if (!res.ok) {
      let detail = '';
      try { detail = ((await res.json()).message || '').slice(0, 120); } catch (e) { /* ignore */ }
      throw new Error('GitHub ' + res.status + (detail ? '：' + detail : ''));
    }
    return remotePath;
  } finally {
    clearTimeout(timer);
  }
}

async function submit(cfg, settings, body, ip) {
  const data = body || {};
  const name = clean(data.name, MAX_NAME);
  const email = clean(data.email, MAX_EMAIL);
  const site = clean(data.site, MAX_SITE);
  const content = clean(data.content, MAX_CONTENT);
  if (!name || !email || !content) throw new Error('昵称、邮箱和留言内容都要填写');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱格式看起来不对');
  // 网址是选填的；写了就必须是 http(s)，否则前端会把它渲染成一个点不开的链接。
  if (site && !/^https?:\/\/[^\s<>"]+$/i.test(site)) throw new Error('网址要以 http:// 或 https:// 开头');

  if (!rateOK(ip)) throw new Error('留言太频繁了，一分钟后再试一次');

  const answer = Number(data.answer);
  const nonce = String(data.nonce || '');
  const c = captchas.get(nonce);
  if (!c || c.expires < Date.now()) throw new Error('验证码过期了，点一下刷新再试');
  // Delete by the map key. The stored object has no `nonce` field, so using
  // c.nonce here silently kept the captcha alive and allowed replay.
  captchas.delete(nonce);
  if (!isFinite(answer) || answer !== c.answer) throw new Error('验证码算错了，点一下刷新再试');

  const token = String(settings.guestbookToken || '');
  const entry = {
    id: crypto.randomUUID(),
    name,
    email,
    site,
    content,
    createdAt: new Date().toISOString(),
    synced: false,
    githubPath: ''
  };

  // Save locally first: a GitHub outage must not lose what somebody wrote.
  const entries = await readEntries(cfg);
  entries.push(entry);
  await writeEntries(cfg, entries);

  let syncError = '';
  if (token) {
    try {
      entry.githubPath = await pushToGitHub(entry, token);
      entry.synced = true;
      const fresh = await readEntries(cfg);
      const hit = fresh.find(e => e.id === entry.id);
      if (hit) { hit.synced = true; hit.githubPath = entry.githubPath; await writeEntries(cfg, fresh); }
    } catch (e) {
      syncError = e.name === 'AbortError' ? 'GitHub 连接超时' : String(e.message || e).slice(0, 160);
    }
  } else {
    syncError = '未配置 GitHub 令牌，留言只存在本机';
  }

  return { entry: forBrowser([entry])[0], syncError };
}

module.exports = { captcha, readEntries, forBrowser, submit };
