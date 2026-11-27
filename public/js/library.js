(function () {
  'use strict';

  var state = {
    sort: 'title', order: 'asc', q: '', format: '',
    view: 'grid', status: '', shelf: ''
  };
  var shelf = document.getElementById('shelf');
  var filters = document.getElementById('filters');
  var empty = document.getElementById('empty');
  var toastEl = document.getElementById('toast');
  var rescanBtn = document.getElementById('rescan');
  var shelvesBar = document.getElementById('shelves-bar');
  var continueBox = document.getElementById('continue');
  var continueMain = document.getElementById('continue-main');
  var continueImg = document.getElementById('continue-img');
  var continueTitle = document.getElementById('continue-title');
  var continueAuthor = document.getElementById('continue-author');
  var continueFill = document.getElementById('continue-fill');
  var continueMeta = document.getElementById('continue-meta');
  var continueList = document.getElementById('continue-list');
  var readingLine = document.getElementById('reading-line');
  var rail = document.getElementById('rail');
  var layoutEl = document.getElementById('layout');
  var formats = {};
  var booksById = {};
  var shelves = [];
  var summary = null;
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

  function send(url, method, body) {
    return api(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function pct(book) {
    var p = book.progress && book.progress.percent;
    return typeof p === 'number' ? Math.round(p * 100) : 0;
  }

  function coverUrl(book) {
    return '/api/book/' + esc(book.id) + '/cover' + (book.coverFile ? '?v=' + esc(book.coverFile) : '');
  }

  function card(book) {
    var percent = pct(book);
    var href = '/reader?id=' + encodeURIComponent(book.id);
    var cover = '<span class="cover"><img src="' + coverUrl(book) + '" alt="" loading="lazy">' +
      '<span class="format-tag">' + esc(book.format.toUpperCase()) + '</span>' +
      '<span class="cover-more" role="button" tabindex="0" data-id="' + esc(book.id) +
      '" aria-label="查看《' + esc(book.title) + '》的详情与单独刮削">⋯</span></span>';
    var title = '<span class="book-title">' + esc(book.title || '未命名') + '</span>';
    var author = '<span class="book-author">' + esc(book.author || '佚名') + '</span>';
    var progress = '<span class="progress-line"><i style="width:' + percent + '%"></i></span>';

    if (state.view === 'list') {
      var mark = book.status === 'finished' ? '读完' : (percent ? percent + '%' : '未读');
      return '<a class="book" href="' + href + '" aria-label="阅读《' + esc(book.title) + '》">' +
        cover + title + author +
        '<span class="list-format">' + esc(book.format.toUpperCase()) + '</span>' +
        '<span class="list-progress">' + mark + '</span>' +
        '</a>';
    }
    return '<a class="book" href="' + href + '" aria-label="阅读《' + esc(book.title) + '》">' +
      cover + title + author + progress + '</a>';
  }

  async function renderBooks() {
    var params = new URLSearchParams({
      sort: state.sort, order: state.order, q: state.q, format: state.format,
      status: state.status, collection: state.shelf
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

  /* ---------- durations ---------- */
  function duration(seconds) {
    var s = Math.max(0, Math.round(seconds || 0));
    if (s < 60) return s > 0 ? '不到 1 分钟' : '0 分钟';
    var minutes = Math.round(s / 60);
    if (minutes < 60) return minutes + ' 分钟';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    if (hours < 24) return hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
    var days = Math.floor(hours / 24);
    return days + ' 天' + (hours % 24 ? ' ' + (hours % 24) + ' 小时' : '');
  }

  function agoText(iso) {
    if (!iso) return '';
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!Number.isFinite(diff) || diff < 0) return '';
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return new Date(iso).toLocaleDateString('zh-CN');
  }

  function whereText(book) {
    var p = book.progress || {};
    if (book.format === 'pdf' || book.format === 'txt') {
      var n = Number(p.location);
      if (Number.isFinite(n) && n > 0) {
        return '第 ' + (book.format === 'txt' ? n + 1 : n) + ' 页';
      }
    }
    var percent = pct(book);
    return percent ? '读到 ' + percent + '%' : '刚开始';
  }

  /* ---------- continue reading ---------- */
  // The rail is a fixed 296px column. If nothing has been opened yet there is
  // nothing to put in it but a one-line hint, so it collapses and the shelf
  // takes the full width instead of leaving a dead strip on the left.
  function syncRail() {
    var bare = continueBox.hidden;
    if (rail) rail.hidden = bare;
    if (layoutEl) layoutEl.classList.toggle('is-bare', bare);
  }

  async function renderContinue() {
    try {
      var data = await api('/api/books?status=reading&sort=recent&limit=6');
      var books = data.books || [];
      if (!books.length) {
        continueBox.hidden = true;
        syncRail();
        return;
      }
      var main = books[0];
      continueBox.hidden = false;
      continueMain.href = '/reader?id=' + encodeURIComponent(main.id);
      continueImg.src = coverUrl(main);
      continueImg.alt = '《' + (main.title || '未命名') + '》封面';
      continueTitle.textContent = main.title || '未命名';
      continueAuthor.textContent = main.author || '佚名';
      continueFill.style.width = Math.max(2, pct(main)) + '%';

      var meta = ['<em class="is-amber">' + esc(whereText(main)) + '</em>'];
      if (main.progress && main.progress.updatedAt) {
        meta.push('<em>' + esc(agoText(main.progress.updatedAt)) + '</em>');
      }
      if (main.noteCount && main.noteCount.highlights) {
        meta.push('<em>' + main.noteCount.highlights + ' 条笔记</em>');
      }
      continueMeta.innerHTML = meta.join('');

      continueList.innerHTML = books.slice(1, 5).map(function (book) {
        var percent = pct(book);
        return '<a class="continue-item" href="/reader?id=' + encodeURIComponent(book.id) + '">' +
          '<img src="' + coverUrl(book) + '" alt="" loading="lazy">' +
          '<span>' + esc(book.title || '未命名') + '</span>' +
          '<em>' + (percent ? percent + '%' : '刚开始') + '</em></a>';
      }).join('') || statRows();
      syncRail();
    } catch (e) {
      continueBox.hidden = true;
      syncRail();
    }
  }

  // With only one book in progress the side column would be an empty box, so it
  // shows the numbers that are worth a glance instead.
  function statRows() {
    if (!summary) return '<p class="continue-empty">其他书都还没开始。</p>';
    return [
      ['今天', summary.today.seconds],
      ['本周', summary.week.seconds],
      ['连续', summary.streak * 60]
    ].map(function (row) {
      var value = row[0] === '连续' ? (summary.streak ? summary.streak + ' 天' : '—') : duration(row[1]);
      return '<button type="button" class="continue-stat" data-open-stats="1">' +
        '<span>' + row[0] + '</span><em>' + value + '</em></button>';
    }).join('');
  }

  continueList.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-open-stats]')) openStats();
  });

  /* ---------- shelves bar ---------- */
  function totals() {
    return (summary && summary.totals) || null;
  }

  function chip(label, attrs, active, extra) {
    return '<button type="button" class="chip' + (extra ? ' ' + extra : '') + '" aria-pressed="' + active + '" ' +
      attrs + '>' + label + '</button>';
  }

  function renderShelves() {
    var t = totals();
    var html = '';
    html += chip('全部', 'data-status=""', !state.status && !state.shelf);
    html += chip('在读' + (t ? '<em>' + t.reading + '</em>' : ''), 'data-status="reading"',
      state.status === 'reading' && !state.shelf);
    html += chip('读完' + (t ? '<em>' + t.finished + '</em>' : ''), 'data-status="finished"',
      state.status === 'finished' && !state.shelf);
    html += '<span class="chip-sep" aria-hidden="true"></span>';
    shelves.forEach(function (s) {
      html += '<button type="button" class="chip" aria-pressed="' + (state.shelf === s.id) + '" data-shelf="' + esc(s.id) + '">' +
        esc(s.name) + '<em>' + s.count + '</em>' +
        '<span class="chip-x" data-del="' + esc(s.id) + '" role="button" tabindex="0" aria-label="删除书单 ' + esc(s.name) + '">×</span>' +
        '</button>';
    });
    html += '<button type="button" class="chip chip-new" id="shelf-new-chip">＋ 书单</button>';
    shelvesBar.innerHTML = html;
  }

  async function loadShelves() {
    try {
      var data = await api('/api/collections');
      shelves = data.collections || [];
    } catch (e) {
      shelves = [];
    }
    renderShelves();
  }

  async function createShelf() {
    var name = window.prompt('新书单叫什么？（比如：今年要读、历史专题）', '');
    if (name === null) return null;
    name = name.trim();
    if (!name) return null;
    try {
      var r = await send('/api/collections', 'POST', { name: name });
      await loadShelves();
      toast('已创建书单「' + r.collection.name + '」');
      return r.collection;
    } catch (e) {
      toast(e.message);
      return null;
    }
  }

  async function deleteShelf(id) {
    var item = shelves.find(function (s) { return s.id === id; });
    if (!item) return;
    if (!window.confirm('删除书单「' + item.name + '」？书本身不会被删，只是不再归在这个书单里。')) return;
    try {
      await api('/api/collections/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.shelf === id) state.shelf = '';
      await loadShelves();
      await renderBooks();
      toast('已删除书单');
    } catch (e) {
      toast(e.message);
    }
  }

  shelvesBar.addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteShelf(del.getAttribute('data-del'));
      return;
    }
    if (e.target.closest && e.target.closest('#shelf-new-chip')) {
      createShelf();
      return;
    }
    var shelfBtn = e.target.closest ? e.target.closest('[data-shelf]') : null;
    if (shelfBtn) {
      state.shelf = state.shelf === shelfBtn.getAttribute('data-shelf') ? '' : shelfBtn.getAttribute('data-shelf');
      state.status = '';
      renderShelves();
      renderBooks();
      return;
    }
    var statusBtn = e.target.closest ? e.target.closest('[data-status]') : null;
    if (statusBtn) {
      state.status = statusBtn.getAttribute('data-status') || '';
      state.shelf = '';
      renderShelves();
      renderBooks();
    }
  });
  shelvesBar.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (!del) return;
    e.preventDefault();
    deleteShelf(del.getAttribute('data-del'));
  });

  /* ---------- reading summary line + statistics ---------- */
  async function renderReading() {
    try {
      summary = await api('/api/reading/summary');
    } catch (e) {
      summary = null;
      readingLine.hidden = true;
      syncRail();
      return;
    }
    var bits = [];
    if (summary.week.seconds > 0) bits.push('本周 ' + duration(summary.week.seconds));
    if (summary.streak > 1) bits.push('连续 ' + summary.streak + ' 天');
    if (summary.year.finished > 0) bits.push('今年读完 ' + summary.year.finished + ' 本');
    if (summary.today.seconds > 0) bits.unshift('今天 ' + duration(summary.today.seconds));
    readingLine.hidden = false;
    readingLine.innerHTML = '<span>' + esc(bits.length ? bits.join(' · ') : '还没有阅读记录，翻开一本书就开始计时') +
      '</span><em>阅读统计 ›</em>';
    syncRail();
    renderShelves();
    // The side column falls back to these numbers when there is only one book
    // in progress, and that fallback needs the summary that just arrived.
    renderContinue();
  }

  var statsSheet = document.getElementById('stats-sheet');
  var statsScrim = document.getElementById('stats-scrim');

  function renderStatsSheet() {
    if (!summary) return;
    document.getElementById('stats-sub').textContent = summary.totals.books + ' 册藏书 · ' +
      summary.totals.reading + ' 本在读 · ' + summary.totals.finished + ' 本读完';

    var tiles = [
      ['今天', summary.today.seconds, false],
      ['本周', summary.week.seconds, true],
      ['今年', summary.year.seconds, false],
      ['连续', summary.streak, false, '天']
    ];
    document.getElementById('stats-tiles').innerHTML = tiles.map(function (t) {
      var value = t[0] === '连续' ? String(t[1]) : String(Math.round(t[1] / 60));
      var unit = t[0] === '连续' ? '天' : '分钟';
      return '<div class="stats-tile' + (t[2] ? ' is-amber' : '') + '"><span>' + t[0] + '</span>' +
        '<strong>' + value + '<em>' + unit + '</em></strong></div>';
    }).join('');

    var max = Math.max(60, Math.max.apply(null, summary.daily.map(function (d) { return d.seconds; })));
    document.getElementById('stats-chart').innerHTML = summary.daily.map(function (d) {
      var h = Math.max(2, Math.round(d.seconds / max * 106));
      var cls = 'stats-bar' + (d.seconds ? ' has-time' : '') + (d.date === summary.today.date ? ' is-today' : '');
      return '<i class="' + cls + '" style="height:' + h + 'px" title="' + d.date + ' · ' + duration(d.seconds) + '"></i>';
    }).join('');

    var topHtml = summary.top.length
      ? '<ul>' + summary.top.map(function (b) {
        return '<li><span>' + esc(b.title) + '</span><em>' + duration(b.seconds) + '</em></li>';
      }).join('') + '</ul>'
      : '<p class="stats-empty">还没有统计到在读的书。</p>';
    var finishedHtml = summary.recentFinished.length
      ? '<ul>' + summary.recentFinished.map(function (b) {
        return '<li><span>' + esc(b.title) + '</span><em>' +
          esc(new Date(b.finishedAt).toLocaleDateString('zh-CN')) + '</em></li>';
      }).join('') + '</ul>'
      : '<p class="stats-empty">还没有标记读完了的书。</p>';

    document.getElementById('stats-lists').innerHTML =
      '<div class="stats-list"><h3>最常翻的书</h3>' + topHtml + '</div>' +
      '<div class="stats-list"><h3>最近读完</h3>' + finishedHtml + '</div>';
  }

  function openStats() {
    if (!summary) return;
    renderStatsSheet();
    statsScrim.hidden = false;
    statsSheet.hidden = false;
    document.getElementById('stats-close').focus();
  }

  function closeStats() {
    statsSheet.hidden = true;
    statsScrim.hidden = true;
  }

  // 阅读统计 is reached from the reading line in the rail now; the old header
  // button would not exist if the rail collapsed.
  readingLine.addEventListener('click', openStats);
  document.getElementById('stats-close').addEventListener('click', closeStats);
  statsScrim.addEventListener('click', closeStats);

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
  var sheetState = document.getElementById('book-sheet-state');
  var sheetShelves = document.getElementById('book-sheet-shelves');
  var sheetNotes = document.getElementById('book-sheet-notes');
  var sheetShelfBtn = document.getElementById('book-sheet-shelf-btn');
  var picker = document.getElementById('shelf-picker');
  var pickerList = document.getElementById('shelf-picker-list');
  var pickerInput = document.getElementById('shelf-new-name');
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

  var STATUS_LABEL = { unread: '未读', reading: '在读', finished: '读完' };

  function renderSheet(book) {
    sheetBook = book;
    book.status = book.status || 'unread';
    book.collections = book.collections || [];
    sheetImg.src = coverUrl(book);
    sheetImg.alt = '《' + (book.title || '未命名') + '》封面';
    sheetName.textContent = book.title || '未命名';
    sheetAuthor.textContent = book.author || '佚名';

    Array.prototype.forEach.call(sheetState.querySelectorAll('button'), function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-status') === book.status));
    });

    sheetShelves.innerHTML = (book.collections || []).map(function (id) {
      var item = shelves.find(function (s) { return s.id === id; });
      return item ? '<span class="chip" aria-pressed="true">' + esc(item.name) + '</span>' : '';
    }).join('');

    var counts = book.noteCount || { highlights: 0, bookmarks: 0 };
    sheetNotes.textContent = '笔记与书签' + (counts.highlights + counts.bookmarks ? '（' + (counts.highlights + counts.bookmarks) + '）' : '');

    var rows = [
      ['格式', (book.format || '').toUpperCase()],
      ['大小', sizeText(book.size)],
      ['状态', STATUS_LABEL[book.status] || '未读'],
      ['路径', book.path || ''],
      ['入馆', book.addedAt ? new Date(book.addedAt).toLocaleString('zh-CN') : '—']
    ];
    if (book.progress && book.progress.percent) {
      rows.push(['进度', Math.round(book.progress.percent * 100) + '%']);
    }
    if (book.progress && book.progress.finishedAt) {
      rows.push(['读完于', new Date(book.progress.finishedAt).toLocaleDateString('zh-CN')]);
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

  function renderShelfPicker() {
    if (!sheetBook) return;
    if (!shelves.length) {
      pickerList.innerHTML = '<p class="shelf-picker-empty">还没有书单，在下面新建一个。</p>';
      return;
    }
    pickerList.innerHTML = shelves.map(function (s) {
      var on = (sheetBook.collections || []).indexOf(s.id) >= 0;
      return '<label class="shelf-picker-row">' +
        '<input type="checkbox" data-shelf="' + esc(s.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + esc(s.name) + '</span><em>' + s.count + ' 本</em></label>';
    }).join('');
  }

  function openSheet(id) {
    var book = booksById[id];
    if (!book) return;
    renderSheet(book);
    picker.hidden = true;
    sheetScrim.hidden = false;
    sheet.hidden = false;
    sheetClose.focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    sheetScrim.hidden = true;
    picker.hidden = true;
    sheetBook = null;
  }

  async function refreshSheet() {
    if (!sheetBook) return;
    var fresh = await api('/api/book/' + encodeURIComponent(sheetBook.id));
    booksById[fresh.id] = fresh;
    renderSheet(fresh);
  }

  sheetState.addEventListener('click', async function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-status]') : null;
    if (!btn || !sheetBook) return;
    var want = btn.getAttribute('data-status');
    if (want === sheetBook.status) return;
    if (want === 'unread' && !window.confirm('标记为未读会清空这本书的阅读位置，下次从第一页开始。确定吗？')) return;
    Array.prototype.forEach.call(sheetState.querySelectorAll('button'), function (b) { b.disabled = true; });
    try {
      await send('/api/book/' + encodeURIComponent(sheetBook.id) + '/status', 'POST', { status: want });
      await refreshSheet();
      await renderBooks();
      await renderContinue();
      await renderReading();
      toast('已标记为' + (STATUS_LABEL[want] || ''));
    } catch (err) {
      toast(err.message);
    } finally {
      Array.prototype.forEach.call(sheetState.querySelectorAll('button'), function (b) { b.disabled = false; });
    }
  });

  sheetShelfBtn.addEventListener('click', function () {
    if (!sheetBook) return;
    picker.hidden = !picker.hidden;
    if (!picker.hidden) {
      renderShelfPicker();
      pickerInput.value = '';
    }
  });

  pickerList.addEventListener('change', async function (e) {
    var cb = e.target.closest ? e.target.closest('input[data-shelf]') : null;
    if (!cb || !sheetBook) return;
    cb.disabled = true;
    var shelfId = cb.getAttribute('data-shelf');
    try {
      await send('/api/collections/' + encodeURIComponent(shelfId), 'PUT',
        cb.checked ? { add: [sheetBook.id] } : { remove: [sheetBook.id] });
      await loadShelves();
      await refreshSheet();
      renderShelfPicker();
      await renderBooks();
    } catch (err) {
      toast(err.message);
      cb.checked = !cb.checked;
      cb.disabled = false;
    }
  });

  document.getElementById('shelf-new-btn').addEventListener('click', async function () {
    var name = pickerInput.value.trim();
    if (!name) { pickerInput.focus(); return; }
    try {
      var r = await send('/api/collections', 'POST', { name: name });
      if (sheetBook) {
        await send('/api/collections/' + encodeURIComponent(r.collection.id), 'PUT', { add: [sheetBook.id] });
      }
      pickerInput.value = '';
      await loadShelves();
      await refreshSheet();
      renderShelfPicker();
      await renderBooks();
      toast('已加入「' + r.collection.name + '」');
    } catch (err) {
      toast(err.message);
    }
  });
  pickerInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('shelf-new-btn').click();
    }
    e.stopPropagation();
  });

  sheetNotes.addEventListener('click', function () {
    if (!sheetBook) return;
    location.href = '/reader?id=' + encodeURIComponent(sheetBook.id) + '&panel=notes';
  });

  async function rescanOne() {
    if (!sheetBook) return;
    var id = sheetBook.id;
    sheetRescan.disabled = true;
    sheetRescan.textContent = '刮削中…';
    try {
      var r = await api('/api/book/' + encodeURIComponent(id) + '/rescan', { method: 'POST' });
      booksById[r.book.id] = r.book;
      // A single-book repair also bumps scannedAt. Absorb it here first, so the
      // background poll does not fire its own "书房已更新" toast on top of ours.
      await renderStats();
      await renderBooks();
      await refreshSheet();
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
    if (e.key !== 'Escape') return;
    if (!sheet.hidden) closeSheet();
    else if (!statsSheet.hidden) closeStats();
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
      if (!stats.converter) bits.push('镜像缺少 Kindle 解包器，MOBI/AZW3 无法在线阅读');
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
        await loadShelves();
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
      await loadShelves();
      await renderBooks();
      await renderReading();
      await renderContinue();
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
  loadShelves();
  renderReading();
  renderBooks();
  renderContinue();
  setInterval(pollStats, 10000);
})();
