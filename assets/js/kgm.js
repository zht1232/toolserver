/* KGM / KGMA / VPR 解密（酷狗音乐）
 *
 * 覆盖两种代际，算法结构一致，仅公钥表尺寸不同：
 *   旧版(v3)：16 字节文件头，公钥表 4 MiB  → 由 assets/kgm.mask 提供，可解 64 MiB 音频
 *   新版(v4)：28 字节文件头，公钥表 70 MiB → 由服务器 /api/kgm/key 分片下发，可解 1.1 GiB 音频
 *
 * 算法（与 unlock-music、ghtz08/kugou-kgm-decoder 一致，两者测试向量均已通过）：
 *   med8 = own_key[i % 17] ^ enc[i];  med8 ^= (med8 & 0xf) << 4
 *   pub8 = PUB_KEY_MEND[i % 272] ^ pubKey[i >> 4];  pub8 ^= (pub8 & 0xf) << 4
 *   out[i] = med8 ^ pub8          （vpr 另需异或 VprMaskDiff[i % 17]）
 *
 * 公钥表按需分片获取（每块 1 MiB），解密全程在浏览器内存完成，文件不上传。
 */
(function () {
  'use strict';

  var MAGIC_V3 = [0x7C, 0xD5, 0x32, 0xEB, 0x86, 0x02, 0x7F, 0x4B, 0xA8, 0xAF, 0xA6, 0x8E, 0x0F, 0xFF, 0x99, 0x14];
  var MAGIC_V4 = MAGIC_V3.concat([0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  var VPR_HEADER = [0x05, 0x28, 0xBC, 0x96, 0xE9, 0xE4, 0x5A, 0x43, 0x91, 0xAA, 0xBD, 0xD0, 0x7A, 0xF5, 0x36, 0x31];
  var VPR_MASK_DIFF = [0x25, 0xDF, 0xE8, 0xA6, 0x75, 0x1E, 0x75, 0x0E, 0x2F, 0x80, 0xF3, 0x2D, 0xB8, 0xB6, 0xE3, 0x11, 0x00];

  var PUB_KEY_MEND = [
    0xB8, 0xD5, 0x3D, 0xB2, 0xE9, 0xAF, 0x78, 0x8C, 0x83, 0x33, 0x71, 0x51, 0x76, 0xA0, 0xCD, 0x37,
    0x2F, 0x3E, 0x35, 0x8D, 0xA9, 0xBE, 0x98, 0xB7, 0xE7, 0x8C, 0x22, 0xCE, 0x5A, 0x61, 0xDF, 0x68,
    0x69, 0x89, 0xFE, 0xA5, 0xB6, 0xDE, 0xA9, 0x77, 0xFC, 0xC8, 0xBD, 0xBD, 0xE5, 0x6D, 0x3E, 0x5A,
    0x36, 0xEF, 0x69, 0x4E, 0xBE, 0xE1, 0xE9, 0x66, 0x1C, 0xF3, 0xD9, 0x02, 0xB6, 0xF2, 0x12, 0x9B,
    0x44, 0xD0, 0x6F, 0xB9, 0x35, 0x89, 0xB6, 0x46, 0x6D, 0x73, 0x82, 0x06, 0x69, 0xC1, 0xED, 0xD7,
    0x85, 0xC2, 0x30, 0xDF, 0xA2, 0x62, 0xBE, 0x79, 0x2D, 0x62, 0x62, 0x3D, 0x0D, 0x7E, 0xBE, 0x48,
    0x89, 0x23, 0x02, 0xA0, 0xE4, 0xD5, 0x75, 0x51, 0x32, 0x02, 0x53, 0xFD, 0x16, 0x3A, 0x21, 0x3B,
    0x16, 0x0F, 0xC3, 0xB2, 0xBB, 0xB3, 0xE2, 0xBA, 0x3A, 0x3D, 0x13, 0xEC, 0xF6, 0x01, 0x45, 0x84,
    0xA5, 0x70, 0x0F, 0x93, 0x49, 0x0C, 0x64, 0xCD, 0x31, 0xD5, 0xCC, 0x4C, 0x07, 0x01, 0x9E, 0x00,
    0x1A, 0x23, 0x90, 0xBF, 0x88, 0x1E, 0x3B, 0xAB, 0xA6, 0x3E, 0xC4, 0x73, 0x47, 0x10, 0x7E, 0x3B,
    0x5E, 0xBC, 0xE3, 0x00, 0x84, 0xFF, 0x09, 0xD4, 0xE0, 0x89, 0x0F, 0x5B, 0x58, 0x70, 0x4F, 0xFB,
    0x65, 0xD8, 0x5C, 0x53, 0x1B, 0xD3, 0xC8, 0xC6, 0xBF, 0xEF, 0x98, 0xB0, 0x50, 0x4F, 0x0F, 0xEA,
    0xE5, 0x83, 0x58, 0x8C, 0x28, 0x2C, 0x84, 0x67, 0xCD, 0xD0, 0x9E, 0x47, 0xDB, 0x27, 0x50, 0xCA,
    0xF4, 0x63, 0x63, 0xE8, 0x97, 0x7F, 0x1B, 0x4B, 0x0C, 0xC2, 0xC1, 0x21, 0x4C, 0xCC, 0x58, 0xF5,
    0x94, 0x52, 0xA3, 0xF3, 0xD3, 0xE0, 0x68, 0xF4, 0x00, 0x23, 0xF3, 0x5E, 0x0A, 0x7B, 0x93, 0xDD,
    0xAB, 0x12, 0xB2, 0x13, 0xE8, 0x84, 0xD7, 0xA7, 0x9F, 0x0F, 0x32, 0x4C, 0x55, 0x1D, 0x04, 0x36,
    0x52, 0xDC, 0x03, 0xF3, 0xF9, 0x4E, 0x42, 0xE9, 0x3D, 0x61, 0xEF, 0x7C, 0xB6, 0xB3, 0x93, 0x50
  ];

  var CHUNK = 1 << 20;
  var MASK_URL = 'assets/kgm.mask';
  var MASK_GZ_URL = 'assets/kgm.mask.gz';
  var GZ_URL = 'assets/kugou_key.gz';
  var GZ_SIZE = 12018799;

  var localMask = null;
  var fullKey = null;
  var capability = null;

  function hasPrefix(u8, prefix, offset) {
    offset = offset || 0;
    if (u8.length < offset + prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) if (u8[offset + i] !== prefix[i]) return false;
    return true;
  }

  /* 浏览器原生 gzip 解压（流式，避免整块驻留） */
  async function inflateGzip(resp) {
    var reader = resp.body.pipeThrough(new DecompressionStream('gzip')).getReader();
    var parts = [], total = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      parts.push(step.value);
      total += step.value.length;
    }
    var out = new Uint8Array(total);
    var off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  /* 能力探测：优先使用服务器的分片密钥表 */
  async function detect() {
    if (capability) return capability;
    capability = { server: false, size: 0 };
    try {
      var r = await fetch('api/ping', { method: 'GET' });
      if (r.ok) {
        var info = await r.json();
        if (info && info.kgmKey) {
          capability.server = true;
          capability.size = info.kgmKeySize || 0;
        }
      }
    } catch (e) { /* 纯静态托管时无此接口，属正常情况 */ }
    return capability;
  }

  async function loadLocalMask() {
    if (localMask) return localMask;
    // 优先取 gzip 版本（约 674 KB，为原始体积的 1/6），浏览器原生解压
    if (window.DecompressionStream) {
      try {
        var rg = await fetch(MASK_GZ_URL);
        if (rg.ok) {
          localMask = await inflateGzip(rg);
          return localMask;
        }
      } catch (e) { /* 走未压缩回退 */ }
    }
    var r = await fetch(MASK_URL);
    if (!r.ok) throw new Error('掩码文件加载失败（HTTP ' + r.status + '）');
    localMask = new Uint8Array(await r.arrayBuffer());
    return localMask;
  }

  /* 纯静态托管时，按用户确认加载完整公钥表（gzip 后约 12 MB，浏览器原生解压） */
  async function loadFullKey() {
    if (fullKey) return fullKey;
    if (!window.DecompressionStream) {
      throw new Error('当前浏览器不支持原生 gzip 解压，无法加载完整密钥表。请改用 server.py 方式访问本站。');
    }
    if (!window.confirm('该音频超过了 4 MiB 掩码表的覆盖范围（64 MiB）。\n' +
      '需要下载并解压完整酷狗密钥表（约 ' + (GZ_SIZE / 1048576).toFixed(1) + ' MB，仅本会话需要），是否继续？')) {
      throw new Error('已取消：未加载完整密钥表');
    }
    MusicDecrypt.notify('正在下载完整密钥表（' + (GZ_SIZE / 1048576).toFixed(1) + ' MB）…');
    var resp = await fetch(GZ_URL);
    if (!resp.ok) throw new Error('密钥表下载失败（HTTP ' + resp.status + '）');
    fullKey = await inflateGzip(resp);
    MusicDecrypt.notify('密钥表就绪（' + (fullKey.length / 1048576).toFixed(1) + ' MB）');
    return fullKey;
  }

  /* 取公钥表字节区间 [start, start+len)（索引已按 16 折算） */
  async function getPubKeySlice(start, len) {
    if (fullKey) return fullKey.subarray(start, start + len);
    var cap = await detect();
    if (cap.server) {
      var r = await fetch('api/kgm/key?start=' + start + '&len=' + len);
      if (!r.ok) {
        var msg = '服务器密钥表请求失败（HTTP ' + r.status + '）';
        try { msg = (await r.json()).error || msg; } catch (e) { /* 忽略 */ }
        throw new Error(msg);
      }
      return new Uint8Array(await r.arrayBuffer());
    }
    var mask = await loadLocalMask();
    if (start + len <= mask.length) return mask.subarray(start, start + len);
    await loadFullKey();
    return fullKey.subarray(start, start + len);
  }

  /* ---------- 主解密流程 ---------- */
  async function parseKgm(buf, fileName) {
    var u8 = new Uint8Array(buf);
    var isVpr = hasPrefix(u8, VPR_HEADER);
    var isV4 = hasPrefix(u8, MAGIC_V4);
    if (!isVpr && !isV4 && !hasPrefix(u8, MAGIC_V3)) {
      throw new Error('不是有效的 KGM / KGMA / VPR 文件（文件头不匹配）');
    }
    if (u8.length <= 1024) throw new Error('文件过小，可能已损坏');

    var headerLen = new DataView(buf).getUint32(0x10, true);
    if (headerLen < 1024 || headerLen >= u8.length) headerLen = 1024;

    var total = u8.length - headerLen;
    var audio = u8.subarray(headerLen);
    var ownKey = new Uint8Array(17);
    ownKey.set(u8.subarray(0x1c, 0x2c), 0);

    for (var pos = 0; pos < total; pos += CHUNK) {
      var end = Math.min(pos + CHUNK, total);
      var kStart = pos >> 4;
      var kEnd = (end - 1) >> 4;
      var slice = await getPubKeySlice(kStart, kEnd - kStart + 1);
      for (var i = pos; i < end; i++) {
        var med8 = ownKey[i % 17] ^ audio[i];
        med8 ^= (med8 & 0xf) << 4;
        var pub8 = PUB_KEY_MEND[i % 272] ^ slice[(i >> 4) - kStart];
        pub8 ^= (pub8 & 0xf) << 4;
        audio[i] = med8 ^ pub8;
      }
      if (total > CHUNK) MusicDecrypt.notify('解密中 ' + Math.round((end / total) * 100) + '%');
    }
    MusicDecrypt.notify('');

    if (isVpr) {
      for (var n = 0; n < total; n++) audio[n] ^= VPR_MASK_DIFF[n % 17];
    }

    var format = MusicDecrypt.sniffFormat(audio);
    if (!format && hasPrefix(audio, [0x66, 0x74, 0x79, 0x70], 4)) format = 'm4a';
    if (!format) format = 'mp3';
    var mime = {
      mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav'
    }[format] || 'audio/mpeg';

    var base = fileName.replace(/\.[^.]+$/, '');
    var info = { title: '', artist: '', album: '', coverBlob: null };
    try {
      if (format === 'mp3') info = MusicDecrypt.parseID3(audio);
      else if (format === 'flac') info = MusicDecrypt.parseFlac(audio);
    } catch (e) { /* 标签解析失败不影响音频 */ }

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
      source: isVpr ? 'VPR' : (isV4 ? 'KGM v4' : 'KGM'),
      audioBlob: new Blob([audio], { type: mime }),
      coverBlob: info.coverBlob || null
    };
  }

  var handler = function (buf, fileName) { return parseKgm(buf, fileName); };
  handler.capability = detect;
  MusicDecrypt.register(['kgm', 'kgma', 'vpr'], handler);
})();
