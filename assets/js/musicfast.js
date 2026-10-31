/* 多源音乐下载：服务器只做搜索与直链解析，音频字节由浏览器直接从 CDN 拉取。
 *
 * 支持音源（CDN 允许浏览器跨域直连）：网易云、QQ音乐、酷狗、汽水音乐、千千、5sing；
 * 默认「全部音源」并行检索并交错合并，便于在失败时换源。
 * 其余平台往往校验 Referer / User-Agent、链接加密或响应不是音频，浏览器无法直连，故不列出。
 * 流程：/api/music/search 搜索 -> /api/music/url 解析直链 -> fetch(url,{mode:'cors'})
 * 流式读取并显示进度 -> Blob -> a[download] 保存。不做服务器代理、不做服务器兜底。
 * 代码保持 ES5 写法（var/function），与项目其余脚本一致。
 */
(function () {
  'use strict';

  var DL_LABEL = '浏览器直连下载';
  var ALL_LABEL = '全部音源';
  var MSG_DOWN = '解析服务暂时不可用，请稍后重试（这不是会员或版权限制）。';
  var MSG_CORS = '该音源的 CDN 不允许浏览器直连（缺少跨域响应头），本站不做服务器下载中转。请换源或点「换源搜索」。';
  var MSG_LIMIT = '平台会员 / 版权曲可能无法下载；这是音源侧限制，不是本站服务器故障。';
  var REASON_LABELS = {
    not_found: '该音源没有可下载资源（可能已下架、受版权或会员限制）',
    restricted: '该歌曲受版权或会员限制',
    copyright: '该歌曲受版权限制',
    vip: '该歌曲需要会员',
    timeout: '解析超时，请重试',
    error: '解析服务临时异常，请重试'
  };
  // #mf-source 的选项在初始化时重建（index.html 不参与改动），默认选中全部音源。
  var SOURCE_OPTIONS = [
    { value: 'all', label: ALL_LABEL },
    { value: 'netease', label: '网易云' },
    { value: 'qq', label: 'QQ音乐' },
    { value: 'kugou', label: '酷狗' },
    { value: 'soda', label: '汽水音乐' },
    { value: 'qianqian', label: '千千' },
    { value: 'fivesing', label: '5sing' }
  ];
  var SOURCE_LABELS = {
    all: ALL_LABEL,
    netease: '网易云',
    kugou: '酷狗',
    qq: 'QQ音乐',
    qianqian: '千千',
    soda: '汽水音乐',
    fivesing: '5sing'
  };
  var MAX_RESULTS = 20;
  var MAX_RESULTS_ALL = 30;
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
  var emptyMsg = '还没有搜索结果。选择音源（默认「全部音源」）、输入关键词后回车或点「搜索」。';
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

  function fail(kind, detail, status) {
    var err = new Error(kind);
    err.kind = kind;
    if (detail) err.detail = String(detail);
    if (status) err.status = String(status);
    return err;
  }

  // 用 DOM API 重建 #mf-source，避免改动 index.html；默认选中「全部音源」。
  function buildSourceSelect() {
    var sel = $('mf-source');
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (var i = 0; i < SOURCE_OPTIONS.length; i++) {
      var opt = document.createElement('option');
      opt.value = SOURCE_OPTIONS[i].value;
      opt.textContent = SOURCE_OPTIONS[i].label;
      sel.appendChild(opt);
    }
    sel.value = 'all';
    sel.addEventListener('change', onSourceChange);
  }

  function selectedSource() {
    var sel = $('mf-source');
    var value = sel ? String(sel.value || '') : '';
    return value || 'all';
  }

  function onSourceChange() {
    if (working) return;
    var label = sourceLabel(selectedSource());
    results = [];
    emptyMsg = '已切换到「' + label + '」，输入关键词后回车或点「搜索」。';
    render();
    hideProgress();
    setStatus('当前音源：' + label +
      (selectedSource() === 'all' ? '（并行检索各源并合并，失败可换源）。' : '。'));
  }

  function parentRow(node) {
    while (node && node.nodeType === 1) {
      var cls = node.className ? String(node.className) : '';
      if (cls.split(/\s+/).indexOf('mf-row') !== -1) return node;
      node = node.parentNode;
    }
    return null;
  }

  function retryRow(row) {
    if (!row || working) return;
    var dl = row.querySelector('.mf-dl');
    var idx = dl ? parseInt(dl.getAttribute('data-idx'), 10) : NaN;
    var song = isFinite(idx) ? results[idx] : null;
    if (!song) return;
    var artist = artistOf(song);
    if (artist === '未知歌手') artist = '';
    var keyword = trim((song.name || '') + ' ' + artist).slice(0, 70);
    if (!keyword) return;
    var sel = $('mf-source');
    if (sel) sel.value = 'all';
    var kw = $('mf-keyword');
    if (kw) kw.value = keyword;
    search();
  }

  // 解析失败原因分类：区分会员 / 版权 / 无直链 / 超时等（优先用上游 status，其次看文案）。
  function failureHint(status, detail) {
    var key = String(status || '').toLowerCase();
    var text = String(detail || '');
    if (key === 'not_found') {
      return '该音源没有找到这首歌的可下载资源（可能已下架）。' + MSG_LIMIT;
    }
    if (key === 'vip' || key === 'paid') {
      return '该曲需要平台会员或付费购买，音源不提供可下载直链。' + MSG_LIMIT;
    }
    if (key === 'copyright' || key === 'restricted') {
      return '该曲受版权限制或已下架，音源没有可用直链。' + MSG_LIMIT;
    }
    if (key === 'timeout') {
      return '解析超时，上游响应较慢，可稍后重试。';
    }
    if (key === 'no_url') return '上游没有返回可用直链。' + MSG_LIMIT;
    if (/会员|vip|付费|购买/i.test(text)) {
      return '该曲需要平台会员或付费购买，音源不提供可下载直链。' + MSG_LIMIT;
    }
    if (/版权|下架/.test(text)) {
      return '该曲受版权限制或已下架，音源没有可用直链。' + MSG_LIMIT;
    }
    if (/超时|timeout/i.test(text)) {
      return '解析超时，上游响应较慢，可稍后重试。';
    }
    return (text || '未返回可用直链（可能是会员曲、版权限制或上游临时异常）。') + MSG_LIMIT;
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

  function rowError(row, msg, withRetry) {
    if (!row) return;
    var el = row.querySelector('.mf-error');
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!msg) {
      el.classList.add('hidden');
      return;
    }
    // 只放纯文本节点：提示里不会出现未转义的用户/上游数据
    var text = document.createElement('span');
    text.className = 'mf-error-text';
    text.textContent = msg;
    el.appendChild(text);
    if (withRetry) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn mf-retry';
      btn.textContent = '换源搜索';
      btn.style.marginLeft = '8px';
      btn.style.padding = '2px 9px';
      btn.style.fontSize = '12px';
      el.appendChild(btn);
    }
    el.classList.remove('hidden');
  }

  function lock(activeBtn, row, text) {
    working = true;
    activeRow = row || null;
    var sBtn = $('mf-search');
    if (sBtn) sBtn.disabled = true;
    var sel = $('mf-source');
    if (sel) sel.disabled = true;
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
    var sel = $('mf-source');
    if (sel) sel.disabled = false;
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
      // 后端一定会带 source；缺失时只在选中具体音源时兜底，避免「全部音源」被当成来源
      var sel = $('mf-source');
      var value = sel ? String(sel.value || '') : '';
      src = value && value !== 'all' ? value : '';
    }
    return String(src).toLowerCase();
  }

  function sourceLabel(src) {
    var key = String(src || '').toLowerCase();
    return SOURCE_LABELS[key] || (key ? String(src) : '未知音源');
  }

  // 把 all 的 counts 渲染成「网易云 5 · 酷狗 3」；只读白名单键，忽略未知字段。
  function sourceBreakdown(counts) {
    if (!counts || typeof counts !== 'object') return '';
    var parts = [];
    for (var i = 0; i < SOURCE_OPTIONS.length; i++) {
      var key = SOURCE_OPTIONS[i].value;
      if (key === 'all') continue;
      var n = Number(counts[key]);
      if (isFinite(n) && n > 0) parts.push(SOURCE_LABELS[key] + ' ' + Math.floor(n));
    }
    return parts.join(' · ');
  }

  function coverOf(song) {
    var url = trim(song && song.cover);
    if (location.protocol === 'https:' && /^http:\/\//i.test(url)) url = 'https://' + url.slice(7);
    return /^https?:\/\//i.test(url) ? url : '';
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
      throw fail('resolve', info.error || reasonText(info), info && info.status);
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
      var status = e && e.status;
      if (kind === 'down') {
        hideProgress();
        setStatus(MSG_DOWN, 'err');
        rowError(row, MSG_DOWN);
      } else if (kind === 'cors') {
        hideProgress();
        var corsMsg = MSG_CORS + (detail ? '（' + detail + '）' : '');
        setStatus(corsMsg, 'err');
        rowError(row, corsMsg, true);
      } else if (kind === 'resolve') {
        hideProgress();
        var resolveMsg = '解析失败：' + failureHint(status, detail);
        setStatus(resolveMsg + ' 可点「换源搜索」在全部音源中查找。', 'err');
        rowError(row, resolveMsg, true);
      } else {
        hideProgress();
        setStatus('下载失败：' + (detail || '未知错误') + '。请稍后重试。', 'err');
        rowError(row, '下载失败：' + (detail || '未知错误'), true);
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
      var cover = coverOf(song);
      html.push('<div class="mf-row">' +
        '<div class="mf-cover-wrap">' +
          '<svg class="nav-ico mf-cover-ph" aria-hidden="true"><use href="#i-music"/></svg>' +
          (cover ? '<img class="mf-cover" src="' + esc(cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') +
        '</div>' +
        '<div class="mf-main">' +
          '<div class="mf-name" title="' + title + '">' + title + '</div>' +
          '<div class="mf-sub mono"><span class="fmt-chip mf-source">' + esc(sourceLabel(src)) + '</span>' + sub + '</div>' +
          '<div class="mf-error hidden"></div>' +
        '</div>' +
        '<button class="btn btn-primary mf-dl" type="button" data-idx="' + i + '">' + DL_LABEL + '</button>' +
      '</div>');
    }
    box.innerHTML = html.join('');

    var covers = box.querySelectorAll('.mf-cover');
    for (var k = 0; k < covers.length; k++) {
      covers[k].addEventListener('error', function () { this.style.display = 'none'; });
    }

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
    var q = trim(kw ? kw.value : '');
    if (!q) {
      setStatus('请输入歌曲名或歌手名', 'err');
      if (kw) kw.focus();
      return;
    }
    var source = selectedSource();
    var isAll = source === 'all';
    var label = sourceLabel(source);
    var limit = isAll ? MAX_RESULTS_ALL : MAX_RESULTS;

    results = [];
    emptyMsg = '正在检索…';
    render();
    lock(null, null, '');
    var sBtn = $('mf-search');
    if (sBtn) sBtn.textContent = '搜索中…';
    setStatus('正在通过服务器检索「' + q + '」（' + label + '）…');

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
        emptyMsg = isAll ?
          '全部音源都没有找到相关歌曲，换个关键词试试。' :
          '「' + label + '」没有找到相关歌曲，可切换到「' + ALL_LABEL + '」再试。';
        render();
        setStatus(isAll ?
          '全部音源都没有找到结果，换个关键词试试。' :
          '「' + label + '」没有找到结果，切换到「' + ALL_LABEL + '」再试。', 'err');
        return;
      }
      results = songs.slice(0, limit);
      emptyMsg = '还没有搜索结果。';
      render();
      var more = songs.length > results.length ?
        '（共 ' + songs.length + ' 条，显示前 ' + results.length + ' 条）' : '';
      var breakdown = isAll ? sourceBreakdown(d.counts) : '';
      setStatus('「' + label + '」找到 ' + results.length + ' 首' + more +
        (breakdown ? '：' + breakdown : '') +
        '，点「' + DL_LABEL + '」由浏览器直连 CDN。');
    }).catch(function () {
      results = [];
      emptyMsg = '检索服务暂不可用，请稍后重试。';
      render();
      setStatus(MSG_DOWN, 'err');
    }).then(function () {
      unlock();
    });
  }

  function bindResults() {
    var box = $('mf-results');
    if (!box) return;
    // 事件委托只绑定一次：错误区域的「换源搜索」按钮不重复监听
    box.addEventListener('click', function (e) {
      var node = e.target;
      var cls = node && node.className ? String(node.className) : '';
      if (cls.split(/\s+/).indexOf('mf-retry') === -1) return;
      retryRow(parentRow(node));
    });
  }

  function init() {
    buildSourceSelect();
    bindResults();
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
    setStatus('默认「' + ALL_LABEL + '」：输入关键词后回车或点「搜索」；服务器只做搜索与直链解析，音频由浏览器直连 CDN。');
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
