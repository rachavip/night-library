/* Music: embedded web player (AnyListen) by default, Subsonic bar as fallback. */
(function () {
  'use strict';

  var audio = document.getElementById('audio');
  var player = document.getElementById('player');
  var cover = document.getElementById('player-cover');
  var titleEl = document.getElementById('player-title');
  var artistEl = document.getElementById('player-artist');
  var playBtn = document.getElementById('player-play');
  var toggle = document.getElementById('music-toggle');
  var volume = document.getElementById('player-volume');
  var panel = document.getElementById('music-panel');
  var frame = document.getElementById('music-frame');
  var panelTitle = document.getElementById('music-panel-title');
  var panelClose = document.getElementById('music-panel-close');

  var songs = [];
  var index = -1;
  var mode = 'embed';
  var musicUrl = '';
  var configured = false;
  var open = false;
  var toastFn = window.nightToast || function () {};

  function normalizeUrl(raw) {
    var v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v;
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

  function openPanel() {
    var url = normalizeUrl(musicUrl);
    if (!url) { toastFn('请先在设置里填写音乐地址'); return; }
    if (frame.getAttribute('src') !== url) frame.setAttribute('src', url);
    panelTitle.textContent = '♫ 音乐 · ' + url.replace(/^https?:\/\//, '');
    panel.classList.add('is-open');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-pressed', 'true');
    open = true;
  }

  function closePanel() {
    if (!open) return;
    panel.classList.remove('is-open');
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-pressed', 'false');
    open = false;
    // The iframe stays alive so music keeps playing while browsing books.
  }

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

  window.nightMusic = {
    configure: function (musicCfg) {
      mode = (musicCfg && musicCfg.mode === 'subsonic') ? 'subsonic' : 'embed';
      musicUrl = (musicCfg && musicCfg.url) || '';
      configured = Boolean(musicUrl);
      if (musicCfg && musicCfg.volume != null) setVolume(musicCfg.volume);
      toggle.title = mode === 'embed' ? '打开音乐' : (configured ? '随机播放音乐' : '随机播放音乐（先在设置里配置服务）');
      toggle.setAttribute('aria-label', toggle.title);
      if (mode === 'embed') hideSubsonic(); else closePanel();
    },
    loadRandom: loadRandom
  };
})();
