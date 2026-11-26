/*
 * Subsonic-compatible client (Navidrome / Airsonic / Subsonic / Gonic ...).
 * The browser never talks to the music server directly: this module proxies
 * it, which avoids CORS and keeps credentials inside the container.
 */
const crypto = require('crypto');

function normalizeBase(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('还没有填写音乐服务地址');
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw new Error('音乐服务地址格式不对：' + url); }
  if (!parsed.hostname) throw new Error('音乐服务地址缺少主机名或 IP');
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

function authParams(music) {
  const params = { u: music.user || 'admin', v: '1.16.1', c: 'NightLibrary', f: 'json' };
  if (music.password) {
    const salt = crypto.randomBytes(8).toString('hex');
    params.s = salt;
    params.t = crypto.createHash('md5').update(music.password + salt).digest('hex');
  } else if (music.token) {
    params.s = music.salt || '';
    params.t = music.token;
  }
  return params;
}

function buildUrl(music, endpoint, extra) {
  const base = normalizeBase(music.url);
  const query = new URLSearchParams({ ...authParams(music), ...(extra || {}) });
  return base + '/rest/' + endpoint + '.view?' + query.toString();
}

async function call(music, endpoint, extra) {
  const url = buildUrl(music, endpoint, extra);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('音乐服务返回 HTTP ' + res.status);
    const data = await res.json();
    const payload = data['subsonic-response'];
    if (!payload) throw new Error('响应不是 Subsonic 格式');
    if (payload.status === 'failed') {
      throw new Error((payload.error && payload.error.message) || '音乐服务拒绝了请求');
    }
    return payload;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接音乐服务超时');
    if (e instanceof TypeError) throw new Error('连不上音乐服务，请检查 IP、端口和容器网络');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function ping(music) {
  const payload = await call(music, 'ping');
  return { ok: true, version: payload.version || '', type: payload.type || 'Subsonic' };
}

function normalizeSong(song) {
  return {
    id: String(song.id || ''),
    title: String(song.title || '未命名曲目'),
    artist: String(song.artist || '未知艺术家'),
    album: String(song.album || ''),
    coverId: song.coverArt != null ? String(song.coverArt) : '',
    duration: Number(song.duration) || 0
  };
}

async function randomSongs(music, size) {
  const payload = await call(music, 'getRandomSongs', { size: String(size || 40) });
  const list = (payload.randomSongs && payload.randomSongs.song) || [];
  return list.map(normalizeSong).filter(song => song.id);
}

function streamUrl(music, id) {
  return buildUrl(music, 'stream', { id: String(id) });
}

function coverUrl(music, id, size) {
  return buildUrl(music, 'getCoverArt', { id: String(id), size: String(size || 160) });
}

/* Generic reachability check for embedded web players (AnyListen etc.). */
async function probe(rawUrl) {
  let url;
  try { url = normalizeBase(rawUrl); }
  catch (e) { throw e; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (res.status >= 400 && res.status !== 401 && res.status !== 403) {
      throw new Error('网页播放器返回 HTTP ' + res.status);
    }
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return { ok: true, type: 'embed', url, title: m ? m[1].trim().slice(0, 80) : '网页播放器', status: res.status };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接超时，请检查 IP 和端口');
    if (e instanceof TypeError) throw new Error('连不上这个地址，请检查 IP、端口和容器网络');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ping, probe, randomSongs, streamUrl, coverUrl, normalizeBase };
