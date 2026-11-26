(function () {
  'use strict';

  var state = { sort: 'added', order: 'desc', q: '', format: '', view: 'grid' };
  var shelf = document.getElementById('shelf');
  var filters = document.getElementById('filters');
  var empty = document.getElementById('empty');
  var toastEl = document.getElementById('toast');
  var rescanBtn = document.getElementById('rescan');
  var formats = {};
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
    var cover = '<span class="cover"><img src="/api/book/' + esc(book.id) + '/cover" alt="" loading="lazy">' +
      '<span class="format-tag">' + esc(book.format.toUpperCase()) + '</span></span>';
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
      shelf.className = 'shelf ' + state.view;
      shelf.innerHTML = data.books.map(card).join('');
      empty.hidden = data.books.length > 0;
    } catch (e) {
      shelf.innerHTML = '';
      toast(e.message);
    }
  }

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
