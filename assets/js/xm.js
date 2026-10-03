/* XM 解密（虾米音乐）
 * 算法移植自 unlock-music（MIT）src/decrypt/xm.ts：
 *   文件头 "ifmt" + 类型标识 + 0xfefe，密钥为 0x0f 处单字节，
 *   音频自 0x10 起，从 dataOffset 开始按 (b - key) ^ 0xff 还原。
 */
(function () {
  'use strict';

  var MAGIC = [0x69, 0x66, 0x6D, 0x74];
  var MAGIC2 = [0xFE, 0xFE, 0xFE, 0xFE];
  var TYPE_MAP = { ' WAV': 'wav', 'FLAC': 'flac', ' MP3': 'mp3', ' A4M': 'm4a' };

  function hasPrefix(u8, prefix, offset) {
    offset = offset || 0;
    if (u8.length < offset + prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) if (u8[offset + i] !== prefix[i]) return false;
    return true;
  }

  async function parseXm(buf, fileName) {
    var u8 = new Uint8Array(buf);
    if (!hasPrefix(u8, MAGIC) || !hasPrefix(u8, MAGIC2, 8)) {
      throw new Error('不是有效的 xm 文件（文件头不匹配）');
    }
    var typeText = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    if (!TYPE_MAP[typeText]) throw new Error('未知的 xm 文件类型：' + typeText);

    var key = u8[0x0f];
    var dataOffset = u8[0x0c] | (u8[0x0d] << 8) | (u8[0x0e] << 16);
    var audio = u8.subarray(0x10);
    for (var cur = dataOffset; cur < audio.length; cur++) {
      audio[cur] = (audio[cur] - key) ^ 0xff;
    }

    var format = TYPE_MAP[typeText];
    var mime = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' }[format] || 'audio/mpeg';

    var info = { title: '', artist: '', album: '', coverBlob: null };
    try {
      if (format === 'mp3') info = MusicDecrypt.parseID3(audio);
      else if (format === 'flac') info = MusicDecrypt.parseFlac(audio);
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
      source: 'XM',
      audioBlob: new Blob([audio], { type: mime }),
      coverBlob: info.coverBlob || null
    };
  }

  MusicDecrypt.register(['xm'], function (buf, fileName) { return parseXm(buf, fileName); });
})();
