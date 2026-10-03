/* 路由、环境探测与通用能力 */
(function () {
  'use strict';

  var ROUTES = ['music', 'syncer', 'lrc', 'image', 'json', 'encode', 'csvjson', 'markdown',
    'regex', 'jwt', 'cron', 'radix', 'generator', 'diff', 'reference',
    'text', 'hash', 'timestamp', 'color', 'about', 'feedback'];
  var TITLES = {
    music: 'MUSIC / DECRYPT + LYRICS', syncer: 'MUSIC / SYNC EDITOR',
    lrc: 'MUSIC / LRC SHIFT', image: 'FORMAT / IMAGE', json: 'FORMAT / JSON',
    encode: 'FORMAT / CODEC', csvjson: 'FORMAT / CSV-JSON', markdown: 'FORMAT / MARKDOWN',
    regex: 'DEV / REGEX', jwt: 'DEV / JWT', cron: 'DEV / CRON', radix: 'DEV / RADIX',
    generator: 'DEV / GENERATOR', diff: 'DEV / DIFF', reference: 'DEV / REFERENCE',
    text: 'TEXT / PROCESS', hash: 'TEXT / HASH',
    timestamp: 'TEXT / TIMESTAMP', color: 'TEXT / COLOR', about: 'INFO / PRIVACY', feedback: 'INFO / FEEDBACK'
  };

  function showPage(route) {
    var lyricsAlias = route === 'lyrics';
    if (lyricsAlias) route = 'music';
    if (ROUTES.indexOf(route) === -1) route = 'music';
    ROUTES.forEach(function (r) {
      var page = document.getElementById('page-' + r);
      if (page) page.classList.toggle('hidden', r !== route);
    });
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === route);
    });
    var t = document.getElementById('top-title');
    if (t) t.textContent = TITLES[route] || '';
    if (lyricsAlias) {
      if (location.hash === '#lyrics' && window.history && history.replaceState) history.replaceState(null, '', '#music');
      var lyricsPanel = document.getElementById('music-lyrics-panel');
      if (lyricsPanel) setTimeout(function () { lyricsPanel.scrollIntoView(); }, 0);
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', function () {
    showPage(location.hash.replace('#', '') || 'music');
  });
  showPage(location.hash.replace('#', '') || 'music');

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

    // 格式统计（此时各解密模块已完成注册）
    setTimeout(function () {
      if (!window.MusicDecrypt) return;
      var list = MusicDecrypt.supported();
      setText('top-format-count', list.length + ' FORMATS');
      setText('rail-formats', String(list.length));
      setText('music-formats', '支持 ' + list.map(function (e) { return '.' + e; }).join('  '));
    }, 0);
  }
  detectEnv();
})();
