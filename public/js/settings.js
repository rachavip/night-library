/* Settings drawer: system name, subtitle, theme, background image. */
(function () {
  'use strict';

  var root = document.documentElement;
  var settings = null;
  var pendingTheme = 'night';
  var pendingTypeface = 'kai';
  var pendingTextEffect = 'soft';
  var pendingBg = null; // { data, enabled }
  var bgVersion = 0;
  // 取景位置：背景图铺满整页时留下哪一块，百分比，50/50 即居中。
  var bgFocus = { x: 50, y: 50 };
  // 取景对话框的临时状态：原图尺寸、拖动起点。
  var cropNatural = null;
  var cropStart = { x: 50, y: 50 };
  var cropDrag = null;

  var drawer = document.getElementById('settings-drawer');
  var scrim = document.getElementById('drawer-scrim');
  var toastFn = window.nightToast || function () {};
  var folders = [];
  // Paths the user confirmed for removal; cleaned up when settings are saved.
  var forgottenFolders = [];
  var pendingMusicMode = 'embed';
  var pendingActiveId = '';

  function el(id) { return document.getElementById(id); }

  function applyTheme(theme) {
    root.setAttribute('data-app-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    var colors = { night: '#0B121C', paper: '#EFE9DC', ink: '#07090B', tide: '#071A1B' };
    if (meta && colors[theme]) meta.content = colors[theme];
    Array.prototype.forEach.call(document.querySelectorAll('.theme-card'), function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.theme === theme));
    });
  }

  /* ---------- 字体风格 ---------- */
  // 每套的探针字体名：命中任意一个就算本机能显示。sans 用系统默认黑体，一定在。
  var TYPEFACES = {
    kai: { probe: ['Kaiti SC', 'STKaiti', 'KaiTi', '楷体'], fallback: '宋体' },
    song: { probe: ['Songti SC', 'SimSun', '宋体'], fallback: '系统默认衬线' },
    sans: { probe: null, fallback: '' },
    li: { probe: ['LiSu', '隶书', 'STLiti', '华文隶书'], fallback: '楷体' }
  };

  var probeCtx = null;
  // document.fonts.check 对系统字体几乎恒为 true，测不出缺字，只能量宽度：
  // 字体存在时宽度和基准不同，不存在时会落回基准，两者相等。
  function hasFamily(name) {
    try {
      if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d');
      var text = '夜读 Wg 123';
      var bases = ['monospace', 'sans-serif'];
      for (var i = 0; i < bases.length; i++) {
        probeCtx.font = '40px ' + bases[i];
        var plain = probeCtx.measureText(text).width;
        probeCtx.font = '40px "' + name + '", ' + bases[i];
        var hit = probeCtx.measureText(text).width;
        if (Math.abs(plain - hit) > 0.5) return true;
      }
    } catch (e) { return true; } // canvas 不可用就别误报缺失
    return false;
  }

  function applyTypeface(name) {
    pendingTypeface = TYPEFACES[name] ? name : 'kai';
    root.setAttribute('data-typeface', pendingTypeface);
    Array.prototype.forEach.call(document.querySelectorAll('.type-card'), function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.typeface === pendingTypeface));
    });
  }

  function applyTextEffect(name) {
    pendingTextEffect = ['soft', 'crisp', 'off'].indexOf(name) >= 0 ? name : 'soft';
    root.setAttribute('data-text-effect', pendingTextEffect);
    Array.prototype.forEach.call(document.querySelectorAll('button[data-text-effect]'), function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.textEffect === pendingTextEffect));
    });
  }

  // 卡片上标出「本机没这个字体」，让人在别的系统上换一套，而不是看着字跑版。
  function markTypefaceSupport() {
    Array.prototype.forEach.call(document.querySelectorAll('.type-card'), function (card) {
      var conf = TYPEFACES[card.dataset.typeface];
      var warn = card.querySelector('.type-warn');
      if (!conf || !warn) return;
      if (!conf.probe || conf.probe.some(hasFamily)) {
        warn.hidden = true;
        warn.textContent = '';
        return;
      }
      warn.hidden = false;
      warn.textContent = '本机无此字体';
      warn.title = '这台设备没装「' + conf.probe[conf.probe.length - 1] + '」，会退回' + conf.fallback + '。换一套风格即可。';
    });
    var note = el('typeface-note');
    if (note) {
      var missing = Array.prototype.filter.call(document.querySelectorAll('.type-warn'), function (w) {
        return w.hidden === false;
      }).length;
      note.textContent = missing ? missing + ' 套本机缺字体' : '';
    }
  }

  function applyBackground() {
    var backdrop = el('backdrop');
    if (!backdrop) return;
    var bg = settings && settings.background ? settings.background : {};
    if (pendingBg) { bg = { data: pendingBg.data, enabled: pendingBg.enabled, dim: bg.dim, blur: bg.blur }; }
    if (bg.enabled && bg.data) {
      backdrop.style.backgroundImage = 'url("/api/background?v=' + bgVersion + '")';
      // 取景位置：cover 裁掉的部分由 background-position 决定。
      backdrop.style.backgroundPosition = bgFocus.x + '% ' + bgFocus.y + '%';
      backdrop.style.setProperty('--bg-dim', String(bg.dim != null ? bg.dim : 0.55));
      backdrop.style.setProperty('--bg-blur', (bg.blur || 0) + 'px');
    } else {
      backdrop.style.backgroundImage = '';
    }
  }

  function focusLabel() {
    if (Math.abs(bgFocus.x - 50) < 0.6 && Math.abs(bgFocus.y - 50) < 0.6) return '居中';
    return '水平 ' + Math.round(bgFocus.x) + '% · 垂直 ' + Math.round(bgFocus.y) + '%';
  }

  // 抽屉里那行小字，说明当前取景，让「会不会把脸裁掉」这件事有据可查。
  function updateFocusNote() {
    var note = el('bg-crop-note');
    if (!note) return;
    var has = Boolean(el('bg-path').value.trim()) ||
      Boolean(pendingBg && pendingBg.data) ||
      Boolean(settings && settings.background && settings.background.enabled && settings.background.data);
    note.textContent = has ? '取景：' + focusLabel() : '未选图片';
  }

  /* ---------- 背景取景 ---------- */
  // 图的来源：正在输入的路径优先（还没保存也能预览），否则用已保存的那张。
  function currentBgSrc() {
    var typed = el('bg-path').value.trim();
    if (typed) return '/api/background?src=' + encodeURIComponent(typed);
    var data = settings && settings.background ? settings.background.data : '';
    if (!data) return '';
    return '/api/background?v=' + (bgVersion || Date.now());
  }

  function clampPct(v) { return Math.max(0, Math.min(100, v)); }

  function openCrop() {
    var src = currentBgSrc();
    if (!src) { toastFn('先选一张背景图，再来调取景'); return; }
    cropStart = { x: bgFocus.x, y: bgFocus.y };
    cropNatural = null;
    el('bg-crop').hidden = false;
    el('bg-crop-frame').style.backgroundImage = 'url("' + src + '")';
    el('bg-crop-info').textContent = '正在载入图片…';
    layoutCrop();
    syncFocus();
    el('bg-crop-frame').focus();
    // 原图尺寸只用来算「会裁掉多少」，取景本身不依赖它。
    var probe = new Image();
    probe.onload = function () {
      cropNatural = { w: probe.naturalWidth, h: probe.naturalHeight };
      updateCropInfo();
    };
    probe.onerror = function () {
      el('bg-crop-info').textContent = '这张图读不出来，检查一下路径或重新上传';
    };
    probe.src = src;
  }

  function closeCrop(revert) {
    if (revert) {
      bgFocus = { x: cropStart.x, y: cropStart.y };
      applyBackground();
      updateFocusNote();
    }
    el('bg-crop').hidden = true;
    el('bg-crop-frame').classList.remove('is-dragging');
    cropDrag = null;
    cropNatural = null;
  }

  // 对话框中间的框按窗口比例生成，所以框里看到的就是书架上的效果。
  function layoutCrop() {
    if (el('bg-crop').hidden) return;
    var stage = el('bg-crop-stage');
    var frame = el('bg-crop-frame');
    var ar = window.innerWidth / Math.max(1, window.innerHeight);
    var availW = Math.max(160, stage.clientWidth - 6);
    var availH = Math.max(90, stage.clientHeight - 6);
    var w = availW;
    var h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    frame.style.width = Math.round(w) + 'px';
    frame.style.height = Math.round(h) + 'px';
    updateCropInfo();
  }

  // cover 之后图片比框大出来的部分，就是可以挪动的余量。
  function cropOverflow() {
    var frame = el('bg-crop-frame');
    var fw = frame.clientWidth;
    var fh = frame.clientHeight;
    if (!cropNatural || !fw || !fh) return { x: 0, y: 0 };
    var ia = cropNatural.w / cropNatural.h;
    var fa = fw / fh;
    var sw = ia > fa ? fh * ia : fw;
    var sh = ia > fa ? fh : fw / ia;
    return { x: Math.max(0, sw - fw), y: Math.max(0, sh - fh) };
  }

  function syncFocus() {
    el('bg-crop-frame').style.backgroundPosition = bgFocus.x + '% ' + bgFocus.y + '%';
    updateCropInfo();
    updateFocusNote();
    // 让背后的真实页面同步动起来，取景时就能看到最终效果。
    applyBackground();
  }

  function ratioText(a) {
    return (Math.round(a * 100) / 100) + ' : 1';
  }

  function updateCropInfo() {
    var out = el('bg-crop-info');
    if (!out || el('bg-crop').hidden) return;
    var fa = window.innerWidth / Math.max(1, window.innerHeight);
    if (!cropNatural) {
      out.textContent = '页面比例 ' + ratioText(fa);
      return;
    }
    var ia = cropNatural.w / cropNatural.h;
    var text = '原图 ' + cropNatural.w + '×' + cropNatural.h + '（' + ratioText(ia) + '） · 页面 ' + ratioText(fa);
    if (Math.abs(ia - fa) / fa > 0.01) {
      var cut = ia > fa ? (1 - fa / ia) : (1 - ia / fa);
      text += ' · 铺满需裁掉' + (ia > fa ? '左右' : '上下') + '约 ' + Math.round(cut * 100) + '%';
    } else {
      text += ' · 比例刚好，几乎不裁';
    }
    out.textContent = text;
  }

  // 拖动：图片跟着手指走，所以位置百分比反向变化。
  function dragFocus(dx, dy) {
    var ov = cropOverflow();
    if (ov.x > 0) bgFocus.x = clampPct(bgFocus.x - (dx / ov.x) * 100);
    if (ov.y > 0) bgFocus.y = clampPct(bgFocus.y - (dy / ov.y) * 100);
    bgFocus.x = Math.round(bgFocus.x * 10) / 10;
    bgFocus.y = Math.round(bgFocus.y * 10) / 10;
    syncFocus();
  }

  function nudgeFocus(dx, dy) {
    // 只挪有余量的方向，否则按了键数字变了、画面没动，反而让人以为坏了。
    var ov = cropOverflow();
    if (ov.x > 0) bgFocus.x = clampPct(Math.round((bgFocus.x + dx) * 10) / 10);
    if (ov.y > 0) bgFocus.y = clampPct(Math.round((bgFocus.y + dy) * 10) / 10);
    syncFocus();
  }

  function applyMusicMode(mode) {
    pendingMusicMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('.mode-card'), function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    });
    el('music-subsonic-fields').hidden = mode !== 'subsonic';
    el('music-hint').textContent = mode === 'embed'
      ? '顶栏 ⏮ ▶ ⏭ 直接控制音乐，不用打开面板。前提：先在面板里登录 AnyListen 一次，并在 AnyListen 里备好几首能播的收藏、循环方式选随机或列表循环（别选播完就停）。'
      : '填写 Navidrome 等 Subsonic 服务的地址与账号，书架底部会出现轻量播放条。';
    el('music-test-result').textContent = '';
  }

  function renderMusicServices() {
    var box = el('music-services');
    if (!box) return;
    box.innerHTML = '';
    var list = (settings && settings.music && settings.music.services) || [];
    list.forEach(function (svc) {
      var row = document.createElement('div');
      row.className = 'music-service';
      row.dataset.id = svc.id;

      var head = document.createElement('div');
      head.className = 'music-service-head';
      var name = document.createElement('span');
      name.className = 'music-service-name';
      name.textContent = svc.name || svc.id;
      head.appendChild(name);
      if (svc.id === pendingActiveId) {
        var cur = document.createElement('span');
        cur.className = 'music-service-current';
        cur.textContent = '当前';
        head.appendChild(cur);
      } else {
        var pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'text-btn';
        pick.textContent = '设为当前';
        pick.addEventListener('click', function () {
          pendingActiveId = svc.id;
          renderMusicServices();
          el('music-test-result').textContent = '';
        });
        head.appendChild(pick);
      }
      row.appendChild(head);

      var urlLabel = document.createElement('label');
      urlLabel.className = 'field';
      urlLabel.appendChild(document.createTextNode('地址'));
      var urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.className = 'music-service-url';
      urlInput.value = svc.url || '';
      urlInput.placeholder = 'http://192.168.0.111:9500';
      urlLabel.appendChild(urlInput);
      row.appendChild(urlLabel);

      var loginLabel = document.createElement('label');
      loginLabel.className = 'field';
      loginLabel.appendChild(document.createTextNode('登录页地址（可选）'));
      var loginInput = document.createElement('input');
      loginInput.type = 'text';
      loginInput.className = 'music-service-login';
      loginInput.value = svc.loginUrl || '';
      loginInput.placeholder = '留空则用上面的地址';
      loginLabel.appendChild(loginInput);
      row.appendChild(loginLabel);

      box.appendChild(row);
    });
  }

  function musicServiceRows() {
    return Array.prototype.slice.call(document.querySelectorAll('.music-service'));
  }

  function currentServiceRow() {
    return musicServiceRows().find(function (row) { return row.dataset.id === pendingActiveId; }) || null;
  }

  function currentServiceUrl() {
    var row = currentServiceRow();
    return row ? row.querySelector('.music-service-url').value.trim() : '';
  }

  function renderFolders() {
    var list = el('folder-list');
    list.innerHTML = '';
    folders.forEach(function (path, i) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.className = 'folder-path';
      span.textContent = path;
      span.title = path;
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'folder-del';
      del.textContent = '移除';
      del.setAttribute('aria-label', '移除文件夹 ' + path);
      del.addEventListener('click', function () {
        // Removing a path is destructive: book ids are hashes of folder + path,
        // so every derived record for that folder becomes unreachable. Say so
        // before deleting rather than silently dropping reading history.
        var label = window.confirm(
          '移除文件夹「' + path + '」？\n\n' +
          '这个文件夹下所有书的封面、转换缓存、阅读进度、笔记、书签和书单记录会一并删除，' +
          '释放它们占用的空间。电子书文件本身不会被删除。\n\n' +
          '确定要移除吗？'
        );
        if (!label) return;
        forgottenFolders.push(path);
        folders.splice(i, 1);
        renderFolders();
      });
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    });
    el('folder-count').textContent = folders.length + ' 个';
  }

  function renderScan() {
    var scan = (settings && settings.scan) || {};
    el('scan-on-start').checked = scan.onStart !== false;
    el('scan-interval').value = scan.intervalMinutes != null ? scan.intervalMinutes : 60;
    var hint = el('scan-env-hint');
    if (hint) hint.hidden = !(scan.onStartFromEnv || scan.intervalFromEnv);
  }

  // 末字黄底黑字的效果在改名后也要保持。用 DOM 节点写而不是 innerHTML，
  // 自定义名里带尖括号时不会把页面结构拆坏。
  function paintBrand(name) {
    var node = el('brand-name');
    if (!node) return;
    var chars = Array.from(String(name || '夜读'));
    node.textContent = '';
    if (chars.length < 2) { node.textContent = chars.join(''); return; }
    var first = document.createElement('span');
    first.className = 'brand-first';
    first.textContent = chars.slice(0, -1).join('');
    var last = document.createElement('span');
    last.className = 'brand-last';
    last.textContent = chars[chars.length - 1];
    node.appendChild(first);
    node.appendChild(last);
  }

  function applyAll(next) {
    settings = next;
    folders = (settings.folders || []).slice();
    renderFolders();
    pendingTheme = settings.theme || 'night';
    pendingBg = null;
    applyTheme(pendingTheme);
    applyTypeface(settings.typeface || 'kai');
    applyTextEffect(settings.textEffect || 'soft');
    markTypefaceSupport();
    paintBrand(settings.systemName || '夜读');
    el('brand-sub').textContent = settings.subtitle || '我的书房';
    document.title = (settings.systemName || '夜读') + ' · ' + (settings.subtitle || '我的书房');
    el('set-name').value = settings.systemName || '';
    el('set-subtitle').value = settings.subtitle || '';
    el('set-guestbook-token').value = settings.guestbookToken || '';
    var gbState = el('guestbook-sync-state');
    if (gbState) gbState.textContent = settings.guestbookToken ? '已配置' : '未配置，留言只存本机';
    renderScan();
    el('bg-path').value = (settings.background && settings.background.data && !settings.background.data.startsWith('uploaded:'))
      ? settings.background.data : '';
    el('bg-dim').value = Math.round((settings.background.dim != null ? settings.background.dim : 0.55) * 100);
    el('bg-dim-out').textContent = el('bg-dim').value + '%';
    el('bg-blur').value = settings.background.blur || 0;
    el('bg-blur-out').textContent = el('bg-blur').value + 'px';
    var focus = (settings.background && settings.background.focus) || {};
    bgFocus = {
      x: Number.isFinite(Number(focus.x)) ? Number(focus.x) : 50,
      y: Number.isFinite(Number(focus.y)) ? Number(focus.y) : 50
    };
    updateFocusNote();
    applyMusicMode((settings.music && settings.music.mode) || 'embed');
    var envHint = el('music-env-hint');
    if (envHint) envHint.hidden = !settings.music.urlFromEnv;
    pendingActiveId = (settings.music && settings.music.activeId) || '';
    renderMusicServices();
    el('music-user').value = settings.music.user || '';
    el('music-pass').value = settings.music.password || '';
    applyBackground();
    if (window.nightMusic) window.nightMusic.configure(settings.music);
  }

  /* ---------- 猜你想看 ---------- */
  // 排序是拿读者的搜索词算的，那就让他看得见记了什么，也能一键忘掉。
  function escText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function loadTaste() {
    var note = el('taste-note');
    var list = el('taste-terms');
    if (!note || !list) return;
    try {
      var data = await fetch('/api/taste').then(function (r) { return r.json(); });
      var terms = data.terms || [];
      var searches = data.searches || 0;
      var keywords = data.keywords || [];
      note.textContent = searches
        ? '已记录 ' + searches + ' 次搜索、' + terms.length + ' 个词。清空后排序只用书名里的高频词。'
        : '还没有记录搜索。搜过的词会出现在这里，也让相关的书往前排。';
      var html = '';
      terms.forEach(function (t) {
        html += '<li><span>' + escText(t.q) + '</span><em>' + t.count + ' 次</em></li>';
      });
      if (keywords.length) {
        html += '<li class="taste-kw"><span>书名里的热点</span><em>' +
          keywords.map(function (k) { return escText(k.keyword) + '×' + k.count; }).join('、') +
          '</em></li>';
      }
      list.innerHTML = html;
    } catch (e) {
      note.textContent = '读不到记录，排序照常按书名里的高频词走。';
      list.innerHTML = '';
    }
  }

  var tasteReset = el('taste-reset');
  if (tasteReset) {
    tasteReset.addEventListener('click', async function () {
      if (!window.confirm('清空搜索记录？清空后「猜你想看」只按书名里的高频词排。')) return;
      try {
        await fetch('/api/taste/reset', { method: 'POST' });
        await loadTaste();
        toastFn('搜索记录已清空');
      } catch (e) {
        toastFn('清空失败：' + e.message);
      }
    });
  }

  /* ---------- 留言板同步 ---------- */
  // 两件事：体检（到底卡在哪一步）和补传（令牌填晚了，之前那几条一直没上去）。
  // 都在设置抽屉里，访客看不到，也用不着令牌。
  function describeDiag(d) {
    var bits = [];
    if (d.dns && d.dns.length) bits.push('域名解析到 ' + d.dns.join(' / '));
    else bits.push('域名解析失败' + (d.dnsError ? '（' + d.dnsError + '）' : ''));

    var api = d.api || {};
    if (api.status) bits.push('api.github.com 能连上，HTTP ' + api.status + ' · ' + (api.ms / 1000).toFixed(1) + ' 秒');
    else bits.push('api.github.com 连不上：' + (api.error || '没有响应'));

    if (d.hasToken) {
      var repo = d.repo || {};
      if (repo.status === 200) bits.push('令牌能读仓库');
      else if (repo.status === 401) bits.push('令牌被拒（HTTP 401，多半已过期或被撤销）');
      else if (repo.status === 403) bits.push('令牌权限不够（HTTP 403，Contents 要给 Read and write）');
      else if (repo.status) bits.push('令牌请求返回 HTTP ' + repo.status);
      else bits.push('令牌请求没发出去：' + (repo.error || '没有响应'));
    } else {
      bits.push('还没填令牌');
    }
    return bits.join('；') + '。';
  }

  async function loadGuestbookPending() {
    var btn = el('gb-resync');
    if (!btn) return;
    try {
      var data = await fetch('/api/guestbook').then(function (r) { return r.json(); });
      var n = Number(data.pending) || 0;
      btn.textContent = n ? '补传未同步（' + n + ' 条）' : '补传未同步';
      btn.disabled = !n;
    } catch (e) { /* 读不到就保持原样 */ }
  }

  var gbTest = el('gb-test');
  if (gbTest) {
    gbTest.addEventListener('click', async function () {
      var note = el('gb-note');
      gbTest.disabled = true;
      if (note) note.textContent = '正在从 NAS 里试一次到 GitHub 的路，最多等 40 秒…';
      try {
        var d = await fetch('/api/guestbook/diag').then(function (r) { return r.json(); });
        if (note) note.textContent = describeDiag(d);
      } catch (e) {
        if (note) note.textContent = '体检失败：' + e.message;
      }
      gbTest.disabled = false;
    });
  }

  var gbResync = el('gb-resync');
  if (gbResync) {
    gbResync.addEventListener('click', async function () {
      var note = el('gb-note');
      gbResync.disabled = true;
      if (note) note.textContent = '正在补传，一条大概要一两秒…';
      try {
        var r = await fetch('/api/guestbook/resync', { method: 'POST' }).then(function (x) { return x.json(); });
        if (!r.pushed) {
          if (note) note.textContent = r.error ? '一条都没传上去：' + r.error : '没有待补传的留言。';
        } else {
          var msg = '补传完成，成功 ' + r.pushed + ' 条';
          if (r.failed) msg += '，还有 ' + r.failed + ' 条没上去（' + r.error + '）';
          if (note) note.textContent = msg + '。';
          toastFn(msg);
        }
      } catch (e) {
        if (note) note.textContent = '补传失败：' + e.message;
      }
      loadGuestbookPending();
    });
  }

  function openDrawer() {
    drawer.hidden = false;
    scrim.hidden = false;
    applyAll(settings);
    loadTaste();
    loadGuestbookPending();
  }

  function closeDrawer() {
    drawer.hidden = true;
    scrim.hidden = true;
    // A cancelled drawer must not leave a pending deletion behind.
    if (forgottenFolders.length) {
      forgottenFolders = [];
      applyAll(settings);
    }
  }

  function collect() {
    var body = {
      systemName: el('set-name').value,
      subtitle: el('set-subtitle').value,
      theme: pendingTheme,
      typeface: pendingTypeface,
      textEffect: pendingTextEffect,
      guestbookToken: el('set-guestbook-token').value.trim(),
      folders: folders.slice(),
      scan: {
        onStart: el('scan-on-start').checked,
        intervalMinutes: el('scan-interval').value.trim() === '' ? 60 : Number(el('scan-interval').value)
      },
      background: {
        enabled: Boolean(el('bg-path').value.trim()) || Boolean(pendingBg && pendingBg.data) ||
          Boolean(settings.background && settings.background.enabled && settings.background.data),
        data: pendingBg && pendingBg.data !== undefined ? pendingBg.data : settings.background.data,
        dim: Number(el('bg-dim').value) / 100,
        blur: Number(el('bg-blur').value),
        focus: { x: bgFocus.x, y: bgFocus.y }
      },
      music: {
        mode: pendingMusicMode,
        enabled: settings.music.enabled,
        url: currentServiceUrl(),
        activeId: pendingActiveId,
        services: musicServiceRows().map(function (row) {
          return {
            id: row.dataset.id,
            name: row.querySelector('.music-service-name').textContent,
            url: row.querySelector('.music-service-url').value.trim(),
            loginUrl: row.querySelector('.music-service-login').value.trim()
          };
        }),
        user: el('music-user').value.trim(),
        password: el('music-pass').value,
        volume: settings.music.volume
      }
    };
    var pathValue = el('bg-path').value.trim();
    if (pathValue) body.background.data = pathValue;
    return body;
  }

  async function save() {
    var btn = el('settings-save');
    btn.disabled = true;
    var beforeFolders = JSON.stringify(folders.slice().sort());
    var beforeToken = String(settings.guestbookToken || '');
    try {
      var res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect())
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      applyAll(data);
      bgVersion = Date.now();
      applyBackground();
      closeDrawer();
      if (window.nightBooks) window.nightBooks.refresh();

      // 令牌变了：服务器收到保存后会在后台把以前没传上去的留言补一遍，
      // 几秒后再看「补传」按钮上的条数才是准的。
      if (String(data.guestbookToken || '') !== beforeToken) {
        setTimeout(loadGuestbookPending, 4000);
      }

      // Forget the removed folders' derived data while the old index is still
      // loaded - that index is what maps a folder to its book ids.
      if (forgottenFolders.length) {
        var cleaned = 0;
        for (var f = 0; f < forgottenFolders.length; f++) {
          var forgetRes = await fetch('/api/folders/forget', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: forgottenFolders[f] })
          });
          var forgetData = await forgetRes.json();
          if (forgetRes.ok && forgetData.ok) cleaned += forgetData.books || 0;
        }
        forgottenFolders = [];
        toastFn('已清理 ' + cleaned + ' 册的封面与阅读记录');
      }

      // Folder changes only take effect after a rescan - do it automatically.
      if (beforeFolders !== JSON.stringify(folders.slice().sort())) {
        toastFn('文件夹已更新，正在刮削…');
        var scanRes = await fetch('/api/rescan', { method: 'POST' });
        var scanData = await scanRes.json();
        if (scanRes.ok && scanData.ok) {
          toastFn('刮削完成，共 ' + scanData.count + ' 册');
          if (window.nightBooks) window.nightBooks.refresh();
        } else {
          toastFn((scanData && scanData.error) || '刮削失败，请手动点一次刮削');
        }
      } else {
        toastFn('设置已保存');
      }
    } catch (e) {
      toastFn(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  /* events */
  el('settings-toggle').addEventListener('click', openDrawer);
  el('settings-close').addEventListener('click', closeDrawer);
  el('settings-cancel').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  el('settings-save').addEventListener('click', save);

  Array.prototype.forEach.call(document.querySelectorAll('.theme-card'), function (btn) {
    btn.addEventListener('click', function () {
      pendingTheme = btn.dataset.theme;
      applyTheme(pendingTheme);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.type-card'), function (btn) {
    btn.addEventListener('click', function () { applyTypeface(btn.dataset.typeface); });
  });

  Array.prototype.forEach.call(document.querySelectorAll('button[data-text-effect]'), function (btn) {
    btn.addEventListener('click', function () { applyTextEffect(btn.dataset.textEffect); });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.mode-card'), function (btn) {
    btn.addEventListener('click', function () { applyMusicMode(btn.dataset.mode); });
  });

  async function addFolder() {
    var raw = el('folder-input').value.trim();
    var out = el('folder-result');
    if (!raw) { out.textContent = '先填一个路径'; out.className = 'folder-result'; return; }
    var path = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (folders.indexOf(path) >= 0) {
      out.textContent = '这个文件夹已经在列表里了';
      out.className = 'folder-result';
      return;
    }
    out.textContent = '正在检查…';
    out.className = 'folder-result';
    try {
      var res = await fetch('/api/folders/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path })
      });
      var data = await res.json();
      if (!data.ok) { out.textContent = data.error || '无法访问这个文件夹'; out.className = 'folder-result'; return; }
      folders.push(data.path);
      renderFolders();
      el('folder-input').value = '';
      out.textContent = '已添加，保存后会自动刮削';
      out.className = 'folder-result ok';
    } catch (e) {
      out.textContent = '检查失败：' + e.message;
      out.className = 'folder-result';
    }
  }
  el('folder-add-btn').addEventListener('click', addFolder);
  el('folder-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addFolder(); }
  });

  el('bg-dim').addEventListener('input', function (e) {
    el('bg-dim-out').textContent = e.target.value + '%';
    settings.background.dim = Number(e.target.value) / 100;
    applyBackground();
  });
  el('bg-blur').addEventListener('input', function (e) {
    el('bg-blur-out').textContent = e.target.value + 'px';
    settings.background.blur = Number(e.target.value);
    applyBackground();
  });
  el('bg-path').addEventListener('input', function () {
    var v = el('bg-path').value.trim();
    pendingBg = { data: v, enabled: Boolean(v) };
    applyBackground();
    updateFocusNote();
  });
  el('bg-clear').addEventListener('click', function () {
    el('bg-path').value = '';
    pendingBg = { data: '', enabled: false };
    settings.background.enabled = false;
    bgFocus = { x: 50, y: 50 };
    applyBackground();
    updateFocusNote();
    toastFn('背景已清除，记得保存');
  });

  /* ---------- 取景对话框 ---------- */
  el('bg-crop-open').addEventListener('click', openCrop);
  el('bg-crop-close').addEventListener('click', function () { closeCrop(true); });
  el('bg-crop-ok').addEventListener('click', function () {
    closeCrop(false);
    updateFocusNote();
    toastFn('取景已设为' + focusLabel() + '，保存设置后生效');
  });
  el('bg-crop-reset').addEventListener('click', function () {
    bgFocus = { x: 50, y: 50 };
    syncFocus();
  });

  var cropFrame = el('bg-crop-frame');
  cropFrame.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;
    cropDrag = { x: e.clientX, y: e.clientY };
    cropFrame.classList.add('is-dragging');
    cropFrame.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cropFrame.addEventListener('pointermove', function (e) {
    if (!cropDrag) return;
    var dx = e.clientX - cropDrag.x;
    var dy = e.clientY - cropDrag.y;
    cropDrag = { x: e.clientX, y: e.clientY };
    dragFocus(dx, dy);
  });
  function endDrag(e) {
    if (!cropDrag) return;
    cropDrag = null;
    cropFrame.classList.remove('is-dragging');
    if (e && e.pointerId != null && cropFrame.hasPointerCapture && cropFrame.hasPointerCapture(e.pointerId)) {
      cropFrame.releasePointerCapture(e.pointerId);
    }
  }
  cropFrame.addEventListener('pointerup', endDrag);
  cropFrame.addEventListener('pointercancel', endDrag);
  cropFrame.addEventListener('keydown', function (e) {
    var map = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    var step = map[e.key];
    if (!step) return;
    e.preventDefault();
    nudgeFocus(step[0], step[1]);
  });
  document.addEventListener('keydown', function (e) {
    if (el('bg-crop').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCrop(true); }
  });
  window.addEventListener('resize', layoutCrop);

  el('bg-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toastFn('图片不能超过 15MB'); return; }
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var res = await fetch('/api/settings/background', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: reader.result, enabled: true })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || '上传失败');
        bgVersion = data.version;
        pendingBg = { data: 'uploaded:pending', enabled: true };
        // Fetch the fresh settings snapshot but keep the drawer edits intact.
        var snap = await fetch('/api/settings').then(function (r) { return r.json(); });
        settings.background.data = snap.background.data;
        settings.background.enabled = true;
        // 新图从居中开始，旧图的取景对不上新构图。
        var fresh = (snap.background && snap.background.focus) || { x: 50, y: 50 };
        bgFocus = { x: Number(fresh.x) || 50, y: Number(fresh.y) || 50 };
        el('bg-path').value = '';
        pendingBg = null;
        applyBackground();
        updateFocusNote();
        // 比例和窗口不一样的图铺满就会裁，直接打开取景，别等用户发现头像少了半边。
        var probe = new Image();
        probe.onload = function () {
          var ia = probe.naturalWidth / Math.max(1, probe.naturalHeight);
          var fa = window.innerWidth / Math.max(1, window.innerHeight);
          if (Math.abs(ia - fa) / fa > 0.02) {
            toastFn('这张图和页面比例不同，先确认保留哪一块');
            openCrop();
          } else {
            toastFn('背景已上传，比例刚好，不用调整');
          }
        };
        probe.onerror = function () { openCrop(); };
        probe.src = reader.result;
      } catch (err) {
        toastFn(err.message);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  el('music-test').addEventListener('click', async function () {
    var out = el('music-test-result');
    var hint = el('music-test-hint');
    var url = currentServiceUrl();
    hint.hidden = true;
    if (!url) { out.textContent = '请先给当前服务填写地址'; out.className = 'test-result'; return; }
    out.textContent = '正在测试…';
    out.className = 'test-result';
    try {
      var res = await fetch('/api/music/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: pendingMusicMode,
          url: url,
          user: el('music-user').value.trim(),
          password: el('music-pass').value
        })
      });
      var data = await res.json();
      if (data.ok) {
        var label = pendingMusicMode === 'embed'
          ? ((data.title || data.url || '已连接') +
             (data.embeddable === false ? ' · 嵌入受限' : '') +
             (data.loginRequired ? ' · 需要登录' : ''))
          : ('Subsonic · ' + (data.type || '已连接'));
        out.textContent = '连接成功 · ' + label;
        out.className = 'test-result ok';
        if (data.hint) { hint.textContent = data.hint; hint.hidden = false; }
      } else {
        out.textContent = data.error || '连接失败';
        out.className = 'test-result';
      }
    } catch (e) {
      out.textContent = '测试失败：' + e.message;
      out.className = 'test-result';
    }
  });

  /* boot */
  fetch('/api/settings').then(function (r) { return r.json(); }).then(applyAll).catch(function () {
    applyAll({ systemName: '夜读', subtitle: '我的书房', theme: 'night',
      scan: { onStart: true, intervalMinutes: 60 },
      background: { enabled: false, data: '', dim: 0.55, blur: 0 },
      music: { mode: 'embed', enabled: false, url: 'http://192.168.0.111:9500', user: '', password: '', volume: 0.8,
        activeId: 'anylisten',
        services: [{ id: 'anylisten', name: 'AnyListen', url: 'http://192.168.0.111:9500', loginUrl: '' }] } });
  });

  window.nightSettings = { applyAll: applyAll, current: function () { return settings; } };
})();
