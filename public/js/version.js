/* Version badge in the header: shows the version baked into this image and
 * compares it with version.json on GitHub so the user can tell at a glance
 * whether the running image matches the latest uploaded code. */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  var badge = el('version-badge');
  var pop = el('version-pop');
  if (!badge || !pop) return;

  var CHECK_KEY = 'nightly-version-check';
  var CHECK_TTL = 30 * 60 * 1000; // 30 minutes
  var current = null;

  function render(v) {
    current = v || {};
    badge.textContent = '当前版本：' + (current.version || '0.0');
    el('version-current').textContent = '当前版本：' + (current.version || '0.0');
    el('version-date').textContent = current.date ? '更新于 ' + current.date : '';
    var list = el('version-notes');
    list.innerHTML = '';
    (current.notes || []).forEach(function (note) {
      var li = document.createElement('li');
      li.textContent = note;
      list.appendChild(li);
    });
    var result = el('version-result');
    result.textContent = '';
    result.className = 'version-result';
  }

  // Highlight the badge only when GitHub is strictly newer. "local-newer"
  // means unsaved/unuploaded changes and must not look like an available update.
  function markBadge(data) {
    var hasUpdate = Boolean(data && data.ok && data.state === 'remote-newer');
    badge.classList.toggle('has-update', hasUpdate);
    badge.setAttribute('title', hasUpdate
      ? 'GitHub 上是当前版本：' + data.remote.version + '，点此查看'
      : '版本与更新');
    return hasUpdate;
  }

  function cachedCheck() {
    try {
      var raw = sessionStorage.getItem(CHECK_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || Date.now() - saved.at > CHECK_TTL) return null;
      return saved.data;
    } catch (e) {
      return null;
    }
  }

  function rememberCheck(data) {
    try {
      sessionStorage.setItem(CHECK_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) { /* private mode - just skip caching */ }
  }

  function setOpen(open) {
    pop.hidden = !open;
    badge.setAttribute('aria-expanded', String(open));
  }

  function showResult(text, cls) {
    var out = el('version-result');
    out.textContent = text;
    out.className = 'version-result' + (cls ? ' ' + cls : '');
  }

  async function requestCheck() {
    var res = await fetch('/api/version/check');
    return res.json();
  }

  function describe(data) {
    if (!data.ok || !data.remote) {
      return [data.error || '检查失败，请稍后再试', 'is-error'];
    }
    if (data.state === 'same') {
      return ['已是最新版 · 当前版本：' + data.local.version, 'is-amber'];
    }
    if (data.state === 'remote-newer') {
      return ['GitHub 上是当前版本：' + data.remote.version + '，重新上传文件并等构建完成后更新镜像', 'is-amber'];
    }
    return ['本机当前版本：' + data.local.version + '，比 GitHub 上的 ' + data.remote.version + ' 新，改动可能还没上传', 'is-amber'];
  }

  // Manual check always hits the network and refreshes the cache.
  async function check() {
    var btn = el('version-check-btn');
    btn.disabled = true;
    showResult('正在检查…');
    try {
      var data = await requestCheck();
      rememberCheck(data);
      markBadge(data);
      var msg = describe(data);
      showResult(msg[0], msg[1]);
    } catch (e) {
      showResult('检查失败：' + e.message, 'is-error');
    } finally {
      btn.disabled = false;
    }
  }

  // Background check on load: silent, cached, never blocks the page.
  async function autoCheck() {
    var data = cachedCheck();
    if (!data) {
      try {
        data = await requestCheck();
        rememberCheck(data);
      } catch (e) {
        return;
      }
    }
    markBadge(data);
  }

  badge.addEventListener('click', function () { setOpen(pop.hidden); });
  el('version-close').addEventListener('click', function () { setOpen(false); badge.focus(); });
  el('version-check-btn').addEventListener('click', check);
  document.addEventListener('click', function (e) {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== badge) setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pop.hidden) { setOpen(false); badge.focus(); }
  });

  fetch('/api/version').then(function (r) { return r.json(); }).then(function (v) {
    render(v);
    setTimeout(autoCheck, 600);
  }).catch(function () {
    render({ version: '0.0', date: '', notes: [], highlights: [] });
  });
})();
