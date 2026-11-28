/* Read aloud.
 *
 * The voice comes from the device itself (Web Speech API), so nothing has to be
 * installed on the NAS and no audio files are stored. What this file does is
 * the boring part: cut the page into sentences short enough for every browser,
 * feed them one at a time, and walk to the next page when the queue runs dry.
 *
 * It never touches reader.js internals - everything it needs comes from
 * window.NightReaderSpeech.
 */
(function () {
  'use strict';

  var synth = window.speechSynthesis;
  var Utterance = window.SpeechSynthesisUtterance;

  var bar = document.getElementById('tts-bar');
  var openBtn = document.getElementById('tts-open');
  var playBtn = document.getElementById('tts-play');
  var prevBtn = document.getElementById('tts-prev');
  var nextBtn = document.getElementById('tts-next');
  var closeBtn = document.getElementById('tts-close');
  var rateInput = document.getElementById('tts-rate');
  var rateOut = document.getElementById('tts-rate-out');
  var voiceSel = document.getElementById('tts-voice');
  var whereEl = document.getElementById('tts-where');

  if (!bar || !openBtn) return;

  var RATE_KEY = 'reader-tts-rate';
  var VOICE_KEY = 'reader-tts-voice';
  // Chrome silently drops very long utterances and gets stuck waiting for an
  // onend that never fires. 120 characters is roughly half a minute of Chinese
  // speech - short enough to be safe, long enough not to sound choppy.
  var MAX_SENTENCE = 120;

  var state = {
    open: false,
    playing: false,
    paused: false,
    queue: [],
    index: 0,
    rate: Number(localStorage.getItem(RATE_KEY)) || 1,
    voiceURI: localStorage.getItem(VOICE_KEY) || '',
    token: 0,
    probed: false,
    textBook: false,
    autoTurn: false,
    skip: 0
  };

  // Where the reader was when the queue was built. A change means somebody
  // flipped a page by hand.
  var lastLocation = '';

  function toast(message) {
    if (typeof window.nightReaderToast === 'function') window.nightReaderToast(message);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  /* ---------------- voices ---------------- */

  // Chinese voices only: reading a Chinese book with an English voice produces
  // something nobody wants to listen to. Local voices first - they work offline
  // and do not pause when the network blinks.
  function chineseVoices() {
    if (!synth) return [];
    var all = synth.getVoices() || [];
    var zh = all.filter(function (v) { return /^zh/i.test(v.lang || ''); });
    zh.sort(function (a, b) {
      var la = a.localService ? 0 : 1;
      var lb = b.localService ? 0 : 1;
      if (la !== lb) return la - lb;
      return String(a.name).localeCompare(String(b.name));
    });
    return zh;
  }

  function pickedVoice() {
    var list = chineseVoices();
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].voiceURI === state.voiceURI) return list[i];
    }
    return list[0];
  }

  function fillVoices() {
    if (!voiceSel) return;
    var list = chineseVoices();
    if (!list.length) {
      voiceSel.innerHTML = '<option value="">没有中文语音</option>';
      voiceSel.disabled = true;
      return;
    }
    voiceSel.disabled = false;
    voiceSel.innerHTML = list.map(function (v) {
      var label = v.name + (v.localService ? '' : ' · 在线');
      return '<option value="' + v.voiceURI.replace(/"/g, '&quot;') + '">' +
        label.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</option>';
    }).join('');
    var current = pickedVoice();
    if (current) voiceSel.value = current.voiceURI;
  }

  if (synth) {
    fillVoices();
    // Chrome fills the list asynchronously; without this the select stays empty
    // until something else asks again. The property form works on Safari too,
    // where speechSynthesis is not a full EventTarget.
    synth.onvoiceschanged = fillVoices;
  }

  /* ---------------- text to sentences ---------------- */

  function toSentences(paragraphs) {
    var out = [];
    (paragraphs || []).forEach(function (raw) {
      var text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      // Split on sentence enders, keeping the punctuation with its sentence.
      var parts = text.match(/[^。！？!?…；;\n]+[。！？!?…；;]?/g) || [text];
      parts.forEach(function (part) {
        var piece = part.trim();
        if (!piece) return;
        while (piece.length > MAX_SENTENCE) {
          out.push(piece.slice(0, MAX_SENTENCE));
          piece = piece.slice(MAX_SENTENCE);
        }
        if (piece) out.push(piece);
      });
    });
    return out;
  }

  /* ---------------- music gives way ---------------- */

  // The shelf lives in another tab. BroadcastChannel is the clean channel and
  // the storage event is the fallback for browsers that lack it.
  function hushMusic() {
    try {
      if (!window.__nightReadChannel && window.BroadcastChannel) {
        window.__nightReadChannel = new BroadcastChannel('night-library');
      }
      if (window.__nightReadChannel) window.__nightReadChannel.postMessage({ type: 'read-aloud' });
    } catch (e) { /* fall through to storage */ }
    try {
      localStorage.setItem('night-library:read-aloud', String(Date.now()));
    } catch (e) { /* private mode without storage still reads aloud */ }
  }

  /* ---------------- player ---------------- */

  function syncBar() {
    bar.hidden = !state.open;
    // The toast sits at the same height as this bar; lift it while the bar is up
    // so "已停止朗读" is not printed on top of the controls.
    document.body.classList.toggle('has-tts', state.open);
    playBtn.textContent = state.playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', state.playing ? '暂停朗读' : '开始朗读');
    openBtn.setAttribute('aria-pressed', String(state.open));
    var total = state.queue.length;
    if (!total) {
      whereEl.textContent = state.paused ? '已暂停' : '未开始';
    } else {
      whereEl.textContent = '第 ' + clamp(state.index + 1, 1, total) + ' / ' + total + ' 句';
    }
    prevBtn.disabled = !total || state.index <= 0;
    nextBtn.disabled = !total || state.index >= total - 1;
  }

  function speakCurrent(token) {
    if (token !== state.token) return;
    if (!state.playing || state.paused) return;
    if (state.index >= state.queue.length) {
      turnPage(token);
      return;
    }
    var text = state.queue[state.index];
    if (!text) {
      state.index++;
      speakCurrent(token);
      return;
    }
    var utterance = new Utterance(text);
    var voice = pickedVoice();
    utterance.lang = voice && voice.lang ? voice.lang : 'zh-CN';
    if (voice) utterance.voice = voice;
    utterance.rate = clamp(state.rate, 0.5, 2);
    utterance.pitch = 1;
    utterance.onend = function () {
      if (token !== state.token || !state.playing) return;
      state.index++;
      syncBar();
      speakCurrent(token);
    };
    utterance.onerror = function (event) {
      var reason = event && event.error;
      // A deliberate cancel or a newer utterance taking over is not a failure.
      if (reason === 'interrupted' || reason === 'canceled') return;
      if (token !== state.token) return;
      state.playing = false;
      state.paused = false;
      syncBar();
      if (reason === 'not-allowed') toast('浏览器拦下了自动朗读，请再点一次播放按钮');
      else toast('朗读中断：' + (reason || '未知原因'));
    };
    synth.speak(utterance);
  }

  // One page is one queue. When it runs out the reader turns the page and the
  // next section becomes the new queue - that is what makes this a book-length
  // read rather than a page-length one.
  function turnPage(token) {
    var api = window.NightReaderSpeech;
    if (!api || !api.canNext()) {
      state.playing = false;
      state.paused = false;
      syncBar();
      toast('这本书读完了');
      return;
    }
    state.playing = false;
    syncBar();
    // This page turn is ours; pageChanged must not rebuild the queue underneath.
    state.autoTurn = true;
    api.nextPage().then(function () {
      if (token !== state.token) return null;
      return api.read();
    }).then(function (got) {
      state.autoTurn = false;
      if (token !== state.token || !got) return;
      if (!got.ok) {
        // 插图页 / 空白页：再往后翻一页试试，最多连跳两页，别停在图上不动。
        if (state.skip < 2 && api.canNext()) {
          state.skip++;
          turnPage(token);
          return;
        }
        state.skip = 0;
        toast('后面没有可朗读的文字了，先停在这里');
        syncBar();
        return;
      }
      state.skip = 0;
      state.queue = toSentences(got.paragraphs);
      state.index = 0;
      state.playing = state.queue.length > 0;
      noteLocation();
      syncBar();
      if (state.playing) speakCurrent(token);
    }).catch(function () {
      state.autoTurn = false;
      if (token !== state.token) return;
      state.playing = false;
      syncBar();
      toast('翻页失败，朗读停了');
    });
  }

  // Remember where the reader is, so a manual page turn can be told apart from
  // the re-renders that happen on resize, zoom and theme changes.
  function noteLocation() {
    var api = window.NightReaderSpeech;
    try {
      lastLocation = api && api.location ? String(api.location() || '') : '';
    } catch (e) { lastLocation = ''; }
  }

  // The reader turned a page by hand. Speech was reading the previous page's
  // sentences, which are no longer on screen - start again from the new page.
  async function restartHere() {
    var token = ++state.token;
    var api = window.NightReaderSpeech;
    if (!api) return;
    var got = await api.read();
    if (token !== state.token) return;
    if (!got || !got.ok) {
      state.playing = false;
      state.paused = false;
      syncBar();
      toast(got && got.reason ? got.reason : '这一页没有可朗读的文字');
      return;
    }
    state.queue = toSentences(got.paragraphs);
    state.index = 0;
    state.playing = state.queue.length > 0;
    state.paused = false;
    noteLocation();
    syncBar();
    if (state.playing) speakCurrent(token);
  }

  function stop(quiet) {
    state.token++;
    state.playing = false;
    state.paused = false;
    state.queue = [];
    state.index = 0;
    if (synth) {
      try { synth.cancel(); } catch (e) { /* already gone */ }
    }
    syncBar();
    if (!quiet) toast('已停止朗读');
  }

  async function start(fromText) {
    if (!synth || !Utterance) {
      toast('这个浏览器不支持朗读，换 Chrome、Edge 或 Safari 试试');
      return;
    }
    var api = window.NightReaderSpeech;
    if (!api) {
      toast('书还在打开，稍等一下再试');
      return;
    }
    if (!chineseVoices().length && (synth.getVoices() || []).length) {
      toast('系统里没有中文语音，先在系统的「语音」设置里装一个中文声音');
      return;
    }

    // A scanned PDF has an empty text layer on every page. Answer that once per
    // book instead of letting the reader wonder why nothing happens.
    if (!state.probed) {
      var hasText = await api.probe();
      state.probed = true;
      state.textBook = !!hasText;
      if (!hasText) {
        toast('这本书是图片或扫描版，没有可提取的文字，暂时不能朗读');
        return;
      }
    } else if (!state.textBook) {
      toast('这本书是图片或扫描版，没有可提取的文字，暂时不能朗读');
      return;
    }

    var got = await api.read();
    // 封面、版权页、插图页在 PDF 里很常见，它们一行字都没有。默认从头读时
    // 往后翻几页找第一段真正有字的内容，而不是一点播放就报「这一页没有文字」。
    if (!fromText) {
      var tries = 0;
      while ((!got || !got.ok) && tries < 3 && api.canNext()) {
        await api.nextPage();
        tries++;
        got = await api.read();
      }
    }
    if (!got || !got.ok) {
      toast(got && got.reason ? got.reason : '这一页没有可朗读的文字');
      return;
    }
    var queue = toSentences(got.paragraphs);
    if (!queue.length) {
      toast('这一页没有可朗读的文字');
      return;
    }

    // 选中后朗读：找到包含选中文字的那一句。去掉空白再比，PDF 文本层的
    // 换行和空格与屏幕上看到的不完全一致。
    var at = 0;
    var needle = String(fromText || '').replace(/\s+/g, '').slice(0, 14);
    if (needle) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].replace(/\s+/g, '').indexOf(needle) >= 0) {
          at = i;
          break;
        }
      }
    }

    state.queue = queue;
    state.index = at;
    state.skip = 0;
    state.token++;
    state.open = true;
    state.playing = true;
    state.paused = false;
    hushMusic();
    noteLocation();
    syncBar();
    speakCurrent(state.token);
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    state.paused = true;
    if (synth) {
      try { synth.pause(); } catch (e) { /* some browsers do not implement it */ }
    }
    syncBar();
  }

  function resume() {
    if (!state.paused) return;
    state.paused = false;
    state.playing = true;
    syncBar();
    // pause() is not implemented everywhere; if the engine never paused, the
    // current sentence has to be spoken again.
    if (synth && synth.paused) {
      try { synth.resume(); return; } catch (e) { /* fall through */ }
    }
    speakCurrent(state.token);
  }

  function step(delta) {
    if (!state.queue.length) return;
    state.token++;
    if (synth) {
      try { synth.cancel(); } catch (e) { /* ignore */ }
    }
    state.index = clamp(state.index + delta, 0, state.queue.length - 1);
    state.playing = true;
    state.paused = false;
    syncBar();
    // Chrome drops a speak() issued in the same tick as cancel().
    var token = state.token;
    setTimeout(function () { speakCurrent(token); }, 60);
  }

  /* ---------------- wiring ---------------- */

  openBtn.addEventListener('click', function () {
    if (!state.open) { start(); return; }
    if (state.playing) { pause(); return; }
    if (state.paused) { resume(); return; }
    start();
  });

  playBtn.addEventListener('click', function () {
    if (!state.queue.length && !state.paused) { start(); return; }
    if (state.playing) pause();
    else resume();
  });

  prevBtn.addEventListener('click', function () { step(-1); });
  nextBtn.addEventListener('click', function () { step(1); });

  closeBtn.addEventListener('click', function () {
    state.open = false;
    stop(true);
    syncBar();
  });

  if (rateInput) {
    rateInput.value = String(state.rate);
    if (rateOut) rateOut.textContent = state.rate.toFixed(1) + '×';
    rateInput.addEventListener('input', function () {
      state.rate = clamp(Number(rateInput.value) || 1, 0.6, 1.8);
      if (rateOut) rateOut.textContent = state.rate.toFixed(1) + '×';
      localStorage.setItem(RATE_KEY, String(state.rate));
      // The rate is baked into each utterance, so the change is heard by
      // re-speaking the current sentence rather than waiting for the next one.
      if (state.playing) step(0);
    });
  }

  if (voiceSel) {
    voiceSel.addEventListener('change', function () {
      state.voiceURI = voiceSel.value;
      localStorage.setItem(VOICE_KEY, state.voiceURI);
      if (state.playing) step(0);
    });
  }

  // Chrome pauses speech in a hidden tab and does not always resume it.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !state.playing || state.paused) return;
    if (!synth || synth.speaking || synth.pending) return;
    speakCurrent(state.token);
  });

  window.addEventListener('pagehide', function () {
    if (synth) {
      try { synth.cancel(); } catch (e) { /* ignore */ }
    }
  });

  // Called by the selection bar in reader.js.
  window.NightReaderTTS = {
    startFrom: function (text) { start(text); },
    stop: function () { stop(true); },
    isOpen: function () { return state.open; },

    // reader.js calls this from syncControls, which fires on every page turn,
    // zoom and resize. Only a real change of position is acted on, otherwise a
    // window resize would restart the sentence.
    pageChanged: function () {
      if (!state.playing && !state.paused) return;
      if (state.autoTurn) return;
      var api = window.NightReaderSpeech;
      var location = '';
      try { location = api && api.location ? String(api.location() || '') : ''; } catch (e) { location = ''; }
      if (!location || location === lastLocation) return;
      lastLocation = location;
      // Paused: drop the stale queue so resuming reads the page now on screen.
      if (state.paused) {
        state.queue = [];
        state.index = 0;
        syncBar();
        return;
      }
      if (synth) {
        try { synth.cancel(); } catch (e) { /* ignore */ }
      }
      restartHere();
    }
  };

  syncBar();
})();
