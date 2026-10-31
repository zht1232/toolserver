/* 路由、环境探测与通用能力 */
(function () {
  'use strict';

  var ROUTES = ['music', 'musicfast', 'syncer', 'lrc', 'image', 'hif', 'retouch', 'raw', 'json', 'encode',
    'csvjson', 'markdown', 'regex', 'jwt', 'cron', 'radix', 'generator', 'diff', 'reference',
    'text', 'hash', 'timestamp', 'color', 'about', 'feedback'];
  var TITLES = {
    music: '音乐解密与歌词', musicfast: '多源音乐下载', syncer: '歌词打轴器',
    lrc: 'LRC 时间轴', image: '图片转换压缩', hif: 'HIF / HEIF 转 JPEG', retouch: '专业修图',
    raw: 'Camera Raw', json: 'JSON 格式化',
    encode: '编解码', csvjson: 'CSV / JSON 互转', markdown: 'Markdown 预览',
    regex: '正则表达式测试', jwt: 'JWT 解析器', cron: 'Cron 表达式', radix: '进制转换 / 位运算',
    generator: 'UUID / 密码生成', diff: '文本 Diff 对比', reference: '速查表',
    text: '文本处理', hash: '哈希校验',
    timestamp: '时间戳转换', color: '颜色转换', about: '隐私与部署', feedback: '建议与反馈'
  };
  TITLES.watermark = '整图 AI 去水印';
  var GROUPS = {
    music: '音乐', musicfast: '音乐', syncer: '音乐', lrc: '音乐',
    image: '格式', hif: '格式', watermark: '格式', json: '格式', encode: '格式',
    csvjson: '格式', markdown: '格式', retouch: '修图', raw: '修图',
    regex: '开发', jwt: '开发', cron: '开发', radix: '开发', generator: '开发',
    diff: '开发', reference: '开发',
    text: '文本', hash: '文本', timestamp: '文本', color: '文本',
    about: '信息', feedback: '信息'
  };

  var RECENT_KEY = 'localtools-recent-v1';

  function readRecent() {
    try {
      var list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      return list.filter(function (item) {
        return item && typeof item.route === 'string' && TITLES[item.route] && typeof item.ts === 'number';
      });
    } catch (e) {
      return [];
    }
  }

  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  }

  function relTime(ts) {
    var diff = Date.now() - ts;
    if (!isFinite(diff) || diff < 0) return '';
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 172800000) return '昨天';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function recentIcon(route) {
    var use = document.querySelector('.nav-item[data-route="' + route + '"] use');
    return use ? use.getAttribute('href') : '#i-book';
  }

  function renderRecent() {
    var box = document.getElementById('rail-recent-list');
    if (!box) return;
    var list = readRecent().slice(0, 3);
    box.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'rail-empty';
      empty.textContent = '还没有使用记录。';
      box.appendChild(empty);
      return;
    }
    list.forEach(function (item) {
      var a = document.createElement('a');
      a.className = 'rail-mini';
      a.href = '#' + item.route;
      a.title = TITLES[item.route];
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'nav-ico');
      svg.setAttribute('aria-hidden', 'true');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', recentIcon(item.route));
      svg.appendChild(use);
      var label = document.createElement('span');
      label.textContent = TITLES[item.route];
      var time = document.createElement('time');
      time.textContent = relTime(item.ts);
      a.appendChild(svg);
      a.appendChild(label);
      a.appendChild(time);
      box.appendChild(a);
    });
  }

  function recordRecent(route) {
    if (!TITLES[route]) return;
    var list = readRecent().filter(function (item) { return item.route !== route; });
    list.unshift({ route: route, ts: Date.now() });
    writeRecent(list.slice(0, 6));
    renderRecent();
  }

  function showPage(route) {
    var watermarkAlias = route === 'watermark';
    var pageRoute = watermarkAlias ? 'image' : route;
    var lyricsAlias = route === 'lyrics';
    if (lyricsAlias) { route = 'music'; pageRoute = 'music'; }
    if (ROUTES.indexOf(pageRoute) === -1) { route = 'music'; pageRoute = 'music'; watermarkAlias = false; }
    ROUTES.forEach(function (r) {
      var page = document.getElementById('page-' + r);
      if (page) page.classList.toggle('hidden', r !== pageRoute);
    });
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === route);
    });
    clearToolSearch();
    // 窄屏：切页后自动收起导航菜单
    document.body.classList.remove('nav-open');
    var nt = document.getElementById('nav-toggle');
    if (nt) nt.setAttribute('aria-expanded', 'false');
    var t = document.getElementById('top-title');
    if (t) t.textContent = TITLES[route] || '';
    var groupEl = document.getElementById('top-group');
    var groupSep = document.querySelector('.crumb-group-sep');
    if (groupEl) groupEl.textContent = GROUPS[route] || '';
    if (groupSep) groupSep.classList.toggle('hidden', !GROUPS[route]);
    document.body.classList.toggle('route-hif', route === 'hif');
    document.body.classList.toggle('route-editor', route === 'retouch' || route === 'raw');
    recordRecent(route);
    if (lyricsAlias) {
      if (location.hash === '#lyrics' && window.history && history.replaceState) history.replaceState(null, '', '#music');
      var lyricsPanel = document.getElementById('music-lyrics-panel');
      if (lyricsPanel) setTimeout(function () { lyricsPanel.scrollIntoView(); }, 0);
    }
    window.scrollTo(0, 0);
    if (watermarkAlias) setTimeout(function () {
      if (window.openWatermarkTool) window.openWatermarkTool();
      else {
        var panel = document.getElementById('img-watermark-panel');
        if (panel) panel.classList.remove('hidden');
        var drop = document.getElementById('img-drop');
        if (drop) drop.scrollIntoView();
      }
    }, 0);
  }

  window.addEventListener('hashchange', function () {
    showPage(location.hash.replace('#', '') || 'music');
  });
  showPage(location.hash.replace('#', '') || 'music');

  // 窄屏导航菜单开关
  var navToggle = document.getElementById('nav-toggle');
  if (navToggle) {
    navToggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var allToolsNav = document.getElementById('nav-all-tools');
  if (allToolsNav) {
    allToolsNav.addEventListener('click', function () {
      var search = document.getElementById('tool-search');
      if (!search) return;
      window.scrollTo(0, 0);
      search.focus();
      search.select();
    });
  }

  /* 顶栏工具搜索：过滤侧栏，回车跳到第一个匹配项；Ctrl/Cmd+K 聚焦 */
  var toolSearch = document.getElementById('tool-search');
  var navEmpty = document.getElementById('nav-empty');

  function clearToolSearch() {
    var input = document.getElementById('tool-search');
    if (!input || !input.value) return;
    input.value = '';
    document.querySelectorAll('.nav-cap').forEach(function (c) { c.classList.remove('hidden'); });
    document.querySelectorAll('.nav-item').forEach(function (a) { a.classList.remove('hidden'); });
    var empty = document.getElementById('nav-empty');
    if (empty) empty.classList.add('hidden');
  }

  function filterNav() {
    if (!toolSearch) return;
    var q = (toolSearch.value || '').trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll('.nav-item').forEach(function (a) {
      var hit = !q || a.textContent.toLowerCase().indexOf(q) !== -1;
      a.classList.toggle('hidden', !hit);
      if (hit) shown++;
    });
    document.querySelectorAll('.nav-cap').forEach(function (c) {
      c.classList.toggle('hidden', !!q);
    });
    if (navEmpty) navEmpty.classList.toggle('hidden', !q || shown > 0);
  }

  if (toolSearch) {
    toolSearch.addEventListener('input', filterNav);
    toolSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var first = document.querySelector('.nav-item:not(.hidden)');
        if (!first) return;
        var route = first.getAttribute('data-route');
        if (!route) return;
        if (location.hash === '#' + route) showPage(route);
        else location.hash = route;
      } else if (e.key === 'Escape') {
        clearToolSearch();
        toolSearch.blur();
      }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toolSearch.focus();
        toolSearch.select();
      }
    });
  }

  /* Alt + 1..9 切换工具 */
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && ROUTES[n - 1]) {
      e.preventDefault();
      location.hash = ROUTES[n - 1];
    }
  });

  /* ================= 通用能力 ================= */
  window.TB = {
    download: function (blob, filename) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    },
    copy: function (text, btn) {
      function done() {
        if (btn) {
          var old = btn.textContent;
          btn.textContent = '已复制';
          setTimeout(function () { btn.textContent = old; }, 1200);
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      }
    },
    formatSize: function (n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(2) + ' MB';
    },
    safeName: function (s) {
      return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled';
    },
    bindDropzone: function (el, onFiles) {
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('dragover'); });
      el.addEventListener('dragleave', function () { el.classList.remove('dragover'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault();
        el.classList.remove('dragover');
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      });
    }
  };

  /* ================= 环境探测 ================= */
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  async function detectEnv() {
    var mode = '纯静态托管';
    var key = '未提供';
    try {
      var r = await fetch('api/ping');
      if (r.ok) {
        var info = await r.json();
        if (info && info.ok) {
          mode = '服务器模式';
          key = info.kgmKey ? (info.kgmKeyExpanded ? '已就绪 70 MB' : '待解压') : '未提供';
        }
      }
    } catch (e) { /* 纯静态托管时无此接口 */ }
    setText('env-mode', mode);
    setText('env-key', key);
    setText('rail-mode', mode);
    setText('rail-key', key);

    var toolCount = document.getElementById('top-tool-count');
  if (toolCount) toolCount.textContent = ROUTES.length + ' 个工具';

  // 格式统计（此时各解密模块已完成注册）
    setTimeout(function () {
      if (!window.MusicDecrypt) return;
      var list = MusicDecrypt.supported();
      setText('top-format-count', list.length + ' 种加密格式');
      setText('rail-formats', String(list.length));
      setText('music-formats', '支持 ' + list.map(function (e) { return '.' + e; }).join('  '));
    }, 0);
  }
  detectEnv();
})();
