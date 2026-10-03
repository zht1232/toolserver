/* 音乐解密框架：统一的格式识别、批量处理与结果列表
 * 各格式模块通过 MusicDecrypt.register(扩展名数组, 处理函数) 注册。
 * 处理函数签名：(arrayBuffer, 文件名) => Promise<结果对象>
 * 结果对象：{ name, artists, album, format, source, audioBlob, coverBlob }
 * 所有解密均在浏览器内存中完成，文件不上传。
 */
(function () {
  'use strict';

  var handlers = [];
  var notifyFn = function () {};

  window.MusicDecrypt = {
    register: function (exts, fn) {
      handlers.push({ exts: exts.map(function (e) { return e.toLowerCase(); }), fn: fn });
    },
    find: function (ext) {
      for (var i = 0; i < handlers.length; i++) {
        if (handlers[i].exts.indexOf(ext) !== -1) return handlers[i].fn;
      }
      return null;
    },
    notify: function (msg) { notifyFn(msg); },
    supported: function () {
      var all = [];
      handlers.forEach(function (h) { all = all.concat(h.exts); });
      return all;
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 音频格式嗅探（依据文件内容而非扩展名） */
  function sniffFormat(u8) {
    if (!u8 || u8.length < 8) return '';
    var s = function (o, n) {
      var r = '';
      for (var i = 0; i < n; i++) r += String.fromCharCode(u8[o + i]);
      return r;
    };
    if (s(0, 4) === 'fLaC') return 'flac';
    if (s(0, 4) === 'OggS') return 'ogg';
    if (s(0, 3) === 'ID3') return 'mp3';
    if (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0) return 'mp3';
    if (s(4, 4) === 'ftyp') return 'm4a';
    if (s(0, 4) === 'RIFF') return 'wav';
    if (s(0, 3) === 'ADT') return 'aac';
    return '';
  }
  window.MusicDecrypt.sniffFormat = sniffFormat;

  /* ID3v2 标签解析（MP3） */
  function decodeText(bytes, enc) {
    if (enc === 0) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    var label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
    try { return new TextDecoder(label).decode(bytes); } catch (e) { return ''; }
  }

  function parseID3(u8) {
    var out = { title: '', artist: '', album: '', coverBlob: null };
    if (u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return out;
    var major = u8[3];
    var size = (u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9];
    var pos = 10, end = Math.min(10 + size, u8.length);
    while (pos + 10 <= end) {
      var id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      var fsize;
      if (major >= 4) {
        fsize = (u8[pos + 4] << 21) | (u8[pos + 5] << 14) | (u8[pos + 6] << 7) | u8[pos + 7];
      } else {
        fsize = (u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7];
      }
      if (fsize <= 0 || pos + 10 + fsize > u8.length) break;
      var data = u8.slice(pos + 10, pos + 10 + fsize);
      if (id === 'TIT2') out.title = decodeText(data.slice(1), data[0]).replace(/\0.*$/, '').trim();
      else if (id === 'TPE1') out.artist = decodeText(data.slice(1), data[0]).replace(/\0.*$/, '').trim();
      else if (id === 'TALB') out.album = decodeText(data.slice(1), data[0]).replace(/\0.*$/, '').trim();
      else if (id === 'APIC') {
        var enc = data[0], p = 1;
        while (p < data.length && data[p] !== 0) p++;
        var mime = '';
        for (var i = 1; i < p; i++) mime += String.fromCharCode(data[i]);
        p += 2;
        if (enc === 1 || enc === 2) {
          while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
          p += 2;
        } else {
          while (p < data.length && data[p] !== 0) p++;
          p++;
        }
        if (p < data.length) out.coverBlob = new Blob([data.slice(p)], { type: mime || 'image/jpeg' });
      }
      pos += 10 + fsize;
    }
    return out;
  }

  /* FLAC 标签解析 */
  function parseFlac(u8) {
    var out = { title: '', artist: '', album: '', coverBlob: null };
    var pos = 4;
    while (pos + 4 <= u8.length) {
      var isLast = (u8[pos] & 0x80) !== 0;
      var type = u8[pos] & 0x7f;
      var len = (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3];
      var d = u8.slice(pos + 4, pos + 4 + len);
      if (type === 4) {
        var p = 0;
        var vlen = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24); p += 4 + vlen;
        var count = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24); p += 4;
        for (var i = 0; i < count && p + 4 <= d.length; i++) {
          var clen = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24); p += 4;
          var field = new TextDecoder('utf-8').decode(d.slice(p, p + clen)); p += clen;
          var eq = field.indexOf('=');
          if (eq < 0) continue;
          var k = field.slice(0, eq).toUpperCase(), v = field.slice(eq + 1).trim();
          if (k === 'TITLE' && !out.title) out.title = v;
          else if (k === 'ARTIST' && !out.artist) out.artist = v;
          else if (k === 'ALBUM' && !out.album) out.album = v;
        }
      } else if (type === 6) {
        var q = 0;
        var rd32 = function () { var v = (d[q] << 24) | (d[q + 1] << 16) | (d[q + 2] << 8) | d[q + 3]; q += 4; return v >>> 0; };
        rd32();
        var mlen = rd32();
        var mime = new TextDecoder('utf-8').decode(d.slice(q, q + mlen)); q += mlen;
        var dlen = rd32(); q += dlen;
        q += 16;
        var ilen = rd32();
        if (q + ilen <= d.length) out.coverBlob = new Blob([d.slice(q, q + ilen)], { type: mime || 'image/jpeg' });
      }
      pos += 4 + len;
      if (isLast) break;
    }
    return out;
  }

  window.MusicDecrypt.parseID3 = parseID3;
  window.MusicDecrypt.parseFlac = parseFlac;

  /* ================= UI ================= */

  var drop = document.getElementById('music-drop');
  var input = document.getElementById('music-input');
  var list = document.getElementById('music-list');
  var toolbar = document.getElementById('music-toolbar');
  var stats = document.getElementById('music-stats');
  var logBox = document.getElementById('music-log');
  var decryptToggle = document.getElementById('music-enable-decrypt');
  var lyricsToggle = document.getElementById('music-enable-lyrics');
  var decryptPanel = document.getElementById('music-decrypt-panel');
  var lyricsPanel = document.getElementById('music-lyrics-panel');
  var nameOrder = document.getElementById('music-name-order');
  var results = [];

  notifyFn = function (msg) {
    if (logBox) logBox.textContent = msg || '';
  };

  function getExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
  }

  function lyricsEnabled() {
    return !lyricsToggle || lyricsToggle.checked;
  }

  function defaultOutputName(title, artist) {
    var mode = nameOrder ? nameOrder.value : 'title-artist';
    if (mode === 'title') return title;
    if (mode === 'artist-title') return artist ? artist + ' - ' + title : title;
    return title + (artist ? ' - ' + artist : '');
  }

  function outputFilename(item) {
    var r = item.result;
    var title = r.name || item.fileName.replace(/\.[^.]+$/, '');
    var base = TB.safeName(item.outputName || defaultOutputName(title, r.artists || ''));
    var ext = String(r.format || 'mp3').toLowerCase();
    if (base.toLowerCase().slice(-(ext.length + 1)) === '.' + ext) base = base.slice(0, -(ext.length + 1));
    return base + '.' + ext;
  }

  function refreshOutputNames() {
    results.forEach(function (item) {
      if (!item.ok || item.nameCustomized) return;
      var title = item.result.name || item.fileName.replace(/\.[^.]+$/, '');
      item.outputName = defaultOutputName(title, item.result.artists || '');
      var inputEl = item.row && item.row.querySelector('.music-output-name');
      if (inputEl) inputEl.value = item.outputName;
    });
  }

  function updateFeaturePanels() {
    if (decryptPanel && decryptToggle) decryptPanel.classList.toggle('hidden', !decryptToggle.checked);
    var enabled = lyricsEnabled();
    if (lyricsPanel) lyricsPanel.classList.toggle('hidden', !enabled);
    document.querySelectorAll('.music-lyric-box').forEach(function (box) {
      box.classList.toggle('hidden', !enabled);
      if (!enabled) box.innerHTML = '';
    });
    if (!enabled) return;
    results.forEach(function (item) {
      var meta = item.ok ? item.result : item.musicMeta;
      var box = item.row && item.row.querySelector('.music-lyric-box');
      if (meta && box && !box.textContent.trim()) {
        autoFetchLyric(box, meta.name || '', meta.artists || '');
      }
    });
  }

  function updateToolbar() {
    toolbar.classList.toggle('hidden', results.length === 0);
    var ok = results.filter(function (r) { return r.ok; }).length;
    stats.textContent = results.length + ' 个文件 / 成功 ' + ok + ' 个';
  }

  function renderItem(item) {
    var div = document.createElement('div');
    div.className = 'filerow';
    if (!item.ok) {
      var meta = item.musicMeta;
      div.innerHTML =
        '<div class="filerow-main"><div class="filerow-name">' + escapeHtml(item.fileName) + '</div>' +
        '<div class="filerow-sub err">' + escapeHtml(item.error) + '</div>' +
        (meta && meta.name ? '<div class="filerow-sub">已读取：' + escapeHtml(meta.name) +
          (meta.artists ? ' · ' + escapeHtml(meta.artists) : '') + '</div><div class="music-lyric-box"></div>' : '') +
        '</div>';
      item.row = div;
      if (meta && meta.name) autoFetchLyric(div.querySelector('.music-lyric-box'), meta.name, meta.artists || '');
      return div;
    }
    var r = item.result;
    var title = r.name || item.fileName.replace(/\.[^.]+$/, '');
    if (!item.outputName) item.outputName = defaultOutputName(title, r.artists || '');
    var cover = r.coverBlob
      ? '<img class="filerow-cover" src="' + URL.createObjectURL(r.coverBlob) + '" alt="">'
      : '<div class="filerow-cover empty"></div>';
    var sub = [r.artists, r.album].filter(Boolean).join(' · ');
    div.innerHTML =
      cover +
      '<div class="filerow-main">' +
      '<div class="filerow-name">' + escapeHtml(title) +
      '<span class="tag">' + escapeHtml(r.format.toUpperCase()) + '</span>' +
      '<span class="tag tag-dim">' + escapeHtml(r.source) + '</span></div>' +
      '<div class="filerow-sub">' + escapeHtml(sub) + (sub ? ' · ' : '') + TB.formatSize(r.audioBlob.size) + '</div>' +
      '<div class="music-rename"><span class="mono muted">导出文件名</span>' +
      '<input type="text" class="input music-output-name" value="' + escapeHtml(item.outputName) + '" aria-label="导出文件名（不含扩展名）"></div>' +
      '<audio controls preload="none" src="' + URL.createObjectURL(r.audioBlob) + '"></audio>' +
      '<div class="music-lyric-box" style="margin-top:8px"></div>' +
      '</div>' +
      '<div class="filerow-actions"><button class="btn btn-primary" type="button">下载</button></div>';
    item.row = div;
    div.querySelector('.music-output-name').addEventListener('input', function (e) {
      item.outputName = e.currentTarget.value;
      item.nameCustomized = true;
    });
    div.querySelector('button').addEventListener('click', function () {
      TB.download(r.audioBlob, outputFilename(item));
    });
    autoFetchLyric(div.querySelector('.music-lyric-box'), title, r.artists);
    return div;
  }

  /* 解密完成后自动用识别到的歌名/歌手去匹配歌词，省去手动跳转歌词页再输入一遍 */
  function autoFetchLyric(box, title, artist) {
    if (!box || !title || !window.LyricsTool || !lyricsEnabled()) return;
    box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词匹配中…</div>';
    window.LyricsTool.search(title, artist || '').then(function (list) {
      if (!lyricsEnabled()) { box.innerHTML = ''; return; }
      if (!list || !list.length) {
        box.innerHTML = '<div class="muted mono" style="font-size:11.5px">未找到匹配歌词</div>';
        return;
      }
      var best = list[0];
      box.innerHTML =
        '<div class="row" style="margin:0;gap:6px">' +
        '<span class="tag-dim tag" style="margin-left:0">歌词：' + escapeHtml(best.name) +
        (best.artist ? ' - ' + escapeHtml(best.artist) : '') + '</span>' +
        '<button class="btn" type="button" data-act="load-lrc" style="padding:3px 9px;font-size:11.5px">载入并下载 LRC</button>' +
        '</div><div class="music-lyric-result" style="margin-top:6px"></div>';
      box.querySelector('[data-act="load-lrc"]').addEventListener('click', async function (e) {
        var btn = e.currentTarget;
        var resultBox = box.querySelector('.music-lyric-result');
        btn.disabled = true;
        resultBox.innerHTML = '<div class="muted mono" style="font-size:11.5px">加载中…</div>';
        try {
          var lyric = await window.LyricsTool.fetchLyric(best);
          if (!lyric) {
            resultBox.innerHTML = '<div class="muted mono" style="font-size:11.5px">该歌曲暂无同步歌词</div>';
          } else {
            var fname = window.LyricsTool.safeLrcName(best.name, best.artist);
            resultBox.innerHTML =
              '<div class="lyric-preview" style="max-height:120px">' + escapeHtml(lyric.slice(0, 1500)) + '</div>' +
              '<button class="btn btn-primary" type="button" style="margin-top:6px;padding:4px 10px;font-size:12px" data-act="dl-lrc">下载 ' + escapeHtml(fname) + '</button>';
            resultBox.querySelector('[data-act="dl-lrc"]').addEventListener('click', function () {
              TB.download(new Blob(['\ufeff' + lyric], { type: 'text/plain;charset=utf-8' }), fname);
            });
          }
        } catch (err) {
          resultBox.innerHTML = '<div class="err mono" style="font-size:11.5px">歌词加载失败：' + escapeHtml(err.message) + '</div>';
        }
        btn.disabled = false;
      });
    }).catch(function () {
      if (!lyricsEnabled()) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词匹配失败，可在本页歌词区域手动重试</div>';
    });
  }

  async function handleFiles(files) {
    var supported = MusicDecrypt.supported();
    var queue = [];
    for (var i = 0; i < files.length; i++) {
      if (supported.indexOf(getExt(files[i].name)) !== -1) queue.push(files[i]);
    }
    if (!queue.length) {
      notifyFn('未识别到受支持的加密音乐文件。支持：' + supported.map(function (e) { return '.' + e; }).join(' '));
      return;
    }
    for (i = 0; i < queue.length; i++) {
      var f = queue[i];
      notifyFn('[' + (i + 1) + '/' + queue.length + '] 正在解密 ' + f.name);
      var item = { fileName: f.name, ok: false };
      try {
        var handler = MusicDecrypt.find(getExt(f.name));
        var buf = await f.arrayBuffer();
        item.result = await handler(buf, f.name);
        if (!item.result.audioBlob || item.result.audioBlob.size === 0) throw new Error('解密结果为空，文件可能已损坏');
        item.ok = true;
      } catch (e) {
        item.error = (e && e.message) || '解密失败';
        item.musicMeta = e && e.musicMeta ? e.musicMeta : null;
      }
      results.push(item);
      list.appendChild(renderItem(item));
      updateToolbar();
    }
    notifyFn('完成：' + queue.length + ' 个文件');
  }

  input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
  drop.addEventListener('click', function (e) {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') input.click();
  });
  TB.bindDropzone(drop, handleFiles);

  document.getElementById('music-clear').addEventListener('click', function () {
    results = [];
    list.innerHTML = '';
    updateToolbar();
    notifyFn('');
  });

  document.getElementById('music-download-all').addEventListener('click', function () {
    results.forEach(function (item) {
      if (!item.ok) return;
      TB.download(item.result.audioBlob, outputFilename(item));
    });
  });

  document.getElementById('music-zip').addEventListener('click', async function (e) {
    var ok = results.filter(function (r) { return r.ok; });
    if (!ok.length) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    notifyFn('正在打包 ' + ok.length + ' 个文件…');
    try {
      var entries = ok.map(function (item) {
        return {
          name: outputFilename(item),
          blob: item.result.audioBlob
        };
      });
      var zip = await TB.zip(entries);
      TB.download(zip, 'music-' + Date.now() + '.zip');
      notifyFn('打包完成（' + TB.formatSize(zip.size) + '）');
    } catch (err) {
      notifyFn('打包失败：' + err.message);
    }
    btn.disabled = false;
  });

  if (decryptToggle) decryptToggle.addEventListener('change', updateFeaturePanels);
  if (lyricsToggle) lyricsToggle.addEventListener('change', updateFeaturePanels);
  if (nameOrder) nameOrder.addEventListener('change', refreshOutputNames);
  updateFeaturePanels();
})();
