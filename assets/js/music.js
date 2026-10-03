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
  var embedLyricsToggle = document.getElementById('music-embed-lyrics');
  var results = [];
  var lyricQueue = [];
  var lyricActive = 0;
  var lyricLimit = 3;

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

  function embedLyricsEnabled() {
    return !!(embedLyricsToggle && embedLyricsToggle.checked);
  }

  function drainLyricQueue() {
    while (lyricActive < lyricLimit && lyricQueue.length) {
      var task = lyricQueue.shift();
      lyricActive++;
      Promise.resolve().then(task.run).then(task.done, task.fail).then(function () {
        lyricActive--;
        drainLyricQueue();
      }, function () {
        lyricActive--;
        drainLyricQueue();
      });
    }
  }

  function enqueueLyricMatch(run) {
    return new Promise(function (resolve, reject) {
      lyricQueue.push({ run: run, done: resolve, fail: reject });
      drainLyricQueue();
    });
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

  function concatBytes(parts) {
    var total = 0, offset = 0;
    parts.forEach(function (part) { total += part.length; });
    var out = new Uint8Array(total);
    parts.forEach(function (part) { out.set(part, offset); offset += part.length; });
    return out;
  }

  function syncSafe(n) {
    return new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  }

  function id3Frame(id, payload) {
    var head = new Uint8Array(10);
    for (var i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
    head.set(syncSafe(payload.length), 4);
    return concatBytes([head, payload]);
  }

  function preservedId3Frames(u8) {
    var frames = [];
    if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return frames;
    var major = u8[3];
    if ((major !== 3 && major !== 4) || (u8[5] & 0x80)) return frames;
    var tagSize = (u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9];
    var footerSize = (major === 4 && (u8[5] & 0x10)) ? 10 : 0;
    var end = Math.min(u8.length, 10 + tagSize - footerSize), pos = 10;
    if (u8[5] & 0x40) {
      if (pos + 4 > end) return frames;
      var extSize = major === 4 ? ((u8[pos] << 21) | (u8[pos + 1] << 14) | (u8[pos + 2] << 7) | u8[pos + 3]) :
        ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]);
      pos += major === 4 ? extSize : extSize + 4;
    }
    while (pos + 10 <= end) {
      var id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      var size = major === 4 ? ((u8[pos + 4] << 21) | (u8[pos + 5] << 14) | (u8[pos + 6] << 7) | u8[pos + 7]) :
        ((u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7]);
      if (size <= 0 || pos + 10 + size > end) break;
      var payload = u8.slice(pos + 10, pos + 10 + size);
      var keep = id !== 'TIT2' && id !== 'TPE1' && id !== 'TALB' && id !== 'USLT';
      if (id === 'TXXX' && payload.length > 1) {
        var textEnd = 1;
        if (payload[0] === 1 || payload[0] === 2) {
          while (textEnd + 1 < payload.length && (payload[textEnd] !== 0 || payload[textEnd + 1] !== 0)) textEnd += 2;
          textEnd += 2;
        } else {
          while (textEnd < payload.length && payload[textEnd] !== 0) textEnd++;
        }
        try {
          var label = new TextDecoder(payload[0] === 1 ? 'utf-16' : (payload[0] === 2 ? 'utf-16be' : 'utf-8')).decode(payload.slice(1, textEnd)).toUpperCase();
          if (label === 'LYRICS') keep = false;
        } catch (e) { /* keep unknown text frames */ }
      }
      if (keep) frames.push(id3Frame(id, payload));
      pos += 10 + size;
    }
    return frames;
  }

  function utf8(s) { return new TextEncoder().encode(String(s || '')); }

  function stripId3(u8) {
    if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return u8;
    var size = (u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9];
    var end = Math.min(u8.length, 10 + size + ((u8[5] & 0x10) ? 10 : 0));
    return u8.slice(end);
  }

  function embedMp3Lyrics(u8, item, lyric) {
    var r = item.result;
    var uslt = concatBytes([new Uint8Array([3, 0x65, 0x6e, 0x67, 0]), utf8(lyric)]);
    var txxx = concatBytes([new Uint8Array([3]), utf8('LYRICS'), new Uint8Array([0]), utf8(lyric)]);
    var frames = preservedId3Frames(u8).concat([
      id3Frame('TIT2', concatBytes([new Uint8Array([3]), utf8(r.name)])),
      id3Frame('TPE1', concatBytes([new Uint8Array([3]), utf8(r.artists)])),
      id3Frame('TALB', concatBytes([new Uint8Array([3]), utf8(r.album)])),
      id3Frame('USLT', uslt),
      id3Frame('TXXX', txxx)
    ]);
    var body = concatBytes(frames);
    var header = new Uint8Array(10);
    header.set([0x49, 0x44, 0x33, 4, 0, 0], 0);
    header.set(syncSafe(body.length), 6);
    return new Blob([concatBytes([header, body, stripId3(u8)])], { type: 'audio/mpeg' });
  }

  function readLe32(u8, at) {
    return (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;
  }

  function writeLe32(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }

  function makeVorbisComment(item, lyric) {
    var r = item.result;
    var comments = [];
    if (r.name) comments.push('TITLE=' + r.name);
    if (r.artists) comments.push('ARTIST=' + r.artists);
    if (r.album) comments.push('ALBUM=' + r.album);
    comments.push('LYRICS=' + lyric);
    var vendor = utf8('LOCALTOOLS');
    var parts = [writeLe32(vendor.length), vendor, writeLe32(comments.length)];
    comments.forEach(function (comment) {
      var bytes = utf8(comment);
      parts.push(writeLe32(bytes.length), bytes);
    });
    return concatBytes(parts);
  }

  function embedFlacLyrics(u8, item, lyric) {
    if (u8.length < 4 || u8[0] !== 0x66 || u8[1] !== 0x4c || u8[2] !== 0x61 || u8[3] !== 0x43) {
      throw new Error('不是有效的 FLAC 文件');
    }
    var blocks = [], offset = 4, foundComment = false, lastBlockSeen = false;
    while (offset + 4 <= u8.length) {
      var h = u8[offset], type = h & 0x7f, last = !!(h & 0x80);
      var len = (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3];
      if (offset + 4 + len > u8.length) throw new Error('FLAC 元数据块长度异常');
      if (type === 4) {
        if (!foundComment) blocks.push({ type: 4, data: makeVorbisComment(item, lyric) });
        foundComment = true;
      } else {
        blocks.push({ type: type, data: u8.slice(offset + 4, offset + 4 + len) });
      }
      offset += 4 + len;
      if (last) { lastBlockSeen = true; break; }
    }
    if (!lastBlockSeen) throw new Error('FLAC 元数据块缺少结束标记');
    if (!foundComment) blocks.push({ type: 4, data: makeVorbisComment(item, lyric) });
    var out = [new Uint8Array([0x66, 0x4c, 0x61, 0x43])];
    blocks.forEach(function (block, i) {
      var h = new Uint8Array(4), len = block.data.length;
      if (len > 0xffffff) throw new Error('内嵌歌词超过 FLAC 元数据块上限');
      h[0] = (i === blocks.length - 1 ? 0x80 : 0) | (block.type & 0x7f);
      h[1] = (len >>> 16) & 0xff; h[2] = (len >>> 8) & 0xff; h[3] = len & 0xff;
      out.push(h, block.data);
    });
    out.push(u8.slice(offset));
    return new Blob([concatBytes(out)], { type: 'audio/flac' });
  }

  async function downloadAudio(item, forceEmbed) {
    var blob = item.result.audioBlob;
    if ((forceEmbed || embedLyricsEnabled()) && item.lyric && (item.result.format === 'mp3' || item.result.format === 'flac')) {
      var bytes = new Uint8Array(await blob.arrayBuffer());
      blob = item.result.format === 'mp3' ? embedMp3Lyrics(bytes, item, item.lyric) : embedFlacLyrics(bytes, item, item.lyric);
    }
    TB.download(blob, outputFilename(item));
  }

  window.MusicDecrypt.embedLyrics = function (format, bytes, item, lyric) {
    if (format === 'mp3') return embedMp3Lyrics(bytes, item, lyric);
    if (format === 'flac') return embedFlacLyrics(bytes, item, lyric);
    throw new Error('只有 MP3 和 FLAC 支持内嵌歌词');
  };

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
        autoFetchLyric(box, meta.name || '', meta.artists || '', item);
      }
    });
  }

  function updateToolbar() {
    toolbar.classList.toggle('hidden', results.length === 0);
    var ok = results.filter(function (r) { return r.ok; }).length;
    var failed = results.length - ok;
    var lyricOk = results.filter(function (r) { return r.lyric; }).length;
    stats.textContent = results.length + ' 个文件 / 解密成功 ' + ok + ' 个 / 失败 ' + failed + ' 个 / 歌词匹配 ' + lyricOk + ' 个';
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
      if (meta && meta.name) autoFetchLyric(div.querySelector('.music-lyric-box'), meta.name, meta.artists || '', item);
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
    div.querySelector('button').addEventListener('click', async function (e) {
      e.currentTarget.disabled = true;
      try { await downloadAudio(item, false); }
      catch (err) { notifyFn('下载失败：' + err.message); }
      e.currentTarget.disabled = false;
    });
    autoFetchLyric(div.querySelector('.music-lyric-box'), title, r.artists, item);
    return div;
  }

  /* 解密完成后自动用识别到的歌名/歌手去匹配歌词，省去手动跳转歌词页再输入一遍 */
  function autoFetchLyric(box, title, artist, item) {
    if (!box || !title || !window.LyricsTool || !lyricsEnabled()) return;
    box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词匹配中…</div>';
    enqueueLyricMatch(function () {
      return lyricsEnabled() ? window.LyricsTool.match(title, artist || '') : null;
    }).then(function (matched) {
      if (!lyricsEnabled()) { box.innerHTML = ''; return; }
      var best = matched && matched.item;
      var lyric = matched && matched.lyric;
      if (!best || !lyric) {
        box.innerHTML = '<div class="muted mono" style="font-size:11.5px">未找到可下载歌词（已自动尝试备用源）</div>';
        return;
      }
      if (item) {
        item.lyric = lyric;
        item.lyricItem = best;
        updateToolbar();
      }
      box.innerHTML =
        '<div class="row" style="margin:0;gap:6px">' +
        '<span class="tag-dim tag" style="margin-left:0">歌词：' + escapeHtml(best.name) +
        (best.artist ? ' - ' + escapeHtml(best.artist) : '') + '</span>' +
        '<span class="muted mono" style="font-size:11.5px">已匹配</span></div>' +
        '<div class="music-lyric-result" style="margin-top:6px">' +
        '<div class="lyric-preview" style="max-height:120px">' + escapeHtml(lyric.slice(0, 1500)) + '</div>' +
        '<button class="btn" type="button" style="margin-top:6px;padding:4px 10px;font-size:12px" data-act="dl-lrc">下载 LRC</button>' +
        ((item && item.ok && (item.result.format === 'mp3' || item.result.format === 'flac')) ?
          ' <button class="btn btn-primary" type="button" style="margin-top:6px;padding:4px 10px;font-size:12px" data-act="embed">内嵌歌词并下载</button>' : '') +
        '</div>';
      var lrcBtn = box.querySelector('[data-act="dl-lrc"]');
      if (lrcBtn) lrcBtn.addEventListener('click', function () {
        var fname = window.LyricsTool.safeLrcName(best.name, best.artist);
        TB.download(new Blob(['\ufeff' + lyric], { type: 'text/plain;charset=utf-8' }), fname);
      });
      var embedBtn = box.querySelector('[data-act="embed"]');
      if (embedBtn) embedBtn.addEventListener('click', async function (e) {
        var button = e.currentTarget;
        button.disabled = true;
        try { await downloadAudio(item, true); }
        catch (err) { box.querySelector('.music-lyric-result').insertAdjacentHTML('beforeend', '<div class="err mono">内嵌失败：' + escapeHtml(err.message) + '</div>'); }
        button.disabled = false;
      });
    }, function () {
      if (!lyricsEnabled()) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词匹配失败，已尝试网易云和备用歌词源</div>';
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
    var skipped = files.length - queue.length;
    if (skipped) notifyFn('上传 ' + files.length + ' 个文件，识别到 ' + queue.length + ' 个支持格式；跳过 ' + skipped + ' 个不支持的文件。');
    var batchResults = [];
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
      batchResults.push(item);
      list.appendChild(renderItem(item));
      updateToolbar();
    }
    var success = batchResults.filter(function (r) { return r.ok; }).length;
    notifyFn('解密完成：' + success + '/' + queue.length + ' 成功。歌词匹配会继续进行，匹配数见结果栏；不支持格式跳过 ' + skipped + ' 个。');
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

  document.getElementById('music-download-all').addEventListener('click', async function (e) {
    var button = e.currentTarget;
    var ok = results.filter(function (item) { return item.ok; });
    if (!ok.length) return;
    if (!embedLyricsEnabled()) {
      ok.forEach(function (item) { TB.download(item.result.audioBlob, outputFilename(item)); });
      return;
    }
    button.disabled = true;
    notifyFn('正在准备批量下载…');
    try {
      var entries = [];
      for (var i = 0; i < ok.length; i++) {
        var item = ok[i], blob = item.result.audioBlob;
        if (item.lyric && (item.result.format === 'mp3' || item.result.format === 'flac')) {
          var bytes = new Uint8Array(await blob.arrayBuffer());
          blob = item.result.format === 'mp3' ? embedMp3Lyrics(bytes, item, item.lyric) : embedFlacLyrics(bytes, item, item.lyric);
        }
        entries.push({ name: outputFilename(item), blob: blob });
      }
      var zip = await TB.zip(entries);
      TB.download(zip, 'music-with-lyrics-' + Date.now() + '.zip');
      notifyFn('已打包 ' + ok.length + ' 首；匹配到歌词 ' + ok.filter(function (item) { return !!item.lyric; }).length + ' 首');
    } catch (err) { notifyFn('批量下载失败：' + err.message); }
    button.disabled = false;
  });

  document.getElementById('music-zip').addEventListener('click', async function (e) {
    var ok = results.filter(function (r) { return r.ok; });
    if (!ok.length) return;
    var btn = e.currentTarget;
    btn.disabled = true;
    notifyFn('正在打包 ' + ok.length + ' 个文件…');
    try {
      var entries = [];
      for (var i = 0; i < ok.length; i++) {
        var item = ok[i], blob = item.result.audioBlob;
        if (embedLyricsEnabled() && item.lyric && (item.result.format === 'mp3' || item.result.format === 'flac')) {
          var bytes = new Uint8Array(await blob.arrayBuffer());
          blob = item.result.format === 'mp3' ? embedMp3Lyrics(bytes, item, item.lyric) : embedFlacLyrics(bytes, item, item.lyric);
        }
        entries.push({ name: outputFilename(item), blob: blob });
      }
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
