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
const dns = require('dns');
const https = require('https');

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

/* 一次请求最多等 15 秒。这个上限得由我们自己说了算：之前用 fetch，Node 的
 * fetch（undici）把「建立连接」硬编码成 10 秒，报出来的 UND_ERR_CONNECT_TIMEOUT
 * 比我们设的 15 秒还早——看着像「连不上」，其实只是握手慢（线路要重传好几轮）。
 * 换成 https.request 后，计时全在自己手里，也能指定只用 IPv4。 */
const TIMEOUT_MS = 15000;

function remoteName(entry) {
  const name = (entry.name || '匿名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 24);
  return REMOTE_DIR + '/' + stamp() + '-' + entry.id.slice(0, 6) + '-' + name + '.md';
}

function reason(err) {
  const cause = (err && err.cause) || {};
  const code = (err && err.code) || cause.code || '';
  const raw = (err && err.message) || cause.message || '';
  const msg = String(raw).replace(/^fetch failed:?\s*/i, '').slice(0, 110);
  return code && msg.indexOf(code) < 0 ? '（' + code + '）' + msg : msg;
}

/* 直连 api.github.com 的小封装：只用 IPv4，超时自己管，返回状态码和耗时。
 * 证书错误、连接被拒、域名解析失败都会带着各自的 code 抛出来，方便报给使用者。 */
function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const req = https.request({
      host: 'api.github.com',
      port: 443,
      family: 4,
      method: options.method || 'GET',
      path: options.path,
      headers: options.headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          ms: Date.now() - started
        });
      });
    });
    req.setTimeout(TIMEOUT_MS, () => {
      const err = new Error('等 ' + Math.round(TIMEOUT_MS / 1000) + ' 秒还没握手完成');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', e => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/* 一次 PUT。HTTP 4xx/5xx 是 GitHub 的明确答复，原样抛；连不上则把底层原因
 * （ECONNRESET / ETIMEDOUT / 证书错误…）翻出来给人看。 */
async function putOnce(pathname, body, token) {
  try {
    const res = await httpsRequest({
      method: 'PUT',
      path: pathname,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'night-library-guestbook'
      },
      body
    });
    if (res.status < 200 || res.status >= 300) {
      let detail = '';
      try { detail = String(JSON.parse(res.body).message || '').slice(0, 110); } catch (e) { /* ignore */ }
      const err = new Error('GitHub ' + res.status + (detail ? '：' + detail : ''));
      err.httpStatus = res.status;
      throw err;
    }
    return res;
  } catch (e) {
    if (e.httpStatus) throw e;
    if (e.code === 'ETIMEDOUT') throw new Error('GitHub 连接超时（15 秒没完成握手）');
    throw new Error('GitHub 连接失败' + reason(e));
  }
}

/* GitHub Contents API. Each message gets its own file so two submissions can
 * never fight over the same SHA. A token without repo write scope gets a clean
 * error back instead of a stack trace.
 * tries 由调用方给：提交留言时只有一次（人还在等回复，不能让他等三十秒）；
 * 手动「补传」可以多试一次，反正按钮转一会儿没人在意。 */
async function pushToGitHub(entry, token, tries) {
  const remotePath = remoteName(entry);
  const pathname = '/repos/' + REPO + '/contents/' + encodeURI(remotePath);
  const body = JSON.stringify({
    message: 'guestbook: ' + entry.name + ' ' + entry.createdAt,
    content: Buffer.from(markdown(entry), 'utf8').toString('base64'),
    branch: BRANCH
  });
  const attempts = Math.max(1, Number(tries) || 1);
  for (let i = 0; i < attempts; i++) {
    try {
      await putOnce(pathname, body, token);
      return remotePath;
    } catch (e) {
      if (e.httpStatus || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return remotePath;
}

/* 令牌填得比留言晚是常态：那时候提交的留言标着 synced=false，之后再也没人
 * 碰过它。这里把没传上去的逐条补上，中途只要有一条失败就停——连着失败说明
 * 线路不通，继续等下去只会让按钮转很久。 */
async function resync(cfg, settings) {
  const token = String((settings && settings.guestbookToken) || '');
  if (!token) return { pending: 0, pushed: 0, failed: 0, error: '还没有填 GitHub 令牌' };
  const entries = await readEntries(cfg);
  const waiting = entries.filter(e => !e.synced);
  if (!waiting.length) return { pending: 0, pushed: 0, failed: 0, error: '' };

  const todo = waiting.slice(0, 20);
  let pushed = 0;
  let error = '';
  for (const item of todo) {
    try {
      item.githubPath = await pushToGitHub(item, token, 2);
      item.synced = true;
      pushed++;
    } catch (e) {
      error = String(e.message || e).slice(0, 160);
      break;
    }
  }
  if (pushed) {
    // 只把同步结果写回去，不整体覆盖，避免和正在提交的新留言打架。
    const fresh = await readEntries(cfg);
    todo.forEach(item => {
      const hit = fresh.find(e => e.id === item.id);
      if (hit && item.synced) { hit.synced = true; hit.githubPath = item.githubPath; }
    });
    await writeEntries(cfg, fresh);
  }
  return { pending: waiting.length, pushed, failed: waiting.length - pushed, error };
}

/* 出网体检：DNS 解析到哪个地址、到 api.github.com 能不能通、令牌能不能读到
 * 仓库。三项分开报，才能分清是「域名解析不了」「线路不通」还是「令牌不对」。
 * 只读，不写任何东西。走的是和同步同一条路（https.request + IPv4 + 15 秒），
 * 所以这里通不了的话，同步也通不了。 */
async function diag(settings) {
  const out = { dns: [], dnsError: '', api: null, repo: null, hasToken: Boolean(settings && settings.guestbookToken) };

  try {
    const list = await dns.promises.lookup('api.github.com', { all: true });
    out.dns = list.map(a => a.address);
  } catch (e) {
    out.dnsError = (e && e.code) || String(e.message || e);
  }

  const probe = async (pathname, token) => {
    const started = Date.now();
    try {
      const res = await httpsRequest({
        path: pathname,
        headers: Object.assign(
          { 'Accept': 'application/vnd.github+json', 'User-Agent': 'night-library-guestbook' },
          token ? { 'Authorization': 'Bearer ' + token } : {}
        )
      });
      return { status: res.status, ms: res.ms, error: '' };
    } catch (e) {
      return {
        status: 0,
        ms: Date.now() - started,
        error: e.code === 'ETIMEDOUT' ? '超时（15 秒没完成握手）' : reason(e)
      };
    }
  };

  out.api = await probe('/rate_limit');
  const token = String((settings && settings.guestbookToken) || '');
  if (token) out.repo = await probe('/repos/' + REPO, token);
  return out;
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
      syncError = String(e.message || e).slice(0, 160);
    }
  } else {
    syncError = '未配置 GitHub 令牌，留言只存在本机';
  }

  return { entry: forBrowser([entry])[0], syncError };
}

module.exports = { captcha, readEntries, forBrowser, submit, resync, diag };
