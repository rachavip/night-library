/* Music: resilient embedded web players, Subsonic random-play bar as fallback. */
(function () {
  'use strict';

  /* ---------- DOM ---------- */
  var audio = document.getElementById('audio');
  var player = document.getElementById('player');
  var cover = document.getElementById('player-cover');
  var titleEl = document.getElementById('player-title');
  var artistEl = document.getElementById('player-artist');
  var playBtn = document.getElementById('player-play');
  var toggle = document.getElementById('music-toggle');
  var prevBtn = document.getElementById('music-prev');
  var nextBtn = document.getElementById('music-next');
  var volume = document.getElementById('player-volume');
  var panel = document.getElementById('music-panel');
  var frame = document.getElementById('music-frame');
  var panelTitle = document.getElementById('music-panel-title');
  var panelClose = document.getElementById('music-panel-close');
  var serviceSelect = document.getElementById('music-service-select');
  var popoutBtn = document.getElementById('music-popout');
  var reloadBtn = document.getElementById('music-reload');
  var notice = document.getElementById('music-notice');
  var noticeText = document.getElementById('music-notice-text');
  var noticeActions = document.getElementById('music-notice-actions');
  var stateLayer = document.getElementById('music-state');
  var stateTitle = document.getElementById('music-state-title');
  var stateText = document.getElementById('music-state-text');
  var stateActions = document.getElementById('music-state-actions');

  var toastFn = window.nightToast || function () {};

  /* ---------- Subsonic state ---------- */
  var songs = [];
  var index = -1;
  var configured = false;

  /* ---------- embed state ---------- */
  var mode = 'embed';
  var services = [];
  var activeId = '';
  var loginUrl = '';
  var musicUrl = '';
  var currentUrl = '';
  var probeInfo = null;
  var loadToken = 0;
  var loadTimer = null;
  var state = 'idle';
  var open = false;

  function normalizeUrl(raw) {
    var v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v;
  }

  function cleanHost(url) {
    try { return new URL(url).host; }
    catch (e) { return String(url || '').replace(/^https?:\/\//, '').split('/')[0]; }
  }

  function activeService() {
    return services.find(function (s) { return s.id === activeId; }) || null;
  }

  function shuffle(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  function setVolume(v) {
    audio.volume = Math.max(0, Math.min(1, v));
    volume.value = Math.round(audio.volume * 100);
  }

  /* ---------- Subsonic bar ---------- */
  function show(song) {
    if (!song) return;
    titleEl.textContent = song.title || '未命名曲目';
    artistEl.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
    cover.src = '/api/music/cover/' + encodeURIComponent(song.coverId || song.id) + '?size=120';
    audio.src = '/api/music/stream/' + encodeURIComponent(song.id);
    audio.play().then(function () {
      playBtn.textContent = '❚❚';
      playBtn.setAttribute('aria-label', '暂停');
    }).catch(function () {
      playBtn.textContent = '▶';
      toastFn('浏览器阻止了自动播放，点一下播放按钮即可');
    });
  }

  async function loadRandom() {
    if (!configured) { toastFn('请先在设置里填写音乐服务地址'); return; }
    try {
      var res = await fetch('/api/music/random?size=50');
      var data = await res.json();
      if (!res.ok || !data.songs || !data.songs.length) {
        toastFn((data && data.error) || '音乐服务里没有可播放的歌曲');
        return;
      }
      songs = shuffle(data.songs);
      index = 0;
      player.hidden = false;
      document.body.classList.add('has-player');
      show(songs[0]);
    } catch (e) {
      toastFn('读取歌单失败：' + e.message);
    }
  }

  function step(delta) {
    if (!songs.length) return loadRandom();
    index = (index + delta + songs.length) % songs.length;
    show(songs[index]);
  }

  function hideSubsonic() {
    if (player.hidden) return;
    player.hidden = true;
    document.body.classList.remove('has-player');
    audio.pause();
  }

  /* ---------- embedded player states ---------- */
  function renderActions(container, actions) {
    container.innerHTML = '';
    (actions || []).forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = action.primary ? 'primary-btn' : 'ghost-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      container.appendChild(btn);
    });
  }

  // Blocking states hide the iframe entirely: connecting, unreachable, timeout.
  function setBlockingState(next, title, text, actions) {
    state = next;
    if (!stateLayer) return;
    if (!title) {
      stateLayer.hidden = true;
      return;
    }
    stateLayer.hidden = false;
    stateTitle.textContent = title;
    stateText.textContent = text || '';
    renderActions(stateActions, actions);
  }

  // Soft notices keep the iframe visible so a login page can be used in place.
  function showNotice(text, actions) {
    if (!notice) return;
    notice.hidden = false;
    noticeText.textContent = text;
    renderActions(noticeActions, actions);
  }

  function clearNotice() {
    if (notice) notice.hidden = true;
  }

  function openSettings() {
    closePanel();
    var btn = document.getElementById('settings-toggle');
    if (btn) btn.click();
  }

  function popout() {
    if (currentUrl) window.open(currentUrl, '_blank', 'noopener');
  }

  function openLogin() {
    var target = normalizeUrl(loginUrl) || currentUrl;
    if (target) window.open(target, '_blank', 'noopener');
  }

  function renderServiceSelect() {
    if (!serviceSelect) return;
    serviceSelect.innerHTML = '';
    services.forEach(function (s) {
      var option = document.createElement('option');
      option.value = s.id;
      option.textContent = s.name || s.id;
      serviceSelect.appendChild(option);
    });
    serviceSelect.value = activeId;
    serviceSelect.hidden = mode !== 'embed' || services.length < 2;
  }

  // Probe first, then mount the iframe. A failed probe never leaves a blank frame.
  function probeAndLoad(attempt) {
    var token = ++loadToken;
    clearTimeout(loadTimer);
    setBlockingState('probing', '正在连接音乐服务', cleanHost(currentUrl) + (attempt ? ' · 第 ' + (attempt + 1) + ' 次尝试' : ''));
    clearNotice();
    frame.removeAttribute('src');

    fetch('/api/music/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (token !== loadToken) return;
        if (!data.configured) throw new Error('还没有配置音乐服务地址');
        if (!data.ok) throw new Error(data.error || '连接失败');
        probeInfo = data;
        mountFrame(token, attempt);
      })
      .catch(function (e) {
        if (token !== loadToken) return;
        if (attempt < 2 && /超时|连不上|网络|Failed/i.test(e.message)) {
          setTimeout(function () { if (token === loadToken) probeAndLoad(attempt + 1); }, 600);
          return;
        }
        setBlockingState('error', '连不上音乐服务',
          e.message + '。检查服务是否已启动，或到设置里确认地址。', [
            { label: '重试', primary: true, onClick: function () { loadCurrent(); } },
            { label: '打开设置', onClick: openSettings }
          ]);
      });
  }

  function mountFrame(token, attempt) {
    setBlockingState(null);
    var settled = false;

    frame.onload = function () {
      if (token !== loadToken || settled) return;
      settled = true;
      clearTimeout(loadTimer);
      var svc = activeService();
      if (probeInfo && probeInfo.loginRequired) {
        showNotice((svc && svc.loginUrl) ? '登录页已在新窗口打开；也可以直接在下方登录。'
          : '这个服务可能需要登录。可直接在下方登录，登录后再点「重新加载」。', [
          { label: '打开登录页', primary: true, onClick: openLogin },
          { label: '重新加载', onClick: function () { loadCurrent(); } }
        ]);
      } else if (probeInfo && !probeInfo.embeddable) {
        showNotice('这个站点设置了嵌入限制。如果下方空白，点「新窗口打开」照常播放。', [
          { label: '新窗口打开', primary: true, onClick: popout }
        ]);
      }
    };

    frame.setAttribute('src', currentUrl);

    loadTimer = setTimeout(function () {
      if (token !== loadToken || settled) return;
      settled = true;
      if (attempt < 2) {
        setTimeout(function () { if (token === loadToken) probeAndLoad(attempt + 1); }, 400);
        return;
      }
      setBlockingState('timeout', '播放器加载超时',
        '服务有响应，但页面迟迟没打开。点重试，或改用新窗口播放。', [
          { label: '重试', primary: true, onClick: function () { loadCurrent(); } },
          { label: '新窗口打开', onClick: popout }
        ]);
    }, 12000);
  }

  function loadCurrent() {
    var svc = activeService();
    var url = normalizeUrl((svc && svc.url) || musicUrl);
    if (!url) {
      setBlockingState('error', '还没有填写地址', '到设置 → 音乐里填一个服务地址，回来点 ♫ 即可。', [
        { label: '打开设置', primary: true, onClick: openSettings }
      ]);
      return;
    }
    currentUrl = url;
    loginUrl = (svc && svc.loginUrl) || '';
    panelTitle.textContent = '♫ ' + ((svc && svc.name) || cleanHost(url));
    probeAndLoad(0);
  }

  // The transport buttons cannot drive AnyListen - it is a separate site with
  // no control API. They open the panel and hand focus to the iframe so the
  // keyboard (space / arrows) works inside the real player.
  function focusPlayer() {
    try { frame.focus(); } catch (e) { /* cross-origin focus is best-effort */ }
  }

  function openPanel() {
    if (mode !== 'embed') return;
    panel.classList.add('is-open');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-pressed', 'true');
    toggle.textContent = '❚❚';
    open = true;
    if (state === 'idle' || state === 'error' || state === 'timeout') loadCurrent();
    setTimeout(focusPlayer, 400);
  }

  function closePanel() {
    if (!open) return;
    panel.classList.remove('is-open');
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.textContent = '▶';
    open = false;
    // The iframe stays alive so music keeps playing while browsing books.
  }

  async function switchService(id) {
    if (id === activeId) return;
    try {
      var res = await fetch('/api/music/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
      });
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '切换失败');
      var svc = services.find(function (s) { return s.id === id; });
      activeId = data.activeId || id;
      if (svc) svc.url = data.url;
      renderServiceSelect();
      loadCurrent();
      if (data.urlFromEnv) toastFn('当前地址由 compose 指定，网页切换不会覆盖它');
    } catch (e) {
      if (serviceSelect && activeId) serviceSelect.value = activeId;
      toastFn(e.message);
    }
  }

  /* ---------- events ---------- */
  // Prev / next focus the embedded player so its own keys can be used. They
  // never fake a track change - that would be a button lying to the user.
  function focusOrOpen() {
    if (mode === 'embed') {
      if (!open) openPanel();
      else focusPlayer();
    } else if (player.hidden) {
      loadRandom().then(function () {
        toggle.setAttribute('aria-pressed', String(!player.hidden));
      });
    }
  }
  if (prevBtn) prevBtn.addEventListener('click', focusOrOpen);
  if (nextBtn) nextBtn.addEventListener('click', focusOrOpen);

  toggle.addEventListener('click', function () {
    if (mode === 'embed') {
      if (open) closePanel(); else openPanel();
      return;
    }
    if (player.hidden) {
      loadRandom().then(function () {
        toggle.setAttribute('aria-pressed', String(!player.hidden));
      });
    } else {
      hideSubsonic();
      toggle.setAttribute('aria-pressed', 'false');
    }
  });

  panelClose.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) closePanel();
  });
  if (serviceSelect) serviceSelect.addEventListener('change', function (e) { switchService(e.target.value); });
  if (popoutBtn) popoutBtn.addEventListener('click', popout);
  if (reloadBtn) reloadBtn.addEventListener('click', function () { if (state !== 'idle') loadCurrent(); });

  playBtn.addEventListener('click', function () {
    if (!songs.length) return loadRandom();
    if (audio.paused) audio.play(); else audio.pause();
  });

  document.getElementById('player-next').addEventListener('click', function () { step(1); });
  document.getElementById('player-prev').addEventListener('click', function () { step(-1); });
  volume.addEventListener('input', function (e) { setVolume(Number(e.target.value) / 100); });
  audio.addEventListener('play', function () { playBtn.textContent = '❚❚'; });
  audio.addEventListener('pause', function () { playBtn.textContent = '▶'; });
  audio.addEventListener('ended', function () { step(1); });
  audio.addEventListener('error', function () { toastFn('这首歌无法播放，正在跳到下一首'); step(1); });

  /* ---------- public API used by settings.js ---------- */
  window.nightMusic = {
    configure: function (musicCfg) {
      var cfg = musicCfg || {};
      mode = cfg.mode === 'subsonic' ? 'subsonic' : 'embed';
      services = Array.isArray(cfg.services)
        ? cfg.services.filter(function (s) { return s && normalizeUrl(s.url); })
        : [];
      activeId = cfg.activeId || '';
      if (!activeService()) activeId = services.length ? services[0].id : '';
      var svc = activeService();
      musicUrl = (svc && svc.url) || cfg.url || '';
      loginUrl = (svc && svc.loginUrl) || '';
      configured = Boolean(musicUrl);
      if (cfg.volume != null) setVolume(cfg.volume);

      // AnyListen keeps its own login. Say so on the control itself: without
      // a prior login the embedded page shows a password box instead of music.
      toggle.title = mode === 'embed'
        ? '打开音乐（播放器需提前登录一次账号）'
        : (configured ? '随机播放音乐' : '随机播放音乐（先在设置里配置服务）');
      toggle.setAttribute('aria-label', toggle.title);
      if (prevBtn) prevBtn.title = '聚焦播放器切上一曲（需提前登录 AnyListen）';
      if (nextBtn) nextBtn.title = '聚焦播放器切下一曲（需提前登录 AnyListen）';
      renderServiceSelect();

      if (mode === 'embed') {
        hideSubsonic();
        // A settings save may have changed the address - reload on next open.
        if (open) loadCurrent();
      } else {
        closePanel();
        clearTimeout(loadTimer);
        ++loadToken;
        frame.removeAttribute('src');
        clearNotice();
        setBlockingState(null);
        state = 'idle';
      }
    },
    loadRandom: loadRandom
  };
})();
