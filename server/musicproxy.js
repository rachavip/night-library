/*
 * Reverse proxy for embedded web music players (AnyListen and friends).
 *
 * The player normally lives on another port, e.g. 9500. A page on 8421 cannot
 * reach into that iframe because of the browser's same-origin policy, so the
 * transport buttons on the shelf can only focus the player, not drive it.
 *
 * Serving the player through /music-proxy/ makes it same-origin: the browser
 * thinks it came from 8421, and the shelf can click the player's own
 * [aria-label=播放|暂停|上一曲|下一曲] buttons directly.
 *
 * Both HTTP and WebSocket have to be forwarded - AnyListen drives its player
 * over a WebSocket at /api/ipc/socket.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PREFIX = '/music-proxy';

function targetUrl(rawUrl) {
  let raw = String(rawUrl || '').trim();
  if (!raw) throw new Error('还没有填写音乐服务地址');
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  const u = new URL(raw);
  // /music-proxy/api/... -> http://host:port/api/...
  return { origin: u.origin, pathBase: u.pathname.replace(/\/$/, ''), protocol: u.protocol };
}

/* Express middleware. req.url still contains the /music-proxy prefix. */
function middleware(req, res, next) {
  if (!req.url || !req.url.startsWith(PREFIX + '/')) return next();
  let t;
  try { t = targetUrl(getMusicUrl()); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const suffix = req.url.slice(PREFIX.length); // "/api/..." or "/index.js"
  const path = (t.pathBase === '/' ? '' : t.pathBase) + suffix;
  const url = t.origin + path;

  const headers = { ...req.headers };
  // The upstream must see its own host, otherwise AnyListen builds absolute
  // URLs (and its WebSocket ticket) against 8421.
  headers.host = new URL(t.origin).host;
  delete headers['accept-encoding']; // avoid compressed bodies we cannot rewrite

  const lib = t.protocol === 'https:' ? https : http;
  const upstream = lib.request(url, { method: req.method, headers }, up => {
    const outHeaders = { ...up.headers };
    delete outHeaders['content-length']; // streaming may change the length
    delete outHeaders['content-encoding'];
    delete outHeaders['transfer-encoding'];
    // A site that forbids framing would break the iframe; drop the header.
    delete outHeaders['x-frame-options'];
    if (outHeaders['content-security-policy']) {
      outHeaders['content-security-policy'] = outHeaders['content-security-policy']
        .replace(/frame-ancestors\s+[^;]+;?/gi, '');
    }
    res.writeHead(up.statusCode || 502, outHeaders);
    up.pipe(res);
  });
  upstream.on('error', e => {
    if (!res.headersSent) res.status(502).json({ error: '代理音乐服务失败：' + e.message });
    else res.end();
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(upstream);
  else upstream.end();
}

/* WebSocket upgrade. Must be attached to the underlying http.Server. */
function upgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(PREFIX + '/')) return; // let other handlers try
    // A failed proxy upgrade must never take the whole server down.
    socket.on('error', () => {});
    let t;
    try { t = targetUrl(getMusicUrl()); }
    catch (e) { socket.destroy(); return; }

    const suffix = req.url.slice(PREFIX.length);
    const path = (t.pathBase === '/' ? '' : t.pathBase) + suffix;
    // Keep an http(s) URL: http.request performs the HTTP upgrade handshake,
    // it rejects a ws: protocol. The 101 response is relayed to the browser.
    const u = new URL(t.origin + path);
    const headers = { ...req.headers };
    headers.host = u.host;
    const lib = t.protocol === 'https:' ? https : http;
    const up = lib.request(u.href, { method: 'GET', headers });
    up.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      // Browsers require Sec-WebSocket-Accept; without it the handshake fails
      // even though the upstream connection succeeded.
      const accept = res.headers['sec-websocket-accept'];
      if (!accept) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n' +
        (res.headers['sec-websocket-protocol']
          ? 'Sec-WebSocket-Protocol: ' + res.headers['sec-websocket-protocol'] + '\r\n' : '') +
        '\r\n'
      );
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      if (head && head.length) upstreamSocket.write(head);
    });
    up.on('error', () => {
      try { socket.destroy(); } catch (e) { /* ignore */ }
    });
    // Upstream refused the upgrade (e.g. auth error): pass its status through
    // instead of leaving the browser waiting forever.
    up.on('response', res => {
      socket.write('HTTP/1.1 ' + (res.statusCode || 502) + ' Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    up.end();
  });
}

let getMusicUrl = () => '';

function setMusicUrl(fn) {
  if (typeof fn === 'function') getMusicUrl = fn;
}

module.exports = { middleware, upgrade, setMusicUrl, PREFIX };
