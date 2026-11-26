(function () {
  'use strict';

  var state = { sort: 'title', order: 'asc', q: '', format: '', view: 'grid' };
  var shelf = document.getElementById('shelf');
  var filters = document.getElementById('filters');
  var empty = document.getElementById('empty');
  var toastEl = document.getElementById('toast');
  var rescanBtn = document.getElementById('rescan');
  var formats = {};
  var booksById = {};
  var toastTimer;
  var lastScannedAt = null;
  var lastCount = -1;
  var lastScanning = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2800);
  }

  window.nightToast = toast;
  window.nightBooks = { refresh: function () { renderStats(); renderBooks(); } };

  async function api(url, options) {
    var res = await fetch(url, options);
    if (!res.ok) {
      var detail = '';
      try { detail = (await res.json()).error || ''; } catch (e) { /* ignore */ }
      throw new Error(detail || ('请求失败 ' + res.status));
    }
    return res.json();
  }

  function pct(book) {
    var p = book.progress && book.progress.percent;
    return typeof p === 'number' ? Math.round(p * 100) : 0;
  }

  function card(book) {
    var percent = pct(book);
    var href = '/reader?id=' + encodeURIComponent(book.id);
    // The cover URL carries the stored filename: when a re-scrape finally finds
    // a real cover, the URL changes and the browser stops showing the cached
    // generated card instead.
    var coverSrc = '/api/book/' + esc(book.id) + '/cover' + (book.coverFile ? '?v=' + esc(book.coverFile) : '');
    var cover = '<span class="cover"><img src="' + coverSrc + '" alt="" loading="lazy">' +
      '<span class="format-tag">' + esc(book.format.toUpperCase()) + '</span>' +
      '<span class="cover-more" role="button" tabindex="0" data-id="' + esc(book.id) +
      '" aria-label="查看《' + esc(book.title) + '》的详情与单独刮削">⋯</span></span>';
    var title = '<span class="book-title">' + esc(book.title || '未命名') + '</span>';
    var author = '<span class="book-author">' + esc(book.author || '佚名') + '</span>';
    var progress = '<span class="progress-line"><i style="width:' + percent + '%"></i></span>';

    if (state.view === 'list') {
      return '<a class="book" href="' + href + '" aria-label="阅读《' + esc(book.title) + '》">' +
        cover + title + author +
        '<span class="list-format">' + esc(book.format.toUpperCase()) + '</span>' +
        '<span class="list-progress">' + (percent ? percent + '%' : '未读') + '</span>' +
        '</a>';
    }
    return '<a class="book" href="' + href + '" aria-label="阅读《' + esc(book.title) + '》">' +
      cover + title + author + progress + '</a>';
  }

  async function renderBooks() {
    var params = new URLSearchParams({
      sort: state.sort, order: state.order, q: state.q, format: state.format
    });
    try {
      var data = await api('/api/books?' + params.toString());
      booksById = {};
      data.books.forEach(function (b) { booksById[b.id] = b; });
      shelf.className = 'shelf ' + state.view;
      shelf.innerHTML = data.books.map(card).join('');
      empty.hidden = data.books.length > 0;
    } catch (e) {
      shelf.innerHTML = '';
      toast(e.message);
    }
  }

  /* ---------- book detail sheet ---------- */
  var sheet = document.getElementById('book-sheet');
  var sheetScrim = document.getElementById('book-scrim');
  var sheetImg = document.getElementById('book-sheet-img');
  var sheetName = document.getElementById('book-sheet-name');
  var sheetAuthor = document.getElementById('book-sheet-author');
  var sheetMeta = document.getElementById('book-sheet-meta');
  var sheetNote = document.getElementById('book-sheet-note');
  var sheetRescan = document.getElementById('book-sheet-rescan');
  var sheetOpen = document.getElementById('book-sheet-open');
  var sheetClose = document.getElementById('book-sheet-close');
  var sheetBook = null;

  function sizeText(n) {
    if (!n) return '—';
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // Same idea as the server-side check, kept deliberately small: a title
  // carrying scripts that never appear on a Chinese shelf is broken bytes.
  function looksBroken(book) {
    var t = book.title || '';
    if (!t.trim()) return true;
    if (/[\uFFFD\u0000-\u0008\u000E-\u001F]/.test(t)) return true;
    if (/^þÿ/.test(t)) return true;
    if (/[\u0400-\u06FF\u0900-\u0DFF\u0E00-\u0EFF\u1000-\u109F\u1100-\u11FF\u3130-\u318F\u3200-\u33FF\uAC00-\uD7AF]/.test(t)) return true;
    return false;
  }

  function renderSheet(book) {
    sheetBook = book;
    var coverSrc = '/api/book/' + esc(book.id) + '/cover' + (book.coverFile ? '?v=' + esc(book.coverFile) : '');
    sheetImg.src = coverSrc;
    sheetImg.alt = '《' + (book.title || '未命名') + '》封面';
    sheetName.textContent = book.title || '未命名';
    sheetAuthor.textContent = book.author || '佚名';

    var rows = [
      ['格式', (book.format || '').toUpperCase()],
      ['大小', sizeText(book.size)],
      ['路径', book.path || ''],
      ['入馆', book.addedAt ? new Date(book.addedAt).toLocaleString('zh-CN') : '—']
    ];
    if (book.progress && book.progress.percent) {
      rows.push(['进度', Math.round(book.progress.percent * 100) + '%']);
    }
    sheetMeta.innerHTML = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    var notes = [];
    if (looksBroken(book)) notes.push('书名看起来是乱码。重新刮削会重新读一遍文件，还是读不出来就用文件名。');
    if (!book.coverFile) notes.push('这本书没有真实封面（文件里就没带图）。重新刮削会再找一次。');
    sheetNote.hidden = notes.length === 0;
    sheetNote.textContent = notes.join(' ');
  }

  function openSheet(id) {
    var book = booksById[id];
    if (!book) return;
    renderSheet(book);
    sheetScrim.hidden = false;
    sheet.hidden = false;
    sheetClose.focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    sheetScrim.hidden = true;
    sheetBook = null;
  }

  async function rescanOne() {
    if (!sheetBook) return;
    var id = sheetBook.id;
    sheetRescan.disabled = true;
    sheetRescan.textContent = '刮削中…';
    try {
      var r = await api('/api/book/' + encodeURIComponent(id) + '/rescan', { method: 'POST' });
      booksById[r.book.id] = r.book;
      renderSheet(r.book);
      // A single-book repair also bumps scannedAt. Absorb it here first, so the
      // background poll does not fire its own "书房已更新" toast on top of ours.
      await renderStats();
      await renderBooks();
      var bits = [];
      if (r.changed.title) bits.push('书名改为「' + r.book.title + '」');
      if (r.changed.author) bits.push('作者改为「' + (r.book.author || '未知') + '」');
      if (r.changed.cover) bits.push(r.book.coverFile ? '换上了真封面' : '仍然没有封面');
      toast(bits.length ? '已重刮：' + bits.join('，') : '重刮完成，信息没有变化 · ' + r.durationMs + 'ms');
    } catch (e) {
      toast(e.message);
    } finally {
      sheetRescan.disabled = false;
      sheetRescan.textContent = '重新刮削这本';
    }
  }

  // The corner button lives inside the card link, so the click has to be
  // intercepted before it turns into a page navigation.
  shelf.addEventListener('click', function (e) {
    var more = e.target && e.target.closest ? e.target.closest('.cover-more') : null;
    if (!more) return;
    e.preventDefault();
    e.stopPropagation();
    openSheet(more.getAttribute('data-id'));
  });
  shelf.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var more = e.target && e.target.closest ? e.target.closest('.cover-more') : null;
    if (!more) return;
    e.preventDefault();
    e.stopPropagation();
    openSheet(more.getAttribute('data-id'));
  });
  sheetScrim.addEventListener('click', closeSheet);
  sheetClose.addEventListener('click', closeSheet);
  sheetRescan.addEventListener('click', rescanOne);
  sheetOpen.addEventListener('click', function () {
    if (sheetBook) location.href = '/reader?id=' + encodeURIComponent(sheetBook.id);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  function renderFilters() {
    var items = [['', '全部', Object.values(formats).reduce(function (a, b) { return a + b; }, 0)]];
    Object.keys(formats).sort().forEach(function (f) { items.push([f, f.toUpperCase(), formats[f]]); });
    filters.innerHTML = items.map(function (item) {
      return '<button class="filter" type="button" data-format="' + esc(item[0]) + '" aria-pressed="' +
        (state.format === item[0]) + '">' + esc(item[1]) + '<em>' + item[2] + '</em></button>';
    }).join('');
    Array.prototype.forEach.call(filters.querySelectorAll('.filter'), function (btn) {
      btn.addEventListener('click', function () {
        state.format = btn.dataset.format;
        renderFilters();
        renderBooks();
      });
    });
  }

  function clock(iso) {
    return iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  }

  function span(ms) {
    if (!ms && ms !== 0) return '';
    return ms < 1000 ? ms + ' 毫秒' : (ms / 1000).toFixed(1) + ' 秒';
  }

  async function renderStats() {
    try {
      var stats = await api('/api/stats');
      formats = stats.formats || {};
      lastScannedAt = stats.scannedAt;
      lastCount = stats.count;
      lastScanning = Boolean(stats.scanning);
      document.getElementById('stat-count').textContent = stats.count;
      var when = stats.scannedAt ? new Date(stats.scannedAt).toLocaleString('zh-CN', {
        month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '从未';
      var bits = ['上次整理 ' + when];
      if (stats.scanning) bits.push('正在整理…');
      var last = stats.lastScan;
      if (last && last.reused > 0) {
        bits.push('跳过 ' + last.reused + ' 册未变化');
      } else if (last && last.scraped > 0) {
        bits.push('本次刮削 ' + last.scraped + ' 册 · ' + span(last.durationMs));
      }
      if (stats.autoScanMinutes) {
        bits.push('每 ' + stats.autoScanMinutes + ' 分钟自动整理');
        if (stats.nextScanAt && !stats.scanning) bits.push('下次 ' + clock(stats.nextScanAt));
      } else if (stats.scanOnStart) {
        bits.push('启动时自动整理');
      }
      if (!stats.calibre) bits.push('未检测到 Calibre，MOBI/AZW3 无法在线阅读');
      document.getElementById('stat-meta').textContent = bits.join(' · ');
      renderFilters();
    } catch (e) {
      document.getElementById('stat-meta').textContent = '书房暂时无法访问';
      toast(e.message);
    }
  }

  // Background scans (startup / timer) change the shelf without a page reload.
  // Poll the cheap stats endpoint and refresh only when a new scan finished.
  async function pollStats() {
    if (document.hidden) return;
    try {
      var stats = await api('/api/stats');
      var scanning = Boolean(stats.scanning);
      if (scanning !== lastScanning) {
        await renderStats();
        return;
      }
      if (lastScannedAt && stats.scannedAt && stats.scannedAt !== lastScannedAt) {
        var last = stats.lastScan;
        // A scan that only re-stat'ed an unchanged shelf has nothing to show:
        // update the caption and leave the grid alone.
        if (last && last.changed === false) {
          await renderStats();
          return;
        }
        var added = stats.count - lastCount;
        toast(added > 0 ? ('书房已更新，新增 ' + added + ' 册') : '书房已更新');
        await renderStats();
        await renderBooks();
      }
    } catch (e) { /* stay quiet: a transient poll failure is not user-facing */ }
  }

  async function rescan() {
    rescanBtn.disabled = true;
    rescanBtn.textContent = '刮削中…';
    try {
      var result = await api('/api/rescan', { method: 'POST' });
      var st = result.stats || {};
      var msg = '已整理 ' + result.count + ' 册';
      if (st.reused > 0) msg += '，跳过 ' + st.reused + ' 册未变化';
      if (st.durationMs !== undefined) msg += ' · ' + span(st.durationMs);
      toast(msg);
      await renderStats();
      await renderBooks();
    } catch (e) {
      toast(e.message);
    } finally {
      rescanBtn.disabled = false;
      rescanBtn.textContent = '刮削';
    }
  }

  var searchTimer;
  document.getElementById('search').addEventListener('input', function (e) {
    clearTimeout(searchTimer);
    var value = e.target.value.trim();
    searchTimer = setTimeout(function () { state.q = value; renderBooks(); }, 180);
  });

  document.getElementById('sort').addEventListener('change', function (e) {
    state.sort = e.target.value;
    renderBooks();
  });

  document.getElementById('order').addEventListener('click', function (e) {
    state.order = state.order === 'asc' ? 'desc' : 'asc';
    e.target.textContent = state.order === 'asc' ? '升序' : '降序';
    renderBooks();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.view-switch button'), function (btn) {
    btn.addEventListener('click', function () {
      state.view = btn.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll('.view-switch button'), function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      renderBooks();
    });
  });

  rescanBtn.addEventListener('click', rescan);
  document.getElementById('empty-rescan').addEventListener('click', rescan);

  renderStats();
  renderBooks();
  setInterval(pollStats, 10000);
})();
