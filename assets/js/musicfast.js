/* 多源音乐下载：服务器只做搜索与直链解析，音频字节由浏览器直接从 CDN 拉取。
 *
 * 支持音源（CDN 允许浏览器跨域直连）：网易云、酷狗、QQ音乐、千千。
 * 其余平台往往校验 Referer / User-Agent 或链接加密，浏览器无法直连，故不列出。
 * 流程：/api/music/search 搜索 -> /api/music/url 解析直链 -> fetch(url,{mode:'cors'})
 * 流式读取并显示进度 -> Blob -> a[download] 保存。不做服务器代理、不做服务器兜底。
 * 代码保持 ES5 写法（var/function），与项目其余脚本一致。
 */
(function () {
  'use strict';

  var DL_LABEL = '浏览器直连下载';
  var MSG_DOWN = '解析服务不可用，请稍后重试';
  var MSG_CORS = '该音源不允许浏览器直连；本站不做服务器下载，请换源/换曲/重试。';
  var SOURCE_LABELS = {
    netease: '网易云',
    kugou: '酷狗',
    qq: 'QQ音乐',
    qianqian: '千千'
  };
  var REASON_LABELS = {
    not_found: '该音源没有可下载资源（可能已下架、受版权或会员限制）',
    restricted: '该歌曲受版权或会员限制',
    copyright: '该歌曲受版权限制',
    vip: '该歌曲需要会员',
    timeout: '解析超时，请重试',
    error: '解析服务临时异常，请重试'
  };
  var AUDIO_EXT = /^(mp3|flac|m4a|mp4|aac|wav|ogg|oga|opus|ape|wma|webm)$/;
  var TYPE_EXT = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/aacp': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/webm': 'webm'
  };
  var HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  var results = [];
  var emptyMsg = '还没有搜索结果。选择音源、输入关键词后回车或点「搜索」。';
  var working = false;
  var activeRow = null;

  function $(id) { return document.getElementById(id); }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return HTML_MAP[c]; });
  }

  function trim(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function fail(kind, detail) {
    var err = new Error(kind);
    err.kind = kind;
    if (detail) err.detail = String(detail);
    return err;
  }

  function fmtDur(d) {
    if (typeof d === 'string' && d.indexOf(':') !== -1) return d;
    var n = Number(d);
    if (!isFinite(n) || n <= 0) return '--:--';
    var sec = n > 36000 ? Math.round(n / 1000) : Math.round(n);
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  function fmtSize(b) {
    var n = Number(b) || 0;
    if (!n) return '未知大小';
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function fmtSpeed(bps) {
    var n = Number(bps) || 0;
    if (!n) return '0 KB/s';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB/s';
    return Math.max(1, Math.round(n / 1024)) + ' KB/s';
  }

  function setStatus(msg, kind) {
    var el = $('mf-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'logline mono' + (kind === 'err' ? ' err' : '');
  }

  function showProgress(indeterminate) {
    var bar = $('mf-progress');
    var fill = $('mf-progress-fill');
    if (bar) bar.classList.remove('hidden');
    if (!fill) return;
    fill.style.width = indeterminate ? '34%' : '0%';
    if (indeterminate) fill.classList.add('is-indeterminate');
    else fill.classList.remove('is-indeterminate');
  }

  function setProgress(ratio) {
    var fill = $('mf-progress-fill');
    if (!fill) return;
    var r = Number(ratio);
    if (!isFinite(r)) r = 0;
    r = Math.max(0, Math.min(1, r));
    fill.classList.remove('is-indeterminate');
    fill.style.width = (Math.round(r * 1000) / 10).toFixed(1) + '%';
  }

  function hideProgress() {
    var bar = $('mf-progress');
    var fill = $('mf-progress-fill');
    if (bar) bar.classList.add('hidden');
    if (fill) {
      fill.classList.remove('is-indeterminate');
      fill.style.width = '0%';
    }
  }

  function rowError(row, msg) {
    if (!row) return;
    var el = row.querySelector('.mf-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function lock(activeBtn, row, text) {
    working = true;
    activeRow = row || null;
    var sBtn = $('mf-search');
    if (sBtn) sBtn.disabled = true;
    var btns = document.querySelectorAll('.mf-dl');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      btns[i].textContent = (activeBtn && btns[i] === activeBtn && text) ? text : DL_LABEL;
    }
    if (activeRow) activeRow.classList.add('is-busy');
  }

  function unlock() {
    working = false;
    var sBtn = $('mf-search');
    if (sBtn) {
      sBtn.disabled = false;
      sBtn.textContent = '搜索';
    }
    var btns = document.querySelectorAll('.mf-dl');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = false;
      btns[i].textContent = DL_LABEL;
    }
    if (activeRow) activeRow.classList.remove('is-busy');
    activeRow = null;
  }

  function artistOf(song) {
    var a = song ? song.artist : '';
    if (a && typeof a === 'object') {
      if (isArray(a)) {
        var names = [];
        for (var i = 0; i < a.length; i++) {
          var item = a[i];
          names.push(item && typeof item === 'object' ? String(item.name || '') : String(item || ''));
        }
        a = names.join('、');
      } else {
        a = String(a.name || '');
      }
    }
    a = trim(a);
    return a || '未知歌手';
  }

  function albumOf(song) {
    var al = song ? song.album : '';
    if (al && typeof al === 'object') al = al.name || '';
    return trim(al);
  }

  function sourceOf(song) {
    var src = song && song.source ? song.source : '';
    if (!src) {
      var sel = $('mf-source');
      src = sel ? sel.value : 'netease';
    }
    return String(src).toLowerCase();
  }

  function sourceLabel(src) {
    var key = String(src || '').toLowerCase();
    return SOURCE_LABELS[key] || src || '未知音源';
  }

  function safeName(s) {
    var out = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '');
    return out.slice(0, 120) || '未命名';
  }

  function extFromType(type) {
    var t = trim(String(type || '').toLowerCase().split(';')[0]);
    return Object.prototype.hasOwnProperty.call(TYPE_EXT, t) ? TYPE_EXT[t] : '';
  }

  function pickExt(url, contentType, blobType) {
    var path = String(url || '').split('?')[0].split('#')[0];
    var m = /\.([a-z0-9]{2,5})$/i.exec(path);
    if (m && AUDIO_EXT.test(m[1].toLowerCase())) return m[1].toLowerCase();
    return extFromType(contentType) || extFromType(blobType) || 'mp3';
  }

  function safeFileName(song, ext) {
    var clean = String(ext || 'mp3').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3';
    var base = (safeName(song && song.name) + ' - ' + safeName(artistOf(song)))
      .slice(0, 120).replace(/[\s.]+$/g, '');
    return (base || '未命名') + '.' + clean;
  }

  function extraParam(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string') {
      var t = trim(v);
      return (t === '' || t === '{}' || t === 'null') ? '' : t;
    }
    try {
      return JSON.stringify(v);
    } catch (e) {
      return '';
    }
  }

  function upgradeCdnUrl(u) {
    var s = String(u || '');
    // HTTPS 页面无法直连 HTTP CDN，主流音源均支持同路径 HTTPS
    if (location.protocol === 'https:' && /^http:\/\//i.test(s)) return 'https://' + s.slice(7);
    return s;
  }

  function reasonText(info) {
    var status = String(info && info.status || '').toLowerCase();
    var reason = trim(info && info.reason);
    var key = REASON_LABELS[reason.toLowerCase()] ? reason.toLowerCase() : status;
    return REASON_LABELS[key] || reason || status || '未返回可用直链';
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (resp) {
      var status = resp.status;
      var ok = resp.ok;
      return resp.json().then(function (data) {
        return { ok: ok, status: status, data: data };
      }, function () {
        return { ok: false, status: status, data: null };
      });
    });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function finish(song, blob, url, type, bytes, t0) {
    var ext = pickExt(url, type, blob.type);
    var name = safeFileName(song, ext);
    saveBlob(blob, name);
    var secs = (Date.now() - t0) / 1000;
    var size = Number(bytes) || blob.size || 0;
    setStatus('下载完成：' + name + ' · ' + fmtSize(size) + ' · 用时 ' + secs.toFixed(1) +
      ' 秒 · 平均 ' + fmtSpeed(secs > 0 ? size / secs : 0) + '（浏览器直连，未经服务器）');
    return true;
  }

  function readBody(song, resp, type, total, t0, url) {
    var reader = resp.body.getReader();
    var chunks = [];
    var received = 0;
    var lastTick = 0;

    showProgress(!total);
    if (total) setProgress(0);

    function next() {
      return reader.read().then(pump, function (e) {
        throw fail('cors', e && e.message ? e.message : '读取中断');
      });
    }

    function pump(step) {
      if (step.done) {
        var blob = new Blob(chunks, { type: type || 'application/octet-stream' });
        showProgress(false);
        setProgress(1);
        return finish(song, blob, url, type, received, t0);
      }
      var value = step.value;
      if (value && value.length) {
        chunks.push(value);
        received += value.length;
      }
      if (total) setProgress(received / total);

      var now = Date.now();
      if (now - lastTick > 220) {
        lastTick = now;
        var secs = (now - t0) / 1000;
        setStatus('浏览器直连下载中：' + fmtSize(received) + (total ? ' / ' + fmtSize(total) : '') +
          ' · ' + fmtSpeed(secs > 0 ? received / secs : 0));
      }
      return next();
    }

    return next();
  }

  function streamToBlob(song, info) {
    var url = upgradeCdnUrl(info.url);
    var t0 = Date.now();
    showProgress(true);
    return fetch(url, { mode: 'cors' }).then(function (resp) {
      if (!resp || resp.type === 'opaque' || !resp.ok) {
        throw fail('cors', resp ? 'CDN 返回 HTTP ' + resp.status : 'CDN 无响应');
      }
      var type = resp.headers.get('Content-Type') || '';
      var total = parseInt(resp.headers.get('Content-Length'), 10) || 0;
      if (!total && info.size) total = Number(info.size) || 0;

      if (!resp.body || !resp.body.getReader) {
        return resp.blob().then(function (blob) {
          showProgress(false);
          setProgress(1);
          return finish(song, blob, url, type || blob.type, blob.size, t0);
        }, function (e) {
          throw fail('cors', e && e.message ? e.message : '读取失败');
        });
      }
      return readBody(song, resp, type, total, t0, url);
    }, function (e) {
      throw fail('cors', e && e.message ? e.message : '网络错误');
    });
  }

  function resolveSong(song) {
    var id = song && song.id != null ? String(song.id) : '';
    var source = sourceOf(song);
    var duration = song && song.duration != null ? String(song.duration) : '';
    var url = '/api/music/url?id=' + encodeURIComponent(id) +
      '&source=' + encodeURIComponent(source) +
      '&duration=' + encodeURIComponent(duration);
    var extra = extraParam(song ? song.extra : '');
    if (extra) url += '&extra=' + encodeURIComponent(extra);

    return fetchJson(url).then(function (res) {
      if (!res.data) throw fail('down');
      if (!res.ok) {
        var apiErr = res.data.error;
        if (res.status >= 500 || !apiErr) throw fail('down');
        throw fail('resolve', apiErr);
      }
      var info = res.data;
      if (info && info.valid !== false && typeof info.url === 'string' &&
        /^https?:\/\//i.test(info.url)) {
        return info;
      }
      throw fail('resolve', info.error || reasonText(info));
    });
  }

  function downloadSong(song, btn, row) {
    if (working) return;
    if (!song || song.id == null || song.id === '') {
      setStatus('歌曲信息不完整，请重新搜索。', 'err');
      rowError(row, '歌曲信息不完整，请重新搜索。');
      return;
    }

    lock(btn, row, '解析中…');
    rowError(row, '');
    showProgress(true);
    setStatus('正在向服务器解析直链…（音频仍由浏览器直连 CDN）');

    resolveSong(song).then(function (info) {
      if (btn) btn.textContent = '下载中…';
      setStatus('直链已就绪' + (info.size ? '（' + fmtSize(info.size) + '）' : '') +
        '，浏览器开始直连 CDN…');
      return streamToBlob(song, info);
    }).catch(function (e) {
      var kind = e && e.kind;
      var detail = e && (e.detail || e.message);
      if (kind === 'down') {
        hideProgress();
        setStatus(MSG_DOWN, 'err');
        rowError(row, MSG_DOWN);
      } else if (kind === 'cors') {
        hideProgress();
        var corsMsg = MSG_CORS + (detail ? '（' + detail + '）' : '');
        setStatus(corsMsg, 'err');
        rowError(row, corsMsg);
      } else if (kind === 'resolve') {
        hideProgress();
        var resolveMsg = '解析失败：' + (detail || '未返回可用直链');
        setStatus(resolveMsg + '。请换源/换曲/重试。', 'err');
        rowError(row, resolveMsg);
      } else {
        hideProgress();
        setStatus('下载失败：' + (detail || '未知错误') + '。请稍后重试。', 'err');
        rowError(row, '下载失败：' + (detail || '未知错误'));
      }
    }).then(function () {
      unlock();
    });
  }

  function render() {
    var box = $('mf-results');
    if (!box) return;
    if (!results.length) {
      box.innerHTML = '<p class="para muted">' + emptyMsg + '</p>';
      return;
    }

    var html = [];
    for (var i = 0; i < results.length; i++) {
      var song = results[i] || {};
      var src = sourceOf(song);
      var artist = artistOf(song);
      var album = albumOf(song);
      var sub = esc(artist);
      if (album) sub += ' · ' + esc(album);
      sub += ' · ' + esc(fmtDur(song.duration));
      var title = esc(song.name || '未命名');
      html.push('<div class="mf-row">' +
        '<div class="mf-main">' +
          '<div class="mf-name" title="' + title + '">' + title + '</div>' +
          '<div class="mf-sub mono"><span class="fmt-chip mf-source">' + esc(sourceLabel(src)) + '</span>' + sub + '</div>' +
          '<div class="mf-error hidden"></div>' +
        '</div>' +
        '<button class="btn btn-primary mf-dl" type="button" data-idx="' + i + '">' + DL_LABEL + '</button>' +
      '</div>');
    }
    box.innerHTML = html.join('');

    var btns = box.querySelectorAll('button[data-idx]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        if (!isFinite(idx) || !results[idx]) return;
        downloadSong(results[idx], this, this.parentNode);
      });
    }
  }

  function search() {
    if (working) return;
    var kw = $('mf-keyword');
    var srcEl = $('mf-source');
    var q = trim(kw ? kw.value : '');
    if (!q) {
      setStatus('请输入歌曲名或歌手名', 'err');
      if (kw) kw.focus();
      return;
    }
    var source = srcEl ? srcEl.value : 'netease';

    results = [];
    emptyMsg = '正在检索…';
    render();
    lock(null, null, '');
    var sBtn = $('mf-search');
    if (sBtn) sBtn.textContent = '搜索中…';
    setStatus('正在通过服务器检索「' + q + '」（' + sourceLabel(source) + '）…');

    fetchJson('/api/music/search?s=' + encodeURIComponent(q) +
      '&source=' + encodeURIComponent(source)).then(function (res) {
      if (!res.data) {
        results = [];
        emptyMsg = '检索服务暂不可用，请稍后重试。';
        render();
        setStatus(MSG_DOWN, 'err');
        return;
      }
      if (!res.ok) {
        var apiErr = res.data.error;
        results = [];
        emptyMsg = '检索失败，请稍后重试。';
        render();
        if (res.status >= 500 || !apiErr) setStatus(MSG_DOWN, 'err');
        else setStatus('检索失败：' + apiErr, 'err');
        return;
      }
      var d = res.data;
      if (d && d.error) {
        results = [];
        emptyMsg = '检索失败，请稍后重试。';
        render();
        setStatus('检索失败：' + d.error, 'err');
        return;
      }
      var songs = d && d.ok !== false && isArray(d.songs) ? d.songs : null;
      if (!songs) {
        results = [];
        emptyMsg = '检索服务返回异常，请稍后重试。';
        render();
        setStatus(MSG_DOWN, 'err');
        return;
      }
      if (!songs.length) {
        results = [];
        emptyMsg = '没有找到相关歌曲，换个关键词或音源试试。';
        render();
        setStatus('没有找到结果，试试其他关键词或更换音源。', 'err');
        return;
      }
      results = songs.slice(0, 20);
      emptyMsg = '还没有搜索结果。';
      render();
      var more = songs.length > results.length ?
        '（共 ' + songs.length + ' 条，显示前 ' + results.length + ' 条）' : '';
      setStatus('找到 ' + results.length + ' 首' + more + '，点「' + DL_LABEL + '」由浏览器直连 CDN。');
    }).catch(function () {
      results = [];
      emptyMsg = '检索服务暂不可用，请稍后重试。';
      render();
      setStatus(MSG_DOWN, 'err');
    }).then(function () {
      unlock();
    });
  }

  function init() {
    var btn = $('mf-search');
    var kw = $('mf-keyword');
    if (btn) btn.addEventListener('click', search);
    if (kw) {
      kw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) {
          e.preventDefault();
          search();
        }
      });
    }
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
