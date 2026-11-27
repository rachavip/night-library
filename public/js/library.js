(function () {
  'use strict';

  var state = {
    sort: 'title', order: 'asc', q: '', format: '',
    view: 'grid', status: '', shelf: '',
    // '' = the shelf people expect (hidden books left out), 'only' = the hidden
    // pile itself, 'all' = everything including it.
    hidden: '',
    selecting: false,
    selected: new Set()
  };
  var shelf = document.getElementById('shelf');
  var filters = document.getElementById('filters');
  var empty = document.getElementById('empty');
  var toastEl = document.getElementById('toast');
  var rescanBtn = document.getElementById('rescan');
  var selectModeBtn = document.getElementById('select-mode');
  var railStates = document.getElementById('rail-states');
  var railSeries = document.getElementById('rail-series');
  var railSeriesReset = document.getElementById('rail-series-reset');
  var railTotal = document.getElementById('rail-total');
  var batchBar = document.getElementById('batch-bar');
  var batchCount = document.getElementById('batch-count');
  var seriesPicker = document.getElementById('series-picker');
  var seriesPickerList = document.getElementById('series-picker-list');
  var seriesPickerHint = document.getElementById('series-picker-hint');
  var seriesPickerNew = document.getElementById('series-picker-new');
  var seriesNewHint = document.getElementById('series-new-hint');
  var seriesNewName = document.getElementById('series-new-name');
  // 同一个面板干两件事：'add' 保留原归属，'move' 只留目标那一组。
  var pickerMode = 'add';
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
  var visibleFormats = {};
  var hiddenFormats = {};
  var hiddenCount = 0;
  var visibleCount = 0;
  var booksById = {};
  var shelves = [];
  // Auto series are derived from titles; `mutedCount` counts the ones the
  // reader folded away, so the rail can offer a way back.
  var mutedCount = 0;
  var lastBooks = [];
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
      var payload = null;
      try { payload = await res.json(); } catch (e) { /* 非 JSON 错误页 */ }
      // 409 会带回「撞上哪个分组」，交给调用方决定合并还是放弃。
      var err = new Error((payload && payload.error) || ('请求失败 ' + res.status));
      if (payload) {
        if (payload.code) err.code = payload.code;
        if (payload.match) err.match = payload.match;
      }
      throw err;
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
    // Open in a new tab so an embedded music player on the shelf keeps
    // playing while the reader is open.
    var href = '/reader?id=' + encodeURIComponent(book.id);
    var target = ' target="_blank" rel="noopener"';
    var picked = state.selected.has(book.id);
    var cls = 'book' + (picked ? ' is-picked' : '');
    var dataId = ' data-id="' + esc(book.id) + '"';
    var cover = '<span class="cover"><span class="pick" aria-hidden="true">✓</span>' +
      '<img src="' + coverUrl(book) + '" alt="" loading="lazy" draggable="false">' +
      '<span class="format-tag">' + esc(book.format.toUpperCase()) + '</span>' +
      '<span class="cover-more" role="button" tabindex="0" data-id="' + esc(book.id) +
      '" aria-label="查看《' + esc(book.title) + '》的详情与单独刮削">⋯</span></span>';
    var title = '<span class="book-title">' + esc(book.title || '未命名') + '</span>';
    var author = '<span class="book-author">' + esc(book.author || '佚名') + '</span>';
    var progress = '<span class="progress-line"><i style="width:' + percent + '%"></i></span>';

    if (state.view === 'list') {
      var mark = book.status === 'finished' ? '读完' : (percent ? percent + '%' : '未读');
      return '<a class="' + cls + '" href="' + href + '"' + target + ' draggable="false"' + dataId + ' aria-label="阅读《' + esc(book.title) + '》">' +
        cover + title + author +
        '<span class="list-format">' + esc(book.format.toUpperCase()) + '</span>' +
        '<span class="list-progress">' + mark + '</span>' +
        '</a>';
    }
    return '<a class="' + cls + '" href="' + href + '"' + target + ' draggable="false"' + dataId + ' aria-label="阅读《' + esc(book.title) + '》">' +
      cover + title + author + progress + '</a>';
  }

  async function renderBooks() {
    var params = new URLSearchParams({
      sort: state.sort, order: state.order, q: state.q, format: state.format,
      status: state.status, collection: state.shelf, hidden: state.hidden
    });
    try {
      var data = await api('/api/books?' + params.toString());
      booksById = {};
      lastBooks = data.books;
      data.books.forEach(function (b) { booksById[b.id] = b; });
      // Ids that dropped out of this listing must not stay selected: hiding
      // them and then pressing "hide" again would be a silent no-op.
      var alive = new Set(data.books.map(function (b) { return b.id; }));
      Array.from(state.selected).forEach(function (id) {
        if (!alive.has(id)) state.selected.delete(id);
      });
      shelf.className = 'shelf ' + state.view + (state.selecting ? ' is-selecting' : '');
      shelf.innerHTML = data.books.map(card).join('');
      if (data.books.length) {
        empty.hidden = true;
      } else {
        empty.hidden = false;
        // The empty state has to explain the tab it belongs to: "put books in
        // the folder" makes no sense when the hidden pile is simply empty.
        var heading = empty.querySelector('h2');
        var note = empty.querySelector('p');
        if (state.hidden === 'only') {
          heading.textContent = '还没有隐藏的书';
          note.textContent = '点顶栏「整理」，勾选不常看的书再点「隐藏」，它们就会收在这里。';
        } else {
          heading.textContent = '这一格还空着';
          note.textContent = '把书放进挂载的文件夹，再点一次「刮削」就会出现在书架。';
        }
      }
      syncBatch();
    } catch (e) {
      shelf.innerHTML = '';
      lastBooks = [];
      empty.hidden = true;
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
  // The rail now carries the navigation, so it stays put even when nothing is
  // in progress; only the reading block inside it collapses.
  function syncRail() {
    if (rail) rail.hidden = false;
    if (layoutEl) layoutEl.classList.remove('is-bare');
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
      continueMain.target = '_blank';
      continueMain.rel = 'noopener';
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

  /* ---------- rail: reading states and series ---------- */
  function totals() {
    return (summary && summary.totals) || null;
  }

  function railItem(label, count, active, attrs, extra) {
    return '<button type="button" class="rail-item' + (extra ? ' ' + extra : '') +
      '" aria-pressed="' + active + '" ' + attrs + '>' +
      '<span>' + label + '</span>' +
      (count === null || count === undefined ? '' : '<em>' + count + '</em>') +
      '</button>';
  }

  function renderRail() {
    var t = totals();
    railTotal.textContent = visibleCount + ' 册可见' + (hiddenCount ? ' · ' + hiddenCount + ' 隐藏' : '');
    // 这里不放「全部」：格式条最前面已经有一个，写两遍是重复。
    // 从「在读」这类筛选退出时，再点一次当前项就回到全部。
    railStates.innerHTML =
      railItem('在读', t ? t.reading : '—',
        state.status === 'reading' && state.hidden !== 'only', 'data-nav="reading"') +
      railItem('读完', t ? t.finished : '—',
        state.status === 'finished' && state.hidden !== 'only', 'data-nav="finished"') +
      railItem('隐藏', hiddenCount, state.hidden === 'only', 'data-nav="hidden"', 'is-hidden-item');

    // 两组：软件按书名自己归的（可以改名、可以收起）和手动建的。
    // 自动的排前面，它们通常就是整柜书。
    var auto = shelves.filter(function (s) { return s.auto; });
    var manual = shelves.filter(function (s) { return !s.auto; });

    function row(s) {
      return '<button type="button" class="rail-item' +
        '" aria-pressed="' + (state.shelf === s.id) + '"' +
        ' data-series="' + esc(s.id) + '" title="' + esc(s.auto ? '按书名自动归组' : '手动建的丛书') + '">' +
        '<span>' + esc(s.name) + '</span><em>' + s.count + '</em>' +
        '<span class="rail-edit" data-rename-series="' + esc(s.id) + '" role="button" tabindex="0"' +
        ' aria-label="给「' + esc(s.name) + '」改名">✎</span>' +
        '<span class="rail-x" data-del-series="' + esc(s.id) + '" role="button" tabindex="0"' +
        ' aria-label="' + (s.auto ? '不再显示「' : '删除「') + esc(s.name) + '」">×</span>' +
        '</button>';
    }

    var html = auto.map(row).join('') + manual.map(row).join('');
    railSeries.innerHTML = html || ('<p class="rail-empty">还没有丛书。书名里出现 5 次以上的词会自动归成一套；' +
      '也可以在「整理」里选中几本手动归组。</p>');

    if (railSeriesReset) {
      railSeriesReset.hidden = !mutedCount;
      railSeriesReset.textContent = '↺ 恢复 ' + mutedCount;
      railSeriesReset.title = '把收起的 ' + mutedCount + ' 个自动丛书放回左侧';
    }
  }

  async function loadShelves() {
    try {
      var data = await api('/api/collections');
      shelves = data.collections || [];
      mutedCount = (data.muted || []).length;
    } catch (e) {
      shelves = [];
      mutedCount = 0;
    }
    renderRail();
  }

  function clearFilters() {
    state.status = '';
    state.shelf = '';
    state.hidden = '';
  }

  async function createSeries() {
    var name = window.prompt('新丛书叫什么？（比如：西游记、二十四史、菜谱）', '');
    if (name === null) return null;
    name = name.trim();
    if (!name) return null;
    try {
      var r = await send('/api/collections', 'POST', { name: name });
      await loadShelves();
      if (r.merged) {
        toast('已有「' + r.collection.name + '」分组，没有重复创建');
        return r.collection;
      }
      toast('已创建丛书「' + r.collection.name + '」');
      return r.collection;
    } catch (e) {
      if (e.code === 'AUTO_NAME' && e.match) {
        toast('已有「' + e.match.name + '」分组（自动归组），换个名字，或用「加入丛书」合并进去');
        return null;
      }
      toast(e.message);
      return null;
    }
  }

  // 自动丛书的组名来自书名里的词，往往带着版本号或半截后缀，所以允许改。
  // 改名只换显示，归组的规则不动。
  async function renameSeries(id) {
    var item = shelves.find(function (s) { return s.id === id; });
    if (!item) return;
    var next = window.prompt('把「' + item.name + '」改成什么名字？', item.name);
    if (next === null) return;
    next = next.trim();
    if (!next || next === item.name) return;
    try {
      await send('/api/collections/' + encodeURIComponent(id), 'PUT', { name: next });
      await loadShelves();
      toast('已改名为「' + next + '」');
    } catch (e) {
      // 撞上已有分组：不硬拦，问一句要不要合成一组。
      if (e.code === 'DUPLICATE' && e.match) {
        await mergeInto(id, item, next, e.match);
        return;
      }
      toast(e.message);
    }
  }

  async function mergeInto(fromId, item, next, match) {
    var ask = '已有「' + match.name + '」分组' + (match.auto ? '（自动归组）' : '') +
      '，共 ' + match.count + ' 本。\n\n把「' + item.name + '」（' + item.count + ' 本）并进去吗？' +
      (match.auto
        ? '\n合并后这一组改为手动丛书，按书名自动归组不再生效。'
        : '\n合并后「' + item.name + '」不再单独存在，书一本不少。');
    if (!window.confirm(ask)) return;
    try {
      var r = await send('/api/collections/merge', 'POST',
        { from: fromId, into: match.id, name: next });
      if (state.shelf === fromId) state.shelf = r.collection.id;
      await loadShelves();
      await renderBooks();
      toast('已合并到「' + r.collection.name + '」，共 ' + r.collection.count + ' 本');
    } catch (e) {
      toast(e.message);
    }
  }

  async function restoreSeries() {
    var n = mutedCount;
    try {
      await api('/api/series/restore', { method: 'POST' });
      await loadShelves();
      toast('已放回 ' + n + ' 个自动丛书');
    } catch (e) {
      toast(e.message);
    }
  }

  async function deleteSeries(id) {
    var item = shelves.find(function (s) { return s.id === id; });
    if (!item) return;
    // 自动组删掉下次扫描又会长出来，所以这里记成「不再显示」，可以从组头恢复。
    var ask = item.auto
      ? '不再显示自动丛书「' + item.name + '」？\n书不会被删，只是左侧不再列这一组。组头上会留一个恢复入口。'
      : '删除丛书「' + item.name + '」？书本身不会被删，只是不再归在这一组里。';
    if (!window.confirm(ask)) return;
    try {
      await api('/api/collections/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.shelf === id) state.shelf = '';
      await loadShelves();
      await renderBooks();
      toast(item.auto ? '已收起这一组' : '已删除丛书');
    } catch (e) {
      toast(e.message);
    }
  }

  railStates.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-nav]') : null;
    if (!btn) return;
    var nav = btn.getAttribute('data-nav');
    state.shelf = '';
    if (nav === 'reading' || nav === 'finished') {
      // 再点一次当前项就取消筛选，回到「全部」——左侧没有单独的「全部」了。
      state.status = state.status === nav ? '' : nav;
      state.hidden = '';
    } else if (nav === 'hidden') {
      state.status = '';
      state.hidden = state.hidden === 'only' ? '' : 'only';
    }
    renderRail();
    renderFilters();
    renderBooks();
  });

  railSeries.addEventListener('click', function (e) {
    var rename = e.target.closest ? e.target.closest('[data-rename-series]') : null;
    if (rename) {
      e.preventDefault();
      e.stopPropagation();
      renameSeries(rename.getAttribute('data-rename-series'));
      return;
    }
    var del = e.target.closest ? e.target.closest('[data-del-series]') : null;
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteSeries(del.getAttribute('data-del-series'));
      return;
    }
    var btn = e.target.closest ? e.target.closest('[data-series]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-series');
    state.shelf = state.shelf === id ? '' : id;
    state.status = '';
    state.hidden = '';
    renderRail();
    renderFilters();
    renderBooks();
  });
  railSeries.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var rename = e.target.closest ? e.target.closest('[data-rename-series]') : null;
    if (rename) {
      e.preventDefault();
      renameSeries(rename.getAttribute('data-rename-series'));
      return;
    }
    var del = e.target.closest ? e.target.closest('[data-del-series]') : null;
    if (!del) return;
    e.preventDefault();
    deleteSeries(del.getAttribute('data-del-series'));
  });
  if (railSeriesReset) railSeriesReset.addEventListener('click', restoreSeries);
  document.getElementById('rail-series-new').addEventListener('click', function () { createSeries(); });

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
    renderRail();
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
  var sheetHide = document.getElementById('book-sheet-hide');
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
      if (!item) return '';
      // 自动丛书只是告诉你这本书归到哪，不能在这里点掉，所以标成淡色。
      return '<span class="chip' + (item.auto ? ' chip-auto' : '') + '" aria-pressed="true"' +
        (item.auto ? ' title="按书名自动归组"' : '') + '>' + esc(item.name) + '</span>';
    }).join('');

    var counts = book.noteCount || { highlights: 0, bookmarks: 0 };
    sheetNotes.textContent = '笔记与书签' + (counts.highlights + counts.bookmarks ? '（' + (counts.highlights + counts.bookmarks) + '）' : '');
    // 隐藏是单本也能做的动作，文案跟着当前状态走，点一下就是反向操作。
    sheetHide.textContent = book.hidden ? '取消隐藏' : '隐藏';

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
    // 自动丛书的成员由书名决定，选不了，所以这里只列手动建的。
    var manual = shelves.filter(function (s) { return !s.auto; });
    if (!manual.length) {
      pickerList.innerHTML = '<p class="shelf-picker-empty">还没有手动建的丛书，在下面新建一个。</p>';
      return;
    }
    pickerList.innerHTML = manual.map(function (s) {
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

  async function finishSingleJoin(r) {
    pickerInput.value = '';
    await loadShelves();
    await refreshSheet();
    renderShelfPicker();
    await renderBooks();
    toast('已加入「' + r.collection.name + '」');
  }

  document.getElementById('shelf-new-btn').addEventListener('click', async function () {
    var name = pickerInput.value.trim();
    if (!name) { pickerInput.focus(); return; }
    var ids = sheetBook ? [sheetBook.id] : [];
    try {
      // 同名会自动并进已有组，所以一次请求就够，不必先建后加。
      await finishSingleJoin(await send('/api/collections', 'POST', { name: name, add: ids }));
    } catch (err) {
      if (err.code !== 'AUTO_NAME' || !err.match) { toast(err.message); return; }
      if (!window.confirm('已有「' + err.match.name + '」分组（自动归组，' + err.match.count + ' 本）。\n\n' +
        '并进这一组吗？合并后这一组改为手动维护，原有的 ' + err.match.count + ' 本一起保留。')) return;
      try {
        await finishSingleJoin(await send('/api/collections', 'POST', {
          name: name,
          add: ids,
          adopt: String(err.match.id || '').replace(/^auto:/, '')
        }));
      } catch (e2) {
        toast(e2.message);
      }
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
    window.open('/reader?id=' + encodeURIComponent(sheetBook.id) + '&panel=notes', '_blank', 'noopener');
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

  /* ---------- drag a box over the shelf to pick books ---------- */
  // 桌面端专用：触屏上拖动等于滚动页面，抢过来只会把人搞晕。
  function marqueeAllowed(e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
    return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  }

  var marqueeOrigin = null;
  var marqueeBox = null;
  var marqueeLive = false;
  var suppressClickUntil = 0;

  function marqueeBounds(a, b) {
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y)
    };
  }

  // 只加不减：划过就选中。想反悔再点一下那张卡片就是取消。
  function marqueePick(bounds) {
    var grew = false;
    Array.prototype.forEach.call(shelf.querySelectorAll('.book'), function (node) {
      var r = node.getBoundingClientRect();
      if (!(r.left < bounds.right && r.right > bounds.left &&
            r.top < bounds.bottom && r.bottom > bounds.top)) return;
      var id = node.getAttribute('data-id');
      if (state.selected.has(id)) return;
      state.selected.add(id);
      node.classList.add('is-picked');
      grew = true;
    });
    if (grew) syncBatch();
  }

  shelf.addEventListener('mousedown', function (e) {
    if (!marqueeAllowed(e)) return;
    marqueeOrigin = { x: e.clientX, y: e.clientY };
    marqueeLive = false;
  });

  document.addEventListener('mousemove', function (e) {
    if (!marqueeOrigin) return;
    var bounds = marqueeBounds(marqueeOrigin, { x: e.clientX, y: e.clientY });
    if (!marqueeLive) {
      // 手抖一两个像素不算框选，让它继续当作点击。
      if (bounds.right - bounds.left < 6 && bounds.bottom - bounds.top < 6) return;
      marqueeLive = true;
      if (!state.selecting) {
        setSelecting(true);
        toast('框选已开启：松手就选好，再点「隐藏」');
      }
      document.body.classList.add('is-marquee');
      marqueeBox = document.createElement('div');
      marqueeBox.className = 'marquee';
      document.body.appendChild(marqueeBox);
    }
    marqueeBox.style.left = bounds.left + 'px';
    marqueeBox.style.top = bounds.top + 'px';
    marqueeBox.style.width = (bounds.right - bounds.left) + 'px';
    marqueeBox.style.height = (bounds.bottom - bounds.top) + 'px';
    marqueePick(bounds);
    e.preventDefault();
  });

  function endMarquee() {
    if (!marqueeOrigin) return;
    var live = marqueeLive;
    marqueeOrigin = null;
    marqueeLive = false;
    if (marqueeBox) {
      marqueeBox.remove();
      marqueeBox = null;
    }
    document.body.classList.remove('is-marquee');
    // 松手后浏览器还会补一个 click：落回卡片上会开阅读器或把刚选中的取消掉。
    if (live) suppressClickUntil = Date.now() + 350;
  }

  document.addEventListener('mouseup', endMarquee);
  window.addEventListener('blur', endMarquee);

  // The corner button lives inside the card link, so the click has to be
  // intercepted before it turns into a page navigation. In tidy-up mode the
  // whole card becomes a checkbox and nothing navigates.
  shelf.addEventListener('click', function (e) {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (state.selecting) {
      var link = e.target.closest ? e.target.closest('.book') : null;
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      togglePick(link.getAttribute('data-id'));
      return;
    }
    var more = e.target && e.target.closest ? e.target.closest('.cover-more') : null;
    if (!more) return;
    e.preventDefault();
    e.stopPropagation();
    openSheet(more.getAttribute('data-id'));
  });
  shelf.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (state.selecting) {
      var card = e.target.closest ? e.target.closest('.book') : null;
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      togglePick(card.getAttribute('data-id'));
      return;
    }
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
    if (sheetBook) window.open('/reader?id=' + encodeURIComponent(sheetBook.id), '_blank', 'noopener');
  });
  // 单本隐藏：不用先进「整理」，从详情面板点一下就收起来。
  sheetHide.addEventListener('click', async function () {
    if (!sheetBook) return;
    var book = sheetBook;
    var want = !book.hidden;
    var name = book.title || '未命名';
    sheetHide.disabled = true;
    try {
      await send('/api/books/hide', 'POST', { ids: [book.id], hidden: want });
      toast(want ? '已隐藏《' + name + '》，左侧「隐藏」里能找到' : '已取消隐藏《' + name + '》');
      closeSheet();
      await renderStats();
      await renderBooks();
      await renderContinue();
    } catch (e) {
      toast(e.message);
    } finally {
      sheetHide.disabled = false;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!sheet.hidden) closeSheet();
    else if (!statsSheet.hidden) closeStats();
  });

  /* ---------- tidy-up: hide a batch, file a batch into a series ---------- */
  function syncBatch() {
    selectModeBtn.textContent = state.selecting ? '完成' : '整理';
    selectModeBtn.setAttribute('aria-pressed', String(state.selecting));
    batchBar.hidden = !state.selecting;
    if (!state.selecting) {
      seriesPicker.hidden = true;
      return;
    }
    batchCount.textContent = '已选 ' + state.selected.size + ' 本';
    var none = state.selected.size === 0;
    ['batch-hide', 'batch-unhide', 'batch-series', 'batch-move'].forEach(function (id) {
      document.getElementById(id).disabled = none;
    });
    document.getElementById('batch-all').textContent = '全选 ' + lastBooks.length + ' 本';
    document.getElementById('batch-all').disabled = lastBooks.length === 0;
  }

  function repaintShelf() {
    shelf.innerHTML = lastBooks.map(card).join('');
  }

  function togglePick(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    var node = shelf.querySelector('.book[data-id="' + id + '"]');
    if (node) node.classList.toggle('is-picked', state.selected.has(id));
    syncBatch();
  }

  function setSelecting(on) {
    state.selecting = on;
    if (!on) {
      state.selected.clear();
      seriesPicker.hidden = true;
    }
    shelf.classList.toggle('is-selecting', on);
    document.body.classList.toggle('is-tidying', on);
    repaintShelf();
    syncBatch();
  }

  async function hideSelected(hidden) {
    var ids = Array.from(state.selected);
    if (!ids.length) return;
    try {
      var r = await send('/api/books/hide', 'POST', { ids: ids, hidden: hidden });
      if (hidden) {
        var skipped = ids.length - (r.changed || 0);
        toast('已隐藏 ' + ids.length + ' 本' + (skipped > 0 ? '（其中 ' + skipped + ' 本本来就在隐藏里）' : ''));
      } else {
        toast('已取消隐藏 ' + ids.length + ' 本');
      }
      state.selected.clear();
      await renderStats();
      await renderBooks();
      await renderContinue();
    } catch (e) {
      toast(e.message);
    }
  }

  // 手动丛书才列出来：自动组的成员是书名算出来的，加不进也移不进。
  function manualShelves() {
    return shelves.filter(function (s) { return !s.auto; });
  }

  function renderSeriesPicker() {
    var manual = manualShelves();
    if (!manual.length) {
      seriesPickerList.innerHTML = '<p class="shelf-picker-empty">' +
        (pickerMode === 'move'
          ? '还没有手动丛书，先用「加入丛书」建一个。'
          : '还没有手动建的丛书，在下面新建一个。') + '</p>';
      return;
    }
    seriesPickerList.innerHTML = manual.map(function (s) {
      return '<button type="button" class="shelf-picker-row" data-put="' + esc(s.id) + '">' +
        '<span>' + esc(s.name) + '</span><em>' + s.count + ' 本</em></button>';
    }).join('');
  }

  function seriesNameKey(name) {
    return String(name || '').replace(/\s+/g, '').toLowerCase();
  }

  // 输入的新名字如果已经有一组，先把话说清楚，别让人以为又开了一个。
  function syncNewHint() {
    var name = seriesNewName.value.trim();
    var hit = name ? shelves.find(function (s) { return seriesNameKey(s.name) === seriesNameKey(name); }) : null;
    if (!hit) { seriesNewHint.hidden = true; return; }
    seriesNewHint.hidden = false;
    seriesNewHint.textContent = hit.auto
      ? '已有「' + hit.name + '」分组（自动归组，' + hit.count + ' 本）；确认后会转成手动丛书，原有的书一起保留。'
      : '已有「' + hit.name + '」分组（' + hit.count + ' 本），会合并进这一组，不会再开新组。';
  }

  function openPicker(mode) {
    if (!state.selected.size) { toast('先勾选几本书'); return; }
    // 再点同一个按钮就收起来，点另一个按钮则换成另一种用法。
    if (!seriesPicker.hidden && pickerMode === mode) { seriesPicker.hidden = true; return; }
    pickerMode = mode;
    seriesPicker.hidden = false;
    var moving = mode === 'move';
    seriesPickerNew.hidden = moving;
    seriesNewHint.hidden = true;
    seriesPickerHint.textContent = moving
      ? '选一组已有的丛书。书会从原来的丛书里移出，只留这一组。'
      : '归进已有的组，或在下面输入新名字；名字已存在就合并进那一组。';
    renderSeriesPicker();
    if (moving) return;
    // Searching "西游记" then grouping is the common path, so the search box
    // is the best guess for a name — still editable.
    seriesNewName.value = document.getElementById('search').value.trim();
    syncNewHint();
  }

  async function addSelectedToSeries(id) {
    var ids = Array.from(state.selected);
    if (!ids.length) return;
    var item = shelves.find(function (s) { return s.id === id; });
    try {
      await send('/api/collections/' + encodeURIComponent(id), 'PUT', { add: ids });
      await loadShelves();
      seriesPicker.hidden = true;
      toast('已把 ' + ids.length + ' 本归入「' + ((item && item.name) || '丛书') + '」');
    } catch (e) {
      toast(e.message);
    }
  }

  async function moveSelectedToSeries(id) {
    var ids = Array.from(state.selected);
    if (!ids.length) return;
    var item = shelves.find(function (s) { return s.id === id; });
    try {
      var r = await send('/api/collections/' + encodeURIComponent(id) + '/move', 'POST', { ids: ids });
      await loadShelves();
      // 正在看某个丛书时，移走的书就该从这一格里消失。
      await renderBooks();
      seriesPicker.hidden = true;
      toast('已把 ' + ids.length + ' 本移到「' + ((item && item.name) || '丛书') + '」' +
        (r.removed ? '，并从原丛书移出 ' + r.removed + ' 处' : ''));
    } catch (e) {
      toast(e.message);
    }
  }

  // 名字撞上自动组：自动组是按书名算的，收不了书，只能先转成手动组。
  async function joinAutoGroup(name, match, ids) {
    var ok = window.confirm('已有「' + match.name + '」分组（自动归组，' + match.count + ' 本）。\n\n' +
      '把这 ' + ids.length + ' 本合并进去吗？合并后这一组改为手动维护，原有的 ' + match.count + ' 本一起保留。');
    if (!ok) return null;
    var r = await send('/api/collections', 'POST', {
      name: name,
      add: ids,
      adopt: String(match.id || '').replace(/^auto:/, '')
    });
    await loadShelves();
    seriesPicker.hidden = true;
    seriesNewName.value = '';
    seriesNewHint.hidden = true;
    toast('已合并进「' + r.collection.name + '」，这一组改为手动维护');
    return r;
  }

  selectModeBtn.addEventListener('click', function () {
    setSelecting(!state.selecting);
    if (state.selecting) toast('勾选书，再点「隐藏」「加入丛书」或「移动到丛书」');
  });
  document.getElementById('batch-exit').addEventListener('click', function () { setSelecting(false); });
  document.getElementById('batch-all').addEventListener('click', function () {
    lastBooks.forEach(function (b) { state.selected.add(b.id); });
    repaintShelf();
    syncBatch();
  });
  document.getElementById('batch-hide').addEventListener('click', function () { hideSelected(true); });
  document.getElementById('batch-unhide').addEventListener('click', function () { hideSelected(false); });
  document.getElementById('batch-series').addEventListener('click', function () { openPicker('add'); });
  document.getElementById('batch-move').addEventListener('click', function () { openPicker('move'); });
  seriesPickerList.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-put]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-put');
    if (pickerMode === 'move') moveSelectedToSeries(id);
    else addSelectedToSeries(id);
  });
  document.getElementById('series-new-btn').addEventListener('click', async function () {
    var name = seriesNewName.value.trim();
    if (!name) { seriesNewName.focus(); return; }
    if (!state.selected.size) { toast('先勾选几本书'); return; }
    var ids = Array.from(state.selected);
    try {
      // 服务端会在同名时直接并进已有组，所以这里不再先建后加。
      var r = await send('/api/collections', 'POST', { name: name, add: ids });
      seriesNewName.value = '';
      seriesNewHint.hidden = true;
      await loadShelves();
      seriesPicker.hidden = true;
      toast(r.merged
        ? '已有「' + r.collection.name + '」分组，已把 ' + ids.length + ' 本合并进去'
        : '已建丛书「' + r.collection.name + '」并加入 ' + ids.length + ' 本');
    } catch (e) {
      if (e.code === 'AUTO_NAME' && e.match) {
        try { await joinAutoGroup(name, e.match, ids); } catch (err) { toast(err.message); }
        return;
      }
      toast(e.message);
    }
  });
  seriesNewName.addEventListener('input', syncNewHint);
  seriesNewName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('series-new-btn').click();
    }
    e.stopPropagation();
  });

  function renderFilters() {
    var onHidden = state.hidden === 'only';
    // The counts follow the tab: format chips describe the pile you are looking
    // at, not the whole library.
    var source = onHidden ? hiddenFormats : visibleFormats;
    var visibleTotal = Object.keys(visibleFormats).reduce(function (a, k) {
      return a + visibleFormats[k];
    }, 0);
    var html = '<button class="filter" type="button" data-format="" aria-pressed="' +
      (!onHidden && !state.format) + '" title="不含已隐藏的书">全部（不含隐藏）<em>' +
      visibleTotal + '</em></button>';
    Object.keys(source).sort().forEach(function (f) {
      html += '<button class="filter" type="button" data-format="' + esc(f) + '" aria-pressed="' +
        (state.format === f) + '">' + esc(f.toUpperCase()) + '<em>' + source[f] + '</em></button>';
    });
    html += '<span class="filter-sep" aria-hidden="true"></span>' +
      '<button class="filter filter-hidden" type="button" data-scope="only" aria-pressed="' +
      onHidden + '" title="只看已隐藏的书">隐藏<em>' + hiddenCount + '</em></button>';
    filters.innerHTML = html;
    Array.prototype.forEach.call(filters.querySelectorAll('.filter'), function (btn) {
      btn.addEventListener('click', function () {
        if (btn.getAttribute('data-scope') === 'only') {
          state.hidden = state.hidden === 'only' ? '' : 'only';
          state.format = '';
          state.status = '';
          state.shelf = '';
        } else {
          // Inside the hidden tab a format chip narrows the hidden pile, which
          // is what the label promises.
          state.format = btn.dataset.format;
        }
        renderRail();
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
      visibleFormats = stats.visibleFormats || formats;
      hiddenFormats = stats.hiddenFormats || {};
      hiddenCount = stats.hiddenCount || 0;
      visibleCount = typeof stats.visibleCount === 'number' ? stats.visibleCount : stats.count;
      lastScannedAt = stats.scannedAt;
      lastCount = stats.count;
      lastScanning = Boolean(stats.scanning);
      document.getElementById('stat-count').textContent = visibleCount;
      var when = stats.scannedAt ? new Date(stats.scannedAt).toLocaleString('zh-CN', {
        month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) : '从未';
      var bits = ['上次整理 ' + when];
      if (hiddenCount) bits.push('已隐藏 ' + hiddenCount + ' 本');
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
      renderRail();
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
