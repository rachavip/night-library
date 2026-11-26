(function () {
  'use strict';

  var id = new URLSearchParams(location.search).get('id');
  var viewer = document.getElementById('viewer');
  var titleEl = document.getElementById('book-title');
  var authorEl = document.getElementById('book-author');
  var pageInfo = document.getElementById('page-info');
  var track = document.getElementById('progress-track');
  var prevBtn = document.getElementById('prev');
  var nextBtn = document.getElementById('next');
  var themeBtn = document.getElementById('theme-btn');
  var fontLabel = document.getElementById('font-size');
  var errorBox = document.getElementById('reader-error');

  var theme = localStorage.getItem('reader-theme') || 'paper';
  var fontSize = Number(localStorage.getItem('reader-font')) || 18;
  var engine = null;
  var saved = null;
  var saveTimer;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showError(message) {
    viewer.hidden = true;
    document.querySelector('.reader-bar').hidden = true;
    document.querySelector('.reader-foot').hidden = true;
    document.getElementById('reader-error-text').textContent = message || '请稍后再试。';
    errorBox.hidden = false;
  }

  async function api(url, options) {
    var res = await fetch(url, options);
    if (!res.ok) {
      var detail = '';
      try { detail = (await res.json()).error || ''; } catch (e) { /* ignore */ }
      throw new Error(detail || ('请求失败 ' + res.status));
    }
    return res.json();
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function scheduleSave(percent, location) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch('/api/book/' + encodeURIComponent(id) + '/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent: percent, location: String(location || '') })
      }).catch(function () { /* reading still works if progress cannot be saved */ });
    }, 900);
  }

  function syncControls() {
    if (!engine) return;
    var p = engine.percent();
    track.value = Math.round(p * 100);
    pageInfo.textContent = engine.label();
    prevBtn.disabled = !engine.canPrev();
    nextBtn.disabled = !engine.canNext();
    scheduleSave(p, engine.location());
  }

  function refresh() {
    if (engine) engine.applyTheme(theme, fontSize);
    document.body.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'paper' ? '#F5F0E4' : '#0B121C';
    themeBtn.textContent = theme === 'paper' ? '夜读' : '纸张';
    fontLabel.textContent = fontSize;
  }

  /* ---------------- PDF ---------------- */
  async function initPdf() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
    var task = pdfjsLib.getDocument({ url: '/api/book/' + id + '/read', rangeChunkSize: 65536 });
    var doc = await task.promise;
    var stage = document.createElement('div');
    stage.className = 'pdf-stage';
    var canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    viewer.replaceChildren(stage);

    var current = 0;
    engine = {
      type: 'pdf',
      percent: function () { return doc.numPages > 1 ? (current - 1) / (doc.numPages - 1) : 1; },
      label: function () { return current + ' / ' + doc.numPages; },
      location: function () { return String(current); },
      canPrev: function () { return current > 1; },
      canNext: function () { return current < doc.numPages; },
      goto: async function (n) {
        current = clamp(Math.round(n), 1, doc.numPages);
        var page = await doc.getPage(current);
        var base = page.getViewport({ scale: 1 });
        var scale = Math.max(0.4, (viewer.clientWidth - 36) / base.width);
        var vp = page.getViewport({ scale: scale });
        var dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = Math.floor(vp.width) + 'px';
        canvas.style.height = Math.floor(vp.height) + 'px';
        var ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
        syncControls();
      },
      next: function () { return engine.goto(current + 1); },
      prev: function () { return engine.goto(current - 1); },
      seek: function (p) { return engine.goto(1 + p * (doc.numPages - 1)); },
      applyTheme: function () { return engine.goto(current); }
    };
    var startPage = Number(saved && saved.location) || 1;
    await engine.goto(startPage);
  }

  /* ---------------- EPUB / MOBI / AZW3 (converted to EPUB) ---------------- */
  async function initEpub() {
    var book = ePub('/api/book/' + id + '/read');
    var rendition = book.renderTo('viewer', { width: '100%', height: '100%', spread: 'none' });
    await book.ready;
    await rendition.display(saved && saved.location ? saved.location : undefined);

    function currentIndex() {
      var loc = rendition.currentLocation();
      if (!loc || !loc.start) return 0;
      var item = book.spine.get(loc.start.href);
      return item ? item.index : 0;
    }

    engine = {
      type: 'epub',
      percent: function () {
        var total = book.spine.length;
        return total > 1 ? currentIndex() / (total - 1) : 0;
      },
      label: function () { return Math.round(engine.percent() * 100) + '%'; },
      location: function () {
        var loc = rendition.currentLocation();
        return loc && loc.start ? loc.start.cfi : '';
      },
      canPrev: function () { return currentIndex() > 0; },
      canNext: function () { return currentIndex() < book.spine.length - 1; },
      goto: function () { return Promise.resolve(); },
      next: function () { return rendition.next().then(syncControls); },
      prev: function () { return rendition.prev().then(syncControls); },
      seek: function (p) {
        var index = Math.round(p * Math.max(0, book.spine.length - 1));
        var item = book.spine.get(index);
        return item ? rendition.display(item.href).then(syncControls) : Promise.resolve();
      },
      applyTheme: function (selectedTheme, size) {
        var night = selectedTheme === 'night';
        rendition.themes.register('night-library', {
          'body': {
            'background': night ? '#0B121C !important' : '#F5F0E4 !important',
            'color': night ? '#EDE6D8 !important' : '#2B2A25 !important',
            'font-family': '"Noto Serif SC", "Songti SC", "SimSun", Georgia, serif !important',
            'line-height': '1.95 !important',
            'padding': '0 8% !important'
          },
          'p': { 'text-indent': '2em !important', 'margin': '0 0 .8em !important' },
          'a': { 'color': night ? '#E9A23B !important' : '#8A5A1F !important' }
        });
        rendition.themes.select('night-library');
        rendition.themes.fontSize(size + 'px');
        var contents = rendition.getContents ? rendition.getContents() : [];
        contents.forEach(function (c) {
          c.addCss('html,body{background:' + (night ? '#0B121C' : '#F5F0E4') + '!important;color:' +
            (night ? '#EDE6D8' : '#2B2A25') + '!important;font-size:' + size + 'px!important;}');
        });
      }
    };
    rendition.on('rendered', function () { engine.applyTheme(theme, fontSize); });
    rendition.on('locationChanged', syncControls);
    syncControls();
  }

  /* ---------------- TXT ---------------- */
  async function initTxt() {
    var res = await fetch('/api/book/' + id + '/text');
    if (!res.ok) throw new Error('文本读取失败');
    var text = await res.text();
    var paragraphs = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!paragraphs.length) paragraphs = [text.trim()].filter(Boolean);

    var pages = [];
    var pageIndex = 0;

    function paginate() {
      var w = viewer.clientWidth, h = viewer.clientHeight;
      var perLine = Math.max(18, Math.floor((w - 48) / fontSize));
      var lines = Math.max(8, Math.floor((h - 28) / (fontSize * 2)));
      var target = perLine * lines;
      pages = [];
      var cur = [], count = 0;
      paragraphs.forEach(function (para) {
        var remaining = para;
        while (remaining.length > target) {
          if (cur.length) { pages.push(cur); cur = []; count = 0; }
          cur.push(remaining.slice(0, target));
          pages.push(cur);
          cur = [];
          remaining = remaining.slice(target);
        }
        if (count + remaining.length > target && cur.length) {
          pages.push(cur); cur = []; count = 0;
        }
        cur.push(remaining);
        count += remaining.length + 1;
      });
      if (cur.length) pages.push(cur);
      if (!pages.length) pages = [[]];
    }

    function render() {
      var page = document.createElement('div');
      page.className = 'txt-page';
      page.style.setProperty('--reader-font', fontSize + 'px');
      page.innerHTML = (pages[pageIndex] || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
      viewer.replaceChildren(page);
    }

    engine = {
      type: 'txt',
      percent: function () { return pages.length > 1 ? pageIndex / (pages.length - 1) : 1; },
      label: function () { return (pageIndex + 1) + ' / ' + pages.length; },
      location: function () { return String(pageIndex); },
      canPrev: function () { return pageIndex > 0; },
      canNext: function () { return pageIndex < pages.length - 1; },
      goto: function (n) { pageIndex = clamp(Math.round(n), 0, pages.length - 1); render(); syncControls(); },
      next: function () { engine.goto(pageIndex + 1); },
      prev: function () { engine.goto(pageIndex - 1); },
      seek: function (p) { engine.goto(p * (pages.length - 1)); },
      applyTheme: function () { render(); }
    };

    paginate();
    var start = Number(saved && saved.location) || 0;
    pageIndex = clamp(start, 0, pages.length - 1);
    render();
    syncControls();

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var p = engine.percent();
        paginate();
        pageIndex = Math.round(p * (pages.length - 1));
        render();
        syncControls();
      }, 180);
    });
  }

  /* ---------------- controls ---------------- */
  prevBtn.addEventListener('click', function () { if (engine) engine.prev(); });
  nextBtn.addEventListener('click', function () { if (engine) engine.next(); });
  track.addEventListener('input', function (e) {
    if (engine) engine.seek(Number(e.target.value) / 100);
  });
  themeBtn.addEventListener('click', function () {
    theme = theme === 'paper' ? 'night' : 'paper';
    localStorage.setItem('reader-theme', theme);
    refresh();
    syncControls();
  });
  document.getElementById('font-down').addEventListener('click', function () {
    fontSize = clamp(fontSize - 2, 14, 28);
    localStorage.setItem('reader-font', fontSize);
    refresh();
    syncControls();
  });
  document.getElementById('font-up').addEventListener('click', function () {
    fontSize = clamp(fontSize + 2, 14, 28);
    localStorage.setItem('reader-font', fontSize);
    refresh();
    syncControls();
  });
  window.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight' && engine) { e.preventDefault(); engine.next(); }
    if (e.key === 'ArrowLeft' && engine) { e.preventDefault(); engine.prev(); }
    if (e.key === 'Escape') location.href = '/';
  });

  /* ---------------- boot ---------------- */
  async function boot() {
    if (!id) return showError('没有指定书籍。');
    // Follow the library's system name and theme unless a local override exists.
    try {
      var cfg = await fetch('/api/settings').then(function (r) { return r.json(); });
      if (cfg.systemName) {
        document.getElementById('back-label').textContent = cfg.systemName;
        if (!localStorage.getItem('reader-theme')) {
          theme = cfg.theme === 'paper' ? 'paper' : 'night';
        }
      }
    } catch (e) { /* defaults are fine */ }
    refresh();
    try {
      var book = await api('/api/book/' + encodeURIComponent(id));
      titleEl.textContent = book.title || '未命名';
      authorEl.textContent = book.author || '佚名';
      saved = book.progress;
      if (book.format === 'pdf') await initPdf();
      else if (book.format === 'txt') await initTxt();
      else await initEpub();
      refresh();
    } catch (e) {
      showError(e.message);
    }
  }

  boot();
})();
