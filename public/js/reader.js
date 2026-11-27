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
  var firstBtn = document.getElementById('first');
  var lastBtn = document.getElementById('last');
  var jumpBox = document.getElementById('page-jump');
  var pageInput = document.getElementById('page-input');
  var pageTotal = document.getElementById('page-total');
  var themeBtn = document.getElementById('theme-btn');
  var fontLabel = document.getElementById('font-size');
  // The − 18 + control only rewrites font-size on reflowable text. A PDF is
  // rendered page by page, so the buttons do nothing there and the zoom select
  // is the right control instead.
  var fontGroup = document.querySelector('.font-group');
  var errorBox = document.getElementById('reader-error');
  var busyBox = document.getElementById('reader-busy');
  var busyText = document.getElementById('reader-busy-text');
  var zoomGroup = document.getElementById('zoom-group');
  var zoomSelect = document.getElementById('zoom-mode');

  var theme = localStorage.getItem('reader-theme') || 'paper';
  var fontSize = Number(localStorage.getItem('reader-font')) || 18;
  var engine = null;
  var saved = null;
  var saveTimer;
  // Kept at this level so the notes panel can jump and repaint highlights
  // without threading the rendition through every helper.
  var epubBook = null;
  var epubRendition = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // A converted MOBI / AZW3 can take tens of seconds on the NAS. Without a
  // message the reader looks broken, so every slow step says what it is doing.
  function setBusy(message) {
    if (!busyBox) return;
    if (!message) { busyBox.hidden = true; return; }
    busyText.textContent = message;
    busyBox.hidden = false;
  }

  function showError(message) {
    setBusy('');
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
    // A page box only means something when the book has page numbers. EPUB has
    // no pages until it is laid out, so it keeps the percentage in the header
    // and hides the box instead of pretending "45 / 100%".
    var pages = engine.pages ? engine.pages() : null;
    jumpBox.hidden = !pages;
    if (pages) {
      pageTotal.textContent = '/ ' + pages.total;
      if (document.activeElement !== pageInput) pageInput.value = pages.current;
    }
    scheduleSave(p, engine.location());
  }

  // Accepts anything with digits in it ("12", " 12 ", "12页").
  function jumpTo(raw) {
    if (!engine || !engine.jumpPage || !engine.pages) return;
    var n = parseInt(String(raw == null ? '' : raw).replace(/[^\d]/g, ''), 10);
    if (Number.isNaN(n)) { pageInput.value = engine.pages().current; return; }
    engine.jumpPage(n);
    pageInput.value = engine.pages().current;
  }

  function refresh() {
    if (engine) engine.applyTheme(theme, fontSize);
    document.body.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'paper' ? '#F5F0E4' : '#0B121C';
    themeBtn.textContent = theme === 'paper' ? '夜读' : '纸张';
    fontLabel.textContent = fontSize;
  }

  /* ---------------- PDF ---------------- */
  var ZOOM_KEY = 'reader-zoom';
  var zoomMode = localStorage.getItem(ZOOM_KEY) || 'fit-width';

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
    var boxCache = new Map();

    function viewportSize() {
      return {
        w: Math.max(200, viewer.clientWidth - 40),
        h: Math.max(200, viewer.clientHeight - 40)
      };
    }

    /* "Fit visible" means fitting the printed area, not the paper: render the
     * page small into an offscreen canvas, find the ink bounding box, and use
     * that instead of the full media box. Scanned pages carry wide margins, so
     * without this the mode would look identical to fit-page. */
    async function contentBox(page, num) {
      if (boxCache.has(num)) return boxCache.get(num);
      var base = page.getViewport({ scale: 1 });
      var probe = Math.min(1, 420 / Math.max(1, base.width));
      var vp = page.getViewport({ scale: probe });
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      try {
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      } catch (e) {
        return null;
      }
      var data;
      try {
        data = ctx.getImageData(0, 0, c.width, c.height).data;
      } catch (e) {
        return null;
      }
      var minX = c.width, minY = c.height, maxX = -1, maxY = -1;
      for (var y = 0; y < c.height; y++) {
        var row = y * c.width * 4;
        for (var x = 0; x < c.width; x++) {
          var i = row + x * 4;
          if (data[i] < 246 || data[i + 1] < 246 || data[i + 2] < 246) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { boxCache.set(num, null); return null; }
      var p1 = vp.convertToPdfPoint(minX, minY);
      var p2 = vp.convertToPdfPoint(maxX + 1, maxY + 1);
      var rect = {
        x: Math.min(p1[0], p2[0]),
        y: Math.min(p1[1], p2[1]),
        w: Math.abs(p2[0] - p1[0]),
        h: Math.abs(p2[1] - p1[1])
      };
      if (boxCache.size > 40) boxCache.clear();
      boxCache.set(num, rect);
      return rect;
    }

    // pdf.js refuses to run two renders on one canvas at once. Wheel paging and
    // slider drags fire much faster than a page can render, so each new render
    // cancels the previous one and only the newest call is allowed to finish.
    var activeRender = null;
    var gotoToken = 0;
    var renderedPage = 0;

    async function cancelRender() {
      if (!activeRender) return;
      var previous = activeRender;
      activeRender = null;
      try { previous.cancel(); } catch (e) { /* already done */ }
      try { await previous.promise; } catch (e) { /* cancelled on purpose */ }
    }

    async function renderPage(page, ctx, vp, ratio) {
      await cancelRender();
      var task = page.render({ canvasContext: ctx, viewport: vp, transform: [ratio, 0, 0, ratio, 0, 0] });
      activeRender = task;
      try {
        await task.promise;
      } finally {
        if (activeRender === task) activeRender = null;
      }
    }

    engine = {
      type: 'pdf',
      percent: function () { return doc.numPages > 1 ? (current - 1) / (doc.numPages - 1) : 1; },
      label: function () { return current + ' / ' + doc.numPages; },
      location: function () { return String(current); },
      canPrev: function () { return current > 1; },
      canNext: function () { return current < doc.numPages; },
      goto: async function (n) {
        var token = ++gotoToken;
        current = clamp(Math.round(n), 1, doc.numPages);
        await cancelRender();
        var page = await doc.getPage(current);
        if (token !== gotoToken) return;          // a newer page already won
        var base = page.getViewport({ scale: 1 });
        var view = viewportSize();
        var box = zoomMode === 'fit-visible' ? await contentBox(page, current) : null;
        if (token !== gotoToken) return;

        var scale;
        if (zoomMode === 'actual') scale = 96 / 72;
        else if (zoomMode === 'fit-page') scale = Math.min(view.w / base.width, view.h / base.height);
        else if (box) scale = Math.min(view.w / box.w, view.h / box.h);
        else scale = view.w / base.width;
        scale = Math.max(0.05, Math.min(scale, 6));

        var vp = page.getViewport({ scale: scale });
        var dpr = window.devicePixelRatio || 1;
        var ctx;

        try {
          if (box) {
            // Render the whole page offscreen, then copy only the ink area into
            // the visible canvas. Cropping by pixel copy keeps this correct no
            // matter how the renderer composes its transform matrix.
            var q1 = vp.convertToViewportPoint(box.x, box.y);
            var q2 = vp.convertToViewportPoint(box.x + box.w, box.y + box.h);
            var sx = Math.min(q1[0], q2[0]);
            var sy = Math.min(q1[1], q2[1]);
            var sw = Math.max(1, Math.abs(q2[0] - q1[0]));
            var sh = Math.max(1, Math.abs(q2[1] - q1[1]));

            var off = document.createElement('canvas');
            off.width = Math.max(1, Math.floor(vp.width * dpr));
            off.height = Math.max(1, Math.floor(vp.height * dpr));
            var octx = off.getContext('2d');
            octx.fillStyle = '#ffffff';
            octx.fillRect(0, 0, off.width, off.height);
            await renderPage(page, octx, vp, dpr);

            var px = Math.max(0, Math.floor(sx * dpr));
            var py = Math.max(0, Math.floor(sy * dpr));
            var pw = Math.max(1, Math.floor(sw * dpr));
            var ph = Math.max(1, Math.floor(sh * dpr));
            canvas.width = pw;
            canvas.height = ph;
            canvas.style.width = Math.floor(sw) + 'px';
            canvas.style.height = Math.floor(sh) + 'px';
            ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, pw, ph);
            ctx.drawImage(off, px, py, pw, ph, 0, 0, pw, ph);
          } else {
            canvas.width = Math.max(1, Math.floor(vp.width * dpr));
            canvas.height = Math.max(1, Math.floor(vp.height * dpr));
            canvas.style.width = Math.floor(vp.width) + 'px';
            canvas.style.height = Math.floor(vp.height) + 'px';
            ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await renderPage(page, ctx, vp, dpr);
          }
        } catch (e) {
          // Cancelled by a newer page turn - the newer call owns the canvas now.
          if (e && e.name === 'RenderingCancelledException') return;
          throw e;
        }
        if (token !== gotoToken) return;
        // A new page starts at its top. Without this, wheeling past the bottom
        // of page 3 would land on the bottom of page 4. Zoom changes keep the
        // scroll position because they re-render the same page.
        if (renderedPage !== current) {
          renderedPage = current;
          if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
        }
        syncControls();
      },
      next: function () { return engine.goto(current + 1); },
      prev: function () { return engine.goto(current - 1); },
      seek: function (p) { return engine.goto(1 + p * (doc.numPages - 1)); },
      pages: function () { return { current: current, total: doc.numPages }; },
      // Page index is 0-based here so bookmarks from PDF and TXT use the same
      // shape and one jump function can handle both.
      position: function () {
        return { page: current - 1, percent: engine.percent(), chapter: '第 ' + current + ' 页', cfi: '' };
      },
      jumpPage: function (n) { return engine.goto(clamp(n, 1, doc.numPages)); },
      refresh: function () { return engine.goto(current); },
      applyTheme: function () { return engine.goto(current); }
    };

    zoomSelect.value = zoomMode;
    zoomGroup.hidden = false;
    fontGroup.hidden = true;

    var startPage = Number(saved && saved.location) || 1;
    await engine.goto(startPage);
  }

  /* ---------------- EPUB / MOBI / AZW3 (converted to EPUB) ---------------- */
  async function initEpub() {
    fontGroup.hidden = false;
    setBusy('正在打开…');
    // epub.js picks the opening strategy from the URL extension. Ours ended in
    // /read with none, so it fell back to "unpacked directory" and requested
    // META-INF/container.xml over HTTP - a guaranteed 404. The .epub suffix and
    // openAs both say "this URL is a zipped EPUB".
    var book = ePub('/api/book/' + id + '/read.epub', { openAs: 'epub' });
    var rendition = book.renderTo('viewer', { width: '100%', height: '100%', spread: 'none' });
    epubBook = book;
    epubRendition = rendition;
    // epub.js swallows its own open rejection and only emits openFailed, which
    // would leave `book.ready` pending forever. Race the two so a broken file
    // reports an error instead of sitting on "正在打开…".
    var failed = new Promise(function (resolve, reject) {
      book.on('openFailed', function () { reject(new Error('openFailed')); });
    });
    failed.catch(function () { /* handled by the race below */ });
    try {
      await Promise.race([book.ready, failed]);
    } catch (e) {
      throw new Error('这个文件打不开：它可能已损坏、带 DRM 加密，或者不是标准的 EPUB 文件。');
    }
    // A stored CFI can point past the end of the book (the file was replaced,
    // or the position came from another edition). Handing that straight to
    // rendition.display throws inside epub.js' queue where our try/catch cannot
    // see it, so validate against the spine first and fall back to page one.
    var startAt;
    if (saved && saved.location) {
      var candidate = String(saved.location);
      if (candidate.indexOf('epubcfi(') === 0) {
        try {
          if (book.spine.get(candidate)) startAt = candidate;
        } catch (e) { startAt = undefined; }
      } else if (candidate.charAt(0) === '/') {
        startAt = candidate;
      }
    }
    try {
      await rendition.display(startAt);
    } catch (e) {
      // A stale reading position must never stop the book from opening.
      await rendition.display();
    }

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
      // Everything a highlight or bookmark needs to be anchored: a CFI that
      // survives re-pagination, plus the chapter name for the notes list.
      position: function () {
        var loc = null;
        try { loc = rendition.currentLocation(); } catch (e) { loc = null; }
        var cfi = loc && loc.start ? loc.start.cfi : '';
        var chapter = '';
        if (loc && loc.start && loc.start.href) {
          try {
            var nav = book.navigation && book.navigation.get(loc.start.href);
            if (nav && nav.label) chapter = String(nav.label).trim().slice(0, 60);
          } catch (e) { /* navigation is optional in some EPUBs */ }
          if (!chapter) {
            var spineItem = book.spine.get(loc.start.href);
            chapter = spineItem ? '第 ' + (spineItem.index + 1) + ' 节' : '';
          }
        }
        return { page: null, percent: engine.percent(), chapter: chapter, cfi: cfi };
      },
      applyTheme: function (selectedTheme, size) {
        var night = selectedTheme === 'night';
        // epub.js 0.3.93 has no Contents.addCss. Calling it threw on every
        // render, and because the theme is applied once more during boot the
        // whole page ended on "打不开" even though the text had rendered.
        // Writing one <style> node per section document is plain DOM and does
        // not depend on whichever helper the bundled epub.js happens to ship.
        var css = [
          'html, body {',
          '  background: ' + (night ? '#0B121C' : '#F5F0E4') + ' !important;',
          '  color: ' + (night ? '#EDE6D8' : '#2B2A25') + ' !important;',
          '  font-family: "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif !important;',
          '  font-size: ' + size + 'px !important;',
          '  line-height: 1.95 !important;',
          '}',
          'body { padding: 0 6% !important; margin: 0 !important; }',
          'p { text-indent: 2em !important; margin: 0 0 .8em !important; }',
          'a { color: ' + (night ? '#E9A23B' : '#8A5A1F') + ' !important; }',
          'img { max-width: 100% !important; height: auto !important; }'
        ].join('\n');

        var contents = typeof rendition.getContents === 'function' ? rendition.getContents() : [];
        contents.forEach(function (c) {
          var doc = c && c.document;
          if (!doc || !doc.head) return;
          var style = doc.getElementById('night-library-theme');
          if (!style) {
            style = doc.createElement('style');
            style.id = 'night-library-theme';
            doc.head.appendChild(style);
          }
          style.textContent = css;
        });
      }
    };
    rendition.on('rendered', function (section, view) {
      engine.applyTheme(theme, fontSize);
      // epub.js only paints annotations that were added while a section was
      // already on screen, so every freshly rendered section repaints them.
      paintSectionHighlights(view);
      // Wheel and arrow keys happen inside the section iframe, where none of
      // the page's own listeners can see them. Bind once per section document.
      var doc = view && view.document;
      if (doc && !doc.__nightLibraryInput) {
        doc.__nightLibraryInput = true;
        doc.addEventListener('wheel', onWheel, { passive: false });
        doc.addEventListener('keydown', onKeyDown);
      }
    });
    rendition.on('selected', onEpubSelected);
    rendition.on('locationChanged', syncControls);
    syncControls();
    setBusy('');
  }

  /* ---------------- TXT ---------------- */
  async function initTxt() {
    fontGroup.hidden = false;
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
      pages: function () { return { current: pageIndex + 1, total: pages.length }; },
      position: function () {
        return { page: pageIndex, percent: engine.percent(), chapter: '第 ' + (pageIndex + 1) + ' 页', cfi: '' };
      },
      jumpPage: function (n) { engine.goto(clamp(n, 1, pages.length) - 1); },
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
  // seek(0) / seek(1) already go through every engine's own clamping + sync.
  firstBtn.addEventListener('click', function () { if (engine) engine.seek(0); });
  lastBtn.addEventListener('click', function () { if (engine) engine.seek(1); });

  pageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); jumpTo(pageInput.value); pageInput.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); pageInput.blur(); }
    e.stopPropagation();
  });
  pageInput.addEventListener('blur', function () { jumpTo(pageInput.value); });
  pageInput.addEventListener('focus', function () { pageInput.select(); });

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
  zoomSelect.addEventListener('change', function (e) {
    zoomMode = e.target.value;
    localStorage.setItem(ZOOM_KEY, zoomMode);
    if (engine && engine.refresh) engine.refresh();
  });
  var pdfResizeTimer;
  window.addEventListener('resize', function () {
    if (!engine || engine.type !== 'pdf' || zoomMode === 'actual') return;
    clearTimeout(pdfResizeTimer);
    pdfResizeTimer = setTimeout(function () { if (engine.refresh) engine.refresh(); }, 200);
  });
  function typable(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  function onKeyDown(e) {
    if (typable(e.target)) return;
    if (!engine) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); engine.next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); engine.prev(); }
    else if (e.key === 'Home') { e.preventDefault(); engine.seek(0); }
    else if (e.key === 'End') { e.preventDefault(); engine.seek(1); }
    else if (e.key === 'Escape') location.href = '/';
  }

  /* ---------------- mouse wheel paging ---------------- */
  // A classic mouse notch arrives as one big delta and turns exactly one page,
  // so a fast flick turns several. A trackpad sends a stream of small deltas:
  // they accumulate, and the short lock brakes the momentum that keeps coming
  // after the fingers lift.
  var wheelAcc = 0;
  var wheelLock = 0;

  function scrollsInside(el, delta) {
    if (!el) return false;
    var max = el.scrollHeight - el.clientHeight;
    if (max <= 4) return false;
    return delta > 0 ? el.scrollTop < max - 1 : el.scrollTop > 1;
  }

  function onWheel(e) {
    if (!engine) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;      // leave pinch-zoom alone
    if (typable(e.target)) return;
    var delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (!delta) return;
    // In 匹配宽度 / 实际大小 the page can be taller than the window. Scroll it
    // first and only turn the page once it has reached the edge, otherwise
    // wheeling straight to the next page would skip the bottom half of every
    // page. When the page fits, the wheel turns pages immediately.
    if (scrollsInside(document.querySelector('.pdf-stage'), delta)) return;

    var discrete = Math.abs(delta) >= 90;
    if (!discrete) {
      var now = Date.now();
      if (now < wheelLock) { e.preventDefault(); return; }
      wheelAcc += delta;
      if (Math.abs(wheelAcc) < 90) { e.preventDefault(); return; }
      wheelLock = now + 220;
    }
    var forward = discrete ? delta > 0 : wheelAcc > 0;
    wheelAcc = 0;
    e.preventDefault();
    if (forward ? engine.canNext() : engine.canPrev()) {
      if (forward) engine.next(); else engine.prev();
    }
  }

  window.addEventListener('keydown', onKeyDown);
  viewer.addEventListener('wheel', onWheel, { passive: false });

  /* ---------------- highlights, notes, bookmarks ---------------- */
  var notesBtn = document.getElementById('notes-btn');
  var notesPanel = document.getElementById('notes-panel');
  var notesBody = document.getElementById('notes-body');
  var selBar = document.getElementById('sel-bar');
  var noteMask = document.getElementById('note-mask');
  var noteEditor = document.getElementById('note-editor');
  var noteQuote = document.getElementById('note-quote');
  var noteText = document.getElementById('note-text');
  var exportBtn = document.getElementById('notes-export');

  var noteState = { highlights: [], bookmarks: [], tab: 'highlights' };
  var pendingSelection = null;
  var editorMode = '';
  var editorItem = null;
  var noteToastTimer;

  function send(url, method, body) {
    return api(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function toast(message) {
    var el = document.getElementById('reader-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'reader-toast';
      el.className = 'reader-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(noteToastTimer);
    noteToastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function totalNotes() {
    return noteState.highlights.length + noteState.bookmarks.length;
  }

  function updateNoteCounts() {
    document.getElementById('notes-hl-count').textContent = noteState.highlights.length;
    document.getElementById('notes-bm-count').textContent = noteState.bookmarks.length;
    notesBtn.textContent = totalNotes() ? '笔记 ' + totalNotes() : '笔记';
    exportBtn.disabled = totalNotes() === 0;
  }

  function renderNotes() {
    var isBookmark = noteState.tab === 'bookmarks';
    var items = isBookmark ? noteState.bookmarks : noteState.highlights;
    Array.prototype.forEach.call(document.querySelectorAll('.notes-tabs button'), function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-tab') === noteState.tab));
    });
    if (!items.length) {
      var hint;
      if (isBookmark) hint = '点下面的「＋ 加书签」记住当前位置。';
      else if (engine && engine.type === 'pdf') hint = 'PDF 暂时不能划词高亮，可以先加书签。';
      else hint = '选中一段文字，就能把它高亮或写成笔记。';
      notesBody.innerHTML = '<p class="notes-empty">' + hint + '</p>';
      return;
    }
    notesBody.innerHTML = items.map(function (item) {
      var quote = isBookmark
        ? (item.label || item.chapter || '书签')
        : (item.text || '（这条只有笔记）');
      var where = [];
      if (item.chapter && item.chapter !== quote) where.push(item.chapter);
      if (item.percent) where.push(Math.round(item.percent * 100) + '%');
      return '<article class="note-item" data-id="' + esc(item.id) + '">' +
        '<button type="button" class="note-jump" data-jump="' + esc(item.id) + '">' +
        '<span class="note-quote-text">' + esc(quote) + '</span>' +
        '<em>' + esc(where.join(' · ')) + '</em></button>' +
        (item.note && !isBookmark ? '<p class="note-memo">' + esc(item.note) + '</p>' : '') +
        '<div class="note-tools">' +
        (!isBookmark ? '<button type="button" data-edit="' + esc(item.id) + '">编辑笔记</button>' : '') +
        '<button type="button" data-del="' + esc(item.id) + '">删除</button></div></article>';
    }).join('');
  }

  function findNote(noteId) {
    return noteState.highlights.concat(noteState.bookmarks).find(function (item) {
      return item.id === noteId;
    }) || null;
  }

  function jumpToItem(item) {
    if (!engine || !item) return;
    if (engine.type === 'epub' && item.cfi && epubRendition) {
      try { epubRendition.display(item.cfi); } catch (e) { /* stale cfi */ }
    } else if (typeof item.page === 'number' && item.page >= 0) {
      if (engine.type === 'pdf') engine.goto(item.page + 1);
      else if (engine.jumpPage) engine.jumpPage(item.page + 1);
    } else if (item.percent) {
      engine.seek(item.percent);
    }
    if (window.innerWidth <= 720) closeNotes();
  }

  // epub.js only paints annotations into sections that are already on screen,
  // and it reuses a view for another section, so every render starts by wiping
  // this view's leftover rects and then paints the ones that belong to it.
  function paintSectionHighlights(view) {
    if (!view || !view.contents) return;
    if (view.highlights) {
      Object.keys(view.highlights).forEach(function (cfi) {
        try { view.unhighlight(cfi); } catch (e) { /* contents were replaced */ }
      });
    }
    noteState.highlights.forEach(function (item) {
      if (!item.cfi) return;
      var spinePos;
      try { spinePos = new ePub.CFI(item.cfi).spinePos; } catch (e) { return; }
      if (spinePos !== view.index) return;
      try {
        view.highlight(item.cfi, { id: item.id }, function () { openNotes(); }, 'nl-highlight', {
          fill: '#E9A23B',
          'fill-opacity': '0.32'
        });
      } catch (e) { /* a broken CFI must not take the page down */ }
    });
  }

  function hideSelBar() { selBar.hidden = true; }

  function showSelBar(x, y) {
    selBar.hidden = false;
    var width = selBar.offsetWidth || 150;
    var left = clamp(x, width / 2 + 10, window.innerWidth - width / 2 - 10);
    // Near the top of the page there is no room above the text.
    var below = y < 120;
    selBar.style.left = left + 'px';
    selBar.style.top = (below ? y + 42 : y - 8) + 'px';
    selBar.style.transform = below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
  }

  function clearSelection() {
    pendingSelection = null;
    hideSelBar();
    try {
      var selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    } catch (e) { /* ignore */ }
    if (epubRendition) {
      try {
        epubRendition.getContents().forEach(function (contents) {
          var inner = contents.window && contents.window.getSelection();
          if (inner) inner.removeAllRanges();
        });
      } catch (e) { /* ignore */ }
    }
  }

  function onEpubSelected(cfiRange, contents) {
    if (!engine) return;
    var win = contents && contents.window;
    if (!win) return;
    var selection = win.getSelection();
    var text = selection ? String(selection).trim() : '';
    if (!text) return;
    var rect;
    try { rect = selection.getRangeAt(0).getBoundingClientRect(); } catch (e) { return; }
    var frame = win.frameElement;
    var box = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    var pos = engine.position();
    pendingSelection = {
      cfi: cfiRange,
      page: null,
      text: text.slice(0, 4000),
      chapter: pos.chapter,
      percent: pos.percent
    };
    showSelBar(box.left + rect.left + rect.width / 2, box.top + rect.top);
  }

  // TXT is plain DOM, so it has no CFI; the page index is the anchor instead.
  viewer.addEventListener('mouseup', function () {
    if (!engine || engine.type !== 'txt') return;
    setTimeout(function () {
      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      var text = String(selection).trim();
      if (!text) return;
      if (!viewer.contains(selection.anchorNode)) return;
      var rect;
      try { rect = selection.getRangeAt(0).getBoundingClientRect(); } catch (e) { return; }
      var pos = engine.position();
      pendingSelection = {
        cfi: '',
        page: pos.page,
        text: text.slice(0, 4000),
        chapter: pos.chapter,
        percent: pos.percent
      };
      showSelBar(rect.left + rect.width / 2, rect.top);
    }, 10);
  });

  async function saveSelection(note) {
    if (!pendingSelection) return;
    var body = {
      kind: 'highlight',
      cfi: pendingSelection.cfi || '',
      page: typeof pendingSelection.page === 'number' ? pendingSelection.page : null,
      text: pendingSelection.text,
      note: note || '',
      chapter: pendingSelection.chapter || '',
      percent: pendingSelection.percent || 0
    };
    var r = await send('/api/book/' + encodeURIComponent(id) + '/notes', 'POST', body);
    var replaced = false;
    noteState.highlights.forEach(function (item, index) {
      if (item.id === r.item.id) {
        noteState.highlights[index] = r.item;
        replaced = true;
      }
    });
    if (!replaced) noteState.highlights.push(r.item);
    pendingSelection = null;
    updateNoteCounts();
    renderNotes();
    if (epubRendition && r.item.cfi) {
      var views = epubRendition.views ? epubRendition.views() : [];
      views.forEach(function (view) { paintSectionHighlights(view); });
    }
  }

  function openEditor(mode, item, quote, value) {
    editorMode = mode;
    editorItem = item || null;
    noteQuote.textContent = quote || '';
    noteQuote.hidden = !quote;
    noteText.value = value || '';
    noteMask.hidden = false;
    noteEditor.hidden = false;
    noteText.focus();
  }

  function closeEditor() {
    noteMask.hidden = true;
    noteEditor.hidden = true;
    editorMode = '';
    editorItem = null;
  }

  async function deleteNote(item) {
    try {
      await api('/api/book/' + encodeURIComponent(id) + '/notes/' + encodeURIComponent(item.id), { method: 'DELETE' });
      noteState.highlights = noteState.highlights.filter(function (h) { return h.id !== item.id; });
      noteState.bookmarks = noteState.bookmarks.filter(function (b) { return b.id !== item.id; });
      updateNoteCounts();
      renderNotes();
      if (item.cfi && epubRendition) {
        var views = epubRendition.views ? epubRendition.views() : [];
        views.forEach(function (view) {
          try { view.unhighlight(item.cfi); } catch (e) { /* ignore */ }
        });
      }
      toast('已删除');
    } catch (e) {
      toast(e.message);
    }
  }

  async function addBookmark() {
    if (!engine) return;
    var pos = engine.position();
    var label = pos.chapter || (typeof pos.page === 'number' ? '第 ' + (pos.page + 1) + ' 页' : '当前位置');
    try {
      var r = await send('/api/book/' + encodeURIComponent(id) + '/notes', 'POST', {
        kind: 'bookmark',
        cfi: pos.cfi || '',
        page: pos.page,
        label: label,
        chapter: pos.chapter || '',
        percent: pos.percent || 0
      });
      noteState.bookmarks.push(r.item);
      noteState.tab = 'bookmarks';
      updateNoteCounts();
      renderNotes();
      toast('已加书签');
    } catch (e) {
      toast(e.message);
    }
  }

  function openNotes() {
    notesPanel.hidden = false;
    renderNotes();
  }

  function closeNotes() {
    notesPanel.hidden = true;
    hideSelBar();
  }

  notesBtn.addEventListener('click', function () {
    if (notesPanel.hidden) openNotes();
    else closeNotes();
  });
  document.getElementById('notes-close').addEventListener('click', closeNotes);
  document.getElementById('add-bookmark').addEventListener('click', addBookmark);

  Array.prototype.forEach.call(document.querySelectorAll('.notes-tabs button'), function (btn) {
    btn.addEventListener('click', function () {
      noteState.tab = btn.getAttribute('data-tab');
      renderNotes();
    });
  });

  notesBody.addEventListener('click', function (e) {
    var jump = e.target.closest ? e.target.closest('[data-jump]') : null;
    if (jump) {
      jumpToItem(findNote(jump.getAttribute('data-jump')));
      return;
    }
    var edit = e.target.closest ? e.target.closest('[data-edit]') : null;
    if (edit) {
      var item = findNote(edit.getAttribute('data-edit'));
      if (item) openEditor('edit', item, item.text || '', item.note || '');
      return;
    }
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      var target = findNote(del.getAttribute('data-del'));
      if (!target) return;
      if (window.confirm('删除这条笔记？')) deleteNote(target);
    }
  });

  selBar.addEventListener('click', async function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'cancel') {
      clearSelection();
      return;
    }
    if (act === 'highlight') {
      hideSelBar();
      try {
        await saveSelection('');
        clearSelection();
        toast('已高亮');
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (act === 'note' && pendingSelection) {
      hideSelBar();
      openEditor('new', null, pendingSelection.text, '');
    }
  });

  noteEditor.addEventListener('submit', async function (e) {
    e.preventDefault();
    var value = noteText.value.trim();
    if (editorMode === 'new') {
      try {
        await saveSelection(value);
        closeEditor();
        clearSelection();
        toast(value ? '笔记已保存' : '已高亮');
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (editorMode === 'edit' && editorItem) {
      try {
        var r = await send('/api/book/' + encodeURIComponent(id) + '/notes/' + encodeURIComponent(editorItem.id),
          'PATCH', { note: value });
        editorItem.note = r.item.note;
        renderNotes();
        closeEditor();
        toast('笔记已更新');
      } catch (err) {
        toast(err.message);
      }
    }
  });

  document.getElementById('note-cancel').addEventListener('click', function () {
    closeEditor();
    clearSelection();
  });
  noteMask.addEventListener('click', function () {
    closeEditor();
    clearSelection();
  });

  exportBtn.addEventListener('click', function () {
    if (!totalNotes()) return;
    var a = document.createElement('a');
    a.href = '/api/book/' + encodeURIComponent(id) + '/notes/export';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  async function loadNotes() {
    try {
      var data = await api('/api/book/' + encodeURIComponent(id) + '/notes');
      noteState.highlights = data.highlights || [];
      noteState.bookmarks = data.bookmarks || [];
    } catch (e) {
      noteState.highlights = [];
      noteState.bookmarks = [];
    }
    updateNoteCounts();
    renderNotes();
    if (epubRendition) {
      var views = epubRendition.views ? epubRendition.views() : [];
      views.forEach(function (view) { paintSectionHighlights(view); });
    }
  }

  /* ---------------- reading time ---------------- */
  // Only counted while the tab is visible and the reader was used recently: a
  // book left open on a desk overnight must not report eight hours.
  var activeMs = 0;
  var lastTickAt = Date.now();
  var lastInputAt = Date.now();
  var wasVisible = !document.hidden;
  var clockStarted = false;

  function markActive() { lastInputAt = Date.now(); }

  function tickClock() {
    var now = Date.now();
    var idle = now - lastInputAt > 300000;
    var visible = !document.hidden;
    // Settle the span that just ended using the visibility it had *during* the
    // span. On visibilitychange document.hidden is already true, so reading it
    // here would throw away the last minutes of every session.
    if (wasVisible && !idle) activeMs += Math.min(30000, now - lastTickAt);
    wasVisible = visible;
    lastTickAt = now;
    if (activeMs >= 60000) sendTime(false);
  }

  function sendTime(beacon) {
    if (!id) return;
    var seconds = Math.round(activeMs / 1000);
    if (seconds < 5) return;
    activeMs -= seconds * 1000;
    var payload = JSON.stringify({ bookId: id, seconds: seconds });
    if (beacon && navigator.sendBeacon) {
      try {
        navigator.sendBeacon('/api/reading/ping', new Blob([payload], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }
    fetch('/api/reading/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(function () { /* statistics are best effort */ });
  }

  function startReadingClock() {
    if (clockStarted) return;
    clockStarted = true;
    ['mousemove', 'keydown', 'wheel', 'touchstart', 'click'].forEach(function (name) {
      window.addEventListener(name, markActive, { passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      tickClock();
      if (document.hidden) sendTime(true);
      else lastTickAt = Date.now();
    });
    window.addEventListener('pagehide', function () {
      tickClock();
      sendTime(true);
    });
    setInterval(tickClock, 15000);
  }

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
      if (book.format === 'mobi' || book.format === 'azw3') {
        // Unpacking runs on the NAS and is not instant: ask for it first so a
        // failure surfaces as text instead of a silent blank page.
        setBusy('第一次打开要先把 ' + book.format.toUpperCase() + ' 转成可翻页的版本，请稍等…');
        await api('/api/book/' + encodeURIComponent(id) + '/prepare');
      }
      if (book.format === 'pdf') await initPdf();
      else if (book.format === 'txt') await initTxt();
      else await initEpub();
      refresh();
      // Notes come after the engine so EPUB highlights can be painted into the
      // section that is already on screen.
      await loadNotes();
      startReadingClock();
      if (new URLSearchParams(location.search).get('panel') === 'notes') openNotes();
    } catch (e) {
      showError(e.message);
    }
  }

  boot();
})();
