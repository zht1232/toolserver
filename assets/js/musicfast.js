/* 网易云直连下载：服务器只负责解析直链，音频字节由浏览器直接从 CDN 拉取。
 *
 * 为什么这么设计：走 /music 代理时，每个字节都要 CDN -> 服务器 WiFi -> cloudflared
 * -> Cloudflare 边缘（这台机器落在 lax，RTT 170ms）-> 用户，实测 0.3 MB/s。
 * 网易云 CDN 返回 Access-Control-Allow-Origin: *，所以浏览器可以跨域把字节取走，
 * 实测同一条连接在模拟测试中能到几十 MB/s，差两个数量级。
 *
 * 流程：/api/nc/url 取直链 -> fetch 流式读并在页面显示进度 -> Blob -> a[download] 保存。
 * 不做服务器代理、不落盘：无直链或直连失败时明确报错，由用户换歌/换音质重试。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var results = [];

  function fmtDur(ms) {
    if (!ms) return '--:--';
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function fmtSize(b) {
    if (!b) return '未知大小';
    return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  }
  function fmtSpeed(bps) {
    return bps > 1024 * 1024 ? (bps / 1024 / 1024).toFixed(1) + ' MB/s' : Math.round(bps / 1024) + ' KB/s';
  }
  // 文件名里的非法字符清理，避免 Windows 保存失败
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || '未命名';
  }

  function setStatus(msg, kind) {
    var el = $('mf-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'logline mono' + (kind === 'err' ? ' err' : '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    var box = $('mf-results');
    if (!box) return;
    if (!results.length) {
      box.innerHTML = '<p class="para muted">还没有搜索结果。</p>';
      return;
    }
    box.innerHTML = results.map(function (s, i) {
      var artists = (s.artists || []).map(function (a) { return a.name; }).join('、') || '未知歌手';
      var album = (s.album || {}).name || '';
      return '<div class="mf-row">' +
        '<div class="mf-main">' +
        '<div class="mf-name">' + esc(s.name) + '</div>' +
        '<div class="mf-sub mono">' + esc(artists) + (album ? ' · ' + esc(album) : '') +
        ' · ' + fmtDur(s.duration) + '</div>' +
        '</div>' +
        '<button class="btn btn-primary" type="button" data-idx="' + i + '">直连下载</button>' +
        '</div>';
    }).join('');
    box.querySelectorAll('button[data-idx]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        downloadSong(results[parseInt(btn.getAttribute('data-idx'), 10)]);
      });
    });
  }

  function search() {
    var q = ($('mf-keyword').value || '').trim();
    if (!q) { setStatus('请输入歌曲名或歌手名', 'err'); return; }
    setStatus('正在检索…');
    var btn = $('mf-search');
    btn.disabled = true;
    fetch('/api/nc/search?s=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false;
        // 网易云限流时返回 {code:406, message:"操作频繁..."}，要如实提示而不是装作没结果
        if (d && d.code && d.code !== 200) {
          results = [];
          render();
          setStatus('检索失败：' + (d.message || d.msg || ('code ' + d.code)) +
            ' —— 网易云的频率限制，等十几秒再试即可', 'err');
          return;
        }
        var songs = ((d.result || {}).songs) || [];
        if (!songs.length) { results = []; render(); setStatus('没有找到结果', 'err'); return; }
        results = songs.slice(0, 15);
        render();
        setStatus('找到 ' + results.length + ' 首，点「直连下载」即可由浏览器直连 CDN 保存');
      })
      .catch(function (e) {
        btn.disabled = false;
        setStatus('检索失败：' + e.message, 'err');
      });
  }

  function downloadSong(song) {
    if (!song) return;
    var br = ($('mf-br') || {}).value || '320000';
    var bar = $('mf-progress');
    var fill = $('mf-progress-fill');
    if (bar) bar.classList.remove('hidden');
    if (fill) fill.style.width = '0%';

    fetch('/api/nc/url?id=' + encodeURIComponent(song.id) + '&br=' + encodeURIComponent(br),
      { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (!info || info.code !== 200 || !info.url) {
          if (bar) bar.classList.add('hidden');
          setStatus(((info && info.error) || '无法取得直链') +
            '；请换一首/音质，或稍后重试。', 'err');
          return;
        }
        setStatus('已取得直链（' + fmtSize(info.size) + '，有效期 ' +
          Math.round((info.expi || 1200) / 60) + ' 分钟），浏览器开始直连 CDN…');
        return fetchFromCdn(song, info);
      })
      .catch(function (e) {
        if (bar) bar.classList.add('hidden');
        setStatus('取直链失败：' + e.message + '；请稍后重试。', 'err');
      });
  }

  function fetchFromCdn(song, info) {
    var fill = $('mf-progress-fill');
    var t0 = Date.now();
    fetch(info.url, { mode: 'cors' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('CDN 返回 ' + resp.status);
        var total = Number(resp.headers.get('Content-Length')) || info.size || 0;
        var received = 0;
        var chunks = [];
        var reader = resp.body ? resp.body.getReader() : null;

        if (!reader) {  // 不支持流式读取就整体读
          return resp.blob().then(function (b) { return saveBlob(song, info, b, total); });
        }
        function pump(loopRes) {
          if (loopRes.done) {
            return saveBlob(song, info, new Blob(chunks), received);
          }
          received += loopRes.value.length;
          chunks.push(loopRes.value);
          if (total && fill) {
            fill.style.width = Math.min(100, (received / total) * 100).toFixed(1) + '%';
          }
          var secs = (Date.now() - t0) / 1000;
          if (secs > 0) {
            setStatus('直连下载中 ' + fmtSize(received) + ' / ' + fmtSize(total) +
              ' · ' + fmtSpeed(received / secs));
          }
          return reader.read().then(pump);
        }
        return reader.read().then(pump);
      })
      .then(function (ok) {
        if (ok) {
          var secs = (Date.now() - t0) / 1000;
          var size = info.size || 0;
          setStatus('下载完成：' + fmtSize(size) + '，用时 ' + secs.toFixed(1) + ' 秒，' +
            '平均 ' + fmtSpeed(size / secs) + '（未经服务器转发）');
        }
      })
      .catch(function (e) {
        var bar = $('mf-progress');
        if (bar) bar.classList.add('hidden');
        setStatus('直连失败：' + e.message + '；本站不做服务器代理，请换一首/音质或稍后重试。', 'err');
      });
  }

  function saveBlob(song, info, blob, received) {
    var artists = (song.artists || []).map(function (a) { return a.name; }).join('、') || '未知歌手';
    var ext = (info.ext || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
    var name = safeName(song.name) + ' - ' + safeName(artists) + '.' + ext;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    return true;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('mf-search');
    var kw = $('mf-keyword');
    if (btn) btn.addEventListener('click', search);
    if (kw) kw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') search();
    });
    render();
  });
})();
