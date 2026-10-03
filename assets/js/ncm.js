/* NCM 解密（网易云音乐 .ncm）
 * 算法与开源项目 ncmdump / unlock-music 一致：
 * 1. 文件头 "CTENFDAM" 校验
 * 2. 密钥区 XOR 0x64 → AES-128-ECB 解密 → 流密钥 → 构建 KeyBox
 * 3. 元数据区 XOR 0x63 → Base64 → AES-128-ECB 解密 → 歌曲信息 JSON
 * 4. 音频流用 KeyBox 逐字节异或还原为 mp3/flac
 * 全部在浏览器内存完成，不上传任何数据。
 */
(function () {
  'use strict';

  var CORE_KEY = 'hzHRAmso5kInbaxW'; // 687a4852416d736f356b496e62617857
  var META_KEY = "#14ljk_!\\]&0U<'(";
  var MAGIC = [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d]; // CTENFDAM
  var te = new TextEncoder();
  var td = new TextDecoder();

  /*
   * WebCrypto 不支持 AES-ECB，用 AES-CBC(IV=0) 等价实现：
   * CBC 解密 P_i = D(C_i) XOR C_{i-1}（首组前驱为 IV=0），
   * 故 ECB 明文 = CBC 解密结果再 XOR 前一个密文分组。
   * 难点：WebCrypto 对 CBC 输出的末分组强制做 PKCS7 校验，
   * 而 ECB 密文直接按 CBC 解密的末分组通常不合法。
   * 解决：末尾追加一个分组 X = E(末分组 XOR 0x10*16)，
   * 使追加后末分组 CBC 输出恰为合法全填充分组（被 WebCrypto 剥离，不影响原文）。
   */
  async function aesEcbDecrypt(data, keyStr) {
    var keyBytes = te.encode(keyStr);
    var src = data instanceof Uint8Array ? data : new Uint8Array(data);
    var ck = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    var lastBlock = src.slice(src.length - 16);
    var padBlock = new Uint8Array(16);
    for (var i = 0; i < 16; i++) padBlock[i] = lastBlock[i] ^ 0x10;
    var encBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, ck, padBlock);
    var extra = new Uint8Array(encBuf).slice(0, 16);
    var full = new Uint8Array(src.length + 16);
    full.set(src);
    full.set(extra, src.length);
    var dec = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, ck, full));
    var out = new Uint8Array(dec.length);
    out.set(dec);
    for (i = 16; i < out.length; i++) out[i] = dec[i] ^ src[i - 16];
    // 手动去除 ECB 明文的 PKCS7 填充
    var pad = out[out.length - 1];
    if (pad >= 1 && pad <= 16) {
      var valid = true;
      for (i = out.length - pad; i < out.length; i++) {
        if (out[i] !== pad) { valid = false; break; }
      }
      if (valid) out = out.slice(0, out.length - pad);
    }
    return out;
  }

  function buildKeyBox(key) {
    var box = new Uint8Array(256);
    for (var i = 0; i < 256; i++) box[i] = i;
    var c = 0, lastByte = 0, keyOffset = 0;
    for (i = 0; i < 256; i++) {
      var swap = box[i];
      c = (swap + lastByte + key[keyOffset++]) & 0xff;
      if (keyOffset >= key.length) keyOffset = 0;
      box[i] = box[c];
      box[c] = swap;
      lastByte = c;
    }
    return box;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function parseNcm(buf) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    for (var i = 0; i < 8; i++) {
      if (u8[i] !== MAGIC[i]) throw new Error('不是有效的 ncm 文件（文件头不匹配）');
    }
    var offset = 10;

    // 密钥区
    var keyLen = dv.getUint32(offset, true); offset += 4;
    if (keyLen <= 0 || offset + keyLen > buf.byteLength) throw new Error('密钥区长度异常');
    var keyData = u8.slice(offset, offset + keyLen); offset += keyLen;
    for (i = 0; i < keyData.length; i++) keyData[i] ^= 0x64;
    var decKey = null;
    var keyError = null;
    try {
      decKey = await aesEcbDecrypt(keyData, CORE_KEY);
      if (td.decode(decKey).indexOf('neteasecloudmusic') !== 0 || decKey.length <= 17) {
        throw new Error('标准 NCM 密钥前缀校验未通过');
      }
    } catch (e) {
      keyError = e;
    }

    // 元数据区
    var metaLen = dv.getUint32(offset, true); offset += 4;
    var meta = {};
    if (metaLen > 0) {
      if (offset + metaLen > buf.byteLength) throw new Error('元数据区长度异常');
      var metaData = u8.slice(offset, offset + metaLen); offset += metaLen;
      try {
        for (i = 0; i < metaData.length; i++) metaData[i] ^= 0x63;
        var metaB64 = td.decode(metaData).slice(22);
        var decMeta = await aesEcbDecrypt(b64ToBytes(metaB64), META_KEY);
        meta = JSON.parse(td.decode(decMeta).slice(6));
      } catch (e) { meta = {}; }
    }

    var artists = '';
    if (Array.isArray(meta.artist)) {
      artists = meta.artist.map(function (a) { return Array.isArray(a) ? a[0] : a; }).join('/');
    }

    if (keyError) {
      var keyMessage = 'NCM 音频密钥解析失败：密钥区不符合当前支持的标准格式，文件可能已损坏或使用了暂不兼容的版本。';
      if (meta.musicName) keyMessage += ' 已读取歌曲信息，可继续匹配歌词。';
      var parseError = new Error(keyMessage);
      parseError.musicMeta = {
        name: meta.musicName || '',
        artists: artists,
        album: meta.album || '',
        format: (meta.format || '').toLowerCase(),
        source: 'NCM'
      };
      throw parseError;
    }

    var box = buildKeyBox(decKey.slice(17));

    // CRC32 与版本字节后是封面帧长度，再跟第一张封面长度。
    // 旧格式的封面帧长度为 0；NCM 3.x 还可能带有额外的封面帧数据。
    offset += 5;
    var coverFrameLen = dv.getUint32(offset, true); offset += 4;

    // 封面
    var imgSize = dv.getUint32(offset, true); offset += 4;
    var coverBlob = null;
    if (imgSize > 0 && offset + imgSize <= buf.byteLength) {
      coverBlob = new Blob([u8.slice(offset, offset + imgSize)], { type: 'image/jpeg' });
      offset += imgSize;
    } else if (imgSize > 0) {
      throw new Error('封面数据长度异常');
    }
    if (coverFrameLen > imgSize) {
      var extraCoverLen = coverFrameLen - imgSize;
      if (offset + extraCoverLen > buf.byteLength) throw new Error('封面帧长度异常');
      offset += extraCoverLen;
    }

    // 音频流
    var audio = u8.slice(offset);
    for (var n = 0; n < audio.length; n++) {
      var j = (n + 1) & 0xff;
      audio[n] ^= box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff];
    }

    var format = (meta.format || '').toLowerCase();
    var sniffed = MusicDecrypt.sniffFormat(audio);
    if (sniffed) format = sniffed;
    if (['mp3', 'flac', 'm4a', 'ogg'].indexOf(format) === -1) format = 'mp3';

    var mime = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg' }[format];
    return {
      name: meta.musicName || '',
      artists: artists,
      album: meta.album || '',
      format: format,
      source: 'NCM',
      audioBlob: new Blob([audio], { type: mime }),
      coverBlob: coverBlob
    };
  }

  MusicDecrypt.register(['ncm'], function (buf) { return parseNcm(buf); });
})();
