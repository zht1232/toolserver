/* HIF / HEIF -> sRGB 转换 Worker（浏览器本地，图片不上传）
 * libheif/libde265 WASM 解码出 10-bit RGB，再按与服务端 hif_convert.py
 * 相同的 PQ/HLG -> BT.709 -> 203 nit 肩部压缩管线做色调映射。
 */
(function () {
  'use strict';

  var LIBHEIF_URL = '../vendor/libheif/libheif-bundle.js?v=20261024-04';
  var REF_WHITE_NITS = 203.0;
  var KNEE = 0.85;
  var SHOULDER = 8.0;
  var MAX_PIXELS = 60000000;

  var HEIF_BRANDS = {
    heic: 1, heix: 1, heim: 1, heis: 1, hevc: 1,
    hevx: 1, hevm: 1, hevs: 1, mif1: 1, msf1: 1
  };

  var libheif = null;
  var libheifPromise = null;

  function fourcc(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function post(id, message, transfer) {
    message.id = id;
    self.postMessage(message, transfer || []);
  }

  function progress(id, stage, value, extra) {
    var message = { type: 'progress', stage: stage, value: value };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) message[key] = extra[key];
      }
    }
    post(id, message);
  }

  function fail(id, code, message) {
    post(id, { type: 'error', code: code, message: message });
  }

  function loadLibheif() {
    if (libheifPromise) return libheifPromise;
    libheifPromise = new Promise(function (resolve, reject) {
      try {
        importScripts(LIBHEIF_URL);
      } catch (err) {
        reject(err);
        return;
      }
      var factory = self.libheif;
      if (typeof factory !== 'function' && factory && typeof factory.default === 'function') {
        factory = factory.default;
      }
      if (typeof factory !== 'function') {
        reject(new Error('本地解码器脚本格式异常'));
        return;
      }
      var module;
      try {
        module = factory();
      } catch (err) {
        reject(err);
        return;
      }
      var started = Date.now();
      (function waitReady() {
        if (typeof module.heif_js_decode_image2 === 'function') {
          libheif = module;
          resolve(module);
          return;
        }
        if (Date.now() - started > 20000) {
          reject(new Error('本地解码器初始化超时'));
          return;
        }
        setTimeout(waitReady, 20);
      })();
    });
    return libheifPromise;
  }

  // 在 HEIF 的 meta/iprp/ipco 里找 nclx 色彩描述和 pixi 位深。
  function parseMeta(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var containers = { meta: 4, iprp: 0, ipco: 0 };
    var nclx = null;
    var pixi = null;

    function walk(start, end, depth) {
      var p = start;
      while (p + 8 <= end) {
        var size = view.getUint32(p);
        var type = fourcc(bytes, p + 4);
        var header = 8;
        if (size === 1) {
          size = Number(view.getBigUint64(p + 8));
          header = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < header || p + size > end) break;

        if (type === 'colr') {
          var q = p + header;
          var colorType = fourcc(bytes, q);
          if (colorType === 'nclx' && q + 11 <= p + size) {
            nclx = {
              primaries: view.getUint16(q + 4),
              transfer: view.getUint16(q + 6),
              matrix: view.getUint16(q + 8),
              fullRange: !!(bytes[q + 10] & 0x80)
            };
          }
        } else if (type === 'pixi') {
          var r = p + header;
          var channels = bytes[r + 4];
          if (channels >= 1 && r + 5 + channels <= p + size) {
            var bits = [];
            for (var i = 0; i < channels; i++) bits.push(bytes[r + 5 + i]);
            pixi = { channels: channels, bits: bits };
          }
        } else if (containers[type] !== undefined && depth < 8) {
          walk(p + header + containers[type], p + size, depth + 1);
        }
        p += size;
      }
    }

    walk(0, bytes.length, 0);
    return { nclx: nclx, pixi: pixi };
  }

  function sourceLabel(primaries, transfer, bitDepth) {
    var p = { 1: 'BT.709', 9: 'BT.2020', 12: 'P3' }[primaries] || 'unknown';
    var t = { 1: 'BT.709', 8: 'linear', 13: 'sRGB', 16: 'PQ', 18: 'HLG' }[transfer] || 'unknown';
    return p + '/' + t + '/' + bitDepth + '-bit';
  }

  function makeLut(length, fn) {
    var lut = new Float32Array(length);
    for (var i = 0; i < length; i++) lut[i] = fn(i);
    return lut;
  }

  function pqEotf(v) {
    var m1 = 2610 / 16384, m2 = 2523 / 4096 * 128;
    var c1 = 3424 / 4096, c2 = 2413 / 4096 * 32, c3 = 2392 / 4096 * 32;
    v = Math.min(Math.max(v, 0), 1);
    var p = Math.pow(v, 1 / m2);
    return 10000 * Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1);
  }

  function hlgInverseOetf(value) {
    var a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
    value = Math.min(Math.max(value, 0), 1);
    return value <= 0.5 ? value * value / 3 : (Math.exp((value - c) / a) + b) / 12;
  }

  function srgbEotf(value) {
    value = Math.min(Math.max(value, 0), 1);
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function bt709Eotf(value) {
    value = Math.min(Math.max(value, 0), 1);
    return value < 0.081 ? value / 4.5 : Math.pow((value + 0.099) / 1.099, 1 / 0.45);
  }

  function srgbOetf(value) {
    value = Math.min(Math.max(value, 0), 1);
    return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  }

  function convert(id, buffer, exposure) {
    var bytes = new Uint8Array(buffer);
    var gain = Math.pow(2, Math.max(-4, Math.min(4, Number(exposure) || 0)));
    if (bytes.length < 16 || fourcc(bytes, 4) !== 'ftyp') {
      fail(id, 'corrupt', '不是有效的 HEIF/HIF 文件');
      return;
    }
    var brand = fourcc(bytes, 8);
    if (!HEIF_BRANDS[brand]) {
      fail(id, 'unsupported', '当前只支持 HEIF/HIF（不支持 AVIF 等其它容器）');
      return;
    }

    var meta = parseMeta(bytes);
    if (!meta.nclx || !meta.nclx.primaries || !meta.nclx.transfer) {
      fail(id, 'unsupported', '文件缺少 nclx 色彩描述，无法做可靠的颜色转换');
      return;
    }
    var primaries = meta.nclx.primaries;
    var transfer = meta.nclx.transfer;
    var bitDepth = meta.pixi && meta.pixi.bits.length ? meta.pixi.bits[0] : 10;
    if (bitDepth < 8 || bitDepth > 16) bitDepth = 10;

    if (primaries !== 1 && primaries !== 9 && primaries !== 12) {
      fail(id, 'unsupported', '不支持的色彩原色（' + primaries + '）');
      return;
    }
    if (transfer !== 1 && transfer !== 8 && transfer !== 13 && transfer !== 16 && transfer !== 18) {
      fail(id, 'unsupported', '不支持的传输曲线（' + transfer + '）');
      return;
    }

    progress(id, 'engine', 8);

    loadLibheif().then(function (module) {
      progress(id, 'decode', 15);
      var decoder = new module.HeifDecoder();
      var images;
      try {
        images = decoder.decode(bytes);
      } catch (err) {
        fail(id, 'corrupt', 'HEIF 解码失败：' + (err && err.message ? err.message : err));
        return;
      }
      if (!images || !images.length) {
        fail(id, 'corrupt', 'HEIF 中没有可解码的图像');
        return;
      }

      var img = images[0];
      var width = img.get_width();
      var height = img.get_height();
      if (!width || !height) {
        fail(id, 'corrupt', 'HEIF 尺寸无效');
        return;
      }
      if (width * height > MAX_PIXELS) {
        fail(id, 'too-large', '图片超过 ' + (MAX_PIXELS / 10000) + ' 万像素上限');
        return;
      }

      var decoded;
      try {
        decoded = module.heif_js_decode_image2(
          img.handle,
          module.heif_colorspace_RGB,
          module.heif_chroma_interleaved_RRGGBB_LE
        );
      } catch (err) {
        fail(id, 'corrupt', 'HEIF 像素解码失败：' + (err && err.message ? err.message : err));
        return;
      }
      if (!decoded || !decoded.channels || !decoded.channels.length) {
        fail(id, 'corrupt', 'HEIF 像素解码失败');
        return;
      }

      var channel = decoded.channels[0];
      var stride = channel.stride;
      var raw = channel.data;
      var copy;
      try {
        copy = new Uint8Array(raw.length);
        copy.set(raw);
      } catch (err) {
        fail(id, 'oom', '浏览器内存不足，无法解码这张图片');
        return;
      }
      try {
        module.heif_image_release(decoded.image);
      } catch (err) { /* ignore */ }

      progress(id, 'decode', 35, { width: width, height: height });
      toneMap(id, copy, width, height, stride, primaries, transfer, bitDepth, gain, Number(exposure) || 0);
    }).catch(function (err) {
      fail(id, 'engine', '本地解码器加载失败：' + (err && err.message ? err.message : err));
    });
  }

  function toneMap(id, copy, width, height, stride, primaries, transfer, bitDepth, gain, exposureEv) {
    var maxCode = (1 << bitDepth) - 1;
    var norm = 1 / maxCode;
    var count = width * height;
    var rowElems = stride >> 1;
    var u16 = new Uint16Array(copy.buffer, copy.byteOffset, copy.byteLength >> 1);
    var hdr = transfer === 16 || transfer === 18;
    var m00, m01, m02, m10, m11, m12, m20, m21, m22;
    if (primaries === 9) {
      m00 = 1.660491; m01 = -0.587641; m02 = -0.072850;
      m10 = -0.124550; m11 = 1.132900; m12 = -0.008350;
      m20 = -0.018151; m21 = -0.100579; m22 = 1.118730;
    } else if (primaries === 12) {
      m00 = 1.224940; m01 = -0.224940; m02 = 0;
      m10 = -0.042057; m11 = 1.042057; m12 = 0;
      m20 = -0.019638; m21 = -0.078636; m22 = 1.098274;
    } else {
      m00 = 1; m01 = 0; m02 = 0;
      m10 = 0; m11 = 1; m12 = 0;
      m20 = 0; m21 = 0; m22 = 1;
    }

    var transferLut;
    if (transfer === 16) {
      transferLut = makeLut(maxCode + 1, function (i) { return pqEotf(i * norm); });
    } else if (transfer === 18) {
      transferLut = makeLut(maxCode + 1, function (i) { return hlgInverseOetf(i * norm); });
    } else if (transfer === 13) {
      transferLut = makeLut(maxCode + 1, function (i) { return srgbEotf(i * norm); });
    } else if (transfer === 1) {
      transferLut = makeLut(maxCode + 1, function (i) { return bt709Eotf(i * norm); });
    } else {
      transferLut = makeLut(maxCode + 1, function (i) { return i * norm; });
    }

    var peak = 0;
    var yMax = 1;
    var ratioLut = null;
    var x, y, r, g, b, R, G, B, row, col, idx;
    var i, progressMark;

    if (hdr) {
      progress(id, 'tone', 40);
      for (row = 0; row < height; row++) {
        var rowBase = row * rowElems;
        for (col = 0; col < width; col++) {
          idx = rowBase + col * 3;
          r = transferLut[u16[idx]];
          g = transferLut[u16[idx + 1]];
          b = transferLut[u16[idx + 2]];
          if (transfer === 18) {
            y = 0.2627 * r + 0.6780 * g + 0.0593 * b;
            var scale = 1000 * Math.pow(Math.max(y, 0), 0.2);
            r *= scale; g *= scale; b *= scale;
          }
          R = m00 * r + m01 * g + m02 * b;
          G = m10 * r + m11 * g + m12 * b;
          B = m20 * r + m21 * g + m22 * b;
          R *= gain; G *= gain; B *= gain;
          y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          if (y > peak) peak = y;
        }
        if ((row & 255) === 0) {
          progress(id, 'tone', 40 + Math.round(row / height * 15));
        }
      }
      if (!isFinite(peak) || peak <= 0) {
        fail(id, 'corrupt', 'HDR 亮度解析失败');
        return;
      }
      yMax = peak;
      var white = Math.max(peak / REF_WHITE_NITS, KNEE + 0.001);
      var denominator = Math.log1p(SHOULDER * (white - KNEE));
      ratioLut = new Float32Array(65537);
      for (i = 0; i <= 65536; i++) {
        y = i / 65536 * yMax;
        x = y / REF_WHITE_NITS;
        var target = x <= KNEE ? x
          : KNEE + (1 - KNEE) * Math.log1p(SHOULDER * (x - KNEE)) / denominator;
        ratioLut[i] = y > 1e-6 ? target / y : 0;
      }
    } else {
      progress(id, 'tone', 55);
    }

    var srgbLut = new Uint8Array(65537);
    for (i = 0; i <= 65536; i++) {
      srgbLut[i] = Math.round(srgbOetf(i / 65536) * 255);
    }

    var out;
    try {
      out = new Uint8Array(count * 4);
    } catch (err) {
      fail(id, 'oom', '浏览器内存不足，无法生成输出图像');
      return;
    }
    var outIndex = 0;
    progressMark = hdr ? 55 : 55;
    var started = Date.now();

    for (row = 0; row < height; row++) {
      var base = row * rowElems;
      for (col = 0; col < width; col++) {
        idx = base + col * 3;
        r = transferLut[u16[idx]];
        g = transferLut[u16[idx + 1]];
        b = transferLut[u16[idx + 2]];
        if (transfer === 18) {
          y = 0.2627 * r + 0.6780 * g + 0.0593 * b;
          var hlgScale = 1000 * Math.pow(Math.max(y, 0), 0.2);
          r *= hlgScale; g *= hlgScale; b *= hlgScale;
        }
        R = m00 * r + m01 * g + m02 * b;
        G = m10 * r + m11 * g + m12 * b;
        B = m20 * r + m21 * g + m22 * b;
        R *= gain; G *= gain; B *= gain;
        if (hdr) {
          y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          var ri = (y / yMax * 65536) | 0;
          if (ri > 65536) ri = 65536;
          var ratio = ratioLut[ri];
          R *= ratio; G *= ratio; B *= ratio;
        }
        var oi = (R * 65536) | 0;
        out[outIndex] = srgbLut[oi > 65536 ? 65536 : (oi < 0 ? 0 : oi)];
        oi = (G * 65536) | 0;
        out[outIndex + 1] = srgbLut[oi > 65536 ? 65536 : (oi < 0 ? 0 : oi)];
        oi = (B * 65536) | 0;
        out[outIndex + 2] = srgbLut[oi > 65536 ? 65536 : (oi < 0 ? 0 : oi)];
        out[outIndex + 3] = 255;
        outIndex += 4;
      }
      if ((row & 127) === 0) {
        var pct = 55 + Math.round(row / height * 40);
        if (pct > progressMark) {
          progressMark = pct;
          progress(id, 'tone', pct);
        }
      }
    }

    var info = {
      width: width,
      height: height,
      primaries: primaries,
      transfer: transfer,
      bitDepth: bitDepth,
      source: sourceLabel(primaries, transfer, bitDepth),
      hdr: hdr,
      peak: hdr ? Math.round(peak * 10) / 10 : null,
      engine: 'browser',
      exposureEv: exposureEv,
      ms: Date.now() - started
    };
    post(id, {
      type: 'done',
      rgba: out.buffer,
      width: width,
      height: height,
      meta: info
    }, [out.buffer]);
  }

  self.onmessage = function (event) {
    var data = event.data || {};
    if (data.type !== 'convert') return;
    try {
      convert(data.id, data.buffer, data.exposure);
    } catch (err) {
      fail(data.id, 'unknown', '转换失败：' + (err && err.message ? err.message : err));
    }
  };
})();
