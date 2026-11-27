/* Settings drawer: system name, subtitle, theme, background image. */
(function () {
  'use strict';

  var root = document.documentElement;
  var settings = null;
  var pendingTheme = 'night';
  var pendingBg = null; // { data, enabled }
  var bgVersion = 0;

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

  function applyBackground() {
    var backdrop = el('backdrop');
    if (!backdrop) return;
    var bg = settings && settings.background ? settings.background : {};
    if (pendingBg) { bg = { data: pendingBg.data, enabled: pendingBg.enabled, dim: bg.dim, blur: bg.blur }; }
    if (bg.enabled && bg.data) {
      backdrop.style.backgroundImage = 'url("/api/background?v=' + bgVersion + '")';
      backdrop.style.setProperty('--bg-dim', String(bg.dim != null ? bg.dim : 0.55));
      backdrop.style.setProperty('--bg-blur', (bg.blur || 0) + 'px');
    } else {
      backdrop.style.backgroundImage = '';
    }
  }

  function applyMusicMode(mode) {
    pendingMusicMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('.mode-card'), function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    });
    el('music-subsonic-fields').hidden = mode !== 'subsonic';
    el('music-hint').textContent = mode === 'embed'
      ? '给服务填地址，点顶栏 ♫ 打开播放器；在播放器左上角切换服务，收起后继续播放。'
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

  function applyAll(next) {
    settings = next;
    folders = (settings.folders || []).slice();
    renderFolders();
    pendingTheme = settings.theme || 'night';
    pendingBg = null;
    applyTheme(pendingTheme);
    el('brand-name').textContent = settings.systemName || '夜读';
    el('brand-sub').textContent = settings.subtitle || '我的书房';
    document.title = (settings.systemName || '夜读') + ' · ' + (settings.subtitle || '我的书房');
    el('set-name').value = settings.systemName || '';
    el('set-subtitle').value = settings.subtitle || '';
    renderScan();
    el('bg-path').value = (settings.background && settings.background.data && !settings.background.data.startsWith('uploaded:'))
      ? settings.background.data : '';
    el('bg-dim').value = Math.round((settings.background.dim != null ? settings.background.dim : 0.55) * 100);
    el('bg-dim-out').textContent = el('bg-dim').value + '%';
    el('bg-blur').value = settings.background.blur || 0;
    el('bg-blur-out').textContent = el('bg-blur').value + 'px';
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

  function openDrawer() {
    drawer.hidden = false;
    scrim.hidden = false;
    applyAll(settings);
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
        blur: Number(el('bg-blur').value)
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
  });
  el('bg-clear').addEventListener('click', function () {
    el('bg-path').value = '';
    pendingBg = { data: '', enabled: false };
    settings.background.enabled = false;
    applyBackground();
    toastFn('背景已清除，记得保存');
  });

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
        el('bg-path').value = '';
        pendingBg = null;
        applyBackground();
        toastFn('背景已上传，记得保存其他修改');
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
