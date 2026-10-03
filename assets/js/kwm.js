/* KWM 解密（酷我音乐）
 * 算法移植自 unlock-music（MIT）src/decrypt/kwm.ts：
 *   文件头 "yeelion-kuwo-tme"，密钥在 0x18-0x20，音频自 0x400 起，
 *   由密钥派生 32 字节掩码，按 0x20 循环异或。
 */
(function () {
  'use strict';

  var MAGIC = [0x79, 0x65, 0x65, 0x6C, 0x69, 0x6F, 0x6E, 0x2D, 0x6B, 0x75, 0x77, 0x6F, 0x2D, 0x74, 0x6D, 0x65];
  var PRE_DEFINED_KEY = 'MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk';

  function hasPrefix(u8, prefix) {
    for (var i = 0; i < prefix.length; i++) if (u8[i] !== prefix[i]) return false;
    return true;
  }

  function trimKey(raw) {
    if (raw.length > 32) return raw.slice(0, 32);
    if (raw.length < 32) return raw.padEnd(32, raw);
    return raw;
  }

  function createMaskFromKey(keyBytes) {
    var dv = new DataView(keyBytes.buffer, keyBytes.byteOffset, 8);
    var keyStr = dv.getBigUint64(0, true).toString();
    var trimmed = trimKey(keyStr);
    var mask = new Uint8Array(32);
    for (var i = 0; i < 32; i++) {
      mask[i] = PRE_DEFINED_KEY.charCodeAt(i) ^ trimmed.charCodeAt(i);
    }
    return mask;
  }

  async function parseKwm(buf, fileName) {
    var u8 = new Uint8Array(buf);
    if (!hasPrefix(u8, MAGIC)) throw new Error('不是有效的 kwm 文件（文件头不匹配）');
    if (u8.length <= 0x400) throw new Error('文件过小，可能已损坏');

    var mask = createMaskFromKey(u8.subarray(0x18, 0x20));
    var audio = u8.subarray(0x400);
    for (var i = 0; i < audio.length; i++) audio[i] ^= mask[i % 0x20];

    var format = MusicDecrypt.sniffFormat(audio) || 'mp3';
    var mime = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' }[format] || 'audio/mpeg';

    var info = { title: '', artist: '', album: '', coverBlob: null };
    try {
      if (format === 'mp3') info = MusicDecrypt.parseID3(audio);
      else if (format === 'flac') info = MusicDecrypt.parseFlac(audio);
    } catch (e) { /* 忽略标签解析失败 */ }

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
      source: 'KWM',
      audioBlob: new Blob([audio], { type: mime }),
      coverBlob: info.coverBlob || null
    };
  }

  MusicDecrypt.register(['kwm'], function (buf, fileName) { return parseKwm(buf, fileName); });
})();
