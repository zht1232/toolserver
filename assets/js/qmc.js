/* QMC 解密（QQ 音乐）
 * 算法移植自 unlock-music（MIT）src/decrypt/qmcMask.ts 与 qmc.ts：
 *   默认掩码（qmc0/2/3/qmcflac/qmcogg/bkcmp3/bkcflac/tkm）：44 字节矩阵展开为 128 字节掩码
 *   mflac / mgg：在前 32 KiB 中按 128 字节步长爆破掩码，用文件头（fLaC / OggS）校验
 *   掩码按 128 字节循环异或，每 0x8000 处跳过一个字节（QQ 音乐的固有特性）
 */
(function () {
  'use strict';

  var QM_DEFAULT_MATRIX = [
    0xde, 0x51, 0xfa, 0xc3, 0x4a, 0xd6, 0xca, 0x90,
    0x7e, 0x67, 0x5e, 0xf7, 0xd5, 0x52, 0x84, 0xd8,
    0x47, 0x95, 0xbb, 0xa1, 0xaa, 0xc6, 0x66, 0x23,
    0x92, 0x62, 0xf3, 0x74, 0xa1, 0x9f, 0xf4, 0xa0,
    0x1d, 0x3f, 0x5b, 0xf0, 0x13, 0x0e, 0x09, 0x3d,
    0xf9, 0xbc, 0x00, 0x11
  ];

  var FLAC_HEADER = [0x66, 0x4c, 0x61, 0x43];
  var OGG_HEADER = [0x4f, 0x67, 0x67, 0x53];

  var QM_OGG_HEADER_1 = [
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
    0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x1e, 0x01, 0x76, 0x6f, 0x72,
    0x62, 0x69, 0x73, 0x00, 0x00, 0x00, 0x00, 0x02, 0x44, 0xac, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xee, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb8, 0x01, 0x4f, 0x67, 0x67, 0x53, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xff];
  var QM_OGG_HEADER_2 = [
    0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0x2c, 0x00, 0x00, 0x00, 0x58, 0x69, 0x70, 0x68, 0x2e,
    0x4f, 0x72, 0x67, 0x20, 0x6c, 0x69, 0x62, 0x56, 0x6f, 0x72, 0x62, 0x69, 0x73, 0x20, 0x49, 0x20,
    0x32, 0x30, 0x31, 0x35, 0x30, 0x31, 0x30, 0x35, 0x20, 0x28, 0xe2, 0x9b, 0x84, 0xe2, 0x9b, 0x84,
    0xe2, 0x9b, 0x84, 0xe2, 0x9b, 0x84, 0x29, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x54,
    0x49, 0x54, 0x4c, 0x45, 0x3d];
  var QM_OGG_CONF_1 = [
    9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 0,
    0, 0, 9, 9, 9, 9, 0, 0, 0, 0, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 6, 3, 3, 3, 3, 6, 6, 6, 6,
    3, 3, 3, 3, 6, 6, 6, 6, 6, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9, 0, 0, 0, 0, 9, 9, 9, 9,
    0, 0, 0, 0];
  var QM_OGG_CONF_2 = [
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 0, 1, 3, 3, 0, 1, 3, 3, 3,
    3, 3, 3, 3, 3];

  /* 128 ↔ 44 索引映射 */
  var AllMapping = [];
  var Mask128to44 = [];
  (function buildMapping() {
    for (var i = 0; i < 128; i++) {
      var realIdx = (i * i + 27) % 256;
      if (AllMapping[realIdx]) AllMapping[realIdx].push(i);
      else AllMapping[realIdx] = [i];
    }
    var idx44 = 0;
    AllMapping.forEach(function (all128) {
      all128.forEach(function (i128) { Mask128to44[i128] = idx44; });
      idx44++;
    });
  })();

  function generate128(matrix44) {
    var matrix128 = [];
    var idx44 = 0;
    AllMapping.forEach(function (it256) {
      it256.forEach(function (m) { matrix128[m] = matrix44[idx44]; });
      idx44++;
    });
    return matrix128;
  }

  function qmcDecrypt(data, matrix128) {
    var dst = data.slice(0);
    var index = -1, maskIdx = -1;
    for (var cur = 0; cur < data.length; cur++) {
      index++; maskIdx++;
      if (index === 0x8000 || (index > 0x8000 && (index + 1) % 0x8000 === 0)) {
        index++; maskIdx++;
      }
      if (maskIdx >= 128) maskIdx -= 128;
      dst[cur] ^= matrix128[maskIdx];
    }
    return dst;
  }

  function hasPrefix(u8, prefix) {
    if (u8.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) if (u8[i] !== prefix[i]) return false;
    return true;
  }

  /* 默认掩码 */
  function defaultMask() {
    return generate128(QM_DEFAULT_MATRIX);
  }

  /* mflac：在前 32 KiB 内按 128 字节步长爆破，用 "fLaC" 文件头校验 */
  function detectMflac(data) {
    var searchLen = Math.min(0x8000, data.length);
    var ref = FLAC_HEADER.join(',');
    for (var idx = 0; idx + 128 <= searchLen; idx += 128) {
      var matrix = Array.from(data.slice(idx, idx + 128));
      if (qmcDecrypt(data.slice(0, 4), matrix).join(',') === ref) return matrix;
    }
    return null;
  }

  /* mgg：基于 Ogg 头部结构反推掩码 */
  function calcMaskFromConfidence(confidence) {
    var keys = Object.keys(confidence);
    if (keys.length === 0) throw new Error('无法匹配掩码');
    var result = 0, conf = -1;
    keys.forEach(function (k) {
      if (confidence[k] > conf) { result = Number(k); conf = confidence[k]; }
    });
    return result;
  }

  function generateOggHeader(page2) {
    var spec = [page2, 0xFF];
    for (var i = 2; i < page2; i++) spec.push(0xFF);
    spec.push(0xFF);
    return QM_OGG_HEADER_1.concat(spec, QM_OGG_HEADER_2);
  }

  function generateOggConf(page2) {
    var specConf = [6, 0];
    for (var i = 2; i < page2; i++) specConf.push(4);
    specConf.push(0);
    return QM_OGG_CONF_1.concat(specConf, QM_OGG_CONF_2);
  }

  function detectMgg(data) {
    if (data.length < 0x100) return null;
    var confidence = [];
    for (var i = 0; i < 44; i++) confidence[i] = {};

    var page2 = data[0x54] ^ data[0xC] ^ QM_OGG_HEADER_1[0xC];
    var spHeader = generateOggHeader(page2);
    var spConf = generateOggConf(page2);

    for (var idx128 = 0; idx128 < spHeader.length; idx128++) {
      if (spConf[idx128] === 0) continue;
      var idx44 = Mask128to44[idx128 % 128];
      var m = data[idx128] ^ spHeader[idx128];
      var c = spConf[idx128];
      if (confidence[idx44][m] !== undefined) confidence[idx44][m] += c;
      else confidence[idx44][m] = c;
    }

    var matrix = [];
    try {
      for (var j = 0; j < 44; j++) matrix[j] = calcMaskFromConfidence(confidence[j]);
    } catch (e) {
      return null;
    }
    var matrix128 = generate128(matrix);
    if (qmcDecrypt(data.slice(0, OGG_HEADER.length), matrix128).join(',') === OGG_HEADER.join(',')) {
      return matrix128;
    }
    return null;
  }

  /* 扩展名 → 默认输出格式 / 掩码来源 */
  var HANDLERS = {
    qmc0: { ext: 'mp3', kind: 'default' },
    qmc3: { ext: 'mp3', kind: 'default' },
    qmc2: { ext: 'ogg', kind: 'default' },
    qmcogg: { ext: 'ogg', kind: 'default' },
    qmcflac: { ext: 'flac', kind: 'default' },
    bkcmp3: { ext: 'mp3', kind: 'default' },
    bkcflac: { ext: 'flac', kind: 'default' },
    tkm: { ext: 'm4a', kind: 'default' },
    mflac: { ext: 'flac', kind: 'detect-flac' },
    mgg: { ext: 'ogg', kind: 'detect-ogg' }
  };

  function getExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
  }

  async function parseQmc(buf, fileName) {
    var ext = getExt(fileName);
    var handler = HANDLERS[ext];
    if (!handler) throw new Error('不支持的 QMC 扩展名：.' + ext);

    var all = new Uint8Array(buf);
    var audio = all, matrix;

    if (handler.kind === 'detect-flac' || handler.kind === 'detect-ogg') {
      // 新格式：文件尾部带有密钥段，音频主体在前
      var tail = new DataView(all.buffer, all.byteOffset + all.length - 4, 4).getUint32(0, true);
      var keyPos = all.length - 4 - tail;
      if (tail > 0 && keyPos > 0 && keyPos < all.length) {
        audio = all.subarray(0, keyPos);
      }
      matrix = handler.kind === 'detect-flac' ? detectMflac(audio) : detectMgg(audio);
      if (!matrix) {
        throw new Error('未能识别该 ' + ext + ' 文件的掩码（QQ 音乐新版加密需联网密钥，暂仅支持可本地识别的文件）');
      }
    } else {
      matrix = defaultMask();
    }

    var decoded = qmcDecrypt(audio, matrix);
    var format = MusicDecrypt.sniffFormat(decoded) || handler.ext;
    var mime = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' }[format] || 'audio/mpeg';

    var info = { title: '', artist: '', album: '', coverBlob: null };
    try {
      if (format === 'mp3') info = MusicDecrypt.parseID3(decoded);
      else if (format === 'flac') info = MusicDecrypt.parseFlac(decoded);
    } catch (e) { /* 忽略 */ }

    var base = fileName.replace(/\.[^.]+$/, '');
    var name = info.title, artists = info.artist;
    if (!name) {
      var parts = base.split(/\s*-\s*/);
      if (parts.length >= 2) {
        artists = artists || parts[0].trim();
        name = parts.slice(1).join(' - ').trim();
      } else {
        name = base.trim();
      }
    }

    return {
      name: name,
      artists: artists,
      album: info.album || '',
      format: format,
      source: 'QMC',
      audioBlob: new Blob([decoded], { type: mime }),
      coverBlob: info.coverBlob || null
    };
  }

  MusicDecrypt.register(Object.keys(HANDLERS), function (buf, fileName) {
    return parseQmc(buf, fileName);
  });
})();
