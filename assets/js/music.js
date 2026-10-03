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

  async function readLyricFile(file) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.slice(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.slice(2));
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.slice(3);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (utf8Error) {
      try { return new TextDecoder('gb18030').decode(bytes); }
      catch (encodingError) { throw new Error('歌词编码无法识别，请另存为 UTF-8 后重试'); }
    }
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

  function uniqueFilename(name, used) {
    var dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '', candidate = name, suffix = 2;
    while (used[candidate.toLowerCase()]) candidate = stem + ' (' + suffix++ + ')' + ext;
    used[candidate.toLowerCase()] = true;
    return candidate;
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
    head[4] = (payload.length >>> 24) & 0xff;
    head[5] = (payload.length >>> 16) & 0xff;
    head[6] = (payload.length >>> 8) & 0xff;
    head[7] = payload.length & 0xff;
    return concatBytes([head, payload]);
  }

  function preservedId3Frames(u8, replacingLyrics) {
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
      if (id === 'APIC' && major === 4) {
        var converted = convertApicToId3v23(payload);
        if (converted) frames.push(id3Frame('APIC', converted));
      } else if (major === 3) {
        var lyricFrame = /^(?:USLT|SYLT)$/.test(id) || (id === 'TXXX' && id3TxxxDescription(payload) === 'LYRICS');
        var replacedFrame = /^(?:TIT2|TPE1|TALB)$/.test(id) || (replacingLyrics && lyricFrame);
        if (!replacedFrame) frames.push(u8.slice(pos, pos + 10 + size));
      }
      pos += 10 + size;
    }
    return frames;
  }

  function id3TxxxDescription(payload) {
    if (!payload.length) return '';
    var encoding = payload[0], end = 1;
    if (encoding === 1 || encoding === 2) {
      while (end + 1 < payload.length && (payload[end] !== 0 || payload[end + 1] !== 0)) end += 2;
      return decodeId3Text(payload.slice(1, end), encoding).replace(/^\ufeff/, '').trim().toUpperCase();
    }
    while (end < payload.length && payload[end] !== 0) end++;
    return decodeId3Text(payload.slice(1, end), encoding).trim().toUpperCase();
  }

  function utf8(s) { return new TextEncoder().encode(String(s || '')); }

  function utf16Le(s, bom) {
    s = String(s || '');
    var out = new Uint8Array((bom ? 2 : 0) + s.length * 2), pos = 0;
    if (bom) { out[0] = 0xff; out[1] = 0xfe; pos = 2; }
    for (var i = 0; i < s.length; i++) {
      var unit = s.charCodeAt(i);
      out[pos++] = unit & 0xff; out[pos++] = unit >>> 8;
    }
    return out;
  }

  function decodeId3Text(data, encoding) {
    try {
      if (encoding === 0) return Array.from(data).map(function (b) { return String.fromCharCode(b); }).join('');
      if (encoding === 1) return new TextDecoder('utf-16').decode(data);
      if (encoding === 2) return new TextDecoder('utf-16be').decode(data);
      return new TextDecoder('utf-8').decode(data);
    } catch (e) { return ''; }
  }

  function convertApicToId3v23(payload) {
    if (payload.length < 5) return null;
    var encoding = payload[0], mimeEnd = 1;
    while (mimeEnd < payload.length && payload[mimeEnd] !== 0) mimeEnd++;
    if (mimeEnd + 2 >= payload.length) return null;
    var mimeBytes = payload.slice(1, mimeEnd), pictureType = payload[mimeEnd + 1], descStart = mimeEnd + 2, descEnd = descStart;
    if (encoding === 1 || encoding === 2) {
      while (descEnd + 1 < payload.length && (payload[descEnd] !== 0 || payload[descEnd + 1] !== 0)) descEnd += 2;
      descEnd = Math.min(payload.length, descEnd + 2);
    } else {
      while (descEnd < payload.length && payload[descEnd] !== 0) descEnd++;
      descEnd = Math.min(payload.length, descEnd + 1);
    }
    var description = decodeId3Text(payload.slice(descStart, Math.max(descStart, descEnd - ((encoding === 1 || encoding === 2) ? 2 : 1))), encoding);
    var image = payload.slice(descEnd);
    var head = new Uint8Array([1]);
    var mimeAndType = concatBytes([mimeBytes, new Uint8Array([0, pictureType])]);
    return concatBytes([head, mimeAndType, utf16Le(description, true), new Uint8Array([0, 0]), image]);
  }

  function utf16TextFrame(id, value) {
    return id3Frame(id, concatBytes([new Uint8Array([1]), utf16Le(value, true)]));
  }

  function normalizeCoverMime(mime, bytes) {
    if (/^image\/(?:jpeg|png|gif|webp)$/i.test(String(mime || ''))) return String(mime).toLowerCase();
    if (bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes && bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes && bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function makeApicFrame(imageBytes, mime) {
    var description = utf16Le('', true);
    var payload = concatBytes([
      new Uint8Array([1]), utf8(normalizeCoverMime(mime, imageBytes)), new Uint8Array([0, 3]),
      description, new Uint8Array([0, 0]), imageBytes
    ]);
    return id3Frame('APIC', payload);
  }

  function parseLrcEntries(lyric) {
    var entries = [];
    String(lyric || '').split(/\r?\n/).forEach(function (line) {
      var times = [], match, re = /\[(\d+):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
      while ((match = re.exec(line))) {
        var fraction = (match[3] || '0').slice(0, 3);
        while (fraction.length < 3) fraction += '0';
        times.push((parseInt(match[1], 10) * 60 + parseInt(match[2], 10)) * 1000 + parseInt(fraction, 10));
      }
      var text = line.replace(re, '').trim();
      if (!text) return;
      times.forEach(function (time) { entries.push({ time: time, text: text }); });
    });
    return entries;
  }

  function makeSyltFrame(lyric) {
    var entries = parseLrcEntries(lyric);
    if (!entries.length) return null;
    var parts = [new Uint8Array([1, 0x65, 0x6e, 0x67, 2, 1, 0, 0])];
    entries.forEach(function (entry) {
      var time = entry.time >>> 0;
      parts.push(utf16Le(entry.text, true), new Uint8Array([0, 0]), new Uint8Array([(time >>> 24) & 0xff, (time >>> 16) & 0xff, (time >>> 8) & 0xff, time & 0xff]));
    });
    return id3Frame('SYLT', concatBytes(parts));
  }

  function stripId3(u8) {
    if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return u8;
    var size = (u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9];
    var end = Math.min(u8.length, 10 + size);
    return u8.slice(end);
  }

  function embedMp3Lyrics(u8, item, lyric, coverBytes, coverMime) {
    var r = item.result;
    lyric = String(lyric || '');
    var frames = preservedId3Frames(u8, !!lyric).concat([
      utf16TextFrame('TIT2', r.name),
      utf16TextFrame('TPE1', r.artists),
      utf16TextFrame('TALB', r.album)
    ]);
    if (lyric) {
      var plain = lyric.split(/\r?\n/).filter(function (line) {
        return !/^\s*\[(?:ar|ti|al|by|re|ve|offset):/i.test(line);
      }).map(function (line) { return line.replace(/\[\d{1,3}:\d{1,2}(?:\.\d{1,3})?\]/g, '').trim(); }).filter(Boolean).join('\n');
      var uslt = concatBytes([new Uint8Array([1, 0x65, 0x6e, 0x67, 0, 0]), utf16Le(plain, true)]);
      var txxx = concatBytes([new Uint8Array([1]), utf16Le('LYRICS', true), new Uint8Array([0, 0]), utf16Le(lyric, true)]);
      frames.push(id3Frame('USLT', uslt), id3Frame('TXXX', txxx));
      var synced = makeSyltFrame(lyric);
      if (synced) frames.push(synced);
    }
    var hasApic = frames.some(function (frame) {
      return frame.length >= 4 && frame[0] === 0x41 && frame[1] === 0x50 && frame[2] === 0x49 && frame[3] === 0x43;
    });
    if (!hasApic && coverBytes && coverBytes.length) frames.push(makeApicFrame(coverBytes, coverMime));
    var body = concatBytes(frames);
    var header = new Uint8Array(10);
    header.set([0x49, 0x44, 0x33, 3, 0, 0], 0);
    header.set(syncSafe(body.length), 6);
    return new Blob([concatBytes([header, body, stripId3(u8)])], { type: 'audio/mpeg' });
  }

  function readLe32(u8, at) {
    return (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;
  }

  function writeLe32(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }

  function makeVorbisComment(item, lyric, existing) {
    var r = item.result;
    var comments = [], vendor = utf8('LOCALTOOLS');
    if (existing && existing.length >= 8) {
      var offset = 0, vendorLength = readLe32(existing, offset); offset += 4;
      if (offset + vendorLength + 4 > existing.length) throw new Error('FLAC 歌曲标签损坏');
      vendor = existing.slice(offset, offset + vendorLength); offset += vendorLength;
      var count = readLe32(existing, offset); offset += 4;
      if (count > 100000) throw new Error('FLAC 歌曲标签异常');
      for (var i = 0; i < count; i++) {
        if (offset + 4 > existing.length) throw new Error('FLAC 歌曲标签损坏');
        var length = readLe32(existing, offset); offset += 4;
        if (offset + length > existing.length) throw new Error('FLAC 歌曲标签损坏');
        comments.push(new TextDecoder('utf-8').decode(existing.slice(offset, offset + length)));
        offset += length;
      }
      if (offset !== existing.length) throw new Error('FLAC 歌曲标签长度异常');
    }
    var updates = { TITLE: r.name || '', ARTIST: r.artists || '', ALBUM: r.album || '' };
    if (String(lyric || '').trim()) updates.LYRICS = String(lyric);
    comments = comments.filter(function (comment) {
      var eq = comment.indexOf('=');
      if (eq < 0) return true;
      var key = comment.slice(0, eq).toUpperCase();
      return !Object.prototype.hasOwnProperty.call(updates, key) || !updates[key];
    });
    Object.keys(updates).forEach(function (key) {
      if (updates[key]) comments.push(key + '=' + updates[key]);
    });
    var parts = [writeLe32(vendor.length), vendor, writeLe32(comments.length)];
    comments.forEach(function (comment) {
      var bytes = utf8(comment);
      parts.push(writeLe32(bytes.length), bytes);
    });
    return concatBytes(parts);
  }

  function writeBe32(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  }

  function makeFlacPicture(imageBytes, mime) {
    var mimeBytes = utf8(normalizeCoverMime(mime, imageBytes));
    return concatBytes([
      writeBe32(3), writeBe32(mimeBytes.length), mimeBytes,
      writeBe32(0), writeBe32(0), writeBe32(0), writeBe32(0), writeBe32(0),
      writeBe32(imageBytes.length), imageBytes
    ]);
  }

  function embedFlacLyrics(u8, item, lyric, coverBytes, coverMime) {
    if (u8.length < 4 || u8[0] !== 0x66 || u8[1] !== 0x4c || u8[2] !== 0x61 || u8[3] !== 0x43) {
      throw new Error('不是有效的 FLAC 文件');
    }
    var blocks = [], offset = 4, foundComment = false, foundPicture = false, lastBlockSeen = false;
    while (offset + 4 <= u8.length) {
      var h = u8[offset], type = h & 0x7f, last = !!(h & 0x80);
      var len = (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3];
      if (offset + 4 + len > u8.length) throw new Error('FLAC 元数据块长度异常');
      if (type === 4) {
        if (!foundComment) blocks.push({ type: 4, data: makeVorbisComment(item, lyric, u8.slice(offset + 4, offset + 4 + len)) });
        foundComment = true;
      } else {
        if (type === 6) foundPicture = true;
        blocks.push({ type: type, data: u8.slice(offset + 4, offset + 4 + len) });
      }
      offset += 4 + len;
      if (last) { lastBlockSeen = true; break; }
    }
    if (!lastBlockSeen) throw new Error('FLAC 元数据块缺少结束标记');
    if (!foundComment) blocks.push({ type: 4, data: makeVorbisComment(item, lyric) });
    if (!foundPicture && coverBytes && coverBytes.length) blocks.push({ type: 6, data: makeFlacPicture(coverBytes, coverMime) });
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
    if ((forceEmbed || (embedLyricsEnabled() && lyricsEnabled())) && item.lyricState === 'pending' && item.lyricPromise && item.lyricSource !== 'manual') {
      notifyFn('等待这首歌的歌词匹配完成…');
      await item.lyricPromise;
    }
    blob = await addExportMetadata(item, (forceEmbed || embedLyricsEnabled()) ? item.lyric : '');
    TB.download(blob, outputFilename(item));
  }

  async function addExportMetadata(item, lyric) {
    var result = item.result, format = result.format;
    if (format !== 'mp3' && format !== 'flac') return result.audioBlob;
    var coverBlob = result.coverExternal ? result.coverBlob : null;
    if (!lyric && !coverBlob) return result.audioBlob;
    var coverBytes = coverBlob ? new Uint8Array(await coverBlob.arrayBuffer()) : null;
    var audioBytes = new Uint8Array(await result.audioBlob.arrayBuffer());
    if (format === 'mp3') return embedMp3Lyrics(audioBytes, item, lyric || '', coverBytes, coverBlob && coverBlob.type);
    return embedFlacLyrics(audioBytes, item, lyric || '', coverBytes, coverBlob && coverBlob.type);
  }

  window.MusicDecrypt.embedLyrics = function (format, bytes, item, lyric, coverBytes, coverMime) {
    if (format === 'mp3') return embedMp3Lyrics(bytes, item, lyric, coverBytes, coverMime);
    if (format === 'flac') return embedFlacLyrics(bytes, item, lyric, coverBytes, coverMime);
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
    if (!enabled) {
      results.forEach(function (item) { if (item.lyricState === 'pending' && !item.lyricPromise) item.lyricState = 'not-run'; });
      updateToolbar();
      return;
    }
    results.forEach(function (item) {
      var meta = item.ok ? item.result : item.musicMeta;
      var box = item.row && item.row.querySelector('.music-lyric-box');
      if (meta && box && !box.textContent.trim()) {
        if (item.lyricState === 'pending' && item.lyricPromise) {
          box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词匹配中…</div>';
        } else if (item.lyric && (item.lyricSource === 'manual' || item.lyricSource === 'matched')) {
          renderLyricResult(box, item, item.lyricItem, item.lyric, item.lyricSource === 'manual' ? '手动上传' : ((item.lyricItem && item.lyricItem.source) || '已匹配'));
        } else if (item.lyricState === 'not-found') {
          box.innerHTML = '<div class="muted mono" style="font-size:11.5px">未找到可下载歌词（已自动尝试备用源）</div>';
        } else if (item.lyricState === 'error') {
          box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词服务暂不可用；可上传自己的 LRC / TXT</div>';
        }
        else autoFetchLyric(box, meta.name || '', meta.artists || '', item);
      }
    });
  }

  function updateToolbar() {
    toolbar.classList.toggle('hidden', results.length === 0);
    var ok = results.filter(function (r) { return r.ok; }).length;
    var decryptFailed = results.length - ok;
    var lyricMatched = results.filter(function (r) { return r.lyricState === 'matched'; }).length;
    var lyricManual = results.filter(function (r) { return r.lyricState === 'manual'; }).length;
    var lyricPending = results.filter(function (r) { return r.lyricState === 'pending'; }).length;
    var lyricNotFound = results.filter(function (r) { return r.lyricState === 'not-found'; }).length;
    var lyricErrors = results.filter(function (r) { return r.lyricState === 'error'; }).length;
    var lyricNoInfo = results.filter(function (r) {
      var meta = r.ok ? r.result : r.musicMeta;
      return !meta || !meta.name;
    }).length;
    var lyricNotStarted = results.filter(function (r) { return r.lyricState === 'not-run'; }).length;
    stats.textContent = results.length + ' 个文件 · 解密成功 ' + ok + ' · 解密失败 ' + decryptFailed +
      (lyricsEnabled() ? ' · 歌词自动匹配 ' + lyricMatched + ' · 未找到 ' + lyricNotFound + ' · 查询错误 ' + lyricErrors +
        ' · 手动歌词 ' + lyricManual + ' · 匹配中 ' + lyricPending + ' · 缺少曲目信息 ' + lyricNoInfo + ' · 未开始 ' + lyricNotStarted : ' · 自动匹配已关闭 · 手动歌词 ' + lyricManual);
  }

  function renderItem(item) {
    var div = document.createElement('div');
    item.objectUrls = [];
    function previewUrl(blob) {
      var url = URL.createObjectURL(blob);
      item.objectUrls.push(url);
      return url;
    }
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
      ? '<img class="filerow-cover" src="' + previewUrl(r.coverBlob) + '" alt="">'
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
      '<div class="music-lyric-upload-row"><label class="btn">上传 / 更换 LRC 或 TXT<input class="music-lyric-upload" type="file" accept=".lrc,.txt,text/plain" hidden></label>' +
      '<span class="mono muted music-lyric-source">' + (item.lyricSource === 'manual' ? '已使用手动上传歌词' : '') + '</span></div>' +
      '<audio controls preload="none" src="' + previewUrl(r.audioBlob) + '"></audio>' +
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
    div.querySelector('.music-lyric-upload').addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 1024 * 1024) { notifyFn('单个歌词文件不能超过 1 MiB'); return; }
      try {
        item.lyric = await readLyricFile(file);
        if (!item.lyric.trim()) throw new Error('歌词文件为空');
        item.lyricSource = 'manual';
        item.lyricState = 'manual';
        item.lyricItem = { name: r.name || item.fileName.replace(/\.[^.]+$/, ''), artist: r.artists || '' };
        item.lyricPromise = null;
        div.querySelector('.music-lyric-source').textContent = '已载入手动歌词';
        renderLyricResult(div.querySelector('.music-lyric-box'), item, item.lyricItem, item.lyric, '手动上传');
        updateToolbar();
        notifyFn('已载入 ' + file.name + '；下载时将按选项内嵌歌词。');
      } catch (err) { notifyFn('歌词读取失败：' + err.message); }
    });
    autoFetchLyric(div.querySelector('.music-lyric-box'), title, r.artists, item);
    return div;
  }

  /* 解密完成后自动用识别到的歌名/歌手去匹配歌词，省去手动跳转歌词页再输入一遍 */
  function autoFetchLyric(box, title, artist, item) {
    if (!box || !lyricsEnabled()) return;
    if (!title || !window.LyricsTool) {
      if (item) item.lyricState = 'not-run';
      updateToolbar();
      return;
    }
    if (item && item.lyricSource === 'manual' && item.lyric) {
      renderLyricResult(box, item, item.lyricItem, item.lyric, '手动上传');
      return;
    }
    if (item) item.lyricState = 'pending';
    updateToolbar();
    box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词匹配中…</div>';
    var lyricPromise = enqueueLyricMatch(function () {
      return lyricsEnabled() ? window.LyricsTool.match(title, artist || '') : null;
    }).then(function (matched) {
      if (!lyricsEnabled()) { if (item) { item.lyricState = 'not-run'; item.lyricPromise = null; } updateToolbar(); box.innerHTML = ''; return; }
      if (item && item.lyricSource === 'manual' && item.lyric) { item.lyricPromise = null; return; }
      var best = matched && matched.item;
      var lyric = matched && matched.lyric;
      if (!best || !lyric) {
        if (item) { item.lyricState = matched ? 'not-found' : 'not-run'; item.lyricPromise = null; }
        updateToolbar();
        box.innerHTML = '<div class="muted mono" style="font-size:11.5px">未找到可下载歌词（已自动尝试备用源）</div>';
        return;
      }
      if (item) {
        item.lyric = lyric;
        item.lyricItem = best;
        item.lyricSource = 'matched';
        item.lyricState = 'matched';
        item.lyricPromise = null;
        updateToolbar();
      }
      renderLyricResult(box, item, best, lyric, matched.source || best.source || '已匹配');
    }, function () {
      if (!lyricsEnabled()) { if (item) { item.lyricState = 'not-run'; item.lyricPromise = null; } updateToolbar(); box.innerHTML = ''; return; }
      if (item) { item.lyricState = 'error'; item.lyricPromise = null; }
      updateToolbar();
      box.innerHTML = '<div class="muted mono" style="font-size:11.5px">歌词服务暂不可用；可上传自己的 LRC / TXT 重试</div>';
    });
    if (item) item.lyricPromise = lyricPromise;
  }

  function renderLyricResult(box, item, best, lyric, source) {
    if (!box || !best || !lyric) return;
    box.innerHTML =
        '<div class="row" style="margin:0;gap:6px">' +
      '<span class="tag-dim tag" style="margin-left:0">歌词：' + escapeHtml(best.name) +
        (best.artist ? ' - ' + escapeHtml(best.artist) : '') + '</span>' +
        '<span class="muted mono" style="font-size:11.5px">' + escapeHtml(source === 'netease' ? '网易云' : (source === 'lrclib' ? 'LRCLIB' : (source || '已匹配'))) + '</span></div>' +
        '<div class="music-lyric-result" style="margin-top:6px">' +
        '<div class="lyric-preview" style="max-height:120px">' + escapeHtml(lyric.slice(0, 1500)) + '</div>' +
        '<button class="btn" type="button" style="margin-top:6px;padding:4px 10px;font-size:12px" data-act="dl-lyric">单独下载 ' + (/\[\d{1,3}:\d{1,2}(?:\.\d{1,3})?\]/.test(lyric) ? 'LRC' : 'TXT') + '</button></div>';
      var lyricBtn = box.querySelector('[data-act="dl-lyric"]');
      if (lyricBtn) lyricBtn.addEventListener('click', function () {
        var extension = /\[\d{1,3}:\d{1,2}(?:\.\d{1,3})?\]/.test(lyric) ? 'lrc' : 'txt';
        var base = TB.safeName(best.name + (best.artist ? ' - ' + best.artist : ''));
        TB.download(new Blob(['\ufeff' + lyric], { type: 'text/plain;charset=utf-8' }), base + '.' + extension);
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
    results.forEach(function (item) { (item.objectUrls || []).forEach(function (url) { URL.revokeObjectURL(url); }); });
    results = [];
    list.innerHTML = '';
    updateToolbar();
    notifyFn('');
  });

  document.getElementById('music-download-all').addEventListener('click', async function (e) {
    var button = e.currentTarget;
    var ok = results.filter(function (item) { return item.ok; });
    if (!ok.length) return;
    button.disabled = true;
    notifyFn('正在打包 ' + ok.length + ' 首…');
    try {
      if (embedLyricsEnabled() && lyricsEnabled()) {
        var pendingMatches = ok.map(function (item) { return item.lyricPromise; }).filter(Boolean);
        if (pendingMatches.length) {
          notifyFn('正在等待 ' + pendingMatches.length + ' 首歌曲的歌词匹配完成…');
          await Promise.all(pendingMatches);
        }
      }
      var entries = [];
      var usedNames = Object.create(null);
      for (var i = 0; i < ok.length; i++) {
        var item = ok[i], blob = await addExportMetadata(item, embedLyricsEnabled() ? item.lyric : '');
        entries.push({ name: uniqueFilename(outputFilename(item), usedNames), blob: blob });
      }
      var zip = await TB.zip(entries);
      TB.download(zip, 'music-' + Date.now() + '.zip');
      notifyFn('已打包 ' + ok.length + ' 首；已内嵌歌词 ' + (embedLyricsEnabled() ? ok.filter(function (item) { return !!item.lyric && (item.result.format === 'mp3' || item.result.format === 'flac'); }).length : 0) + ' 首');
    } catch (err) { notifyFn('批量下载失败：' + err.message); }
    button.disabled = false;
  });

  if (decryptToggle) decryptToggle.addEventListener('change', updateFeaturePanels);
  if (lyricsToggle) lyricsToggle.addEventListener('change', updateFeaturePanels);
  if (nameOrder) nameOrder.addEventListener('change', refreshOutputNames);
  updateFeaturePanels();
})();
