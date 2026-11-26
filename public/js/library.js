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

  async function renderStats() {
    try {
      var stats = await api('/api/stats');
      formats = stats.formats || {};
      document.getElementById('stat-count').textContent = stats.count;
      var when = stats.scannedAt ? new Date(stats.scannedAt).toLocaleString('zh-CN', {
        month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '从未';
      document.getElementById('stat-meta').textContent =
        '上次整理 ' + when + (stats.calibre ? '' : ' · 未检测到 Calibre，MOBI/AZW3 无法在线阅读');
      renderFilters();
    } catch (e) {
      document.getElementById('stat-meta').textContent = '书房暂时无法访问';
      toast(e.message);
    }
  }

  async function rescan() {
    rescanBtn.disabled = true;
    rescanBtn.textContent = '刮削中…';
    try {
      var result = await api('/api/rescan', { method: 'POST' });
      toast('已整理 ' + result.count + ' 册');
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
})();
