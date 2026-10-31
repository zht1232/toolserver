/* LOCALTOOLS — RAW 显影（Camera Raw 风格，浅色主题）
 * 全部在浏览器本地完成：FlashRaw (WASM) 解码 RAW，WebGL2 做实时显影，导出 Blob 下载。
 * 不依赖服务器 API，不请求第三方资源，不上传图片。
 *
 * 挂载点：<div id="raw-root"></div>
 * 集成：<link rel="stylesheet" href="assets/raw.css">
 *       <script type="module" src="assets/js/raw.js"></script>
 * 也可在稍后调用 window.RAWDevelop.mount(element)。
 */
(function () {
  'use strict';

  if (window.RAWDevelop && window.RAWDevelop.__mounted) return;

  /* ------------------------------------------------------------------ *
   * 常量与工具
   * ------------------------------------------------------------------ */

  var VERSION = '1.1.0';
  var PREVIEW_MAX_EDGE = 1600;
  var PREVIEW_MAX_PIXELS = 22e6; // 超过此像素数时预览改用半尺寸去马赛克
  var EXPORT_MAX_PIXELS = 80e6;
  var MAX_FILE_BYTES = 350 * 1024 * 1024;
  var MASK_PREVIEW_WIDTH = 768;
  var MASK_EXPORT_WIDTH = 2048;
  var MAX_MASKS = 8;
  var MAX_HISTORY = 40;
  var IDENTITY_CURVE = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  var CURVE_CHANNELS = [
    { key: 'rgb', label: 'RGB', short: 'RGB', color: '#0C7A69', curve: '#0C7A69' },
    { key: 'r', label: '红', short: '红', color: '#C0392B', curve: '#C0392B' },
    { key: 'g', label: '绿', short: '绿', color: '#1F7A4D', curve: '#1F7A4D' },
    { key: 'b', label: '蓝', short: '蓝', color: '#2F5EB8', curve: '#2F5EB8' }
  ];
  var CROP_ASPECTS = {
    free: 0,
    original: 0,
    '1:1': 1,
    '4:3': 4 / 3,
    '3:2': 3 / 2,
    '16:9': 16 / 9
  };

  var RAW_RE = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|arq|dng|raf|orf|ori|orw|rw2|rwl|pef|srw|mrw|iiq|mos|3fr|fff|kdc|dcr|dcs|erf|mef|x3f|ari|raw)$/i;
  var IMAGE_RE = /\.(jpe?g|png|webp|avif|gif|bmp)$/i;
  var ACCEPT = '.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.arq,.dng,.raf,.orf,.ori,.orw,.rw2,.rwl,.pef,.srw,.mrw,.iiq,.mos,.3fr,.fff,.kdc,.dcr,.dcs,.erf,.mef,.x3f,.ari,.raw,.jpg,.jpeg,.png,.webp,.avif,.gif,.bmp';

  var ICONS = {
    camera: '<path d="M4 7h3l1.6-2h6.8L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
    open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
    compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/><path d="M6 9h3M15 9h3M6 13h3M15 13h3"/>',
    fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/>',
    one: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9.5 11 8v8"/><path d="M14.5 16h2.5"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    sliders: '<path d="M4 7h8M17 7h3M4 17h4M13 17h7"/><circle cx="14.5" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    curve: '<path d="M4 4v16h16"/><path d="M4 18c4 0 5-12 9-12 3 0 4 6 7 6"/>',
    mask: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    'image-off': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 3 18 18"/><path d="M8 15l2.5-3 2 2.2L15 11l3 4"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
    rotate: '<path d="M4 9a8 8 0 1 1 1.2 8.4"/><path d="M4 3v6h6"/>',
    flip: '<path d="M12 3v18"/><path d="M8 6 3 12l5 6Z"/><path d="m16 6 5 6-5 6Z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
    lens: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M4.5 7.5h3M16.5 16.5h3"/>',
    wand: '<path d="m4 20 11-11"/><path d="m14 4 .8 2.2L17 7l-2.2.8L14 10l-.8-2.2L11 7l2.2-.8Z"/><path d="m19 12 .6 1.4L21 14l-1.4.6L19 16l-.6-1.4L17 14l1.4-.6Z"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(lo, hi, x) {
    var t = clamp((x - lo) / Math.max(1e-8, hi - lo), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { setTimeout(resolve, 0); });
    });
  }

  function formatBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function formatShutter(sec) {
    if (!sec || !isFinite(sec) || sec <= 0) return '—';
    if (sec >= 1) return (sec < 10 ? sec.toFixed(1) : Math.round(sec)) + ' s';
    var d = Math.round(1 / sec);
    if (d >= 1 && Math.abs(1 / d - sec) / sec < 0.06) return '1/' + d + ' s';
    return sec.toFixed(4) + ' s';
  }

  function baseName(name) {
    return String(name || '').replace(/\.[^.]+$/, '') || 'raw-export';
  }

  function extOf(name) {
    var m = /\.([^.]+)$/.exec(String(name || ''));
    return m ? m[1].toUpperCase() : '';
  }

  function describeError(err) {
    if (!err) return '发生未知错误。';
    var kind = err.kind || '';
    if (kind === 'UnsupportedFormat') {
      return '不支持的文件格式：这可能不是相机 RAW 文件，或格式尚未被解码器支持。';
    }
    if (kind === 'UnsupportedCompression') {
      return '该相机的压缩格式暂不支持（例如 Nikon 高效 NEF / JPEG XL DNG）。请先用相机厂商软件导出 DNG 后再试。';
    }
    if (kind === 'CorruptFile') {
      return '文件损坏或被截断，无法完整解码。请检查文件是否拷贝完整。';
    }
    if (kind === 'InvalidMetadata' || kind === 'CameraUnsupported') {
      return '无法识别相机元数据，文件可能不是有效的 RAW。';
    }
    if (kind === 'OutOfMemory' || kind === 'LimitExceeded') {
      return '内存不足或图片尺寸超出浏览器限制。请关闭其它标签页，或先用桌面软件缩小图片。';
    }
    if (kind === 'NotAvailable') {
      return '当前浏览器缺少所需能力（WebAssembly / WebGL2），无法在本机完成显影。';
    }
    if (kind === 'Closed') return '会话已关闭，请重新载入文件。';
    var msg = String(err.message || err);
    if (/webgl2|webgl/i.test(msg)) {
      return '当前浏览器未启用 WebGL2，无法进行实时显影。请更新浏览器或开启硬件加速。';
    }
    if (/wasm|webassembly|fetch|instantiate|magic word|application\/wasm/i.test(msg)) {
      return '解码器加载失败。请确认 assets/vendor/flashraw/ 下的 wasm 文件完整，并由服务器以 application/wasm 提供。';
    }
    if (/memory|alloc|too large|Array buffer allocation/i.test(msg)) {
      return '内存不足，无法完成解码。请关闭其它标签页后重试，或换用较小的文件。';
    }
    if (/unsupported-ext/.test(msg)) {
      return '不支持的文件扩展名。请选择 CR2/CR3/NEF/ARW/DNG/RAF/ORW 等 RAW，或 JPEG/PNG/WebP。';
    }
    if (/image|bitmap|decode/i.test(msg)) {
      return '无法解码这个图片文件，可能已损坏或使用了浏览器不支持的编码。';
    }
    return '处理失败：' + msg;
  }

  /* ------------------------------------------------------------------ *
   * 调整项定义
   * ------------------------------------------------------------------ */

  var ADJUSTMENTS = [
    { key: 'exposure', label: '曝光', min: -5, max: 5, step: 0.05, def: 0, ev: true },
    { key: 'contrast', label: '对比度', min: -100, max: 100, step: 1, def: 0 },
    { key: 'highlights', label: '高光', min: -100, max: 100, step: 1, def: 0 },
    { key: 'shadows', label: '阴影', min: -100, max: 100, step: 1, def: 0 },
    { key: 'whites', label: '白色', min: -100, max: 100, step: 1, def: 0 },
    { key: 'blacks', label: '黑色', min: -100, max: 100, step: 1, def: 0 },
    { key: 'temperature', label: '色温', min: -100, max: 100, step: 1, def: 0 },
    { key: 'tint', label: '色调', min: -100, max: 100, step: 1, def: 0 },
    { key: 'vibrance', label: '自然饱和度', min: -100, max: 100, step: 1, def: 0 },
    { key: 'saturation', label: '饱和度', min: -100, max: 100, step: 1, def: 0 },
    { key: 'clarity', label: '清晰度', min: -100, max: 100, step: 1, def: 0 },
    { key: 'dehaze', label: '去雾', min: -100, max: 100, step: 1, def: 0 },
    { key: 'vignette', label: '暗角', min: -100, max: 100, step: 1, def: 0 },
    { key: 'grain', label: '颗粒', min: 0, max: 100, step: 1, def: 0 },
    { key: 'sharpen', label: '锐化', min: 0, max: 100, step: 1, def: 0 }
  ];

  var LENS = [
    { key: 'lensDistort', label: '畸变校正', min: -100, max: 100, step: 1, def: 0 },
    { key: 'lensVignette', label: '暗角校正', min: -100, max: 100, step: 1, def: 0 },
    { key: 'lensCa', label: '色差校正', min: -100, max: 100, step: 1, def: 0 }
  ];

  var DETAIL = [
    { key: 'noiseLuma', label: '亮度降噪', min: 0, max: 100, step: 1, def: 0 },
    { key: 'noiseColor', label: '色彩降噪', min: 0, max: 100, step: 1, def: 0 }
  ];

  var ALL_ADJUSTMENTS = ADJUSTMENTS.concat(LENS, DETAIL);

  var LOCALS = [
    { key: 'exposure', label: '局部曝光', min: -3, max: 3, step: 0.05, def: 0, ev: true },
    { key: 'contrast', label: '局部对比', min: -100, max: 100, step: 1, def: 0 },
    { key: 'temperature', label: '局部色温', min: -100, max: 100, step: 1, def: 0 },
    { key: 'saturation', label: '局部饱和', min: -100, max: 100, step: 1, def: 0 }
  ];

  var PARAM_CURVE = [
    { key: 'highlights', label: '高光', min: -100, max: 100, step: 1, def: 0 },
    { key: 'lights', label: '亮调', min: -100, max: 100, step: 1, def: 0 },
    { key: 'darks', label: '暗调', min: -100, max: 100, step: 1, def: 0 },
    { key: 'shadows', label: '阴影', min: -100, max: 100, step: 1, def: 0 },
    { key: 'shadowSplit', label: '阴影分界', min: 0, max: 45, step: 1, def: 25, unit: '%' },
    { key: 'midSplit', label: '中间调分界', min: 25, max: 75, step: 1, def: 50, unit: '%' },
    { key: 'highlightSplit', label: '高光分界', min: 55, max: 100, step: 1, def: 75, unit: '%' }
  ];

  function defaultAdjust() {
    var o = {};
    ALL_ADJUSTMENTS.forEach(function (d) { o[d.key] = d.def; });
    return o;
  }
  function defaultLocal() {
    var o = {};
    LOCALS.forEach(function (d) { o[d.key] = d.def; });
    return o;
  }
  function defaultParamCurve() {
    var o = {};
    PARAM_CURVE.forEach(function (d) { o[d.key] = d.def; });
    return o;
  }
  function defaultGeometry() {
    return { rotate90: 0, flipH: false, flipV: false, angle: 0, crop: null };
  }
  function cloneGeometry(g) {
    g = g || {};
    return {
      rotate90: (((Number(g.rotate90) || 0) % 4) + 4) % 4,
      flipH: !!g.flipH,
      flipV: !!g.flipV,
      angle: clamp(Number(g.angle) || 0, -45, 45),
      crop: g.crop ? {
        x: clamp(Number(g.crop.x) || 0, 0, 1),
        y: clamp(Number(g.crop.y) || 0, 0, 1),
        w: clamp(Number(g.crop.w) || 0, 0.001, 1),
        h: clamp(Number(g.crop.h) || 0, 0.001, 1)
      } : null
    };
  }

  function fmtAdjust(def, v) {
    if (def.unit === '%') return Math.round(v) + '%';
    if (def.ev) return (v > 0 ? '+' : '') + Number(v).toFixed(2);
    var r = Math.round(v);
    return (r > 0 ? '+' : '') + String(r);
  }

  /* ------------------------------------------------------------------ *
   * WebGL2 渲染器
   * ------------------------------------------------------------------ */

  var VERT_SRC = [
    '#version 300 es',
    'in vec2 a_pos;',
    'out vec2 v_uv;',
    'void main() {',
    '  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 v_uv;',
    'out vec4 outColor;',
    'uniform sampler2D u_image;',
    'uniform sampler2D u_stage;',
    'uniform sampler2D u_curve;',
    'uniform sampler2D u_mask;',
    'uniform vec2 u_texSize;',
    'uniform float u_aspect;',
    'uniform float u_before;',
    'uniform float u_pass;',
    'uniform float u_exposure;',
    'uniform float u_contrast;',
    'uniform float u_highlights;',
    'uniform float u_shadows;',
    'uniform float u_whites;',
    'uniform float u_blacks;',
    'uniform float u_temp;',
    'uniform float u_tint;',
    'uniform float u_vibrance;',
    'uniform float u_saturation;',
    'uniform float u_clarity;',
    'uniform float u_dehaze;',
    'uniform float u_vignette;',
    'uniform float u_grain;',
    'uniform float u_sharpen;',
    'uniform float u_lensDistort;',
    'uniform float u_lensVignette;',
    'uniform float u_lensCa;',
    'uniform float u_noiseLuma;',
    'uniform float u_noiseColor;',
    'uniform float u_maskType;',
    'uniform float u_maskInvert;',
    'uniform float u_maskShow;',
    'uniform float u_maskFeather;',
    'uniform vec2 u_maskP1;',
    'uniform vec2 u_maskP2;',
    'uniform vec4 u_local;',
    'uniform float u_curveOn;',
    'uniform float u_scale;',
    'uniform float u_seed;',
    '',
    'const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);',
    '',
    'vec3 srgbToLinear(vec3 c) {',
    '  c = clamp(c, 0.0, 1.0);',
    '  vec3 lo = c / 12.92;',
    '  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));',
    '  return mix(lo, hi, step(vec3(0.04045), c));',
    '}',
    'vec3 linearToSrgb(vec3 c) {',
    '  c = max(c, vec3(0.0));',
    '  vec3 lo = c * 12.92;',
    '  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;',
    '  return mix(lo, hi, step(vec3(0.0031308), c));',
    '}',
    'float lumaOf(vec3 c) { return dot(c, LUMA); }',
    'float hash21(vec2 p) {',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    '',
    'float maskValue(vec2 uv) {',
    '  if (u_maskType < 0.5) return 0.0;',
    '  float m = 0.0;',
    '  if (u_maskType < 1.5) {',
    '    vec2 d = u_maskP2 - u_maskP1;',
    '    float t = dot(uv - u_maskP1, d) / max(dot(d, d), 1e-6);',
    '    float f = mix(0.03, 0.9, clamp(u_maskFeather, 0.0, 1.0));',
    '    m = smoothstep(0.5 - f * 0.5, 0.5 + f * 0.5, t);',
    '  } else if (u_maskType < 2.5) {',
    '    vec2 r = max(abs(u_maskP2), vec2(0.002));',
    '    float d = length((uv - u_maskP1) / r);',
    '    float f = mix(0.03, 0.9, clamp(u_maskFeather, 0.0, 1.0));',
    '    m = 1.0 - smoothstep(max(1.0 - f, 0.01), 1.0, d);',
    '  } else {',
    '    m = texture(u_mask, uv).r;',
    '    float f = clamp(u_maskFeather, 0.0, 1.0);',
    '    float lo = clamp(0.42 - f * 0.38, 0.001, 0.49);',
    '    float hi = clamp(0.58 + f * 0.38, 0.51, 0.999);',
    '    m = smoothstep(lo, hi, m);',
    '  }',
    '  return mix(m, 1.0 - m, step(0.5, u_maskInvert));',
    '}',
    '',
    'vec2 lensRemap(vec2 uv) {',
    '  if (abs(u_lensDistort) < 0.0001) return uv;',
    '  float aspect = u_texSize.x / max(1.0, u_texSize.y);',
    '  vec2 halfSpan = vec2(aspect, 1.0) * 0.5;',
    '  vec2 c = (uv - 0.5) / halfSpan;',
    '  float r2 = clamp(dot(c, c) * 0.5, 0.0, 1.0);',
    '  float cover = 1.0 / (1.0 + abs(u_lensDistort) * 0.35);',
    '  c *= cover * (1.0 + u_lensDistort * 0.35 * r2);',
    '  return clamp(c * halfSpan + 0.5, 0.0, 1.0);',
    '}',
    '',
    'vec3 sampleChroma(vec2 uv) {',
    '  uv = clamp(uv, 0.0, 1.0);',
    '  if (abs(u_lensCa) < 0.0001) return texture(u_image, uv).rgb;',
    '  vec2 d = uv - 0.5;',
    '  float k = u_lensCa * 0.006;',
    '  return vec3(',
    '    texture(u_image, clamp(0.5 + d * (1.0 + k), 0.0, 1.0)).r,',
    '    texture(u_image, uv).g,',
    '    texture(u_image, clamp(0.5 + d * (1.0 - k), 0.0, 1.0)).b',
    '  );',
    '}',
    '',
    'vec3 denoiseSource(vec3 src, vec2 uv) {',
    '  if (u_noiseLuma < 0.001 && u_noiseColor < 0.001) return src;',
    '  vec2 px = vec2(max(1.0, u_scale)) / u_texSize;',
    '  float l0 = lumaOf(src);',
    '  float sigma = mix(0.035, 0.12, u_noiseLuma);',
    '  vec3 acc = src;',
    '  float wsum = 1.0;',
    '  for (int i = -1; i <= 1; i++) {',
    '    for (int j = -1; j <= 1; j++) {',
    '      if (i == 0 && j == 0) continue;',
    '      vec3 s = sampleChroma(lensRemap(uv + vec2(float(i), float(j)) * px));',
    '      float dl = lumaOf(s) - l0;',
    '      float w = exp(-(dl * dl) / max(0.0001, sigma * sigma));',
    '      acc += s * w;',
    '      wsum += w;',
    '    }',
    '  }',
    '  vec3 avg = acc / wsum;',
    '  float lb = lumaOf(avg);',
    '  float edge = smoothstep(0.0, 0.06, abs(lb - l0));',
    '  float outL = mix(l0, lb, u_noiseLuma * (1.0 - edge * 0.65));',
    '  vec3 chroma = avg - vec3(lb);',
    '  vec3 srcChroma = src - vec3(l0);',
    '  return vec3(outL) + mix(srcChroma, chroma, u_noiseColor);',
    '}',
    '',
    'vec3 globalAdjust(vec3 src) {',
    '  vec3 lin = srgbToLinear(src);',
    '',
    '  // 白平衡（相对相机已应用的白平衡）',
    '  lin.r *= exp2(u_temp * 0.55);',
    '  lin.b *= exp2(-u_temp * 0.55);',
    '  lin.g *= exp2(-u_tint * 0.32);',
    '  lin.r *= exp2(u_tint * 0.10);',
    '  lin.b *= exp2(u_tint * 0.10);',
    '',
    '  // 镜头暗角校正：只抬边缘，不改变中心曝光',
    '  if (abs(u_lensVignette) > 0.0001) {',
    '    float vr = length((v_uv - 0.5) * vec2(u_aspect, 1.0)) / length(vec2(u_aspect, 1.0) * 0.5);',
    '    lin *= 1.0 + u_lensVignette * 1.1 * smoothstep(0.25, 1.0, clamp(vr, 0.0, 1.5));',
    '  }',
    '',
    '  // 曝光在线性光中计算',
    '  lin *= exp2(u_exposure);',
    '  vec3 g = pow(max(lin, 0.0), vec3(1.0 / 2.2));',
    '  float lum = lumaOf(g);',
    '',
    '  // 基础明暗',
    '  g += u_blacks * 0.20 * pow(clamp(1.0 - smoothstep(0.0, 0.55, lum), 0.0, 1.0), 1.4);',
    '  g += u_shadows * 0.26 * pow(clamp(1.0 - smoothstep(0.0, 0.72, lum), 0.0, 1.0), 1.6);',
    '  g -= u_highlights * 0.28 * smoothstep(0.35, 1.0, lum);',
    '  g += u_whites * 0.20 * smoothstep(0.45, 1.0, lum);',
    '  g = (g - 0.5) * (1.0 + u_contrast * 0.85) + 0.5;',
    '',
    '  // 清晰度 / 锐化使用的邻域采样',
    '  vec2 px = 1.0 / u_texSize;',
    '  float sc = max(1.0, u_scale);',
    '  vec2 cpx = px * 1.5 * sc;',
    '  vec3 blurC = sampleChroma(lensRemap(v_uv + vec2(cpx.x, 0.0)))',
    '             + sampleChroma(lensRemap(v_uv - vec2(cpx.x, 0.0)))',
    '             + sampleChroma(lensRemap(v_uv + vec2(0.0, cpx.y)))',
    '             + sampleChroma(lensRemap(v_uv - vec2(0.0, cpx.y)));',
    '  float blurL = lumaOf(blurC * 0.25);',
    '  float detail = lumaOf(src) - blurL;',
    '  if (abs(u_clarity) > 0.0001) {',
    '    g += detail * u_clarity * 1.5;',
    '  }',
    '',
    '  // 去雾',
    '  if (u_dehaze > 0.0) {',
    '    g = (g - 0.045 * u_dehaze) * (1.0 + 0.32 * u_dehaze);',
    '  } else if (u_dehaze < 0.0) {',
    '    g += (-u_dehaze) * 0.16 * (1.0 - clamp(g, 0.0, 1.0));',
    '  }',
    '',
    '  // 自然饱和度 / 饱和度',
    '  float lum2 = lumaOf(g);',
    '  float mx = max(max(g.r, g.g), g.b);',
    '  float mn = min(min(g.r, g.g), g.b);',
    '  float satAmt = clamp(mx - mn, 0.0, 1.0);',
    '  g = mix(vec3(lum2), g, 1.0 + u_vibrance * 0.9 * (1.0 - satAmt));',
    '  lum2 = lumaOf(g);',
    '  g = mix(vec3(lum2), g, 1.0 + u_saturation * 0.9);',
    '  return g;',
    '}',
    '',
    'vec3 localAdjust(vec3 g, float m) {',
    '  vec3 lg = g;',
    '  lg *= vec3(exp2(u_local.z * 0.5), 1.0, exp2(-u_local.z * 0.5));',
    '  lg *= exp2(u_local.x);',
    '  lg = (lg - 0.5) * (1.0 + u_local.y * 0.8) + 0.5;',
    '  float ll = lumaOf(lg);',
    '  lg = mix(vec3(ll), lg, 1.0 + u_local.w * 0.9);',
    '  return mix(g, lg, m);',
    '}',
    '',
    'void main() {',
    '  // Pass 0：全局显影；原图对比时直接输出源像素。',
    '  if (u_pass < 0.5) {',
    '    if (u_before > 0.5) {',
    '      outColor = vec4(texture(u_image, v_uv).rgb, 1.0);',
    '      return;',
    '    }',
    '    vec3 src = sampleChroma(lensRemap(v_uv));',
    '    src = denoiseSource(src, v_uv);',
    '    outColor = vec4(clamp(globalAdjust(src), 0.0, 1.0), 1.0);',
    '    return;',
    '  }',
    '',
    '  // Pass 1：单个蒙版的局部调整。中间纹理的 t 轴与屏幕方向相反，采样时翻转。',
    '  if (u_pass < 1.5) {',
    '    vec3 g = texture(u_stage, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;',
    '    if (u_maskType > 0.5) {',
    '      float m = maskValue(v_uv);',
    '      g = localAdjust(g, m);',
    '    }',
    '    outColor = vec4(clamp(g, 0.0, 1.0), 1.0);',
    '    return;',
    '  }',
    '',
    '  // Pass 2：分通道曲线（先 RGB 复合、后单通道）+ 锐化 / 暗角 / 颗粒 / 蒙版显示。',
    '  vec3 g = texture(u_stage, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;',
    '',
    '  if (u_curveOn > 0.5) {',
    '    vec3 cg = clamp(g, 0.0, 1.0);',
    '    g = vec3(',
    '      texture(u_curve, vec2(cg.r, 1.0 / 6.0)).r,',
    '      texture(u_curve, vec2(cg.g, 3.0 / 6.0)).g,',
    '      texture(u_curve, vec2(cg.b, 5.0 / 6.0)).b',
    '    );',
    '  }',
    '',
    '  // 锐化',
    '  if (u_sharpen > 0.0001) {',
    '    vec2 px = 1.0 / u_texSize;',
    '    float sc = max(1.0, u_scale);',
    '    vec2 spx = px * sc;',
    '    vec3 n4 = sampleChroma(lensRemap(v_uv + vec2(spx.x, 0.0)))',
    '            + sampleChroma(lensRemap(v_uv - vec2(spx.x, 0.0)))',
    '            + sampleChroma(lensRemap(v_uv + vec2(0.0, spx.y)))',
    '            + sampleChroma(lensRemap(v_uv - vec2(0.0, spx.y)));',
    '    float sharpDetail = lumaOf(g) - lumaOf(n4 * 0.25);',
    '    g += sharpDetail * u_sharpen * 1.6;',
    '  }',
    '',
    '  // 暗角',
    '  if (abs(u_vignette) > 0.0001) {',
    '    vec2 vp = (v_uv - 0.5) * vec2(u_aspect, 1.0);',
    '    float d = length(vp) / (0.5 * max(u_aspect, 1.0));',
    '    float f = smoothstep(0.32, 1.0, d);',
    '    if (u_vignette >= 0.0) g *= 1.0 - u_vignette * 0.85 * f;',
    '    else g *= 1.0 + (-u_vignette) * 0.55 * f;',
    '  }',
    '',
    '  // 颗粒',
    '  if (u_grain > 0.0001) {',
    '    float n = hash21(v_uv * u_texSize + vec2(u_seed));',
    '    float mid = 1.0 - abs(clamp(lumaOf(g), 0.0, 1.0) - 0.5) * 1.6;',
    '    g += (n - 0.5) * u_grain * 0.16 * (0.35 + 0.65 * clamp(mid, 0.0, 1.0));',
    '  }',
    '',
    '  // 只显示当前活动蒙版的覆盖（红色叠加）',
    '  if (u_maskShow > 0.5 && u_maskType > 0.5) {',
    '    float mm = maskValue(v_uv);',
    '    g = mix(g, vec3(0.86, 0.16, 0.12), mm * 0.55);',
    '  }',
    '',
    '  vec3 lin = pow(max(g, 0.0), vec3(2.2));',
    '  vec3 outc = linearToSrgb(lin);',
    '  outColor = vec4(clamp(outc, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  var UNIFORM_NAMES = [
    'u_image', 'u_stage', 'u_curve', 'u_mask', 'u_texSize', 'u_aspect', 'u_before', 'u_pass',
    'u_exposure', 'u_contrast', 'u_highlights', 'u_shadows', 'u_whites', 'u_blacks',
    'u_temp', 'u_tint', 'u_vibrance', 'u_saturation', 'u_clarity', 'u_dehaze',
    'u_vignette', 'u_grain', 'u_sharpen', 'u_lensDistort', 'u_lensVignette', 'u_lensCa',
    'u_noiseLuma', 'u_noiseColor', 'u_maskType', 'u_maskInvert', 'u_maskShow',
    'u_maskFeather', 'u_maskP1', 'u_maskP2', 'u_local', 'u_curveOn', 'u_scale', 'u_seed'
  ];

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('WebGL shader compile failed: ' + log);
    }
    return sh;
  }

  function RawRenderer(canvas) {
    this.canvas = canvas;
    var gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    var vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('WebGL program link failed: ' + log);
    }
    this.program = prog;
    gl.useProgram(prog);

    this.u = {};
    for (var i = 0; i < UNIFORM_NAMES.length; i++) {
      this.u[UNIFORM_NAMES[i]] = gl.getUniformLocation(prog, UNIFORM_NAMES[i]);
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.imageTex = this.makeTexture();
    this.curveTex = this.makeTexture();
    this.emptyMaskTex = this.makeTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.emptyMaskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    this.maskTextures = Object.create(null);
    this.targets = null;
    this.curveLut = null;
    this.sourceW = 0;
    this.sourceH = 0;
    this.disposed = false;

    // 默认 1:1 曲线：256×3（R/G/B 各一行）
    var lut = new Uint8Array(256 * 3 * 4);
    for (var row = 0; row < 3; row++) {
      for (var k = 0; k < 256; k++) {
        var o = (row * 256 + k) * 4;
        lut[o] = k;
        lut[o + 1] = k;
        lut[o + 2] = k;
        lut[o + 3] = 255;
      }
    }
    this.setCurve(lut, false);
  }

  RawRenderer.prototype.makeTexture = function () {
    var gl = this.gl;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  };

  RawRenderer.prototype.setSource = function (source) {
    var gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.sourceW = source.width;
    this.sourceH = source.height;
  };

  RawRenderer.prototype.setCurve = function (lut, on) {
    var gl = this.gl;
    if (!lut || lut.length !== 256 * 3 * 4) {
      lut = new Uint8Array(256 * 3 * 4);
      for (var row = 0; row < 3; row++) {
        for (var i = 0; i < 256; i++) {
          var o = (row * 256 + i) * 4;
          lut[o] = i;
          lut[o + 1] = i;
          lut[o + 2] = i;
          lut[o + 3] = 255;
        }
      }
    }
    this.curveLut = lut;
    this.curveOn = on !== false;
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  };

  // 每个画笔蒙版独立纹理，按 id 缓存；id 为 null 时使用 1×1 黑色占位纹理。
  RawRenderer.prototype.setMask = function (id, canvas) {
    if (!canvas || id == null) return;
    var gl = this.gl;
    var key = String(id);
    var tex = this.maskTextures[key];
    if (!tex) {
      tex = this.makeTexture();
      this.maskTextures[key] = tex;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  };

  RawRenderer.prototype.clearMask = function (id) {
    if (id == null) return;
    var key = String(id);
    var tex = this.maskTextures[key];
    if (!tex) return;
    try { this.gl.deleteTexture(tex); } catch (e) { /* ignore */ }
    delete this.maskTextures[key];
  };

  RawRenderer.prototype.disposeTargets = function () {
    if (!this.targets) return;
    var gl = this.gl;
    try {
      gl.deleteFramebuffer(this.targets.fboA);
      gl.deleteFramebuffer(this.targets.fboB);
      gl.deleteTexture(this.targets.texA);
      gl.deleteTexture(this.targets.texB);
    } catch (e) { /* ignore */ }
    this.targets = null;
  };

  RawRenderer.prototype.ensureTargets = function (w, h) {
    if (this.targets && this.targets.w === w && this.targets.h === h) return;
    this.disposeTargets();
    var gl = this.gl;
    // 使用固定单元 5 创建 FBO 纹理，避免覆盖正在使用的源图/曲线/蒙版采样器。
    var prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE5);
    function makeTarget() {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('WebGL framebuffer incomplete: 0x' + status.toString(16));
      }
      return { tex: tex, fbo: fbo };
    }
    var a = makeTarget();
    var b = makeTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(prevActive);
    this.targets = { w: w, h: h, texA: a.tex, fboA: a.fbo, texB: b.tex, fboB: b.fbo };
  };

  RawRenderer.prototype.bindStage = function (tex) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex || this.emptyMaskTex);
  };

  RawRenderer.prototype.bindMask = function (id) {
    var gl = this.gl;
    var tex = id == null ? null : this.maskTextures[String(id)];
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tex || this.emptyMaskTex);
  };

  RawRenderer.prototype.setGlobalUniforms = function (params, w, h) {
    var gl = this.gl;
    var u = this.u;
    gl.uniform2f(u.u_texSize, Math.max(1, w), Math.max(1, h));
    gl.uniform1f(u.u_aspect, w / Math.max(1, h));
    gl.uniform1f(u.u_exposure, params.exposure);
    gl.uniform1f(u.u_contrast, params.contrast);
    gl.uniform1f(u.u_highlights, params.highlights);
    gl.uniform1f(u.u_shadows, params.shadows);
    gl.uniform1f(u.u_whites, params.whites);
    gl.uniform1f(u.u_blacks, params.blacks);
    gl.uniform1f(u.u_temp, params.temperature);
    gl.uniform1f(u.u_tint, params.tint);
    gl.uniform1f(u.u_vibrance, params.vibrance);
    gl.uniform1f(u.u_saturation, params.saturation);
    gl.uniform1f(u.u_clarity, params.clarity);
    gl.uniform1f(u.u_dehaze, params.dehaze);
    gl.uniform1f(u.u_vignette, params.vignette);
    gl.uniform1f(u.u_grain, params.grain);
    gl.uniform1f(u.u_sharpen, params.sharpen);
    gl.uniform1f(u.u_lensDistort, params.lensDistort);
    gl.uniform1f(u.u_lensVignette, params.lensVignette);
    gl.uniform1f(u.u_lensCa, params.lensCa);
    gl.uniform1f(u.u_noiseLuma, params.noiseLuma);
    gl.uniform1f(u.u_noiseColor, params.noiseColor);
    gl.uniform1f(u.u_scale, Math.max(1, w / 1600));
    gl.uniform1f(u.u_seed, 17.0);
  };

  RawRenderer.prototype.setMaskUniforms = function (mask) {
    var gl = this.gl;
    var u = this.u;
    if (!mask) {
      gl.uniform1f(u.u_maskType, 0);
      gl.uniform1f(u.u_maskInvert, 0);
      gl.uniform1f(u.u_maskShow, 0);
      gl.uniform1f(u.u_maskFeather, 0.5);
      gl.uniform2f(u.u_maskP1, 0.5, 0.5);
      gl.uniform2f(u.u_maskP2, 0.5, 0.5);
      gl.uniform4f(u.u_local, 0, 0, 0, 0);
      return;
    }
    var local = mask.local || [0, 0, 0, 0];
    gl.uniform1f(u.u_maskType, mask.type || 0);
    gl.uniform1f(u.u_maskInvert, mask.invert ? 1 : 0);
    gl.uniform1f(u.u_maskShow, 0);
    gl.uniform1f(u.u_maskFeather, mask.feather);
    gl.uniform2f(u.u_maskP1, mask.p1[0], mask.p1[1]);
    gl.uniform2f(u.u_maskP2, mask.p2[0], mask.p2[1]);
    gl.uniform4f(u.u_local, local[0], local[1], local[2], local[3]);
  };

  RawRenderer.prototype.draw = function () {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  };

  RawRenderer.prototype.render = function (params) {
    var gl = this.gl;
    var w = this.canvas.width;
    var h = this.canvas.height;
    if (!w || !h) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // 固定纹理单元：0 源图，1 中间结果，2 曲线 LUT，3 蒙版
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.uniform1i(this.u.u_image, 0);
    gl.uniform1i(this.u.u_stage, 1);
    gl.uniform1i(this.u.u_curve, 2);
    gl.uniform1i(this.u.u_mask, 3);

    this.setGlobalUniforms(params, w, h);
    this.setMaskUniforms(null);
    gl.uniform1f(this.u.u_curveOn, this.curveOn ? 1 : 0);

    // Before：直接输出原始像素。
    if (params.before) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.uniform1f(this.u.u_pass, 0);
      gl.uniform1f(this.u.u_before, 1);
      this.bindStage(this.imageTex);
      this.bindMask(null);
      this.draw();
      gl.activeTexture(gl.TEXTURE0);
      return;
    }

    this.ensureTargets(w, h);
    var targets = this.targets;

    // Pass 0：全局显影 → FBO A
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fboA);
    gl.viewport(0, 0, w, h);
    gl.uniform1f(this.u.u_pass, 0);
    gl.uniform1f(this.u.u_before, 0);
    this.bindStage(this.imageTex);
    this.bindMask(null);
    this.draw();

    // Pass 1..N：按列表顺序逐蒙版叠加，FBO A/B ping-pong
    var masks = params.masks || [];
    var stageTex = targets.texA;
    var destFbo = targets.fboB;
    for (var i = 0; i < masks.length; i++) {
      var mask = masks[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, destFbo);
      gl.viewport(0, 0, w, h);
      gl.uniform1f(this.u.u_pass, 1);
      gl.uniform1f(this.u.u_before, 0);
      this.setMaskUniforms(mask);
      this.bindStage(stageTex);
      this.bindMask(mask.type >= 3 ? mask.id : null);
      this.draw();
      if (destFbo === targets.fboB) {
        stageTex = targets.texB;
        destFbo = targets.fboA;
      } else {
        stageTex = targets.texA;
        destFbo = targets.fboB;
      }
    }

    // Pass Final：曲线、锐化、暗角、颗粒与当前蒙版覆盖显示 → 画布
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.uniform1f(this.u.u_pass, 2);
    gl.uniform1f(this.u.u_before, 0);
    var show = params.showMask || null;
    this.setMaskUniforms(show);
    gl.uniform1f(this.u.u_maskShow, show ? 1 : 0);
    this.bindStage(stageTex);
    this.bindMask(show && show.type >= 3 ? show.id : null);
    this.draw();

    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  };

  RawRenderer.prototype.dispose = function () {
    if (this.disposed) return;
    this.disposed = true;
    var gl = this.gl;
    try {
      gl.deleteTexture(this.imageTex);
      gl.deleteTexture(this.curveTex);
      gl.deleteTexture(this.emptyMaskTex);
      var keys = Object.keys(this.maskTextures);
      for (var i = 0; i < keys.length; i++) gl.deleteTexture(this.maskTextures[keys[i]]);
      this.maskTextures = Object.create(null);
      this.disposeTargets();
      gl.deleteProgram(this.program);
      gl.deleteVertexArray(this.vao);
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (e) { /* ignore */ }
  };

  /* ------------------------------------------------------------------ *
   * HTML 模板
   * ------------------------------------------------------------------ */

  function sliderHTML(def, scope) {
    var id = 'raw-' + scope + '-' + def.key;
    return '<div class="raw-slider">' +
      '<label for="' + id + '">' + def.label + '</label>' +
      '<input id="' + id + '" type="range" min="' + def.min + '" max="' + def.max +
      '" step="' + def.step + '" value="' + def.def + '" data-' + scope + '="' + def.key +
      '" aria-label="' + def.label + '">' +
      '<output for="' + id + '" data-out-' + scope + '="' + def.key + '">' +
      fmtAdjust(def, def.def) + '</output>' +
      '</div>';
  }

  function buildHTML() {
    var basicSliders = ADJUSTMENTS.map(function (d) { return sliderHTML(d, 'adj'); }).join('');
    var localSliders = LOCALS.map(function (d) { return sliderHTML(d, 'local'); }).join('');
    var lensSliders = LENS.map(function (d) { return sliderHTML(d, 'adj'); }).join('');
    var detailSliders = DETAIL.map(function (d) { return sliderHTML(d, 'adj'); }).join('');
    var paramRegionSliders = PARAM_CURVE.filter(function (d) { return d.unit !== '%'; })
      .map(function (d) { return sliderHTML(d, 'param'); }).join('');
    var paramSplitSliders = PARAM_CURVE.filter(function (d) { return d.unit === '%'; })
      .map(function (d) { return sliderHTML(d, 'param'); }).join('');

    return '' +
      '<div class="raw-head">' +
        '<div class="raw-head-main">' +
          '<div class="raw-eyebrow">Camera Raw · 本地显影</div>' +
          '<h2>RAW 显影</h2>' +
          '<p>解码 CR2 / CR3 / NEF / ARW / DNG / RAF / ORW 等相机原始文件，在浏览器内完成曝光、点曲线与参数曲线、裁剪旋转、镜头校正、降噪与智能蒙版调整，并导出 JPEG / PNG。<b>图片不会上传</b>，关闭页面即清除。</p>' +
        '</div>' +
        '<div class="raw-head-actions">' +
          '<button type="button" class="raw-btn primary" data-act="open">' + icon('open') + '打开文件</button>' +
          '<button type="button" class="raw-btn" data-act="undo" id="raw-undo" disabled title="撤销 (Ctrl+Z)">撤销</button>' +
          '<button type="button" class="raw-btn" data-act="redo" id="raw-redo" disabled title="重做 (Ctrl+Shift+Z)">重做</button>' +
          '<button type="button" class="raw-btn" data-act="export">' + icon('download') + '导出</button>' +
        '</div>' +
      '</div>' +

      '<div class="raw-body">' +
        '<section class="raw-stage" aria-label="RAW 预览">' +
          '<div class="raw-stage-bar">' +
            '<div class="raw-file" id="raw-file">' +
              '<span class="raw-file-dot"></span>' +
              '<span class="raw-file-name" id="raw-filename">尚未载入文件</span>' +
              '<span class="raw-file-tag" id="raw-filetag" hidden>RAW</span>' +
            '</div>' +
            '<div class="raw-view-tools">' +
              '<button type="button" class="raw-btn" data-act="before" id="raw-before" title="切换原图与调整后">' +
                icon('compare') + '<span data-before-label>原图对比</span></button>' +
              '<button type="button" class="raw-btn" data-act="fit" title="适应窗口">适应</button>' +
              '<button type="button" class="raw-btn" data-act="one" title="100% 像素">100%</button>' +
              '<div class="raw-zoom"><span>缩放</span>' +
                '<input id="raw-zoom" type="range" min="25" max="200" step="1" value="100" aria-label="预览缩放">' +
                '<span id="raw-zoom-val">适应</span></div>' +
              '<button type="button" class="raw-btn" data-act="reset" title="重置全部调整">' + icon('reset') + '重置</button>' +
            '</div>' +
          '</div>' +
          '<div class="raw-canvas-wrap" id="raw-drop">' +
            '<div class="raw-empty" id="raw-empty" role="button" tabindex="0" aria-label="选择或拖入图片">' +
              '<div class="raw-empty-icon">' + icon('camera') + '</div>' +
              '<h3>拖入 RAW 或点击选择文件</h3>' +
              '<p>支持相机原始文件与 JPEG / PNG / WebP。解码、预览和导出全部在本机完成。</p>' +
              '<div class="raw-empty-formats">CR2 · CR3 · NEF · NRW · ARW · SR2 · DNG · RAF · ORF · ORI · RW2 · PEF · SRW · 3FR · KDC</div>' +
              '<span class="raw-empty-privacy">' + icon('lock') + '图片不上传，无服务器请求</span>' +
            '</div>' +
            '<canvas id="raw-canvas" class="is-hidden" aria-label="RAW 预览画布"></canvas>' +
            '<div class="raw-busy-overlay" id="raw-busy" hidden>' +
              '<span class="raw-spinner"></span><b id="raw-busy-title">正在载入</b>' +
              '<span id="raw-busy-sub">大文件解码可能需要数秒，请保持此页打开。</span>' +
            '</div>' +
            '<div class="raw-crop-overlay" id="raw-crop-overlay" hidden>' +
              '<div class="raw-crop-box" id="raw-crop-box" data-crop-box>' +
                '<span class="raw-crop-grid" aria-hidden="true"></span>' +
                '<span class="raw-crop-handle is-nw" data-handle="nw"></span>' +
                '<span class="raw-crop-handle is-n" data-handle="n"></span>' +
                '<span class="raw-crop-handle is-ne" data-handle="ne"></span>' +
                '<span class="raw-crop-handle is-e" data-handle="e"></span>' +
                '<span class="raw-crop-handle is-se" data-handle="se"></span>' +
                '<span class="raw-crop-handle is-s" data-handle="s"></span>' +
                '<span class="raw-crop-handle is-sw" data-handle="sw"></span>' +
                '<span class="raw-crop-handle is-w" data-handle="w"></span>' +
                '<span class="raw-crop-size" id="raw-crop-size"></span>' +
              '</div>' +
              '<div class="raw-crop-bar">' +
                '<span><b>裁剪</b> 拖动框内移动，拖动边角调整</span>' +
                '<button type="button" class="raw-btn tiny primary" data-act="crop-apply">应用裁剪</button>' +
                '<button type="button" class="raw-btn tiny" data-act="crop-cancel">取消</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="raw-stage-foot">' +
            '<div class="raw-status" aria-live="polite">' +
              '<span class="raw-spinner" id="raw-spinner" hidden></span>' +
              '<span class="raw-status-text" id="raw-status">等待载入 RAW 或图片…</span>' +
            '</div>' +
            '<div class="raw-foot-right" id="raw-foot-right">本地解码 · 不上传</div>' +
          '</div>' +
        '</section>' +

        '<aside class="raw-side" aria-label="调整面板">' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('info') + '<span>元数据</span><span class="raw-sum-meta" id="raw-meta-sum">—</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<dl class="raw-meta" id="raw-meta">' +
                '<div><dt>相机</dt><dd id="raw-m-camera">—</dd></div>' +
                '<div><dt>镜头</dt><dd id="raw-m-lens">—</dd></div>' +
                '<div><dt>ISO</dt><dd id="raw-m-iso">—</dd></div>' +
                '<div><dt>快门</dt><dd id="raw-m-shutter">—</dd></div>' +
                '<div><dt>光圈</dt><dd id="raw-m-aperture">—</dd></div>' +
                '<div><dt>焦距</dt><dd id="raw-m-focal">—</dd></div>' +
                '<div><dt>尺寸</dt><dd id="raw-m-size">—</dd></div>' +
                '<div><dt>格式</dt><dd id="raw-m-format">—</dd></div>' +
                '<div><dt>解码耗时</dt><dd id="raw-m-decode">—</dd></div>' +
                '<div><dt>文件大小</dt><dd id="raw-m-file">—</dd></div>' +
              '</dl>' +
              '<p class="raw-file-note" id="raw-file-note" hidden>' + icon('info') + '<span></span></p>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('history') + '<span>历史记录</span><span class="raw-sum-meta" id="raw-history-sum">—</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body raw-history-body">' +
              '<div class="raw-history-list" id="raw-history-list" aria-label="历史记录"></div>' +
              '<p class="raw-group-hint raw-history-hint">点击任意步骤回到该状态；回到旧步骤后继续调整会丢弃其后的步骤。</p>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('sliders') + '<span>基本调整</span><span class="raw-sum-meta" id="raw-adj-sum">0 项</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-sliders" id="raw-adj-sliders">' + basicSliders + '</div>' +
              '<p class="raw-group-hint" style="margin:9px 0 0;font-size:10.5px;color:var(--raw-ink-3)">双击滑杆可单独复位。曝光以 EV 计算，色温 / 色调为相对相机白平衡的偏移。</p>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group" open id="raw-geometry-group">' +
            '<summary>' + icon('crop') + '<span>几何与裁剪</span><span class="raw-sum-meta" id="raw-geo-sum">原始</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-geo-row">' +
                '<button type="button" class="raw-btn tiny" data-act="rotate-left" title="逆时针旋转 90°">' + icon('rotate') + '左转</button>' +
                '<button type="button" class="raw-btn tiny" data-act="rotate-right" title="顺时针旋转 90°">右转</button>' +
                '<button type="button" class="raw-btn tiny" data-act="flip-h" title="水平镜像">' + icon('flip') + '水平</button>' +
                '<button type="button" class="raw-btn tiny" data-act="flip-v" title="垂直镜像">垂直</button>' +
              '</div>' +
              '<div class="raw-slider raw-geo-angle">' +
                '<label for="raw-geo-angle">拉直</label>' +
                '<input id="raw-geo-angle" type="range" min="-45" max="45" step="0.1" value="0" data-geo="angle">' +
                '<output for="raw-geo-angle" id="raw-geo-angle-v">0.0°</output>' +
              '</div>' +
              '<div class="raw-crop-controls">' +
                '<label class="raw-field-label" for="raw-crop-aspect">比例</label>' +
                '<select class="raw-select" id="raw-crop-aspect">' +
                  '<option value="free">自由</option>' +
                  '<option value="original">原始比例</option>' +
                  '<option value="1:1">1 : 1</option>' +
                  '<option value="4:3">4 : 3</option>' +
                  '<option value="3:2">3 : 2</option>' +
                  '<option value="16:9">16 : 9</option>' +
                '</select>' +
                '<button type="button" class="raw-btn tiny primary" data-act="crop-mode" id="raw-crop-toggle">' + icon('crop') + '裁剪</button>' +
                '<button type="button" class="raw-btn tiny" data-act="geometry-reset">重置</button>' +
              '</div>' +
              '<div class="raw-crop-apply-row" id="raw-crop-apply-row" hidden>' +
                '<button type="button" class="raw-btn primary" data-act="crop-apply">应用裁剪</button>' +
                '<button type="button" class="raw-btn" data-act="crop-cancel">取消</button>' +
              '</div>' +
              '<p class="raw-group-hint raw-geo-note" id="raw-geo-note">拉直会自动放大以避免空白边缘；旋转或翻转后仍可继续裁剪。</p>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group">' +
            '<summary>' + icon('lens') + '<span>镜头校正</span><span class="raw-sum-meta" id="raw-lens-sum">手动</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<p class="raw-group-hint">没有镜头配置文件，按画面边缘手动校正。畸变正负对应枕形 / 桶形，暗角校正只提亮四角。</p>' +
              '<div class="raw-sliders" id="raw-lens-sliders">' + lensSliders + '</div>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group">' +
            '<summary>' + icon('sliders') + '<span>细节与降噪</span><span class="raw-sum-meta" id="raw-detail-sum">关闭</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<p class="raw-group-hint">降噪作用于原始像素并保留边缘。高 ISO 可从亮度 20–40、色彩 25–50 开始；过强会损失细节。</p>' +
              '<div class="raw-sliders" id="raw-detail-sliders">' + detailSliders + '</div>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('curve') + '<span>色调曲线</span><span class="raw-sum-meta" id="raw-curve-sum">RGB · 线性</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-curve-channels" id="raw-curve-channels" role="group" aria-label="曲线通道">' +
                '<button type="button" data-curve-channel="rgb" class="is-active" aria-pressed="true"><span class="raw-ch-dot is-rgb"></span>RGB</button>' +
                '<button type="button" data-curve-channel="r" aria-pressed="false"><span class="raw-ch-dot is-r"></span>红</button>' +
                '<button type="button" data-curve-channel="g" aria-pressed="false"><span class="raw-ch-dot is-g"></span>绿</button>' +
                '<button type="button" data-curve-channel="b" aria-pressed="false"><span class="raw-ch-dot is-b"></span>蓝</button>' +
              '</div>' +
              '<div class="raw-curve-wrap"><canvas id="raw-curve" aria-label="色调曲线编辑器"></canvas><span class="raw-curve-axis-l">暗部</span><span class="raw-curve-axis-r">高光</span></div>' +
              '<div class="raw-curve-foot">' +
                '<div class="raw-curve-actions">' +
                  '<button type="button" class="raw-btn" data-curve="linear">线性</button>' +
                  '<button type="button" class="raw-btn" data-curve="soft">柔和</button>' +
                  '<button type="button" class="raw-btn" data-curve="contrast">强对比</button>' +
                  '<button type="button" class="raw-btn" data-curve="reset">重置通道</button>' +
                '</div>' +
                '<span class="raw-curve-hint" id="raw-curve-hint">先 RGB 复合，再单通道 · 点击加点 / 拖动 / 双击删点</span>' +
              '</div>' +
              '<div class="raw-param-curve" id="raw-param-curve">' +
                '<div class="raw-param-head">' +
                  '<span><b>参数曲线</b><em>仅 RGB 复合 · 按四个亮度区间微调，叠加在点曲线之后</em></span>' +
                  '<button type="button" class="raw-btn tiny" data-act="param-reset">重置参数</button>' +
                '</div>' +
                '<div class="raw-param-sliders">' + paramRegionSliders + '</div>' +
                '<div class="raw-param-split-head"><span>区间分界</span><span>阴影 · 暗调 · 亮调 · 高光</span></div>' +
                '<div class="raw-param-splits">' + paramSplitSliders + '</div>' +
                '<p class="raw-curve-hint raw-param-hint">虚线为叠加参数后的实际曲线。四个滑杆分别压暗 / 提亮对应亮度区域。</p>' +
              '</div>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('mask') + '<span>蒙版</span><span class="raw-sum-meta" id="raw-mask-sum">1 个 · 蒙版 1</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-mask-list-head"><span>蒙版列表</span><span id="raw-mask-count">1 / 8</span></div>' +
              '<div class="raw-mask-list" id="raw-mask-list" aria-label="蒙版列表"></div>' +
              '<div class="raw-mask-create-row" id="raw-mask-create-row">' +
                '<label for="raw-mask-new-type">新建</label>' +
                '<select id="raw-mask-new-type" class="raw-select raw-mask-new-type">' +
                  '<option value="linear">线性渐变</option>' +
                  '<option value="radial">径向渐变</option>' +
                  '<option value="brush">画笔</option>' +
                  '<option value="subject">智能主体</option>' +
                  '<option value="sky">智能天空</option>' +
                '</select>' +
                '<button type="button" class="raw-btn tiny primary" data-act="mask-add">＋ 添加蒙版</button>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-duplicate">复制</button>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-remove">删除</button>' +
              '</div>' +
              '<div class="raw-seg" id="raw-mask-seg" role="group" aria-label="当前蒙版类型">' +
                '<button type="button" data-mask="none">无</button>' +
                '<button type="button" data-mask="linear" class="is-active">线性渐变</button>' +
                '<button type="button" data-mask="radial">径向渐变</button>' +
                '<button type="button" data-mask="brush">画笔</button>' +
                '<button type="button" data-mask="subject">智能主体</button>' +
                '<button type="button" data-mask="sky">智能天空</button>' +
              '</div>' +
              '<p class="raw-group-hint" style="margin:5px 0 9px;font-size:10.5px;color:var(--raw-ink-3)">切换当前蒙版类型会重置范围；想保留已有范围请用上方“新建”添加。</p>' +
              '<p class="raw-mask-note" id="raw-mask-note"><b>线性渐变</b>：在画面上从起点拖到终点，<b>终点一侧</b>为蒙版内；可调羽化与局部参数。</p>' +
              '<div class="raw-mask-actions">' +
                '<label class="raw-check"><input type="checkbox" id="raw-mask-invert">反转</label>' +
                '<label class="raw-check"><input type="checkbox" id="raw-mask-show">显示蒙版</label>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-clear">清除笔画 / 范围</button>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-ai-refresh" id="raw-mask-ai-refresh" hidden>' + icon('wand') + '重新识别</button>' +
              '</div>' +
              '<div class="raw-slider" style="margin-bottom:9px">' +
                '<label for="raw-mask-feather">羽化</label>' +
                '<input id="raw-mask-feather" type="range" min="0" max="100" step="1" value="45">' +
                '<output for="raw-mask-feather" id="raw-mask-feather-v">45</output>' +
              '</div>' +
              '<div class="raw-slider" id="raw-brush-size-row" style="margin-bottom:10px" hidden>' +
                '<label for="raw-brush-size">画笔大小</label>' +
                '<input id="raw-brush-size" type="range" min="1" max="24" step="1" value="8">' +
                '<output for="raw-brush-size" id="raw-brush-size-v">8%</output>' +
              '</div>' +
              '<div class="raw-brush-row" id="raw-brush-extra" hidden>' +
                '<div class="raw-seg raw-brush-mode" id="raw-brush-mode" role="group" aria-label="画笔模式">' +
                  '<button type="button" data-brush-mode="add" class="is-active">添加</button>' +
                  '<button type="button" data-brush-mode="subtract">擦除</button>' +
                '</div>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-undo-stroke">撤销笔画</button>' +
              '</div>' +
              '<div class="raw-subhead"><span>当前蒙版局部调整</span><span id="raw-local-scope">线性渐变</span></div>' +
              '<div class="raw-sliders raw-local" id="raw-local-sliders">' + localSliders + '</div>' +
            '</div>' +
          '</details>' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('download') + '<span>导出</span><span class="raw-sum-meta" id="raw-export-sum">JPEG</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-export-row">' +
                '<div class="raw-select-wrap">' +
                  '<label class="raw-field-label" for="raw-export-format">格式</label>' +
                  '<select class="raw-select" id="raw-export-format">' +
                    '<option value="image/jpeg">JPEG（较小，可调质量）</option>' +
                    '<option value="image/png">PNG（无损，文件较大）</option>' +
                  '</select>' +
                '</div>' +
                '<div class="raw-export-actions">' +
                  '<button type="button" class="raw-btn primary" data-act="export" id="raw-export-btn" disabled>' + icon('download') + '导出原尺寸</button>' +
                '</div>' +
              '</div>' +
              '<div class="raw-slider raw-quality" id="raw-quality-row">' +
                '<label for="raw-quality">质量</label>' +
                '<input id="raw-quality" type="range" min="60" max="100" step="1" value="92">' +
                '<output for="raw-quality" id="raw-quality-v">92</output>' +
              '</div>' +
              '<p class="raw-export-note">导出会重新以全分辨率解码原始文件并应用当前调整与蒙版。10 MP 约需数秒；超大文件会先提示耗时，内存不足时自动退回预览分辨率并明确标注。</p>' +
              '<div class="raw-export-result" id="raw-export-result" hidden></div>' +
            '</div>' +
          '</details>' +
        '</aside>' +
      '</div>' +
      '<input type="file" id="raw-input" class="raw-visually-hidden" accept="' + ACCEPT + '">';
  }

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var maskSeq = 0;

  function cloneCurvePoints(pts) {
    return pts.map(function (p) { return { x: p.x, y: p.y }; });
  }

  function createCurves() {
    return {
      rgb: cloneCurvePoints(IDENTITY_CURVE),
      r: cloneCurvePoints(IDENTITY_CURVE),
      g: cloneCurvePoints(IDENTITY_CURVE),
      b: cloneCurvePoints(IDENTITY_CURVE)
    };
  }

  function channelInfo(key) {
    for (var i = 0; i < CURVE_CHANNELS.length; i++) {
      if (CURVE_CHANNELS[i].key === key) return CURVE_CHANNELS[i];
    }
    return CURVE_CHANNELS[0];
  }

  function maskTypeLabel(type) {
    return type === 'linear' ? '线性' : type === 'radial' ? '径向' :
      type === 'brush' ? '画笔' : type === 'sky' ? '智能天空' :
      type === 'subject' ? '智能主体' : '未启用';
  }

  function maskGeometryDefaults(type) {
    if (type === 'radial') return { p1: { x: 0.5, y: 0.5 }, p2: { x: 0.28, y: 0.28 } };
    return { p1: { x: 0.2, y: 0.5 }, p2: { x: 0.8, y: 0.5 } };
  }

  function applyMaskOptions(mask, opts) {
    if (!opts) return mask;
    if (opts.name) mask.name = String(opts.name);
    if (opts.enabled != null) mask.enabled = !!opts.enabled;
    if (opts.show != null) mask.show = !!opts.show;
    if (opts.invert != null) mask.invert = !!opts.invert;
    if (opts.feather != null) mask.feather = clamp(Number(opts.feather), 0, 1);
    if (opts.brushPct != null) mask.brushPct = clamp(Number(opts.brushPct), 1, 24);
    if (opts.brushMode === 'subtract' || opts.brushMode === 'add') mask.brushMode = opts.brushMode;
    if (opts.p1) mask.p1 = { x: clamp(Number(opts.p1.x), 0, 1), y: clamp(Number(opts.p1.y), 0, 1) };
    if (opts.p2) mask.p2 = { x: clamp(Number(opts.p2.x), 0, 1), y: clamp(Number(opts.p2.y), 0, 1) };
    if (opts.strokes) {
      mask.strokes = opts.strokes.map(function (stroke) {
        var pts = stroke.points || stroke || [];
        return {
          radius: stroke.radius != null ? Number(stroke.radius) : Math.max(0.005, mask.brushPct / 200),
          mode: stroke.mode === 'subtract' ? 'subtract' : 'add',
          points: pts.map(function (p) { return { x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1) }; })
        };
      });
    }
    if (opts.local) {
      LOCALS.forEach(function (d) {
        if (opts.local[d.key] != null) mask.local[d.key] = clamp(Number(opts.local[d.key]), d.min, d.max);
      });
    }
    return mask;
  }

  function createMask(type, opts) {
    maskSeq += 1;
    type = normalizeMaskType(type);
    var geo = maskGeometryDefaults(type);
    var smart = isSmartMaskType(type);
    var mask = {
      id: 'mask-' + maskSeq,
      name: smart ? (type === 'sky' ? '天空 ' : '主体 ') + maskSeq : '蒙版 ' + maskSeq,
      type: type,
      enabled: true,
      show: false,
      invert: false,
      feather: type === 'brush' ? 0.35 : smart ? 0.3 : 0.45,
      p1: geo.p1,
      p2: geo.p2,
      strokes: [],
      brushPct: 8,
      brushMode: 'add',
      local: defaultLocal(),
      current: null,
      dragMode: '',
      _start: null,
      _moved: false
    };
    return applyMaskOptions(mask, opts);
  }

  function createState() {
    var initialMask = createMask('linear');
    return {
      loaded: false,
      busy: false,
      fileName: '',
      fileSize: 0,
      fileKind: 'raw',
      fileExt: '',
      raw: null,
      flashraw: null,
      imageFile: null,
      meta: null,
      fullSize: { w: 0, h: 0 },
      preview: null,
      previewCanvas: null,
      renderSource: null,
      renderW: 0,
      renderH: 0,
      histogram: null,
      decodeMs: 0,
      previewDecodeMs: 0,
      backendLabel: 'WebGL2',
      sourceNote: '',
      sourceWarn: false,
      adjust: defaultAdjust(),
      before: false,
      curves: createCurves(),
      paramCurve: defaultParamCurve(),
      curveChannel: 'rgb',
      curveLut: null,
      curveOn: false,
      curveDragging: -1,
      geometry: defaultGeometry(),
      cropEditing: false,
      cropAspect: 'free',
      cropRect: null,
      cropBackup: null,
      cropDrag: null,
      masks: [initialMask],
      activeMaskId: initialMask.id,
      zoomMode: 'fit',
      zoomPct: 100,
      lastExport: null,
      loadSeq: 0
    };
  }

  /* ------------------------------------------------------------------ *
   * 挂载
   * ------------------------------------------------------------------ */

  var mountedRoots = [];
  var state = createState();
  var root = null;
  var els = {};
  var renderer = null;
  var curveCanvas = null;
  var curveCtx = null;
  var vendorBase = '';
  var flashrawPromise = null;
  var rafPending = false;
  var maskBuildQueue = Object.create(null);
  var maskBuildRaf = false;
  var previewMaskCanvases = Object.create(null);
  var resizeObserver = null;
  var curveResizeObserver = null;
  var glLost = false;
  var historyEntries = [];
  var historyIndex = -1;
  var historyTimer = 0;
  var historyPendingLabel = '';
  var historySuspend = false;
  var histogramTimer = 0;
  var aiBaseCache = Object.create(null);
  var geometryRaf = 0;
  var cropSyncRaf = 0;
  var smartMaskTimer = 0;

  function resolveVendorBase() {
    var scripts = Array.prototype.slice.call(document.scripts || []);
    var me = null;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      if (/(?:^|\/)raw\.js(?:[?#]|$)/.test(src)) { me = src; break; }
    }
    var base = me ? new URL('.', me) : new URL('assets/js/', document.baseURI);
    return new URL('../vendor/flashraw/', base).href;
  }

  function ensureFlashRaw() {
    if (!flashrawPromise) {
      flashrawPromise = (async function () {
        var mod = await import(vendorBase + 'browser.js');
        await mod.init({ baseUrl: vendorBase, threads: false, jpegxl: 'never' });
        return mod;
      })().catch(function (err) {
        flashrawPromise = null;
        throw err;
      });
    }
    return flashrawPromise;
  }

  function mount(el) {
    if (!el || el.dataset.rawMounted === '1') return null;
    if (root) {
      // 只支持一个活动挂载点：保留第一次挂载的实例。
      return null;
    }
    root = el;
    root.dataset.rawMounted = '1';
    root.innerHTML = buildHTML();

    els = {
      file: $('#raw-file', root),
      filename: $('#raw-filename', root),
      filetag: $('#raw-filetag', root),
      beforeBtn: $('#raw-before', root),
      beforeLabel: $('[data-before-label]', root),
      zoom: $('#raw-zoom', root),
      zoomVal: $('#raw-zoom-val', root),
      drop: $('#raw-drop', root),
      empty: $('#raw-empty', root),
      canvas: $('#raw-canvas', root),
      busy: $('#raw-busy', root),
      busyTitle: $('#raw-busy-title', root),
      busySub: $('#raw-busy-sub', root),
      spinner: $('#raw-spinner', root),
      status: $('#raw-status', root),
      footRight: $('#raw-foot-right', root),
      input: $('#raw-input', root),
      metaSum: $('#raw-meta-sum', root),
      meta: {
        camera: $('#raw-m-camera', root),
        lens: $('#raw-m-lens', root),
        iso: $('#raw-m-iso', root),
        shutter: $('#raw-m-shutter', root),
        aperture: $('#raw-m-aperture', root),
        focal: $('#raw-m-focal', root),
        size: $('#raw-m-size', root),
        format: $('#raw-m-format', root),
        decode: $('#raw-m-decode', root),
        file: $('#raw-m-file', root)
      },
      fileNote: $('#raw-file-note', root),
      fileNoteText: $('#raw-file-note span', root),
      adjSum: $('#raw-adj-sum', root),
      curveSum: $('#raw-curve-sum', root),
      curveCanvas: $('#raw-curve', root),
      curveChannels: $('#raw-curve-channels', root),
      curveHint: $('#raw-curve-hint', root),
      historyList: $('#raw-history-list', root),
      historySum: $('#raw-history-sum', root),
      geoSum: $('#raw-geo-sum', root),
      geoNote: $('#raw-geo-note', root),
      geoAngle: $('#raw-geo-angle', root),
      geoAngleV: $('#raw-geo-angle-v', root),
      cropAspect: $('#raw-crop-aspect', root),
      cropToggle: $('#raw-crop-toggle', root),
      cropApplyRow: $('#raw-crop-apply-row', root),
      cropOverlay: $('#raw-crop-overlay', root),
      cropBox: $('#raw-crop-box', root),
      cropSize: $('#raw-crop-size', root),
      lensSum: $('#raw-lens-sum', root),
      detailSum: $('#raw-detail-sum', root),
      maskAI: $('#raw-mask-ai-refresh', root),
      maskSum: $('#raw-mask-sum', root),
      maskSeg: $('#raw-mask-seg', root),
      maskList: $('#raw-mask-list', root),
      maskCount: $('#raw-mask-count', root),
      maskNewType: $('#raw-mask-new-type', root),
      maskNote: $('#raw-mask-note', root),
      maskInvert: $('#raw-mask-invert', root),
      maskShow: $('#raw-mask-show', root),
      maskFeather: $('#raw-mask-feather', root),
      maskFeatherV: $('#raw-mask-feather-v', root),
      brushRow: $('#raw-brush-size-row', root),
      brushSize: $('#raw-brush-size', root),
      brushSizeV: $('#raw-brush-size-v', root),
      brushExtra: $('#raw-brush-extra', root),
      brushMode: $('#raw-brush-mode', root),
      localSliders: $('#raw-local-sliders', root),
      localScope: $('#raw-local-scope', root),
      exportFormat: $('#raw-export-format', root),
      exportQuality: $('#raw-quality', root),
      qualityRow: $('#raw-quality-row', root),
      qualityV: $('#raw-quality-v', root),
      exportBtn: $('#raw-export-btn', root),
      exportResult: $('#raw-export-result', root),
      exportSum: $('#raw-export-sum', root)
    };

    var cfg = window.RAWDevelopConfig || {};
    if (cfg.vendorBase) {
      vendorBase = new URL(cfg.vendorBase, document.baseURI).href;
      if (!/\/$/.test(vendorBase)) vendorBase += '/';
    } else {
      vendorBase = resolveVendorBase();
    }
    curveCanvas = els.curveCanvas;
    curveCtx = curveCanvas.getContext('2d');

    // WebGL 可用性探测
    try {
      var probe = document.createElement('canvas');
      var glProbe = probe.getContext('webgl2');
      if (!glProbe) {
        setStatus('当前浏览器不支持 WebGL2，无法进行实时显影。请更新浏览器或开启硬件加速。', 'err');
      }
    } catch (e) {
      setStatus('当前浏览器不支持 WebGL2，无法进行实时显影。', 'err');
    }

    bindEvents();
    initCurveEditor();
    updateMaskUI();
    updateAdjustOutputs();
    updateParamCurveUI();
    updateCurveUI();
    updateBeforeLabel();
    updateGeometryUI();
    renderHistoryPanel();
    updateHistoryUI();
    scheduleRender();
    mountedRoots.push(el);
    return api;
  }

  /* ------------------------------------------------------------------ *
   * 状态 / 提示
   * ------------------------------------------------------------------ */

  function setStatus(text, kind, spinning) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.className = 'raw-status-text' + (kind ? ' is-' + kind : '');
    if (els.spinner) els.spinner.hidden = !spinning;
  }

  function setBusy(on, title, sub) {
    state.busy = !!on;
    if (!els.busy) return;
    els.busy.hidden = !on;
    if (title) els.busyTitle.textContent = title;
    if (sub !== undefined) els.busySub.textContent = sub;
    root.querySelectorAll('button, select, input').forEach(function (n) {
      if (n.id === 'raw-input') return;
      if (on) {
        n.dataset.wasDisabled = n.disabled ? '1' : '0';
        n.disabled = true;
      } else if (n.dataset.wasDisabled !== undefined) {
        n.disabled = n.dataset.wasDisabled === '1';
        delete n.dataset.wasDisabled;
      }
    });
  }

  function updateFootRight() {
    if (!els.footRight) return;
    if (state.preview) {
      els.footRight.textContent = (state.renderW || state.preview.w) + '×' + (state.renderH || state.preview.h) + ' 预览 · ' + state.backendLabel;
    } else {
      els.footRight.textContent = '本地解码 · 不上传';
    }
  }

  function baselineStatus() {
    if (!state.loaded || !state.preview) return '等待载入 RAW 或图片…';
    return '已载入 ' + state.fileName + ' · ' + (state.renderW || state.preview.w) + '×' + (state.renderH || state.preview.h) +
      ' 预览 · 解码 ' + Math.round(state.decodeMs) + ' ms';
  }

  function restoreBaselineIfNeeded() {
    if (!state.loaded || !els.status) return;
    var t = els.status.textContent || '';
    if (t.indexOf('已重置') === 0 || t.indexOf('等待载入') === 0) {
      setStatus(baselineStatus(), 'ok');
    }
  }

  /* ------------------------------------------------------------------ *
   * 文件载入
   * ------------------------------------------------------------------ */

  function isImageFile(file) {
    var name = file.name || '';
    if (RAW_RE.test(name)) return false;
    if (IMAGE_RE.test(name)) return true;
    return /^image\/(jpeg|png|webp|avif|gif|bmp)/i.test(file.type || '');
  }

  function openPicker() {
    if (!els.input) return;
    els.input.value = '';
    els.input.click();
  }

  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    loadFile(fileList[0]);
  }

  async function loadFile(file) {
    if (!file || state.busy) return;
    if (file.size > MAX_FILE_BYTES) {
      setStatus('文件超过 ' + formatBytes(MAX_FILE_BYTES) + '，浏览器内存可能不足，已取消。', 'err');
      return;
    }

    var seq = ++state.loadSeq;
    var name = file.name || '未命名文件';
    var ext = extOf(name);
    var kind = isImageFile(file) ? 'image' : 'raw';
    var oldRaw = state.raw;
    var newRaw = null;

    setBusy(true, kind === 'raw' ? '正在解码 RAW' : '正在读取图片',
      kind === 'raw' ? '首次使用需加载约 2.9 MB 的本地 WASM 解码器。' : '图片仅在浏览器内存中处理。');
    setStatus(kind === 'raw' ? '正在读取 RAW 元数据与像素…' : '正在解码图片…', '', true);
    await nextFrame();
    if (seq !== state.loadSeq) { setBusy(false); return; }

    try {
      var result;
      if (kind === 'raw') {
        result = await decodeRawFile(file);
      } else {
        result = await decodeImageFile(file);
      }
      if (seq !== state.loadSeq) {
        if (result.raw) result.raw.close();
        setBusy(false);
        return;
      }

      // 新文件使用独立编辑状态，避免上一张图的局部蒙版/裁剪套到新画面。
      for (var mi = 0; mi < state.masks.length; mi++) {
        if (renderer) renderer.clearMask(state.masks[mi].id);
      }
      previewMaskCanvases = Object.create(null);
      aiBaseCache = Object.create(null);
      state.adjust = defaultAdjust();
      state.before = false;
      state.curves = createCurves();
      state.paramCurve = defaultParamCurve();
      state.curveChannel = 'rgb';
      state.curveLut = null;
      state.curveOn = false;
      state.curveDragging = -1;
      var freshMask = createMask('linear');
      state.masks = [freshMask];
      state.activeMaskId = freshMask.id;
      state.geometry = defaultGeometry();
      state.cropEditing = false;
      state.cropDrag = null;
      state.cropRect = null;
      state.cropBackup = null;
      if (els.cropOverlay) els.cropOverlay.hidden = true;
      commitSource(result);
      if (result.raw) {
        state.raw = result.raw;
        newRaw = result.raw;
        state.imageFile = null;
      } else {
        state.raw = null;
        state.imageFile = file;
      }
      if (oldRaw && oldRaw !== newRaw) {
        try { oldRaw.close(); } catch (e) { /* ignore */ }
      }
      state.fileName = name;
      state.fileSize = file.size;
      state.fileKind = kind;
      state.fileExt = ext;
      state.loaded = true;
      els.empty.hidden = true;
      els.canvas.classList.remove('is-hidden');
      els.file.classList.add('has-file');
      els.filename.textContent = name;
      els.filetag.hidden = false;
      els.filetag.textContent = kind === 'raw' ? (ext || 'RAW') + ' RAW' : (ext || 'IMAGE');
      els.exportBtn.disabled = false;
      showExportResult('', false);
      applyMetaToUI(result);
      if (result.sourceWarn) {
        setStatus(result.sourceNote || '已载入。', 'warn');
      } else {
        setStatus('已载入 ' + name + ' · ' + result.preview.w + '×' + result.preview.h + ' 预览 · 解码 ' + Math.round(result.decodeMs) + ' ms', 'ok');
      }
      state.before = false;
      updateBeforeLabel();
      state.zoomMode = 'fit';
      requestAnimationFrame(applyZoom);
      updateFootRight();
      updateAdjustOutputs();
      updateParamCurveUI();
      updateCurveLut(false);
      updateMaskUI();
      updateGeometryUI();
      resetHistory();
      dispatch('raw:file', { name: name, meta: state.meta, preview: { w: result.preview.w, h: result.preview.h } });
    } catch (err) {
      if (newRaw) { try { newRaw.close(); } catch (e) { /* ignore */ } }
      console.warn('[raw] load failed', err);
      showLoadError(err);
    } finally {
      if (seq === state.loadSeq) {
        setBusy(false);
        if (els.exportBtn) els.exportBtn.disabled = !state.loaded;
        if (!state.loaded) els.empty.hidden = false;
      }
    }
  }

  function showLoadError(err) {
    var msg = describeError(err);
    setStatus(msg, 'err');
    if (els.busy) els.busy.hidden = true;
    if (!state.loaded) {
      els.empty.hidden = false;
      els.canvas.classList.add('is-hidden');
      els.file.classList.remove('has-file');
      els.filename.textContent = '载入失败';
      els.filetag.hidden = true;
    }
    showExportResult(msg, true);
    dispatch('raw:error', { message: msg, error: err });
  }

  async function decodeRawFile(file) {
    var fr = await ensureFlashRaw();
    var t0 = performance.now();
    var raw = await fr.FlashRaw.open(file);
    var meta = raw.metadata;
    var openMs = performance.now() - t0;

    var previewOpts = {
      output: 'rgba8',
      demosaic: 'bilinear',
      crop: true,
      corruptionPolicy: 'recover',
      previewFallback: true
    };
    var fullPixels = (meta.width || 0) * (meta.height || 0);
    if (fullPixels > PREVIEW_MAX_PIXELS) previewOpts.demosaic = 'half-size';

    var t1 = performance.now();
    var frame;
    try {
      frame = await raw.decode(previewOpts);
    } catch (e) {
      // 传感器数据无法解码时，退回相机内嵌预览，至少保证页面可用。
      var embedded = null;
      try { embedded = await raw.preview({ format: 'rgba8' }); } catch (e2) { embedded = null; }
      if (!embedded || !embedded.data || !embedded.width || !embedded.height) {
        try { raw.close(); } catch (e3) { /* ignore */ }
        throw e;
      }
      var bmp = await createImageBitmap(new ImageData(embedded.data, embedded.width, embedded.height));
      var up = await makePreviewFromBitmap(bmp, bmp.width, bmp.height);
      bmp.close();
      var caps = null;
      try { caps = await fr.getCapabilities(); } catch (e4) { caps = null; }
      return {
        raw: raw,
        meta: meta,
        preview: up,
        fullSize: { w: meta.width || embedded.width, h: meta.height || embedded.height },
        decodeMs: performance.now() - t1,
        previewDecodeMs: performance.now() - t1,
        sourceNote: '传感器数据解码失败，当前显示相机内嵌预览，色彩与细节可能不完整。',
        sourceWarn: true,
        backend: caps && caps.simd && caps.simd.active ? 'WASM SIMD' : 'WASM',
        openMs: openMs
      };
    }
    var decodeMs = performance.now() - t1;
    var fw = frame.width;
    var fh = frame.height;
    var previewSource;
    if (frame.source === 'preview') {
      previewSource = await makePreviewFromImageData(frame, fw, fh);
    } else {
      previewSource = await makePreviewFromImageData(frame, fw, fh);
    }
    var incomplete = !!frame.incomplete;
    var source = frame.source;
    var caps2 = null;
    try { caps2 = await fr.getCapabilities(); } catch (e5) { caps2 = null; }
    var backend = caps2 && caps2.simd && caps2.simd.active ? 'WASM SIMD' : 'WASM';
    var note = '';
    var warn = false;
    if (source === 'preview') {
      note = '该文件使用相机内嵌预览（传感器压缩格式暂不支持完整解码），调整仍会作用到像素，但暗部与细节有限。';
      warn = true;
    } else if (incomplete) {
      note = '文件部分像素数据缺失，已尽可能恢复；缺失区域可能显示为黑色。';
      warn = true;
    }
    // 释放 frame 数据
    try { frame.free(); } catch (e6) { /* ignore */ }

    return {
      raw: raw,
      meta: meta,
      preview: previewSource,
      fullSize: { w: meta.width || fw, h: meta.height || fh },
      decodeMs: decodeMs,
      previewDecodeMs: decodeMs,
      sourceNote: note,
      sourceWarn: warn,
      backend: backend,
      openMs: openMs
    };
  }

  async function decodeImageFile(file) {
    var t0 = performance.now();
    var bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      bmp = await createImageBitmap(file);
    }
    var w = bmp.width;
    var h = bmp.height;
    var preview = await makePreviewFromBitmap(bmp, w, h);
    bmp.close();
    var ms = performance.now() - t0;
    return {
      raw: null,
      meta: null,
      preview: preview,
      fullSize: { w: w, h: h },
      decodeMs: ms,
      previewDecodeMs: ms,
      sourceNote: '',
      sourceWarn: false,
      backend: 'Canvas',
      openMs: ms
    };
  }

  async function makePreviewFromImageData(frame, fw, fh) {
    var imageData = frame.toImageData();
    var scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(fw, fh));
    var w = Math.max(1, Math.round(fw * scale));
    var h = Math.max(1, Math.round(fh * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var bmp;
    try {
      bmp = await createImageBitmap(imageData);
    } catch (e) {
      // 老浏览器不支持 ImageData -> ImageBitmap
      var full = document.createElement('canvas');
      full.width = fw;
      full.height = fh;
      full.getContext('2d').putImageData(imageData, 0, 0);
      bmp = await createImageBitmap(full);
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    try { bmp.close(); } catch (e2) { /* ignore */ }
    return { canvas: canvas, w: w, h: h };
  }

  async function makePreviewFromBitmap(bmp, fw, fh) {
    var scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(fw, fh));
    var w = Math.max(1, Math.round(fw * scale));
    var h = Math.max(1, Math.round(fh * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return { canvas: canvas, w: w, h: h };
  }

  function commitSource(result) {
    if (!renderer || glLost) {
      renderer = new RawRenderer(els.canvas);
    }
    state.preview = result.preview;
    state.previewCanvas = result.preview.canvas;
    state.histogram = computeHistogram(result.preview.canvas);
    state.previewDecodeMs = result.previewDecodeMs || result.decodeMs;
    state.decodeMs = result.decodeMs;
    state.fullSize = result.fullSize;
    state.meta = result.meta;
    state.backendLabel = result.backend || 'WebGL2';
    state.sourceNote = result.sourceNote || '';
    state.sourceWarn = !!result.sourceWarn;

    applyGeometrySource();
    if (curveCtx) drawCurve();
    refreshAllMaskTextures();
    updateGeometryUI();
    scheduleRender();
  }

  function computeHistogram(canvas) {
    try {
      var tw = 256;
      var th = Math.max(32, Math.round(canvas.height / Math.max(1, canvas.width) * 256));
      var tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      var ctx = tmp.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, tw, th);
      var data = ctx.getImageData(0, 0, tw, th).data;
      var out = {
        r: new Uint32Array(256),
        g: new Uint32Array(256),
        b: new Uint32Array(256),
        l: new Uint32Array(256)
      };
      for (var i = 0; i < data.length; i += 4) {
        var r = data[i], g = data[i + 1], b = data[i + 2];
        out.r[r]++;
        out.g[g]++;
        out.b[b]++;
        out.l[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function drawHistogram(b) {
    var hist = state.histogram;
    if (!hist) return;
    var active = state.curveChannel;
    var channels = [
      { key: 'r', bins: hist.r, color: active === 'rgb' || active === 'r' ? 'rgba(190, 62, 52, ' + (active === 'r' ? '0.30' : '0.16') + ')' : 'rgba(190, 62, 52, 0.055)' },
      { key: 'g', bins: hist.g, color: active === 'rgb' || active === 'g' ? 'rgba(40, 145, 82, ' + (active === 'g' ? '0.28' : '0.14') + ')' : 'rgba(40, 145, 82, 0.05)' },
      { key: 'b', bins: hist.b, color: active === 'rgb' || active === 'b' ? 'rgba(48, 92, 190, ' + (active === 'b' ? '0.30' : '0.15') + ')' : 'rgba(48, 92, 190, 0.05)' }
    ];
    curveCtx.save();
    curveCtx.beginPath();
    curveCtx.rect(b.x, b.y, b.w, b.h);
    curveCtx.clip();
    for (var c = 0; c < channels.length; c++) {
      var bins = channels[c].bins;
      var max = 1;
      for (var n = 0; n < 256; n++) if (bins[n] > max) max = bins[n];
      var bar = b.w / 256;
      curveCtx.fillStyle = channels[c].color;
      curveCtx.beginPath();
      for (var i = 0; i < 256; i++) {
        var height = Math.pow(bins[i] / max, 0.45) * b.h;
        if (height < 0.5) continue;
        curveCtx.rect(b.x + i * bar, b.y + b.h - height, Math.max(1, bar + 0.5), height);
      }
      curveCtx.fill();
    }
    curveCtx.restore();
  }

  /* ------------------------------------------------------------------ *
   * 元数据
   * ------------------------------------------------------------------ */

  function setMetaField(key, text) {
    var el = els.meta[key];
    if (el) {
      el.textContent = text || '—';
      el.title = text || '';
    }
  }

  function applyMetaToUI(result) {
    var m = result.meta;
    var camera = '—';
    var lens = '—';
    var iso = '—';
    var shutter = '—';
    var aperture = '—';
    var focal = '—';
    var format = state.fileExt || 'IMAGE';

    if (m) {
      camera = (m.camera && (m.camera.name || [m.camera.canonicalMake, m.camera.canonicalModel].filter(Boolean).join(' '))) || '—';
      lens = (m.lens && (m.lens.model || m.lens.focalRange)) || '—';
      var ex = m.exposure || {};
      iso = ex.iso ? String(ex.iso) : '—';
      shutter = formatShutter(ex.exposureTime);
      aperture = ex.fNumber ? 'f/' + (Math.round(ex.fNumber * 10) / 10) : '—';
      focal = ex.focalLength ? Math.round(ex.focalLength) + ' mm' +
        (ex.focalLength35mm && Math.abs(ex.focalLength35mm - ex.focalLength) > 2 ? '（等效 ' + Math.round(ex.focalLength35mm) + '）' : '') : '—';
      format = (m.format || state.fileExt || 'RAW') + (state.fileExt && m.format !== state.fileExt ? ' / ' + state.fileExt : '');
    } else {
      camera = '图片文件（无 RAW 元数据）';
      lens = '—';
      format = state.fileExt || 'IMAGE';
    }

    setMetaField('camera', camera);
    setMetaField('lens', lens);
    setMetaField('iso', iso);
    setMetaField('shutter', shutter);
    setMetaField('aperture', aperture);
    setMetaField('focal', focal);
    setMetaField('size', (result.fullSize.w || '—') + ' × ' + (result.fullSize.h || '—'));
    setMetaField('format', format);
    setMetaField('decode', Math.round(result.decodeMs) + ' ms');
    setMetaField('file', formatBytes(state.fileSize));

    var summary = (m && m.camera && (m.camera.canonicalModel || m.camera.model)) || (m ? m.format : (state.fileExt || 'IMAGE'));
    els.metaSum.textContent = summary || '—';

    if (result.sourceNote) {
      els.fileNote.hidden = false;
      els.fileNoteText.textContent = result.sourceNote;
      els.fileNote.classList.toggle('is-warn', !!result.sourceWarn);
    } else {
      els.fileNote.hidden = true;
      els.fileNoteText.textContent = '';
    }
    updateFootRight();
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function isTexturedMaskType(type) {
    return type === 'brush' || type === 'sky' || type === 'subject';
  }

  function isSmartMaskType(type) {
    return type === 'sky' || type === 'subject';
  }

  function maskTypeCode(type) {
    if (type === 'linear') return 1;
    if (type === 'radial') return 2;
    if (isTexturedMaskType(type)) return 3;
    return 0;
  }

  function localVector(l) {
    return [l.exposure, l.contrast / 100, l.temperature / 100, l.saturation / 100];
  }

  function renderParams(isExport) {
    var a = state.adjust;
    var masks = [];
    for (var i = 0; i < state.masks.length; i++) {
      var m = state.masks[i];
      if (!m.enabled || m.type === 'none') continue;
      if (m.type === 'brush' && !m.strokes.length) continue;
      masks.push({
        id: m.id,
        type: maskTypeCode(m.type),
        invert: !!m.invert,
        feather: m.feather,
        p1: [m.p1.x, m.p1.y],
        p2: [m.p2.x, m.p2.y],
        local: localVector(m.local)
      });
    }
    var showMask = null;
    var am = activeMask();
    if (!isExport && am && am.enabled && am.type !== 'none' && am.show) {
      showMask = {
        id: am.id,
        type: maskTypeCode(am.type),
        invert: !!am.invert,
        feather: am.feather,
        p1: [am.p1.x, am.p1.y],
        p2: [am.p2.x, am.p2.y],
        local: localVector(am.local)
      };
    }
    return {
      before: isExport ? false : state.before,
      exposure: a.exposure,
      contrast: a.contrast / 100,
      highlights: a.highlights / 100,
      shadows: a.shadows / 100,
      whites: a.whites / 100,
      blacks: a.blacks / 100,
      temperature: a.temperature / 100,
      tint: a.tint / 100,
      vibrance: a.vibrance / 100,
      saturation: a.saturation / 100,
      clarity: a.clarity / 100,
      dehaze: a.dehaze / 100,
      vignette: a.vignette / 100,
      grain: a.grain / 100,
      sharpen: a.sharpen / 100,
      lensDistort: a.lensDistort / 100,
      lensVignette: a.lensVignette / 100,
      lensCa: a.lensCa / 100,
      noiseLuma: a.noiseLuma / 100,
      noiseColor: a.noiseColor / 100,
      masks: masks,
      showMask: showMask
    };
  }

  function scheduleRender() {
    historyTouch();
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderNow();
    });
  }

  /* ------------------------------------------------------------------ *
   * 撤销 / 重做（调整、曲线、蒙版；不重复解码原图）
   * ------------------------------------------------------------------ */

  function cloneHistoryMask(mask) {
    return {
      id: mask.id,
      name: mask.name,
      type: mask.type,
      enabled: !!mask.enabled,
      invert: !!mask.invert,
      feather: mask.feather,
      p1: { x: mask.p1.x, y: mask.p1.y },
      p2: { x: mask.p2.x, y: mask.p2.y },
      brushPct: mask.brushPct,
      brushMode: mask.brushMode || 'add',
      strokes: (mask.strokes || []).map(function (stroke) {
        return {
          radius: stroke.radius,
          mode: stroke.mode || 'add',
          points: (stroke.points || []).map(function (p) { return { x: p.x, y: p.y }; })
        };
      }),
      local: Object.assign({}, mask.local)
    };
  }

  function historySnapshot() {
    var curves = {};
    CURVE_CHANNELS.forEach(function (ch) {
      curves[ch.key] = state.curves[ch.key].map(function (p) { return { x: p.x, y: p.y }; });
    });
    return JSON.stringify({
      adjust: Object.assign({}, state.adjust),
      curves: curves,
      paramCurve: Object.assign({}, state.paramCurve),
      curveChannel: state.curveChannel,
      geometry: cloneGeometry(state.geometry),
      masks: state.masks.map(cloneHistoryMask)
    });
  }

  function markHistory(label) {
    if (label) historyPendingLabel = String(label);
  }

  function renderHistoryPanel(scrollToCurrent) {
    if (!els.historyList) return;
    if (!historyEntries.length) {
      els.historyList.innerHTML = '<p class="raw-history-empty">载入文件后，调整步骤会出现在这里。</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < historyEntries.length; i++) {
      var entry = historyEntries[i];
      var cls = 'raw-history-item';
      if (i === historyIndex) cls += ' is-current';
      else if (i > historyIndex) cls += ' is-future';
      html += '<button type="button" class="' + cls + '" data-history-index="' + i + '"' +
        ' title="' + escapeHTML(entry.label + ' · ' + new Date(entry.time).toLocaleTimeString()) + '">' +
        '<span class="raw-history-dot"></span>' +
        '<span class="raw-history-label">' + escapeHTML(entry.label) + '</span>' +
        '<span class="raw-history-step">' + (i + 1) + '</span>' +
        '</button>';
    }
    els.historyList.innerHTML = html;
    if (scrollToCurrent) {
      var cur = els.historyList.querySelector('.raw-history-item.is-current');
      if (cur) {
        var top = cur.offsetTop;
        var h = els.historyList.clientHeight;
        if (top < els.historyList.scrollTop || top + cur.offsetHeight > els.historyList.scrollTop + h) {
          els.historyList.scrollTop = Math.max(0, top - h / 2);
        }
      }
    }
  }

  function updateHistoryUI() {
    if (!root) return;
    var undoBtn = root.querySelector('#raw-undo');
    var redoBtn = root.querySelector('#raw-redo');
    if (undoBtn) undoBtn.disabled = !state.loaded || (historyIndex <= 0 && !historyTimer);
    if (redoBtn) redoBtn.disabled = !state.loaded || !!historyTimer || historyIndex >= historyEntries.length - 1;
    if (els.historySum) {
      if (!historyEntries.length) els.historySum.textContent = '—';
      else {
        var current = historyEntries[historyIndex];
        els.historySum.textContent = (historyTimer && historyPendingLabel ? historyPendingLabel + '…' : (current ? current.label : '—'));
      }
    }
  }

  function resetHistory() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = 0;
    historyPendingLabel = '';
    historyEntries = [];
    historyIndex = -1;
    if (state.loaded) {
      historyEntries.push({ label: '打开文件', snap: historySnapshot(), time: Date.now() });
      historyIndex = 0;
    }
    renderHistoryPanel(true);
    updateHistoryUI();
  }

  function historyCommit() {
    historyTimer = 0;
    if (historySuspend || !state.loaded) return;
    var snap = historySnapshot();
    var current = historyEntries[historyIndex];
    if (current && snap === current.snap) {
      historyPendingLabel = '';
      updateHistoryUI();
      return;
    }
    if (historyIndex >= 0) historyEntries = historyEntries.slice(0, historyIndex + 1);
    var label = historyPendingLabel || '调整';
    historyEntries.push({ label: label, snap: snap, time: Date.now() });
    historyIndex = historyEntries.length - 1;
    if (historyEntries.length > MAX_HISTORY) {
      historyEntries.splice(0, historyEntries.length - MAX_HISTORY);
      historyIndex = historyEntries.length - 1;
    }
    historyPendingLabel = '';
    renderHistoryPanel(true);
    updateHistoryUI();
  }

  function historyTouch(label) {
    if (label) markHistory(label);
    if (historySuspend || !state.loaded || state.cropEditing) return;
    for (var i = 0; i < state.masks.length; i++) {
      if (state.masks[i].dragMode) return;
    }
    if (!historyPendingLabel) historyPendingLabel = '调整';
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(historyCommit, 450);
    updateHistoryUI();
  }

  function historyFlush() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = 0;
    if (state.cropEditing) return;
    historyCommit();
  }

  function restoreHistory(serialized) {
    var snap;
    try { snap = JSON.parse(serialized); } catch (e) { return; }
    if (!snap) return;
    historySuspend = true;
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = 0;
    historyPendingLabel = '';
    state.adjust = Object.assign(defaultAdjust(), snap.adjust || {});
    state.curves = createCurves();
    CURVE_CHANNELS.forEach(function (ch) {
      if (snap.curves && Array.isArray(snap.curves[ch.key])) {
        state.curves[ch.key] = snap.curves[ch.key].map(function (p) {
          return { x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1) };
        });
      }
    });
    state.paramCurve = defaultParamCurve();
    if (snap.paramCurve) {
      PARAM_CURVE.forEach(function (d) {
        var value = Number(snap.paramCurve[d.key]);
        if (isFinite(value)) state.paramCurve[d.key] = clamp(value, d.min, d.max);
      });
      normalizeParamSplits(state.paramCurve);
    }
    state.curveChannel = state.curves[snap.curveChannel] ? snap.curveChannel : 'rgb';
    state.curveDragging = -1;
    state.before = false;
    state.curveLut = null;
    state.geometry = cloneGeometry(snap.geometry);
    state.cropEditing = false;
    state.cropDrag = null;
    state.cropRect = null;
    if (els.cropOverlay) els.cropOverlay.hidden = true;
    if (els.cropToggle) els.cropToggle.classList.remove('is-on');
    var previousActiveId = state.activeMaskId;
    for (var i = 0; i < state.masks.length; i++) {
      if (renderer) renderer.clearMask(state.masks[i].id);
    }
    previewMaskCanvases = Object.create(null);
    aiBaseCache = Object.create(null);
    state.masks = (snap.masks || []).map(function (m) {
      var id = String(m.id || ('mask-' + (++maskSeq)));
      var numeric = parseInt(id.replace(/^mask-/, ''), 10);
      if (isFinite(numeric)) maskSeq = Math.max(maskSeq, numeric);
      return {
        id: id,
        name: m.name || id,
        type: normalizeMaskType(m.type),
        enabled: m.enabled !== false,
        show: false,
        invert: !!m.invert,
        feather: clamp(Number(m.feather), 0, 1),
        p1: { x: clamp(Number(m.p1 && m.p1.x), 0, 1), y: clamp(Number(m.p1 && m.p1.y), 0, 1) },
        p2: { x: clamp(Number(m.p2 && m.p2.x), 0, 1), y: clamp(Number(m.p2 && m.p2.y), 0, 1) },
        strokes: (m.strokes || []).map(function (stroke) {
          return {
            radius: Number(stroke.radius) || 0.04,
            mode: stroke.mode === 'subtract' ? 'subtract' : 'add',
            points: (stroke.points || []).map(function (p) {
              return { x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1) };
            })
          };
        }),
        brushPct: clamp(Number(m.brushPct) || 8, 1, 24),
        brushMode: m.brushMode === 'subtract' ? 'subtract' : 'add',
        local: Object.assign(defaultLocal(), m.local || {}),
        current: null,
        dragMode: '',
        _start: null,
        _moved: false
      };
    });
    var active = state.masks.filter(function (m) { return m.id === previousActiveId; })[0];
    state.activeMaskId = active ? active.id : (state.masks[0] ? state.masks[0].id : null);
    ALL_ADJUSTMENTS.forEach(function (d) {
      var input = root.querySelector('[data-adj="' + d.key + '"]');
      if (input) input.value = String(state.adjust[d.key]);
    });
    updateAdjustOutputs();
    updateParamCurveUI();
    updateBeforeLabel();
    applyGeometrySource();
    updateCurveLut(false);
    updateMaskUI();
    updateGeometryUI();
    refreshAllMaskTextures();
    applyZoom();
    updateFootRight();
    scheduleRender();
    historySuspend = false;
    updateHistoryUI();
  }

  function restoreHistoryEntry(index, quiet) {
    if (index < 0 || index >= historyEntries.length) return;
    var entry = historyEntries[index];
    historyIndex = index;
    restoreHistory(entry.snap);
    renderHistoryPanel(true);
    updateHistoryUI();
    if (!quiet) setStatus('已回到历史步骤：' + entry.label, 'ok');
  }

  function undoHistory() {
    if (!state.loaded) return;
    if (state.cropEditing) {
      setStatus('请先应用或取消裁剪，再撤销调整。', 'warn');
      return;
    }
    historyFlush();
    if (historyIndex <= 0) return;
    restoreHistoryEntry(historyIndex - 1, true);
    setStatus('已撤销到：' + historyEntries[historyIndex].label, 'ok');
  }

  function redoHistory() {
    if (!state.loaded) return;
    if (state.cropEditing) {
      setStatus('请先应用或取消裁剪，再重做调整。', 'warn');
      return;
    }
    historyFlush();
    if (historyIndex >= historyEntries.length - 1) return;
    restoreHistoryEntry(historyIndex + 1, true);
    setStatus('已重做到：' + historyEntries[historyIndex].label, 'ok');
  }

  function renderNow() {
    if (!renderer || !state.preview) return;
    try {
      renderer.render(renderParams(false));
      scheduleLiveHistogram();
    } catch (e) {
      console.error('[raw] render failed', e);
      setStatus(describeError(e), 'err');
    }
  }

  // 直方图跟随当前显影结果，而不是一直停留在原始预览上。
  function scheduleLiveHistogram() {
    if (histogramTimer) return;
    histogramTimer = setTimeout(function () {
      histogramTimer = 0;
      if (!state.loaded || !els.canvas) return;
      var hist = computeHistogram(els.canvas);
      if (!hist) return;
      state.histogram = hist;
      if (curveCtx) drawCurve();
    }, 90);
  }

  function ensureCurveLut() {
    if (!renderer) return;
    if (!state.curveLut) updateCurveLut(false);
    else renderer.setCurve(state.curveLut, state.curveOn);
  }

  /* ------------------------------------------------------------------ *
   * 调整滑杆
   * ------------------------------------------------------------------ */

  function updateAdjustOutputs() {
    ALL_ADJUSTMENTS.forEach(function (d) {
      var out = root.querySelector('[data-out-adj="' + d.key + '"]');
      if (out) {
        out.textContent = fmtAdjust(d, state.adjust[d.key]);
        out.classList.toggle('is-set', Math.abs(state.adjust[d.key] - d.def) > 1e-9);
      }
      var input = root.querySelector('[data-adj="' + d.key + '"]');
      if (input && Number(input.value) !== state.adjust[d.key]) input.value = String(state.adjust[d.key]);
    });
    var am = activeMask();
    var l = am ? am.local : defaultLocal();
    LOCALS.forEach(function (d) {
      var out = root.querySelector('[data-out-local="' + d.key + '"]');
      var v = l[d.key];
      if (out) {
        out.textContent = fmtAdjust(d, v);
        out.classList.toggle('is-set', Math.abs(v - d.def) > 1e-9);
      }
      var input = root.querySelector('[data-local="' + d.key + '"]');
      if (input && Number(input.value) !== v) input.value = String(v);
    });
    var count = ADJUSTMENTS.filter(function (d) {
      return Math.abs(state.adjust[d.key] - d.def) > 1e-9;
    }).length;
    if (els.adjSum) els.adjSum.textContent = count ? count + ' 项' : '0 项';
    var lensCount = LENS.filter(function (d) {
      return Math.abs(state.adjust[d.key] - d.def) > 1e-9;
    }).length;
    if (els.lensSum) els.lensSum.textContent = lensCount ? lensCount + ' 项' : '手动';
    var detailCount = DETAIL.filter(function (d) {
      return Math.abs(state.adjust[d.key] - d.def) > 1e-9;
    }).length;
    if (els.detailSum) els.detailSum.textContent = detailCount ? detailCount + ' 项' : '关闭';
  }

  function findDef(key, list) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function setAdjustment(key, value, local, silent) {
    var def = findDef(key, local ? LOCALS : ALL_ADJUSTMENTS);
    if (!def) return;
    var v = clamp(Number(value), def.min, def.max);
    var localMask = null;
    if (local) {
      localMask = activeMask();
      if (!localMask) localMask = addMask('linear');
      if (!localMask) return;
      localMask.local[key] = v;
      markHistory(def.label + (localMask ? ' · ' + localMask.name : ''));
    } else {
      state.adjust[key] = v;
      markHistory(def.label);
    }
    var input = root.querySelector('[data-' + (local ? 'local' : 'adj') + '="' + key + '"]');
    if (input && Number(input.value) !== v) input.value = v;
    updateAdjustOutputs();
    if (localMask) updateMaskBadge(localMask);
    restoreBaselineIfNeeded();
    if (!silent) scheduleRender();
  }

  function resetAdjustment(key, local) {
    var def = findDef(key, local ? LOCALS : ALL_ADJUSTMENTS);
    if (!def) return;
    setAdjustment(key, def.def, local);
  }

  function bindSlider(input) {
    var isLocal = input.hasAttribute('data-local');
    var key = input.getAttribute(isLocal ? 'data-local' : 'data-adj');
    input.addEventListener('input', function () {
      setAdjustment(key, Number(input.value), isLocal);
    });
    input.addEventListener('dblclick', function () {
      resetAdjustment(key, isLocal);
    });
  }

  /* ------------------------------------------------------------------ *
   * 色调曲线
   * ------------------------------------------------------------------ */

  function initCurveEditor() {
    resizeCurveCanvas();
    drawCurve();
    curveCanvas.addEventListener('pointerdown', onCurveDown);
    curveCanvas.addEventListener('pointermove', onCurveMove);
    curveCanvas.addEventListener('pointerup', onCurveUp);
    curveCanvas.addEventListener('pointercancel', onCurveUp);
    curveCanvas.addEventListener('dblclick', onCurveDblClick);
    if (typeof ResizeObserver !== 'undefined') {
      curveResizeObserver = new ResizeObserver(function () {
        resizeCurveCanvas();
        drawCurve();
      });
      curveResizeObserver.observe(curveCanvas);
    }
  }

  function curveBox() {
    var w = curveCanvas.width;
    var h = curveCanvas.height;
    var pad = Math.round(10 * (window.devicePixelRatio || 1));
    return { x: pad, y: pad, w: Math.max(1, w - pad * 2), h: Math.max(1, h - pad * 2) };
  }

  function resizeCurveCanvas() {
    var rect = curveCanvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(160, Math.round(rect.width * dpr));
    var h = Math.max(110, Math.round(rect.height * dpr));
    if (curveCanvas.width !== w || curveCanvas.height !== h) {
      curveCanvas.width = w;
      curveCanvas.height = h;
    }
  }

  function curveToPx(p) {
    var b = curveBox();
    return { x: b.x + p.x * b.w, y: b.y + (1 - p.y) * b.h };
  }
  function pxToCurve(px, py) {
    var b = curveBox();
    return { x: clamp((px - b.x) / b.w, 0, 1), y: clamp(1 - (py - b.y) / b.h, 0, 1) };
  }

  function drawCurve() {
    if (!curveCtx) return;
    var w = curveCanvas.width;
    var h = curveCanvas.height;
    var dpr = window.devicePixelRatio || 1;
    var b = curveBox();
    curveCtx.clearRect(0, 0, w, h);
    // 背景
    curveCtx.fillStyle = '#FBFDF9';
    curveCtx.fillRect(0, 0, w, h);
    // 图像直方图（RGB 三通道叠加），让曲线和实际亮度分布对应
    drawHistogram(b);
    // 网格
    curveCtx.strokeStyle = '#E1E7E0';
    curveCtx.lineWidth = Math.max(1, dpr * 0.7);
    for (var i = 1; i < 4; i++) {
      var gx = b.x + b.w * (i / 4);
      var gy = b.y + b.h * (i / 4);
      curveCtx.beginPath();
      curveCtx.moveTo(gx, b.y);
      curveCtx.lineTo(gx, b.y + b.h);
      curveCtx.stroke();
      curveCtx.beginPath();
      curveCtx.moveTo(b.x, gy);
      curveCtx.lineTo(b.x + b.w, gy);
      curveCtx.stroke();
    }
    // 对角线
    curveCtx.strokeStyle = '#CFD9CE';
    curveCtx.setLineDash([3 * dpr, 3 * dpr]);
    curveCtx.beginPath();
    curveCtx.moveTo(b.x, b.y + b.h);
    curveCtx.lineTo(b.x + b.w, b.y);
    curveCtx.stroke();
    curveCtx.setLineDash([]);

    var activeKey = state.curveChannel;
    var activeInfo = channelInfo(activeKey);

    // 其它已调整通道用细虚线提示，不抢当前通道焦点。
    for (var ci = 0; ci < CURVE_CHANNELS.length; ci++) {
      var other = CURVE_CHANNELS[ci];
      if (other.key === activeKey) continue;
      var opts = state.curves[other.key];
      if (!opts || isPointsIdentity(opts)) continue;
      var optPts = opts.slice().sort(function (a, c) { return a.x - c.x; });
      var optEval = makeCurveEvaluator(optPts);
      curveCtx.save();
      curveCtx.globalAlpha = 0.34;
      curveCtx.strokeStyle = other.curve;
      curveCtx.lineWidth = Math.max(1, dpr * 1.1);
      curveCtx.setLineDash([4 * dpr, 3 * dpr]);
      curveCtx.beginPath();
      for (var oi = 0; oi <= 64; oi++) {
        var ox = oi / 64;
        var op = curveToPx({ x: ox, y: optEval(ox) });
        if (oi === 0) curveCtx.moveTo(op.x, op.y);
        else curveCtx.lineTo(op.x, op.y);
      }
      curveCtx.stroke();
      curveCtx.restore();
    }

    // 当前通道曲线
    var pts = activeCurvePoints().slice().sort(function (a, c) { return a.x - c.x; });
    var evaluate = makeCurveEvaluator(pts);
    curveCtx.strokeStyle = activeInfo.curve;
    curveCtx.lineWidth = Math.max(1.6, dpr * 1.8);
    curveCtx.lineJoin = 'round';
    curveCtx.beginPath();
    var N = 96;
    for (var s = 0; s <= N; s++) {
      var x = s / N;
      var y = evaluate(x);
      var p = curveToPx({ x: x, y: y });
      if (s === 0) curveCtx.moveTo(p.x, p.y);
      else curveCtx.lineTo(p.x, p.y);
    }
    curveCtx.stroke();

    // 参数曲线叠加后的实际曲线：仅 RGB 复合有精确定义，单通道视图不画以免误导。
    if (!paramCurveIsIdentity() && activeKey === 'rgb') {
      curveCtx.save();
      curveCtx.globalAlpha = 0.62;
      curveCtx.strokeStyle = activeInfo.curve;
      curveCtx.lineWidth = Math.max(1, dpr * 1.2);
      curveCtx.setLineDash([5 * dpr, 3.5 * dpr]);
      curveCtx.beginPath();
      for (var pi = 0; pi <= N; pi++) {
        var pxc = pi / N;
        var pyc = parametricEval(evaluate(pxc), state.paramCurve);
        var ppc = curveToPx({ x: pxc, y: pyc });
        if (pi === 0) curveCtx.moveTo(ppc.x, ppc.y);
        else curveCtx.lineTo(ppc.x, ppc.y);
      }
      curveCtx.stroke();
      curveCtx.restore();
    }

    // 控制点
    var activePts = activeCurvePoints();
    for (var k = 0; k < activePts.length; k++) {
      var cp = curveToPx(activePts[k]);
      curveCtx.beginPath();
      curveCtx.arc(cp.x, cp.y, Math.max(4, 4.6 * dpr), 0, Math.PI * 2);
      curveCtx.fillStyle = '#FFFFFF';
      curveCtx.fill();
      curveCtx.lineWidth = Math.max(1.4, dpr * 1.6);
      curveCtx.strokeStyle = activeInfo.curve;
      curveCtx.stroke();
    }
  }

  // 单调三次 Hermite（Fritsch-Carlson），两个端点时退化为 y = x。
  function makeCurveEvaluator(pts) {
    var n = pts.length;
    if (!n) return function (x) { return x; };
    if (n === 1) return function () { return pts[0].y; };
    var xs = [], ys = [], d = [], m = [];
    for (var i = 0; i < n; i++) { xs.push(pts[i].x); ys.push(pts[i].y); }
    for (var j = 0; j < n - 1; j++) {
      d.push((ys[j + 1] - ys[j]) / Math.max(1e-6, xs[j + 1] - xs[j]));
    }
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (var k = 1; k < n - 1; k++) {
      m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    }
    for (var q = 0; q < n - 1; q++) {
      if (d[q] === 0) {
        m[q] = 0;
        m[q + 1] = 0;
        continue;
      }
      var a = m[q] / d[q];
      var b = m[q + 1] / d[q];
      var s = a * a + b * b;
      if (s > 9) {
        var t = 3 / Math.sqrt(s);
        m[q] = t * a * d[q];
        m[q + 1] = t * b * d[q];
      }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      var idx = 0;
      while (idx < n - 2 && x > xs[idx + 1]) idx++;
      var h = Math.max(1e-6, xs[idx + 1] - xs[idx]);
      var tt = (x - xs[idx]) / h;
      var t2 = tt * tt;
      var t3 = t2 * tt;
      var h00 = 2 * t3 - 3 * t2 + 1;
      var h10 = t3 - 2 * t2 + tt;
      var h01 = -2 * t3 + 3 * t2;
      var h11 = t3 - t2;
      return h00 * ys[idx] + h10 * h * m[idx] + h01 * ys[idx + 1] + h11 * h * m[idx + 1];
    };
  }

  function isPointsIdentity(pts) {
    if (!pts || pts.length !== 2) return false;
    if (Math.abs(pts[0].x) > 1e-6 || Math.abs(pts[0].y) > 1e-6) return false;
    if (Math.abs(pts[1].x - 1) > 1e-6 || Math.abs(pts[1].y - 1) > 1e-6) return false;
    return true;
  }

  function activeCurvePoints() {
    return state.curves[state.curveChannel] || state.curves.rgb;
  }

  function normalizeParamSplits(p) {
    p.shadowSplit = clamp(Number(p.shadowSplit), 0, 45);
    p.midSplit = clamp(Number(p.midSplit), 25, 75);
    p.highlightSplit = clamp(Number(p.highlightSplit), 55, 100);
    if (p.shadowSplit > p.midSplit - 5) p.shadowSplit = Math.max(0, p.midSplit - 5);
    if (p.highlightSplit < p.midSplit + 5) p.highlightSplit = Math.min(100, p.midSplit + 5);
    return p;
  }

  function paramCurveIsIdentity(p) {
    p = p || state.paramCurve;
    return !p.highlights && !p.lights && !p.darks && !p.shadows;
  }

  // 四个亮度区间的余弦权重叠加；在两端收束，保证纯黑与纯白不被推开。
  function parametricEval(x, p) {
    if (paramCurveIsIdentity(p)) return x;
    var bounds = [0, p.shadowSplit / 100, p.midSplit / 100, p.highlightSplit / 100, 1];
    var values = [p.shadows, p.darks, p.lights, p.highlights];
    var delta = 0;
    var sum = 0;
    for (var i = 0; i < 4; i++) {
      var lo = bounds[i];
      var hi = bounds[i + 1];
      if (hi - lo < 0.001) continue;
      var center = (lo + hi) / 2;
      var half = Math.max(0.02, (hi - lo) * 0.75);
      var d = Math.abs(x - center) / half;
      var w = d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
      sum += w;
      delta += w * (values[i] / 100);
    }
    if (sum > 0) delta /= sum;
    var taper = smoothstep(0, 0.035, x) * smoothstep(0, 0.035, 1 - x);
    return clamp(x + delta * 0.24 * taper, 0, 1);
  }

  // 先应用 RGB 复合点曲线与参数曲线，再应用对应单通道点曲线，生成 256×3 LUT。
  function buildCurveLut() {
    var evaluators = {};
    var identity = paramCurveIsIdentity();
    for (var c = 0; c < CURVE_CHANNELS.length; c++) {
      var key = CURVE_CHANNELS[c].key;
      var pts = state.curves[key].slice().sort(function (a, b) { return a.x - b.x; });
      evaluators[key] = makeCurveEvaluator(pts);
      if (identity && !isPointsIdentity(state.curves[key])) identity = false;
    }
    var lut = new Uint8Array(256 * 3 * 4);
    for (var i = 0; i < 256; i++) {
      var x = i / 255;
      var comp = clamp(parametricEval(evaluators.rgb(x), state.paramCurve), 0, 1);
      var rv = Math.round(clamp(evaluators.r(comp), 0, 1) * 255);
      var gv = Math.round(clamp(evaluators.g(comp), 0, 1) * 255);
      var bv = Math.round(clamp(evaluators.b(comp), 0, 1) * 255);
      var o = i * 4;
      lut[o] = rv; lut[o + 1] = 0; lut[o + 2] = 0; lut[o + 3] = 255;
      o = (256 + i) * 4;
      lut[o] = 0; lut[o + 1] = gv; lut[o + 2] = 0; lut[o + 3] = 255;
      o = (512 + i) * 4;
      lut[o] = 0; lut[o + 1] = 0; lut[o + 2] = bv; lut[o + 3] = 255;
    }
    return { lut: lut, identity: identity };
  }

  function curvePointsIdentity(points) {
    return Array.isArray(points) && isPointsIdentity(points);
  }

  function updateCurveUI() {
    var info = channelInfo(state.curveChannel);
    var identity = curvePointsIdentity(activeCurvePoints());
    var paramCount = ['highlights', 'lights', 'darks', 'shadows'].filter(function (k) {
      return Math.abs(state.paramCurve[k]) > 1e-9;
    }).length;
    if (els.curveSum) {
      var status = identity && !paramCount ? '线性' : (!identity && paramCount ? '点 + 参数' : (paramCount ? '参数 ' + paramCount : '已调整'));
      els.curveSum.textContent = info.label + ' · ' + status;
    }
    if (els.curveHint) {
      els.curveHint.textContent = info.label + ' 通道 · 先 RGB 复合再单通道 · 点击加点 / 拖动 / 双击删点';
    }
    if (els.curveChannels) {
      els.curveChannels.querySelectorAll('button').forEach(function (b) {
        var on = b.getAttribute('data-curve-channel') === state.curveChannel;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  }

  function updateParamCurveUI() {
    if (!root) return;
    PARAM_CURVE.forEach(function (d) {
      var v = state.paramCurve[d.key];
      var input = root.querySelector('[data-param="' + d.key + '"]');
      var out = root.querySelector('[data-out-param="' + d.key + '"]');
      if (input && Number(input.value) !== v) input.value = String(v);
      if (out) {
        out.textContent = fmtAdjust(d, v);
        out.classList.toggle('is-set', Math.abs(v - d.def) > 1e-9);
      }
    });
  }

  function setParamCurve(key, value, silent) {
    var def = findDef(key, PARAM_CURVE);
    if (!def) return;
    state.paramCurve[key] = clamp(Number(value), def.min, def.max);
    normalizeParamSplits(state.paramCurve);
    updateParamCurveUI();
    markHistory('参数曲线 · ' + def.label);
    restoreBaselineIfNeeded();
    updateCurveLut(true);
    if (silent) historyFlush();
  }

  function resetParamCurve() {
    state.paramCurve = defaultParamCurve();
    updateParamCurveUI();
    markHistory('重置参数曲线');
    updateCurveLut(true);
  }

  function updateCurveLut(doRender) {
    var built = buildCurveLut();
    state.curveLut = built.lut;
    state.curveOn = !built.identity;
    if (renderer) renderer.setCurve(built.lut, !built.identity);
    updateCurveUI();
    restoreBaselineIfNeeded();
    drawCurve();
    if (doRender !== false) scheduleRender();
  }

  function setCurvePoints(points, channel, label) {
    channel = state.curves[channel] ? channel : state.curveChannel;
    var pts = (points || []).map(function (p) {
      return { x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1) };
    });
    if (!pts.length) pts = cloneCurvePoints(IDENTITY_CURVE);
    pts.sort(function (a, b) { return a.x - b.x; });
    state.curves[channel] = pts;
    markHistory(label || (channelInfo(channel).label + ' 点曲线'));
    updateCurveLut(true);
  }

  function setCurveChannel(channel) {
    if (!state.curves[channel] || channel === state.curveChannel) return;
    state.curveChannel = channel;
    state.curveDragging = -1;
    updateCurveUI();
    drawCurve();
    dispatch('raw:curve-channel', { channel: channel });
  }

  function curveEventPoint(e) {
    var rect = curveCanvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    return pxToCurve((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
  }

  function onCurveDown(e) {
    e.preventDefault();
    markHistory(channelInfo(state.curveChannel).label + ' 点曲线');
    var p = curveEventPoint(e);
    var pts = activeCurvePoints();
    var best = -1;
    var bestD = 14 * (window.devicePixelRatio || 1);
    for (var i = 0; i < pts.length; i++) {
      var cp = curveToPx(pts[i]);
      var rect = curveCanvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      var dx = (e.clientX - rect.left) * dpr - cp.x;
      var dy = (e.clientY - rect.top) * dpr - cp.y;
      var d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) {
      pts.push({ x: p.x, y: p.y });
      pts.sort(function (a, b) { return a.x - b.x; });
      for (var k = 0; k < pts.length; k++) {
        if (Math.abs(pts[k].x - p.x) < 1e-9 && Math.abs(pts[k].y - p.y) < 1e-9) { best = k; break; }
      }
    }
    state.curveDragging = best;
    try { curveCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    updateCurveLut(true);
  }

  function onCurveMove(e) {
    if (state.curveDragging < 0) return;
    e.preventDefault();
    markHistory(channelInfo(state.curveChannel).label + ' 点曲线');
    var p = curveEventPoint(e);
    var idx = state.curveDragging;
    var pts = activeCurvePoints();
    if (idx < 0 || idx >= pts.length) return;
    var isFirst = idx === 0;
    var isLast = idx === pts.length - 1;
    if (isFirst) {
      pts[idx].x = 0;
    } else if (isLast) {
      pts[idx].x = 1;
    } else {
      var lo = pts[idx - 1].x + 0.01;
      var hi = pts[idx + 1].x - 0.01;
      pts[idx].x = clamp(p.x, lo, Math.max(lo, hi));
    }
    pts[idx].y = p.y;
    updateCurveLut(true);
  }

  function onCurveUp(e) {
    if (state.curveDragging >= 0) {
      state.curveDragging = -1;
      try { curveCanvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      updateCurveLut(true);
    }
  }

  function onCurveDblClick(e) {
    var pts = activeCurvePoints();
    var best = -1;
    var bestD = Infinity;
    var rect = curveCanvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    for (var i = 0; i < pts.length; i++) {
      var cp = curveToPx(pts[i]);
      var d = Math.hypot((e.clientX - rect.left) * dpr - cp.x, (e.clientY - rect.top) * dpr - cp.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best <= 0 || best >= pts.length - 1) return;
    pts.splice(best, 1);
    markHistory(channelInfo(state.curveChannel).label + ' 删除曲线点');
    updateCurveLut(true);
  }

  function applyCurvePreset(name, channel) {
    channel = state.curves[channel] ? channel : state.curveChannel;
    var points;
    if (name === 'soft') {
      points = [{ x: 0, y: 0 }, { x: 0.25, y: 0.28 }, { x: 0.75, y: 0.72 }, { x: 1, y: 1 }];
    } else if (name === 'contrast') {
      points = [{ x: 0, y: 0 }, { x: 0.22, y: 0.14 }, { x: 0.5, y: 0.5 }, { x: 0.78, y: 0.87 }, { x: 1, y: 1 }];
    } else {
      points = cloneCurvePoints(IDENTITY_CURVE);
    }
    var presetLabel = name === 'soft' ? '柔和' : name === 'contrast' ? '强对比' : '线性';
    setCurvePoints(points, channel, channelInfo(channel).label + ' 曲线 · ' + presetLabel);
  }

  /* ------------------------------------------------------------------ *
   * 几何：旋转 / 镜像 / 拉直 / 裁剪
   * ------------------------------------------------------------------ */

  function normalizeMaskType(type) {
    return type === 'radial' || type === 'brush' || type === 'none' ||
      type === 'sky' || type === 'subject' ? type : 'linear';
  }

  function geometryIsIdentity(g) {
    g = g || state.geometry;
    return !g.rotate90 && !g.flipH && !g.flipV &&
      Math.abs(g.angle) < 0.01 && !g.crop;
  }

  // 预览和导出共用同一条几何管线：旋转/镜像 → 拉直（自动放大防黑边）→ 裁剪。
  function composeGeometry(source, geometry) {
    var w = source.width;
    var h = source.height;
    if (!w || !h) return { canvas: source, w: w || 0, h: h || 0 };
    var g = geometry || defaultGeometry();
    var rot = (((Number(g.rotate90) || 0) % 4) + 4) % 4;
    var oriented = source;
    var ow = w;
    var oh = h;
    if (rot || g.flipH || g.flipV) {
      var swap = rot % 2 === 1;
      ow = swap ? h : w;
      oh = swap ? w : h;
      var oc = document.createElement('canvas');
      oc.width = ow;
      oc.height = oh;
      var octx = oc.getContext('2d');
      octx.save();
      octx.translate(ow / 2, oh / 2);
      octx.rotate(rot * Math.PI / 2);
      octx.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(source, -w / 2, -h / 2);
      octx.restore();
      oriented = oc;
    }
    var angle = clamp(Number(g.angle) || 0, -45, 45);
    if (Math.abs(angle) > 0.001) {
      var rad = angle * Math.PI / 180;
      var c = Math.abs(Math.cos(rad));
      var s = Math.abs(Math.sin(rad));
      var cover = Math.max((ow * c + oh * s) / ow, (ow * s + oh * c) / oh);
      var sc = document.createElement('canvas');
      sc.width = ow;
      sc.height = oh;
      var sctx = sc.getContext('2d');
      sctx.save();
      sctx.translate(ow / 2, oh / 2);
      sctx.rotate(rad);
      sctx.scale(cover, cover);
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(oriented, -ow / 2, -oh / 2);
      sctx.restore();
      oriented = sc;
    }
    var crop = g.crop;
    if (crop && crop.w > 0.001 && crop.h > 0.001) {
      var cx = clamp(Number(crop.x) || 0, 0, 0.999);
      var cy = clamp(Number(crop.y) || 0, 0, 0.999);
      var cw = clamp(Number(crop.w) || 1, 0.001, 1 - cx);
      var ch = clamp(Number(crop.h) || 1, 0.001, 1 - cy);
      var sx = Math.round(cx * ow);
      var sy = Math.round(cy * oh);
      var sw = Math.max(1, Math.min(ow - sx, Math.round(cw * ow)));
      var sh = Math.max(1, Math.min(oh - sy, Math.round(ch * oh)));
      if (sx > 0 || sy > 0 || sw < ow || sh < oh) {
        var cc = document.createElement('canvas');
        cc.width = sw;
        cc.height = sh;
        var cctx = cc.getContext('2d');
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = 'high';
        cctx.drawImage(oriented, sx, sy, sw, sh, 0, 0, sw, sh);
        oriented = cc;
      }
    }
    return { canvas: oriented, w: oriented.width, h: oriented.height };
  }

  function applyGeometrySource() {
    if (!state.previewCanvas) return;
    var composed = composeGeometry(state.previewCanvas, state.geometry);
    state.renderSource = composed.canvas;
    state.renderW = composed.w;
    state.renderH = composed.h;
    els.canvas.width = composed.w;
    els.canvas.height = composed.h;
    aiBaseCache = Object.create(null);
    if (renderer) {
      renderer.setSource(composed.canvas);
      ensureCurveLut();
    }
  }

  function rebuildRenderSource(opts) {
    if (!state.previewCanvas) return;
    applyGeometrySource();
    if (opts && opts.fit) state.zoomMode = 'fit';
    refreshAllMaskTextures(!!(opts && opts.deferSmart));
    if (opts && opts.deferSmart) scheduleSmartMaskRefresh();
    updateGeometryUI();
    applyZoom();
    if (state.cropEditing) {
      els.cropOverlay.hidden = false;
      syncCropOverlay();
      updateCropBox();
    }
    scheduleRender();
    updateFootRight();
  }

  function scheduleGeometryApply(label, fit) {
    if (label) markHistory(label);
    if (geometryRaf) return;
    geometryRaf = requestAnimationFrame(function () {
      geometryRaf = 0;
      rebuildRenderSource({ fit: !!fit, deferSmart: true });
    });
  }

  function scheduleSmartMaskRefresh() {
    var hasSmart = false;
    for (var i = 0; i < state.masks.length; i++) {
      if (isSmartMaskType(state.masks[i].type)) { hasSmart = true; break; }
    }
    if (!hasSmart) return;
    if (smartMaskTimer) clearTimeout(smartMaskTimer);
    smartMaskTimer = setTimeout(function () {
      smartMaskTimer = 0;
      if (!state.preview) return;
      for (var j = 0; j < state.masks.length; j++) {
        if (isSmartMaskType(state.masks[j].type)) refreshMaskTexture(state.masks[j]);
      }
      scheduleRender();
    }, 220);
  }

  function transformCropForRotate(crop, dir) {
    if (!crop) return null;
    var x = crop.x, y = crop.y, w = crop.w, h = crop.h;
    if (dir > 0) return { x: 1 - (y + h), y: x, w: h, h: w };
    return { x: y, y: 1 - (x + w), w: h, h: w };
  }

  function rotateGeometry(dir) {
    if (!state.loaded || state.cropEditing) return;
    historyFlush();
    state.geometry.rotate90 = (((state.geometry.rotate90 + (dir > 0 ? 1 : -1)) % 4) + 4) % 4;
    state.geometry.crop = transformCropForRotate(state.geometry.crop, dir);
    markHistory(dir > 0 ? '向右旋转 90°' : '向左旋转 90°');
    rebuildRenderSource({ fit: true });
  }

  function flipGeometry(axis) {
    if (!state.loaded || state.cropEditing) return;
    historyFlush();
    var crop = state.geometry.crop;
    if (axis === 'h') {
      state.geometry.flipH = !state.geometry.flipH;
      if (crop) state.geometry.crop = { x: 1 - (crop.x + crop.w), y: crop.y, w: crop.w, h: crop.h };
    } else {
      state.geometry.flipV = !state.geometry.flipV;
      if (crop) state.geometry.crop = { x: crop.x, y: 1 - (crop.y + crop.h), w: crop.w, h: crop.h };
    }
    markHistory(axis === 'h' ? '水平镜像' : '垂直镜像');
    rebuildRenderSource();
  }

  function setStraighten(value) {
    if (!state.loaded || state.cropEditing) return;
    var angle = clamp(Number(value), -45, 45);
    state.geometry.angle = angle;
    if (els.geoAngleV) els.geoAngleV.textContent = angle.toFixed(1) + '°';
    if (els.geoAngle && Number(els.geoAngle.value) !== angle) els.geoAngle.value = String(angle);
    markHistory(Math.abs(angle) < 0.01 ? '拉直归零' : '拉直 ' + angle.toFixed(1) + '°');
    scheduleGeometryApply(null);
  }

  function resetGeometry() {
    if (!state.loaded || state.cropEditing) return;
    historyFlush();
    state.geometry = defaultGeometry();
    markHistory('重置几何');
    rebuildRenderSource({ fit: true });
  }

  function updateGeometryUI() {
    if (!root) return;
    var g = state.geometry;
    if (els.geoAngle) els.geoAngle.value = String(g.angle);
    if (els.geoAngleV) els.geoAngleV.textContent = Number(g.angle).toFixed(1) + '°';
    if (els.cropAspect) els.cropAspect.value = state.cropAspect;
    if (els.geoSum) {
      if (state.cropEditing) els.geoSum.textContent = '裁剪中';
      else if (geometryIsIdentity(g)) els.geoSum.textContent = '原始';
      else {
        var parts = [];
        if (g.rotate90) parts.push('旋转 ' + (g.rotate90 * 90) + '°');
        if (g.flipH) parts.push('水平镜像');
        if (g.flipV) parts.push('垂直镜像');
        if (Math.abs(g.angle) > 0.01) parts.push('拉直 ' + Number(g.angle).toFixed(1) + '°');
        if (g.crop) parts.push('已裁剪');
        els.geoSum.textContent = parts.join(' · ');
      }
    }
    if (els.geoNote) {
      if (!state.loaded) {
        els.geoNote.textContent = '拉直会自动放大以避免空白边缘；旋转或翻转后仍可继续裁剪。';
      } else {
        var dims = (state.renderW || 0) + ' × ' + (state.renderH || 0);
        var note = '输出 ' + dims + ' px';
        if (g.crop) note += ' · 裁剪 ' + Math.round(g.crop.w * 100) + '% × ' + Math.round(g.crop.h * 100) + '%';
        if (Math.abs(g.angle) > 0.01) note += ' · 拉直已自动放大避免空白边缘';
        if (state.cropEditing) note += ' · 拖动裁剪框后点击“应用裁剪”';
        els.geoNote.textContent = note;
      }
    }
    if (els.cropToggle) {
      els.cropToggle.classList.toggle('is-on', state.cropEditing);
      els.cropToggle.innerHTML = icon('crop') + (state.cropEditing ? '裁剪中' : '裁剪');
    }
    if (els.cropApplyRow) els.cropApplyRow.hidden = !state.cropEditing;
  }

  function syncCropOverlay() {
    if (!state.cropEditing || !els.cropOverlay || !els.canvas || !els.drop) return;
    var cr = els.canvas.getBoundingClientRect();
    var dr = els.drop.getBoundingClientRect();
    els.cropOverlay.style.left = Math.round(cr.left - dr.left + els.drop.scrollLeft) + 'px';
    els.cropOverlay.style.top = Math.round(cr.top - dr.top + els.drop.scrollTop) + 'px';
    els.cropOverlay.style.width = Math.round(cr.width) + 'px';
    els.cropOverlay.style.height = Math.round(cr.height) + 'px';
  }

  function cropOverlayRatio() {
    if (!els.cropOverlay) return 0;
    var w = els.cropOverlay.clientWidth || 1;
    var h = els.cropOverlay.clientHeight || 1;
    return w / h;
  }

  function cropNormRatio() {
    if (state.cropAspect === 'free') return 0;
    if (state.cropAspect === 'original') return 1;
    var aspect = CROP_ASPECTS[state.cropAspect] || 0;
    return aspect ? cropOverlayRatio() / aspect : 0;
  }

  function clampCropRect(rect) {
    var r = {
      x: clamp(Number(rect.x) || 0, 0, 0.98),
      y: clamp(Number(rect.y) || 0, 0, 0.98),
      w: clamp(Number(rect.w) || 0.02, 0.02, 1),
      h: clamp(Number(rect.h) || 0.02, 0.02, 1)
    };
    if (r.x + r.w > 1) r.w = 1 - r.x;
    if (r.y + r.h > 1) r.h = 1 - r.y;
    return r;
  }

  function fitCropToRatio(rect) {
    var nr = cropNormRatio();
    if (!nr) return clampCropRect(rect);
    var w = Math.max(0.02, rect.w);
    var h = w * nr;
    if (h > rect.h) {
      h = Math.max(0.02, rect.h);
      w = h / nr;
    }
    var scale = Math.min(1, 0.94 / Math.max(0.0001, w), 0.94 / Math.max(0.0001, h));
    w = Math.max(0.02, w * scale);
    h = Math.max(0.02, h * scale);
    var cx = clamp(rect.x + rect.w / 2, w / 2 + 0.02, 1 - w / 2 - 0.02);
    var cy = clamp(rect.y + rect.h / 2, h / 2 + 0.02, 1 - h / 2 - 0.02);
    return clampCropRect({ x: cx - w / 2, y: cy - h / 2, w: w, h: h });
  }

  function updateCropBox() {
    if (!els.cropBox || !state.cropEditing) return;
    var r = clampCropRect(state.cropRect || { x: 0, y: 0, w: 1, h: 1 });
    state.cropRect = r;
    els.cropBox.style.left = (r.x * 100).toFixed(3) + '%';
    els.cropBox.style.top = (r.y * 100).toFixed(3) + '%';
    els.cropBox.style.width = (r.w * 100).toFixed(3) + '%';
    els.cropBox.style.height = (r.h * 100).toFixed(3) + '%';
    els.cropBox.classList.toggle('is-ratio', !!cropNormRatio());
    updateCropSize();
  }

  function updateCropSize() {
    if (!els.cropSize || !state.cropRect) return;
    var r = state.cropRect;
    var pw = Math.max(1, Math.round((state.renderW || 0) * r.w));
    var ph = Math.max(1, Math.round((state.renderH || 0) * r.h));
    var ratioText = state.cropAspect === 'free' ? '' : ' · ' + state.cropAspect;
    els.cropSize.textContent = pw + ' × ' + ph + ratioText;
  }

  function updateCropUI() {
    if (!root) return;
    if (els.cropOverlay) els.cropOverlay.hidden = !state.cropEditing;
    if (state.cropEditing) {
      els.cropOverlay.hidden = false;
      syncCropOverlay();
      updateCropBox();
    }
  }

  function beginCropMode() {
    if (!state.loaded) return;
    if (state.cropEditing) { cancelCropMode(); return; }
    historyFlush();
    state.cropEditing = true;
    state.cropBackup = state.geometry.crop ? Object.assign({}, state.geometry.crop) : null;
    state.cropRect = state.cropBackup ? Object.assign({}, state.cropBackup) : { x: 0.07, y: 0.07, w: 0.86, h: 0.86 };
    state.geometry.crop = null;
    state.before = false;
    updateBeforeLabel();
    applyGeometrySource();
    state.zoomMode = 'fit';
    refreshAllMaskTextures();
    updateGeometryUI();
    applyZoom();
    updateCropUI();
    if (cropNormRatio()) {
      state.cropRect = fitCropToRatio(state.cropRect);
      updateCropBox();
    }
    scheduleRender();
    setStatus('裁剪模式：拖动边角调整裁剪框，完成后点击“应用裁剪”。', '');
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches) {
      var stage = root.querySelector('.raw-stage');
      if (stage) setTimeout(function () { stage.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 40);
    }
  }

  function applyCropMode() {
    if (!state.cropEditing) return;
    state.geometry.crop = clampCropRect(state.cropRect);
    state.cropEditing = false;
    state.cropDrag = null;
    state.cropBackup = null;
    state.cropRect = null;
    updateCropUI();
    markHistory('裁剪');
    rebuildRenderSource({ fit: true });
    setStatus('已应用裁剪：' + state.renderW + ' × ' + state.renderH + ' px。', 'ok');
  }

  function cancelCropMode() {
    if (!state.cropEditing) return;
    state.geometry.crop = state.cropBackup;
    state.cropEditing = false;
    state.cropDrag = null;
    state.cropBackup = null;
    state.cropRect = null;
    updateCropUI();
    rebuildRenderSource({ fit: true });
    setStatus('已取消裁剪。', '');
  }

  function cropPointFromEvent(e) {
    var rect = els.cropOverlay.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    };
  }

  function rectFromPoints(x0, y0, x1, y1, normRatio) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var w = Math.abs(dx);
    var h = Math.abs(dy);
    if (normRatio > 0) {
      if (w / Math.max(0.0001, h) < normRatio) w = h * normRatio;
      else h = w / normRatio;
      var maxW = dx >= 0 ? 1 - x0 : x0;
      var maxH = dy >= 0 ? 1 - y0 : y0;
      var k = Math.min(1, maxW / Math.max(0.0001, w), maxH / Math.max(0.0001, h));
      w *= k;
      h *= k;
    }
    return clampCropRect({
      x: dx >= 0 ? x0 : x0 - w,
      y: dy >= 0 ? y0 : y0 - h,
      w: w,
      h: h
    });
  }

  function resizeCropRect(base, handle, dx, dy, normRatio) {
    if (normRatio > 0 && (handle === 'n' || handle === 's' || handle === 'e' || handle === 'w')) {
      return base;
    }
    if (normRatio > 0) {
      var ax = handle.indexOf('w') >= 0 ? base.x + base.w : base.x;
      var ay = handle.indexOf('n') >= 0 ? base.y + base.h : base.y;
      var px = (handle.indexOf('w') >= 0 ? base.x : base.x + base.w) + dx;
      var py = (handle.indexOf('n') >= 0 ? base.y : base.y + base.h) + dy;
      var w = Math.abs(px - ax);
      var h = Math.abs(py - ay);
      if (w / Math.max(0.0001, h) < normRatio) w = h * normRatio;
      else h = w / normRatio;
      var signX = px >= ax ? 1 : -1;
      var signY = py >= ay ? 1 : -1;
      var maxW = signX > 0 ? 1 - ax : ax;
      var maxH = signY > 0 ? 1 - ay : ay;
      var k = Math.min(1, maxW / Math.max(0.0001, w), maxH / Math.max(0.0001, h));
      w *= k;
      h *= k;
      return clampCropRect({
        x: signX > 0 ? ax : ax - w,
        y: signY > 0 ? ay : ay - h,
        w: w,
        h: h
      });
    }
    var left = base.x;
    var top = base.y;
    var right = base.x + base.w;
    var bottom = base.y + base.h;
    if (handle.indexOf('w') >= 0) left = clamp(left + dx, 0, right - 0.02);
    if (handle.indexOf('e') >= 0) right = clamp(right + dx, left + 0.02, 1);
    if (handle.indexOf('n') >= 0) top = clamp(top + dy, 0, bottom - 0.02);
    if (handle.indexOf('s') >= 0) bottom = clamp(bottom + dy, top + 0.02, 1);
    return clampCropRect({ x: left, y: top, w: right - left, h: bottom - top });
  }

  function onCropPointerDown(e) {
    if (!state.cropEditing) return;
    e.preventDefault();
    var p = cropPointFromEvent(e);
    var handleEl = e.target.closest('[data-handle]');
    var inBox = e.target.closest('[data-crop-box]');
    var handle = handleEl ? handleEl.getAttribute('data-handle') : (inBox ? 'move' : 'new');
    if (cropNormRatio() && (handle === 'n' || handle === 's' || handle === 'e' || handle === 'w')) return;
    state.cropDrag = {
      mode: handle,
      sx: p.x,
      sy: p.y,
      rect: Object.assign({}, state.cropRect)
    };
    if (handle === 'new') {
      state.cropRect = { x: p.x, y: p.y, w: 0.02, h: 0.02 };
      updateCropBox();
    }
    try { els.cropOverlay.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function onCropPointerMove(e) {
    var drag = state.cropDrag;
    if (!drag || !state.cropEditing) return;
    e.preventDefault();
    var p = cropPointFromEvent(e);
    var dx = p.x - drag.sx;
    var dy = p.y - drag.sy;
    var nr = cropNormRatio();
    if (drag.mode === 'move') {
      state.cropRect = clampCropRect({
        x: clamp(drag.rect.x + dx, 0, 1 - drag.rect.w),
        y: clamp(drag.rect.y + dy, 0, 1 - drag.rect.h),
        w: drag.rect.w,
        h: drag.rect.h
      });
    } else if (drag.mode === 'new') {
      state.cropRect = rectFromPoints(drag.sx, drag.sy, p.x, p.y, nr);
    } else {
      state.cropRect = resizeCropRect(drag.rect, drag.mode, dx, dy, nr);
    }
    updateCropBox();
  }

  function onCropPointerUp(e) {
    if (!state.cropDrag) return;
    state.cropDrag = null;
    try { els.cropOverlay.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (!state.cropRect || state.cropRect.w < 0.025 || state.cropRect.h < 0.025) {
      state.cropRect = { x: 0.07, y: 0.07, w: 0.86, h: 0.86 };
      if (cropNormRatio()) state.cropRect = fitCropToRatio(state.cropRect);
    }
    updateCropBox();
  }

  function setCropAspect(value) {
    state.cropAspect = CROP_ASPECTS.hasOwnProperty(value) ? value : 'free';
    if (state.cropEditing) {
      state.cropRect = fitCropToRatio(state.cropRect);
      updateCropBox();
    }
    updateGeometryUI();
  }

  /* ------------------------------------------------------------------ *
   * 蒙版
   * ------------------------------------------------------------------ */

  var MASK_LABELS = { none: '未启用', linear: '线性渐变', radial: '径向渐变', brush: '画笔', sky: '智能天空', subject: '智能主体' };

  function activeMask() {
    for (var i = 0; i < state.masks.length; i++) {
      if (state.masks[i].id === state.activeMaskId) return state.masks[i];
    }
    return null;
  }

  function findMaskById(id) {
    for (var i = 0; i < state.masks.length; i++) {
      if (state.masks[i].id === id) return state.masks[i];
    }
    return null;
  }

  function maskHasAdjustments(mask) {
    if (mask.strokes && mask.strokes.length) return true;
    var l = mask.local || {};
    for (var i = 0; i < LOCALS.length; i++) {
      if (Math.abs(l[LOCALS[i].key] - LOCALS[i].def) > 1e-9) return true;
    }
    return false;
  }

  function renderMaskList() {
    if (!els.maskList) return;
    var keepTop = els.maskList.scrollTop;
    var keepLeft = els.maskList.scrollLeft;
    if (!state.masks.length) {
      els.maskList.innerHTML = '<p class="raw-mask-empty">尚未添加蒙版。点击下方“添加蒙版”开始，可叠加多个独立局部调整。</p>';
    } else {
      var html = '';
      for (var i = 0; i < state.masks.length; i++) {
        var m = state.masks[i];
        var isActive = m.id === state.activeMaskId;
        html += '<div class="raw-mask-item' + (isActive ? ' is-active' : '') + (m.enabled ? '' : ' is-off') + '" data-mask-row="' + m.id + '">' +
          '<button type="button" class="raw-mask-pick" data-mask-pick="' + m.id + '" aria-pressed="' + (isActive ? 'true' : 'false') + '">' +
            '<span class="raw-mask-dot is-' + m.type + '"></span>' +
            '<span class="raw-mask-name">' + escapeHTML(m.name) + '</span>' +
            '<span class="raw-mask-kind">' + maskTypeLabel(m.type) + '</span>' +
            (maskHasAdjustments(m) ? '<span class="raw-mask-badge">已调整</span>' : '') +
          '</button>' +
          '<label class="raw-mask-toggle" title="启用或停用此蒙版"><input type="checkbox" data-mask-enabled="' + m.id + '"' +
            (m.enabled ? ' checked' : '') + '><span>' + (m.enabled ? '启用' : '停用') + '</span></label>' +
        '</div>';
      }
      els.maskList.innerHTML = html;
    }
    els.maskList.scrollTop = keepTop;
    els.maskList.scrollLeft = keepLeft;
    if (els.maskCount) els.maskCount.textContent = state.masks.length + ' / ' + MAX_MASKS;
  }

  function updateMaskBadge(mask) {
    if (!els.maskList || !mask) return;
    var row = els.maskList.querySelector('[data-mask-row="' + mask.id + '"]');
    if (!row) return;
    var pick = row.querySelector('.raw-mask-pick');
    if (!pick) return;
    var badge = pick.querySelector('.raw-mask-badge');
    if (maskHasAdjustments(mask)) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'raw-mask-badge';
        badge.textContent = '已调整';
        pick.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  }

  function updateMaskUI() {
    var mask = activeMask();
    var hasMask = !!mask && mask.type !== 'none';
    renderMaskList();
    els.maskSeg.querySelectorAll('button').forEach(function (b) {
      var on = !!mask && b.getAttribute('data-mask') === mask.type;
      b.classList.toggle('is-active', on);
    });
    if (els.maskSum) {
      if (!state.masks.length) {
        els.maskSum.textContent = '未添加';
      } else {
        var enabled = state.masks.filter(function (m) { return m.enabled; }).length;
        els.maskSum.textContent = state.masks.length + ' 个 · ' + enabled + ' 启用';
      }
    }
    if (els.localSliders) els.localSliders.classList.toggle('is-disabled', !hasMask);
    if (els.localScope) els.localScope.textContent = mask ? (mask.name + ' · ' + maskTypeLabel(mask.type)) : '未启用';
    els.maskInvert.checked = mask ? !!mask.invert : false;
    els.maskShow.checked = mask ? !!mask.show : false;
    els.maskInvert.disabled = !mask;
    els.maskShow.disabled = !mask;
    els.maskFeather.disabled = !mask;
    if (mask) {
      els.maskFeather.value = String(Math.round(mask.feather * 100));
      els.maskFeatherV.textContent = String(Math.round(mask.feather * 100));
    } else {
      els.maskFeather.value = '0';
      els.maskFeatherV.textContent = '0';
    }
    var textured = !!mask && isTexturedMaskType(mask.type);
    els.brushRow.hidden = !textured;
    if (els.brushExtra) els.brushExtra.hidden = !textured;
    if (els.brushMode) {
      els.brushMode.querySelectorAll('button').forEach(function (b) {
        var on = !!mask && b.getAttribute('data-brush-mode') === (mask.brushMode || 'add');
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    if (mask) {
      els.brushSize.value = String(mask.brushPct);
      els.brushSizeV.textContent = mask.brushPct + '%';
      var undoStroke = root.querySelector('[data-act="mask-undo-stroke"]');
      if (undoStroke) undoStroke.disabled = !textured || !mask.strokes.length;
    }
    if (els.maskAI) els.maskAI.hidden = !mask || !isSmartMaskType(mask.type);
    var clearBtn = root.querySelector('[data-act="mask-clear"]');
    if (clearBtn) {
      clearBtn.textContent = isSmartMaskType(mask && mask.type) ? '清除笔画' :
        isTexturedMaskType(mask && mask.type) ? '清除笔画 / 范围' : '清除范围';
    }
    els.canvas.classList.toggle('is-masking', hasMask && mask.enabled && !state.cropEditing);
    els.maskNote.classList.toggle('is-empty', !hasMask);
    if (!mask) {
      els.maskNote.innerHTML = '尚未添加蒙版。点击“添加蒙版”后可在预览画面上拖动定义范围，局部调整只作用于蒙版内。';
    } else if (!hasMask) {
      els.maskNote.innerHTML = '当前蒙版类型为“无”。选择线性、径向、画笔或智能识别后即可建立范围。';
    } else if (mask.type === 'linear') {
      els.maskNote.innerHTML = '<b>线性渐变</b>：在画面上从起点拖到终点，<b>终点一侧</b>为蒙版内；多个蒙版按列表顺序叠加。';
    } else if (mask.type === 'radial') {
      els.maskNote.innerHTML = '<b>径向渐变</b>：从中心向外拖动改变椭圆范围；勾选“显示蒙版”可检查当前活动蒙版的覆盖区域。';
    } else if (mask.type === 'sky') {
      els.maskNote.innerHTML = '<b>智能天空</b>：在浏览器内按颜色与顶部连通区域识别，人物/建筑边缘可能需用画笔修整。勾选“显示蒙版”检查覆盖，必要时点“重新识别”。';
    } else if (mask.type === 'subject') {
      els.maskNote.innerHTML = '<b>智能主体</b>：按中心构图、边缘色差与显著性识别主体，复杂背景可能需要画笔补充或擦除。全部计算在本机完成。';
    } else {
      els.maskNote.innerHTML = '<b>画笔</b>：在画面上拖动涂抹蒙版，可调画笔大小与羽化；勾选“显示蒙版”可查看覆盖范围。';
    }
    if (els.exportSum) {
      els.exportSum.textContent = els.exportFormat.value === 'image/png' ? 'PNG' : 'JPEG';
    }
  }

  function setMaskType(type) {
    var mask = activeMask();
    if (!mask) {
      if (type === 'none') return;
      addMask(type);
      return;
    }
    type = normalizeMaskType(type);
    if (type === mask.type) return;
    if (isTexturedMaskType(mask.type)) {
      if (renderer) renderer.clearMask(mask.id);
      delete previewMaskCanvases[mask.id];
      clearAIBaseForMask(mask.id);
    }
    mask.type = type;
    mask.show = false;
    mask.current = null;
    mask.dragMode = '';
    mask.strokes = [];
    if (type === 'linear') {
      var lg = maskGeometryDefaults('linear');
      mask.p1 = lg.p1;
      mask.p2 = lg.p2;
      mask.feather = 0.45;
    } else if (type === 'radial') {
      var rg = maskGeometryDefaults('radial');
      mask.p1 = rg.p1;
      mask.p2 = rg.p2;
      mask.feather = 0.45;
    } else if (type === 'brush') {
      mask.feather = 0.35;
    } else if (isSmartMaskType(type)) {
      mask.feather = 0.3;
      mask.show = true;
    }
    markHistory('切换蒙版类型 · ' + maskTypeLabel(type));
    updateMaskUI();
    updateAdjustOutputs();
    restoreBaselineIfNeeded();
    if (isSmartMaskType(type)) identifySmartMask(mask, true);
    else if (type === 'brush') scheduleMaskBuild(mask);
    else scheduleRender();
    dispatch('raw:mask', { type: type, id: mask.id });
  }

  function setBrushMode(mode) {
    var mask = activeMask();
    if (!mask) return;
    mask.brushMode = mode === 'subtract' ? 'subtract' : 'add';
    updateMaskUI();
    scheduleRender();
  }

  function undoMaskStroke() {
    var mask = activeMask();
    if (!mask || !isTexturedMaskType(mask.type) || !mask.strokes.length) return;
    mask.strokes.pop();
    mask.current = null;
    markHistory('撤销蒙版笔画');
    updateMaskUI();
    scheduleMaskBuild(mask);
    scheduleRender();
    setStatus('已撤销一笔蒙版画笔。', 'ok');
  }

  function clearMaskRange() {
    var mask = activeMask();
    if (!mask) return;
    markHistory('清除蒙版范围');
    if (mask.type === 'linear' || mask.type === 'radial') {
      var geo = maskGeometryDefaults(mask.type);
      mask.p1 = geo.p1;
      mask.p2 = geo.p2;
    } else if (isTexturedMaskType(mask.type)) {
      mask.strokes = [];
      mask.current = null;
      scheduleMaskBuild(mask);
    }
    updateMaskUI();
    scheduleRender();
  }

  function addMask(type, opts, silent) {
    if (state.masks.length >= MAX_MASKS) {
      setStatus('最多支持 ' + MAX_MASKS + ' 个蒙版，请先删除一个。', 'warn');
      return null;
    }
    var mask = createMask(type || 'linear', opts);
    if (isSmartMaskType(mask.type)) mask.show = true;
    state.masks.push(mask);
    state.activeMaskId = mask.id;
    if (!silent) {
      markHistory('添加' + maskTypeLabel(mask.type) + '蒙版');
      updateMaskUI();
      updateAdjustOutputs();
      restoreBaselineIfNeeded();
      if (isSmartMaskType(mask.type)) identifySmartMask(mask, true);
      else if (mask.type === 'brush') scheduleMaskBuild(mask);
      else scheduleRender();
      dispatch('raw:masks', { action: 'add', id: mask.id, count: state.masks.length });
    }
    return mask;
  }

  function duplicateActiveMask() {
    var src = activeMask();
    if (!src) {
      addMask('linear');
      return null;
    }
    if (state.masks.length >= MAX_MASKS) {
      setStatus('最多支持 ' + MAX_MASKS + ' 个蒙版，请先删除一个。', 'warn');
      return null;
    }
    var copy = createMask(src.type);
    copy.name = src.name + ' 副本';
    copy.enabled = src.enabled;
    copy.show = src.show;
    copy.invert = src.invert;
    copy.feather = src.feather;
    copy.p1 = { x: src.p1.x, y: src.p1.y };
    copy.p2 = { x: src.p2.x, y: src.p2.y };
    copy.brushPct = src.brushPct;
    copy.brushMode = src.brushMode || 'add';
    copy.local = Object.assign({}, src.local);
    copy.strokes = src.strokes.map(function (stroke) {
      return {
        radius: stroke.radius,
        mode: stroke.mode || 'add',
        points: (stroke.points || []).map(function (p) { return { x: p.x, y: p.y }; })
      };
    });
    var idx = state.masks.indexOf(src);
    state.masks.splice(idx + 1, 0, copy);
    state.activeMaskId = copy.id;
    markHistory('复制蒙版');
    updateMaskUI();
    updateAdjustOutputs();
    restoreBaselineIfNeeded();
    if (isSmartMaskType(copy.type)) identifySmartMask(copy, false);
    else if (copy.type === 'brush') scheduleMaskBuild(copy);
    else scheduleRender();
    dispatch('raw:masks', { action: 'duplicate', id: copy.id, count: state.masks.length });
    return copy;
  }

  function removeMaskById(id) {
    for (var i = 0; i < state.masks.length; i++) {
      if (state.masks[i].id !== id) continue;
      var removed = state.masks.splice(i, 1)[0];
      if (renderer) renderer.clearMask(removed.id);
      delete previewMaskCanvases[removed.id];
      clearAIBaseForMask(removed.id);
      if (state.activeMaskId === removed.id) {
        var next = state.masks[Math.min(i, state.masks.length - 1)];
        state.activeMaskId = next ? next.id : null;
      }
      markHistory('删除蒙版');
      updateMaskUI();
      updateAdjustOutputs();
      restoreBaselineIfNeeded();
      scheduleRender();
      dispatch('raw:masks', { action: 'remove', id: removed.id, count: state.masks.length });
      return removed;
    }
    return null;
  }

  function removeActiveMask() {
    var mask = activeMask();
    if (!mask) return null;
    return removeMaskById(mask.id);
  }

  function setActiveMask(id) {
    var mask = findMaskById(id);
    if (!mask) return;
    state.activeMaskId = mask.id;
    updateMaskUI();
    updateAdjustOutputs();
    scheduleRender();
    dispatch('raw:masks', { action: 'activate', id: mask.id, count: state.masks.length });
  }

  function setMaskEnabled(id, enabled) {
    var mask = findMaskById(id);
    if (!mask) return;
    mask.enabled = !!enabled;
    markHistory(mask.enabled ? '启用蒙版' : '停用蒙版');
    updateMaskUI();
    updateAdjustOutputs();
    scheduleRender();
    dispatch('raw:masks', { action: 'enabled', id: mask.id, enabled: mask.enabled, count: state.masks.length });
  }

  function clearAIBaseForMask(id) {
    var prefix = String(id) + ':';
    Object.keys(aiBaseCache).forEach(function (key) {
      if (key.indexOf(prefix) === 0) delete aiBaseCache[key];
    });
  }

  function analysisCanvas(source, maxEdge) {
    var scale = Math.min(1, maxEdge / Math.max(1, source.width, source.height));
    var w = Math.max(24, Math.round(source.width * scale));
    var h = Math.max(24, Math.round(source.height * scale));
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return { w: w, h: h, data: ctx.getImageData(0, 0, w, h).data };
  }

  function maskCanvasFromBinary(binary, w, h, targetWidth, coverage) {
    var small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    var sctx = small.getContext('2d');
    var img = sctx.createImageData(w, h);
    for (var i = 0; i < binary.length; i++) {
      var v = binary[i] ? 255 : 0;
      var o = i * 4;
      img.data[o] = v;
      img.data[o + 1] = v;
      img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    var outW = Math.max(64, Math.min(1024, Math.round(targetWidth)));
    var outH = Math.max(1, Math.round(outW * h / w));
    var out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try { ctx.filter = 'blur(' + Math.max(1, outW / 420).toFixed(2) + 'px)'; } catch (e) { /* ignore */ }
    ctx.drawImage(small, 0, 0, outW, outH);
    try { ctx.filter = 'none'; } catch (e2) { /* ignore */ }
    return { canvas: out, coverage: coverage || 0 };
  }

  // 本地天空识别：颜色评分 + 顶部连通域，避免把蓝色衣服等孤立区域当成天空。
  function detectSkyBase(source, targetWidth) {
    var a = analysisCanvas(source, 256);
    var w = a.w;
    var h = a.h;
    var data = a.data;
    var n = w * h;
    var bin = new Uint8Array(n);
    var score = new Float32Array(n);
    for (var y = 0; y < h; y++) {
      var top = 1 - y / Math.max(1, h - 1);
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var o = i * 4;
        var r = data[o] / 255;
        var g = data[o + 1] / 255;
        var b = data[o + 2] / 255;
        var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        var mx = Math.max(r, g, b);
        var mn = Math.min(r, g, b);
        var sat = (mx - mn) / Math.max(0.0001, mx);
        var blueness = b - (r + g) / 2;
        var blueSky = smoothstep(0.0, 0.08, blueness);
        var paleSky = smoothstep(0.28, 0.68, l) * (1 - smoothstep(0.28, 0.6, sat));
        var value = Math.max(blueSky * 0.95, paleSky * 0.9);
        if (g > b + 0.02 && sat > 0.2) value *= 0.35;
        var prior = 0.28 + 0.72 * smoothstep(0.05, 0.65, top);
        value *= prior;
        score[i] = value;
        if (value >= 0.26) bin[i] = 1;
      }
    }
    var seen = new Uint8Array(n);
    var keep = new Uint8Array(n);
    var stack = new Int32Array(n);
    var keptArea = 0;
    for (var start = 0; start < n; start++) {
      if (!bin[start] || seen[start]) continue;
      var sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      var pixels = [];
      var minY = h;
      while (sp > 0) {
        var cur = stack[--sp];
        pixels.push(cur);
        var cy = Math.floor(cur / w);
        if (cy < minY) minY = cy;
        var cx = cur % w;
        var neighbors = [cur - 1, cur + 1, cur - w, cur + w];
        for (var k = 0; k < 4; k++) {
          var nb = neighbors[k];
          if (k === 0 && cx === 0) continue;
          if (k === 1 && cx === w - 1) continue;
          if (nb < 0 || nb >= n || seen[nb] || !bin[nb]) continue;
          seen[nb] = 1;
          stack[sp++] = nb;
        }
      }
      var area = pixels.length;
      if (minY <= Math.max(2, Math.round(h * 0.12)) && area >= n * 0.002) {
        for (var q = 0; q < pixels.length; q++) keep[pixels[q]] = 1;
        keptArea += area;
      }
    }
    var coverage = keptArea / n;
    return maskCanvasFromBinary(keep, w, h, targetWidth, coverage);
  }

  // 本地主体识别：以画面中心、与边缘背景的色差、饱和度和局部边缘作显著性评分。
  function fillMaskHoles(bin, w, h) {
    var n = w * h;
    var outside = new Uint8Array(n);
    var stack = new Int32Array(n);
    var sp = 0;
    function push(i) {
      if (i < 0 || i >= n || outside[i] || bin[i]) return;
      outside[i] = 1;
      stack[sp++] = i;
    }
    for (var x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp > 0) {
      var cur = stack[--sp];
      push(cur - 1);
      push(cur + 1);
      push(cur - w);
      push(cur + w);
    }
    var keep = new Uint8Array(n);
    for (var i = 0; i < n; i++) keep[i] = (bin[i] || !outside[i]) ? 1 : 0;
    return keep;
  }

  // 本地主体识别：边缘背景色聚类 + 中心/显著性/边缘密度评分，再做连通域与填洞。
  function detectSubjectBase(source, targetWidth) {
    var a = analysisCanvas(source, 256);
    var w = a.w;
    var h = a.h;
    var data = a.data;
    var n = w * h;
    var lums = new Float32Array(n);
    var i, x, y, o;
    for (i = 0; i < n; i++) {
      o = i * 4;
      lums[i] = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
    }
    // 从画面四边采样背景，做 4 类颜色聚类（天空、地面、山体、深色边缘等）。
    var border = Math.max(3, Math.round(Math.min(w, h) * 0.04));
    var samples = [];
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        if (x >= border && x < w - border && y >= border && y < h - border) continue;
        o = (y * w + x) * 4;
        samples.push({
          r: data[o] / 255,
          g: data[o + 1] / 255,
          b: data[o + 2] / 255,
          l: lums[y * w + x]
        });
      }
    }
    samples.sort(function (p1, p2) { return p1.l - p2.l; });
    var k = 4;
    var centroids = [];
    for (var ci = 0; ci < k; ci++) {
      var sample = samples[Math.min(samples.length - 1, Math.round((ci + 0.5) / k * samples.length))] ||
        { r: 0.5, g: 0.5, b: 0.5 };
      centroids.push([sample.r, sample.g, sample.b]);
    }
    for (var it = 0; it < 10; it++) {
      var sums = [];
      for (var kk = 0; kk < k; kk++) sums.push([0, 0, 0, 0]);
      for (var si = 0; si < samples.length; si++) {
        var sp2 = samples[si];
        var best = 0;
        var bestD = Infinity;
        for (var cj = 0; cj < k; cj++) {
          var dd = Math.pow(sp2.r - centroids[cj][0], 2) +
            Math.pow(sp2.g - centroids[cj][1], 2) + Math.pow(sp2.b - centroids[cj][2], 2);
          if (dd < bestD) { bestD = dd; best = cj; }
        }
        sums[best][0] += sp2.r;
        sums[best][1] += sp2.g;
        sums[best][2] += sp2.b;
        sums[best][3]++;
      }
      for (var ck = 0; ck < k; ck++) {
        if (!sums[ck][3]) continue;
        centroids[ck][0] = sums[ck][0] / sums[ck][3];
        centroids[ck][1] = sums[ck][1] / sums[ck][3];
        centroids[ck][2] = sums[ck][2] / sums[ck][3];
      }
    }
    var bgDist = new Float32Array(n);
    for (i = 0; i < n; i++) {
      o = i * 4;
      var r = data[o] / 255;
      var g = data[o + 1] / 255;
      var b = data[o + 2] / 255;
      var minD = Infinity;
      for (var cq = 0; cq < k; cq++) {
        var d2 = Math.pow(r - centroids[cq][0], 2) +
          Math.pow(g - centroids[cq][1], 2) + Math.pow(b - centroids[cq][2], 2);
        if (d2 < minD) minD = d2;
      }
      bgDist[i] = Math.sqrt(minD);
    }
    // 5×5 邻域边缘密度，用来区分有细节的主体与平滑的天空/虚化背景。
    var edge = new Float32Array(n);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (x > 0 && y > 0) {
          edge[i] = Math.abs(lums[i] - lums[i - 1]) + Math.abs(lums[i] - lums[i - w]);
        }
      }
    }
    var edgeDensity = new Float32Array(n);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var sum = 0;
        var cnt = 0;
        for (var oy = -2; oy <= 2; oy++) {
          for (var ox = -2; ox <= 2; ox++) {
            var yy = y + oy;
            var xx = x + ox;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
            sum += edge[yy * w + xx];
            cnt++;
          }
        }
        edgeDensity[y * w + x] = sum / Math.max(1, cnt);
      }
    }
    var scores = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var px = (i % w) / Math.max(1, w - 1);
      var py = Math.floor(i / w) / Math.max(1, h - 1);
      var center = Math.exp(-0.5 * (Math.pow((px - 0.5) / 0.32, 2) + Math.pow((py - 0.5) / 0.4, 2)));
      o = i * 4;
      var mx = Math.max(data[o], data[o + 1], data[o + 2]) / 255;
      var mn = Math.min(data[o], data[o + 1], data[o + 2]) / 255;
      var sat = (mx - mn) / Math.max(0.0001, mx);
      scores[i] = 0.14 * center +
        0.52 * Math.min(1, bgDist[i] / 0.42) +
        0.12 * Math.min(1, sat / 0.6) +
        0.22 * Math.min(1, edgeDensity[i] / 0.09);
    }
    var hist = new Uint32Array(101);
    for (var hi = 0; hi < n; hi++) hist[clamp(Math.round(scores[hi] * 100), 0, 100)]++;
    var targetCount = Math.round(n * 0.78);
    var acc = 0;
    var thresholdBin = 30;
    for (var hb = 0; hb <= 100; hb++) {
      acc += hist[hb];
      if (acc >= targetCount) { thresholdBin = hb; break; }
    }
    var threshold = clamp(thresholdBin / 100, 0.28, 0.6);
    var bin = new Uint8Array(n);
    for (var bi = 0; bi < n; bi++) if (scores[bi] >= threshold) bin[bi] = 1;
    var filled = fillMaskHoles(bin, w, h);
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var bestPixels = null;
    var bestArea = 0;
    for (var start = 0; start < n; start++) {
      if (!filled[start] || seen[start]) continue;
      var sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      var pixels = [];
      var cxSum = 0;
      var cySum = 0;
      while (sp > 0) {
        var cur = stack[--sp];
        pixels.push(cur);
        cxSum += cur % w;
        cySum += Math.floor(cur / w);
        var cx = cur % w;
        var neighbors = [cur - 1, cur + 1, cur - w, cur + w];
        for (var nbk = 0; nbk < 4; nbk++) {
          var nb = neighbors[nbk];
          if (nbk === 0 && cx === 0) continue;
          if (nbk === 1 && cx === w - 1) continue;
          if (nb < 0 || nb >= n || seen[nb] || !filled[nb]) continue;
          seen[nb] = 1;
          stack[sp++] = nb;
        }
      }
      var area = pixels.length;
      var cxNorm = (cxSum / Math.max(1, area)) / w;
      var cyNorm = (cySum / Math.max(1, area)) / h;
      var central = cxNorm > 0.12 && cxNorm < 0.88 && cyNorm > 0.08 && cyNorm < 0.95;
      var weighted = area * (central ? 1 : 0.4);
      if (weighted > bestArea) { bestArea = weighted; bestPixels = pixels; }
    }
    var keep = new Uint8Array(n);
    var keptArea = 0;
    if (bestPixels && bestPixels.length >= n * 0.003) {
      for (var bp = 0; bp < bestPixels.length; bp++) keep[bestPixels[bp]] = 1;
      keptArea = bestPixels.length;
    } else {
      // 没有可靠的连通区域时退回中心椭圆，用户仍可用画笔修整。
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var ex = (x / Math.max(1, w - 1) - 0.5) / 0.3;
          var ey = (y / Math.max(1, h - 1) - 0.56) / 0.42;
          if (ex * ex + ey * ey <= 1) {
            keep[y * w + x] = 1;
            keptArea++;
          }
        }
      }
    }
    return maskCanvasFromBinary(keep, w, h, targetWidth, keptArea / n);
  }

  function getSmartBase(mask, targetWidth, srcW, srcH, sourceCanvas, force) {
    var source = sourceCanvas || state.renderSource;
    if (!source) return null;
    var key = mask.id + ':' + Math.round(targetWidth) + ':' + source.width + 'x' + source.height;
    if (!force && aiBaseCache[key]) return aiBaseCache[key];
    var base = mask.type === 'sky'
      ? detectSkyBase(source, targetWidth)
      : detectSubjectBase(source, targetWidth);
    aiBaseCache[key] = base;
    return base;
  }

  function identifySmartMask(mask, show) {
    if (!mask || !isSmartMaskType(mask.type) || !state.renderSource) return;
    clearAIBaseForMask(mask.id);
    var base = getSmartBase(mask, MASK_PREVIEW_WIDTH, state.renderW, state.renderH, state.renderSource, true);
    if (show) mask.show = true;
    if (mask.show) {
      for (var i = 0; i < state.masks.length; i++) {
        if (state.masks[i] !== mask) state.masks[i].show = false;
      }
    }
    refreshMaskTexture(mask);
    markHistory('识别' + maskTypeLabel(mask.type) + '蒙版');
    updateMaskUI();
    scheduleRender();
    var coverage = base ? Math.round(base.coverage * 1000) / 10 : 0;
    if (coverage >= 0.2) {
      setStatus('已生成' + maskTypeLabel(mask.type) + '蒙版，覆盖约 ' + coverage +
        '%。可用画笔补充或擦除，并调节羽化与局部参数。', 'ok');
    } else {
      setStatus('未识别到明显的' + (mask.type === 'sky' ? '天空' : '主体') +
        '。可换一张照片，或改用画笔手动建立范围。', 'warn');
    }
    dispatch('raw:mask-ai', { id: mask.id, type: mask.type, coverage: coverage / 100 });
  }

  function buildMaskCanvas(mask, targetWidth, srcW, srcH, reuse, sourceCanvas) {
    if (!mask) return null;
    var w = Math.max(64, Math.min(2048, Math.round(targetWidth)));
    var h = Math.max(1, Math.round(w * (srcH / Math.max(1, srcW))));
    var canvas = reuse || document.createElement('canvas');
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    if (!isTexturedMaskType(mask.type)) return canvas;
    if (isSmartMaskType(mask.type)) {
      var base = getSmartBase(mask, w, srcW, srcH, sourceCanvas || state.renderSource, false);
      if (base && base.canvas) ctx.drawImage(base.canvas, 0, 0, w, h);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < mask.strokes.length; i++) {
      var stroke = mask.strokes[i];
      var pts = stroke.points || [];
      if (!pts.length) continue;
      var color = stroke.mode === 'subtract' ? '#000000' : '#FFFFFF';
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      var radius = Math.max(0.0015, stroke.radius || 0.04);
      var lineWidth = Math.max(1, radius * 2 * w);
      ctx.lineWidth = lineWidth;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * w, pts[0].y * h, lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x * w, pts[0].y * h);
        for (var p = 1; p < pts.length; p++) {
          var prev = pts[p - 1];
          var cur = pts[p];
          // 二次曲线让笔画更顺滑
          var mx = (prev.x + cur.x) * 0.5 * w;
          var my = (prev.y + cur.y) * 0.5 * h;
          ctx.quadraticCurveTo(prev.x * w, prev.y * h, mx, my);
        }
        var last = pts[pts.length - 1];
        ctx.lineTo(last.x * w, last.y * h);
        ctx.stroke();
      }
    }
    return canvas;
  }

  function refreshMaskTexture(mask, skipSmart) {
    if (!renderer || !state.preview || !mask) return;
    if (skipSmart && isSmartMaskType(mask.type)) return;
    if (isTexturedMaskType(mask.type)) {
      var c = buildMaskCanvas(mask, MASK_PREVIEW_WIDTH, state.renderW || state.preview.w,
        state.renderH || state.preview.h, previewMaskCanvases[mask.id], state.renderSource);
      previewMaskCanvases[mask.id] = c;
      renderer.setMask(mask.id, c);
    } else {
      renderer.clearMask(mask.id);
      delete previewMaskCanvases[mask.id];
    }
  }

  function refreshAllMaskTextures(skipSmart) {
    if (!renderer || !state.preview) return;
    if (!skipSmart && smartMaskTimer) {
      clearTimeout(smartMaskTimer);
      smartMaskTimer = 0;
    }
    for (var i = 0; i < state.masks.length; i++) refreshMaskTexture(state.masks[i], skipSmart);
  }

  function scheduleMaskBuild(mask) {
    mask = mask || activeMask();
    if (!mask || !isTexturedMaskType(mask.type)) return;
    maskBuildQueue[mask.id] = true;
    if (maskBuildRaf) return;
    maskBuildRaf = true;
    requestAnimationFrame(function () {
      maskBuildRaf = false;
      var ids = Object.keys(maskBuildQueue);
      maskBuildQueue = Object.create(null);
      for (var i = 0; i < ids.length; i++) {
        var m = findMaskById(ids[i]);
        if (m) refreshMaskTexture(m);
      }
      scheduleRender();
    });
  }

  function canvasUV(e) {
    var rect = els.canvas.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    };
  }

  function onCanvasPointerDown(e) {
    var mask = activeMask();
    if (!state.loaded || state.cropEditing || !mask || mask.type === 'none' || !mask.enabled || state.before) return;
    e.preventDefault();
    var uv = canvasUV(e);
    try { els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (isTexturedMaskType(mask.type)) {
      mask.current = {
        points: [uv],
        radius: Math.max(0.005, mask.brushPct / 200),
        mode: mask.brushMode || 'add'
      };
      mask.strokes.push(mask.current);
      mask.dragMode = 'brush';
      markHistory(mask.type === 'brush' ? '画笔涂抹' : '修整' + maskTypeLabel(mask.type) + '蒙版');
      scheduleMaskBuild(mask);
    } else if (mask.type === 'linear') {
      mask.dragMode = 'linear';
      mask._start = uv;
      mask._moved = false;
      markHistory('调整线性蒙版');
    } else if (mask.type === 'radial') {
      mask.dragMode = 'radial';
      mask._start = uv;
      mask._moved = false;
      mask.p1 = uv;
      markHistory('调整径向蒙版');
    }
  }

  function onCanvasPointerMove(e) {
    var mask = activeMask();
    if (!mask || !mask.dragMode) return;
    var uv = canvasUV(e);
    if (mask.dragMode === 'brush' && mask.current) {
      var pts = mask.current.points;
      var last = pts[pts.length - 1];
      var dx = (uv.x - last.x) * state.preview.w;
      var dy = (uv.y - last.y) * state.preview.h;
      if (Math.hypot(dx, dy) >= 1.5) {
        pts.push(uv);
        scheduleMaskBuild(mask);
      }
    } else if (mask.dragMode === 'linear') {
      var s = mask._start;
      if (Math.hypot(uv.x - s.x, uv.y - s.y) > 0.004) {
        mask.p1 = s;
        mask.p2 = uv;
        mask._moved = true;
        scheduleRender();
      }
    } else if (mask.dragMode === 'radial') {
      var c = mask._start;
      var rx = Math.abs(uv.x - c.x);
      var ry = Math.abs(uv.y - c.y);
      if (Math.hypot(rx, ry) > 0.004) {
        mask.p1 = c;
        mask.p2 = { x: Math.max(0.01, rx), y: Math.max(0.01, ry) };
        mask._moved = true;
        scheduleRender();
      }
    }
  }

  function onCanvasPointerUp(e) {
    var mask = activeMask();
    if (!mask || !mask.dragMode) return;
    if (mask.dragMode === 'brush') {
      mask.current = null;
      scheduleMaskBuild(mask);
      historyTouch(mask.type === 'brush' ? '画笔涂抹' : '修整' + maskTypeLabel(mask.type) + '蒙版');
    } else if (mask.dragMode === 'radial' && !mask._moved) {
      mask.p2 = { x: 0.28, y: 0.28 };
      scheduleRender();
    }
    mask.dragMode = '';
    mask._start = null;
    updateMaskUI();
    if (mask.type === 'linear' || mask.type === 'radial') historyTouch('调整蒙版范围');
    try { els.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * 缩放 / 适应
   * ------------------------------------------------------------------ */

  function applyZoom() {
    if (!state.preview || !els.canvas) return;
    var w = state.renderW || state.preview.w;
    var h = state.renderH || state.preview.h;
    var scale;
    if (state.zoomMode === 'fit') {
      var availW = Math.max(80, els.drop.clientWidth - 30);
      var availH = Math.max(80, els.drop.clientHeight - 30);
      scale = Math.min(availW / w, availH / h);
      if (!isFinite(scale) || scale <= 0) scale = 1;
    } else {
      scale = state.zoomPct / 100;
    }
    els.canvas.style.width = Math.max(1, Math.round(w * scale)) + 'px';
    els.canvas.style.height = Math.max(1, Math.round(h * scale)) + 'px';
    var pct = Math.round(scale * 100);
    els.zoomVal.textContent = state.zoomMode === 'fit' ? '适应 ' + pct + '%' : pct + '%';
    if (state.zoomMode !== 'fit') els.zoom.value = String(clamp(pct, 25, 200));
    if (state.cropEditing) syncCropOverlay();
  }

  function setZoomPct(pct) {
    state.zoomMode = 'manual';
    state.zoomPct = clamp(pct, 25, 200);
    applyZoom();
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function estimateExportSeconds() {
    var pixels = (state.fullSize.w || 0) * (state.fullSize.h || 0);
    var previewPixels = state.preview ? state.preview.w * state.preview.h : 1;
    var ratio = Math.max(1, pixels / Math.max(1, previewPixels));
    var decode = state.previewDecodeMs || 400;
    var ms = decode * ratio * 1.15 + 500;
    return ms / 1000;
  }

  function confirmLargeExport(sec, pixels) {
    return new Promise(function (resolve) {
      var modal = document.createElement('div');
      modal.className = 'raw-modal';
      modal.innerHTML =
        '<div class="raw-modal-card" role="dialog" aria-modal="true" aria-labelledby="raw-modal-title">' +
          '<h3 id="raw-modal-title">全分辨率导出</h3>' +
          '<p>导出会重新解码原始文件并应用当前调整与蒙版。<b>预计需要约 ' + Math.ceil(sec) + ' 秒</b>，期间页面会短暂无响应。</p>' +
          '<div class="raw-modal-meta">' + (state.fullSize.w || '?') + ' × ' + (state.fullSize.h || '?') +
            ' · ' + (pixels ? (pixels / 1e6).toFixed(1) + ' MP' : '未知像素') + ' · 全部在本地完成</div>' +
          '<div class="raw-modal-actions">' +
            '<button type="button" class="raw-btn" data-modal="cancel">取消</button>' +
            '<button type="button" class="raw-btn primary" data-modal="ok">继续导出</button>' +
          '</div>' +
        '</div>';
      root.appendChild(modal);
      function done(ok) {
        modal.remove();
        resolve(ok);
      }
      modal.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-modal]');
        if (!btn) return;
        done(btn.getAttribute('data-modal') === 'ok');
      });
      var okBtn = modal.querySelector('[data-modal="ok"]');
      if (okBtn) okBtn.focus();
    });
  }

  async function decodeFullResolution() {
    if (!state.loaded) throw new Error('尚未载入文件。');
    if (state.fileKind === 'raw') {
      if (!state.raw) throw new Error('RAW 会话已关闭，请重新载入文件。');
      var frame = await state.raw.decode({
        output: 'rgba8',
        demosaic: 'bilinear',
        crop: true,
        corruptionPolicy: 'recover',
        previewFallback: true
      });
      var imageData = frame.toImageData();
      var w = frame.width;
      var h = frame.height;
      var source = frame.source;
      try { frame.free(); } catch (e) { /* ignore */ }
      return { imageData: imageData, w: w, h: h, source: source };
    }
    if (!state.imageFile) throw new Error('原始图片已不可用，请重新载入。');
    var bmp;
    try {
      bmp = await createImageBitmap(state.imageFile, { imageOrientation: 'from-image' });
    } catch (e) {
      bmp = await createImageBitmap(state.imageFile);
    }
    return { bitmap: bmp, w: bmp.width, h: bmp.height, source: 'image' };
  }

  function makeExportSourceCanvas(decoded) {
    var canvas = document.createElement('canvas');
    canvas.width = decoded.w;
    canvas.height = decoded.h;
    var ctx = canvas.getContext('2d', { willReadFrequently: false });
    // 相机 RAW 无透明通道；PNG/WebP 的透明区域在导出时铺白，避免 JPEG 变黑。
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (decoded.imageData) ctx.putImageData(decoded.imageData, 0, 0);
    else ctx.drawImage(decoded.bitmap, 0, 0);
    return canvas;
  }

  async function renderExportCanvas(sourceCanvas, width, height, format, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var r = null;
    try {
      r = new RawRenderer(canvas);
      r.setSource(sourceCanvas);
      var built = buildCurveLut();
      r.setCurve(built.lut, !built.identity);
      // 按列表顺序为每个像素蒙版生成独立纹理；几何蒙版由着色器直接计算。
      var maskWidth = Math.min(MASK_EXPORT_WIDTH, Math.max(MASK_PREVIEW_WIDTH, width));
      for (var i = 0; i < state.masks.length; i++) {
        var m = state.masks[i];
        if (!isTexturedMaskType(m.type)) continue;
        var mc = buildMaskCanvas(m, maskWidth, width, height, null, sourceCanvas);
        r.setMask(m.id, mc);
        // texImage2D 已完成上传，及时释放大画布，避免多蒙版导出占用过多内存。
        mc.width = 0;
        mc.height = 0;
      }
      r.render(renderParams(true));
      var blob = await canvasToBlob(canvas, format, quality);
      if (!blob) throw new Error('浏览器未能生成导出图片（canvas.toBlob 返回空）。');
      return blob;
    } finally {
      if (r) r.dispose();
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (canvas.convertToBlob) {
        canvas.convertToBlob({ type: type, quality: quality }).then(resolve, function () { resolve(null); });
        return;
      }
      canvas.toBlob(function (blob) { resolve(blob); }, type, quality);
    });
  }

  async function exportPreviewResolution(reason) {
    if (!state.renderSource) throw new Error('没有可导出的预览图。');
    var format = els.exportFormat.value;
    var quality = Number(els.exportQuality.value) / 100;
    var t0 = performance.now();
    var blob = await renderExportCanvas(state.renderSource, state.renderW, state.renderH, format, quality);
    var ms = performance.now() - t0;
    finalizeExport(blob, state.renderW, state.renderH, format, ms, 'preview', reason);
    return blob;
  }

  function finalizeExport(blob, w, h, type, ms, resolution, reason) {
    var url = URL.createObjectURL(blob);
    var ext = type === 'image/png' ? 'png' : 'jpg';
    var filename = baseName(state.fileName) + '-raw.' + ext;
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    root.appendChild(a);
    try { a.click(); } catch (e) { /* 自动下载可能被浏览器拦截，Blob 仍然生成 */ }
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(url);
    }, 30000);
    state.lastExport = {
      blob: blob,
      size: blob.size,
      width: w,
      height: h,
      type: type,
      ms: ms,
      filename: filename,
      resolution: resolution,
      reason: reason || '',
      at: Date.now()
    };
    var label = type === 'image/png' ? 'PNG' : 'JPEG';
    var extra = resolution === 'preview' ? '（预览分辨率）' : '（全分辨率）';
    var note = '已生成 ' + label + ' ' + formatBytes(blob.size) + ' · ' + w + '×' + h + ' ' + extra +
      ' · 用时 ' + (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
    if (reason) note += '。' + reason;
    setStatus(note, resolution === 'preview' ? 'warn' : 'ok');
    showExportResult(note, false);
    dispatch('raw:export', {
      size: blob.size, width: w, height: h, type: type, resolution: resolution, filename: filename
    });
  }

  async function exportImage(opts) {
    opts = opts || {};
    if (!state.loaded) {
      showExportResult('请先载入 RAW 或图片。', true);
      return null;
    }
    if (state.cropEditing) {
      setStatus('请先应用或取消裁剪，再导出。', 'warn');
      showExportResult('请先应用或取消裁剪，再导出。', true);
      return null;
    }
    if (state.busy) return null;

    var format = opts.format || els.exportFormat.value || 'image/jpeg';
    var quality = opts.quality != null ? clamp(Number(opts.quality), 0.6, 1) : Number(els.exportQuality.value) / 100;
    if (format === 'image/png') quality = undefined;
    var force = !!opts.force;
    var pixels = (state.fullSize.w || 0) * (state.fullSize.h || 0);
    var est = estimateExportSeconds();

    setBusy(true, '正在导出', resolutionHint());
    setStatus('正在以全分辨率解码并渲染…', '', true);
    showExportResult('正在导出，请稍候…', false);
    els.exportBtn.disabled = true;
    await nextFrame();

    var decoded = null;
    var sourceCanvas = null;
    var geometryCanvas = null;
    try {
      if (pixels > EXPORT_MAX_PIXELS) {
        throw new Error('too-large');
      }
      if (!force && (est > 7 || pixels > 40e6)) {
        setBusy(false);
        var ok = await confirmLargeExport(est, pixels);
        if (!ok) {
          setStatus('已取消导出。', '');
          showExportResult('已取消导出。', false);
          return null;
        }
        setBusy(true, '正在导出', resolutionHint());
        await nextFrame();
      }

      var t0 = performance.now();
      decoded = await decodeFullResolution();
      var fullMs = performance.now() - t0;
      setStatus('正在应用几何与渲染…', '', true);
      await nextFrame();
      sourceCanvas = makeExportSourceCanvas(decoded);
      var composed = composeGeometry(sourceCanvas, state.geometry);
      geometryCanvas = composed.canvas === sourceCanvas ? null : composed.canvas;
      var outW = composed.w;
      var outH = composed.h;
      var blob = await renderExportCanvas(composed.canvas, outW, outH, format, quality);
      var totalMs = performance.now() - t0;
      var fromPreview = decoded.source === 'preview';
      finalizeExport(blob, outW, outH, format, totalMs,
        fromPreview ? 'preview' : 'full',
        fromPreview ? '源文件只能解码相机内嵌预览，导出像素来自该预览。' : '');
      return state.lastExport;
    } catch (err) {
      console.warn('[raw] full export failed', err);
      var reason = '';
      if (err && err.message === 'too-large') {
        reason = '图片约 ' + (pixels / 1e6).toFixed(0) + ' MP，超过浏览器全分辨率导出的安全上限，已改用预览分辨率。';
      } else {
        var msg = describeError(err);
        reason = '全分辨率导出失败（' + msg + '），已改用预览分辨率。';
      }
      try {
        return await exportPreviewResolution(reason);
      } catch (err2) {
        console.error('[raw] preview export failed', err2);
        var msg2 = describeError(err2);
        setStatus('导出失败：' + msg2, 'err');
        showExportResult('导出失败：' + msg2, true);
        return null;
      }
    } finally {
      if (decoded && decoded.bitmap) { try { decoded.bitmap.close(); } catch (e) { /* ignore */ } }
      if (geometryCanvas) { geometryCanvas.width = 0; geometryCanvas.height = 0; }
      if (sourceCanvas) { sourceCanvas.width = 0; sourceCanvas.height = 0; }
      setBusy(false);
      els.exportBtn.disabled = !state.loaded;
      updateFootRight();
    }
  }

  function resolutionHint() {
    var pixels = (state.fullSize.w || 0) * (state.fullSize.h || 0);
    return (state.fullSize.w || '?') + ' × ' + (state.fullSize.h || '?') +
      (pixels ? ' · ' + (pixels / 1e6).toFixed(1) + ' MP' : '') + ' · 在本机完成，不上传';
  }

  function showExportResult(text, isErr) {
    if (!els.exportResult) return;
    if (!text) {
      els.exportResult.hidden = true;
      els.exportResult.textContent = '';
      return;
    }
    els.exportResult.hidden = false;
    els.exportResult.textContent = text;
    els.exportResult.classList.toggle('is-err', !!isErr);
  }

  /* ------------------------------------------------------------------ *
   * 重置 / 对比
   * ------------------------------------------------------------------ */

  function updateBeforeLabel() {
    if (!els.beforeLabel) return;
    els.beforeLabel.textContent = state.before ? '查看调整后' : '原图对比';
    els.beforeBtn.classList.toggle('is-on', state.before);
  }

  function resetAll() {
    if (state.cropEditing) {
      state.cropEditing = false;
      state.cropDrag = null;
      state.cropBackup = null;
      state.cropRect = null;
      if (els.cropOverlay) els.cropOverlay.hidden = true;
    }
    state.adjust = defaultAdjust();
    state.before = false;
    state.curves = createCurves();
    state.paramCurve = defaultParamCurve();
    state.curveChannel = 'rgb';
    state.curveDragging = -1;
    state.geometry = defaultGeometry();
    for (var i = 0; i < state.masks.length; i++) {
      if (renderer) renderer.clearMask(state.masks[i].id);
    }
    previewMaskCanvases = Object.create(null);
    aiBaseCache = Object.create(null);
    var freshMask = createMask('linear');
    state.masks = [freshMask];
    state.activeMaskId = freshMask.id;
    root.querySelectorAll('[data-adj]').forEach(function (input) {
      var def = findDef(input.getAttribute('data-adj'), ALL_ADJUSTMENTS);
      if (def) input.value = def.def;
    });
    applyGeometrySource();
    markHistory('重置全部');
    updateAdjustOutputs();
    updateParamCurveUI();
    updateBeforeLabel();
    updateGeometryUI();
    updateCurveLut(true);
    updateMaskUI();
    refreshAllMaskTextures();
    scheduleRender();
    state.zoomMode = 'fit';
    requestAnimationFrame(applyZoom);
    showExportResult('', false);
    setStatus('已重置全部调整、几何与蒙版。', 'ok');
    dispatch('raw:reset', {});
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  function bindEvents() {
    // 文件选择 / 拖放
    els.input.addEventListener('change', function () {
      handleFiles(els.input.files);
      els.input.value = '';
    });
    els.empty.addEventListener('click', openPicker);
    els.empty.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      els.drop.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.drop.classList.add('is-dragover');
      });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      els.drop.addEventListener(type, function (e) {
        if (e.target === els.drop || !els.drop.contains(e.relatedTarget)) {
          els.drop.classList.remove('is-dragover');
        }
      });
    });
    els.drop.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.drop.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
    root.addEventListener('dragover', function (e) { e.preventDefault(); });
    root.addEventListener('drop', function (e) {
      if (e.target === els.drop || els.drop.contains(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    // 顶栏 / 工具栏按钮
    root.addEventListener('click', function (e) {
      var actBtn = e.target.closest('[data-act]');
      if (actBtn) {
        var act = actBtn.getAttribute('data-act');
        if (act === 'open') openPicker();
        else if (act === 'undo') undoHistory();
        else if (act === 'redo') redoHistory();
        else if (act === 'export') {
          var details = actBtn.closest('details');
          if (details) details.open = true;
          exportImage({});
        } else if (act === 'before') {
          if (!state.loaded) return;
          state.before = !state.before;
          updateBeforeLabel();
          scheduleRender();
        } else if (act === 'fit') {
          state.zoomMode = 'fit';
          applyZoom();
        } else if (act === 'one') {
          setZoomPct(100);
        } else if (act === 'reset') {
          resetAll();
        } else if (act === 'mask-clear') {
          clearMaskRange();
        } else if (act === 'mask-undo-stroke') {
          undoMaskStroke();
        } else if (act === 'mask-add') {
          addMask(els.maskNewType ? els.maskNewType.value : 'linear');
        } else if (act === 'mask-duplicate') {
          duplicateActiveMask();
        } else if (act === 'mask-remove') {
          removeActiveMask();
        } else if (act === 'mask-ai-refresh') {
          identifySmartMask(activeMask(), false);
        } else if (act === 'rotate-left') {
          rotateGeometry(-1);
        } else if (act === 'rotate-right') {
          rotateGeometry(1);
        } else if (act === 'flip-h') {
          flipGeometry('h');
        } else if (act === 'flip-v') {
          flipGeometry('v');
        } else if (act === 'crop-mode') {
          beginCropMode();
        } else if (act === 'crop-apply') {
          applyCropMode();
        } else if (act === 'crop-cancel') {
          cancelCropMode();
        } else if (act === 'geometry-reset') {
          resetGeometry();
        } else if (act === 'param-reset') {
          resetParamCurve();
        }
        return;
      }
      var historyBtn = e.target.closest('[data-history-index]');
      if (historyBtn) {
        historyFlush();
        restoreHistoryEntry(Number(historyBtn.getAttribute('data-history-index')));
        return;
      }
      var brushModeBtn = e.target.closest('[data-brush-mode]');
      if (brushModeBtn) {
        setBrushMode(brushModeBtn.getAttribute('data-brush-mode'));
        return;
      }
      var maskPick = e.target.closest('[data-mask-pick]');
      if (maskPick) {
        setActiveMask(maskPick.getAttribute('data-mask-pick'));
        return;
      }
      var maskBtn = e.target.closest('[data-mask]');
      if (maskBtn) {
        setMaskType(maskBtn.getAttribute('data-mask'));
        return;
      }
      var channelBtn = e.target.closest('[data-curve-channel]');
      if (channelBtn) {
        setCurveChannel(channelBtn.getAttribute('data-curve-channel'));
        return;
      }
      var curveBtn = e.target.closest('[data-curve]');
      if (curveBtn) {
        applyCurvePreset(curveBtn.getAttribute('data-curve'));
      }
    });

    // 蒙版列表：启用/停用
    root.addEventListener('change', function (e) {
      var toggle = e.target.closest('[data-mask-enabled]');
      if (toggle) {
        setMaskEnabled(toggle.getAttribute('data-mask-enabled'), toggle.checked);
      }
    });

    // 撤销 / 重做快捷键（仅 Camera Raw 页面可见时生效）
    document.addEventListener('keydown', function (e) {
      if (!state.loaded) return;
      var page = document.getElementById('page-raw');
      if (!page || page.classList.contains('hidden')) return;
      if (e.key === 'Escape' && state.cropEditing) {
        e.preventDefault();
        cancelCropMode();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'select' || (tag === 'input' && e.target.type !== 'range')) return;
      var key = String(e.key || '').toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoHistory(); else undoHistory();
      } else if (key === 'y') {
        e.preventDefault();
        redoHistory();
      }
    });

    // 滑杆
    root.querySelectorAll('[data-adj], [data-local]').forEach(bindSlider);
    root.querySelectorAll('[data-param]').forEach(function (input) {
      var key = input.getAttribute('data-param');
      input.addEventListener('input', function () {
        setParamCurve(key, Number(input.value));
      });
      input.addEventListener('dblclick', function () {
        var def = findDef(key, PARAM_CURVE);
        if (def) setParamCurve(key, def.def);
      });
    });

    // 几何：拉直、裁剪比例、裁剪框拖动
    if (els.geoAngle) {
      els.geoAngle.addEventListener('input', function () {
        setStraighten(Number(els.geoAngle.value));
      });
      els.geoAngle.addEventListener('dblclick', function () {
        setStraighten(0);
      });
    }
    if (els.cropAspect) {
      els.cropAspect.addEventListener('change', function () {
        setCropAspect(els.cropAspect.value);
      });
    }
    if (els.cropOverlay) {
      els.cropOverlay.addEventListener('pointerdown', onCropPointerDown);
      els.cropOverlay.addEventListener('pointermove', onCropPointerMove);
      els.cropOverlay.addEventListener('pointerup', onCropPointerUp);
      els.cropOverlay.addEventListener('pointercancel', onCropPointerUp);
    }

    // 缩放
    els.zoom.addEventListener('input', function () {
      setZoomPct(Number(els.zoom.value));
    });
    els.drop.addEventListener('wheel', function (e) {
      if (!state.loaded) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      var cur = state.zoomMode === 'fit'
        ? parseFloat(String(els.zoomVal.textContent).replace(/[^\d.]/g, '')) || 100
        : state.zoomPct;
      setZoomPct(cur + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });

    // 蒙版控件（作用于当前活动蒙版）
    els.maskInvert.addEventListener('change', function () {
      var mask = activeMask();
      if (!mask) return;
      mask.invert = els.maskInvert.checked;
      markHistory('反转蒙版');
      scheduleRender();
    });
    els.maskShow.addEventListener('change', function () {
      var mask = activeMask();
      if (!mask) return;
      mask.show = els.maskShow.checked;
      if (mask.show) {
        for (var i = 0; i < state.masks.length; i++) {
          if (state.masks[i] !== mask) state.masks[i].show = false;
        }
      }
      updateMaskUI();
      scheduleRender();
    });
    els.maskFeather.addEventListener('input', function () {
      var mask = activeMask();
      if (!mask) return;
      mask.feather = Number(els.maskFeather.value) / 100;
      els.maskFeatherV.textContent = els.maskFeather.value;
      markHistory('蒙版羽化');
      scheduleRender();
    });
    els.brushSize.addEventListener('input', function () {
      var mask = activeMask();
      if (!mask) return;
      mask.brushPct = Number(els.brushSize.value);
      els.brushSizeV.textContent = els.brushSize.value + '%';
    });

    // 画布蒙版拖动
    els.canvas.addEventListener('pointerdown', onCanvasPointerDown);
    els.canvas.addEventListener('pointermove', onCanvasPointerMove);
    els.canvas.addEventListener('pointerup', onCanvasPointerUp);
    els.canvas.addEventListener('pointercancel', onCanvasPointerUp);

    // 导出设置
    els.exportFormat.addEventListener('change', function () {
      var png = els.exportFormat.value === 'image/png';
      els.qualityRow.classList.toggle('is-hidden', png);
      els.exportSum.textContent = png ? 'PNG' : 'JPEG';
    });
    els.exportQuality.addEventListener('input', function () {
      els.qualityV.textContent = els.exportQuality.value;
    });

    // WebGL 上下文丢失/恢复
    els.canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      glLost = true;
      renderer = null;
      setStatus('图形上下文丢失，正在尝试恢复…', 'warn');
    });
    els.canvas.addEventListener('webglcontextrestored', function () {
      glLost = false;
      try {
        renderer = new RawRenderer(els.canvas);
        if (state.previewCanvas) {
          els.canvas.width = state.preview.w;
          els.canvas.height = state.preview.h;
          renderer.setSource(state.previewCanvas);
          ensureCurveLut();
          refreshAllMaskTextures();
          renderNow();
          setStatus('图形上下文已恢复。', 'ok');
        }
      } catch (err) {
        setStatus(describeError(err), 'err');
      }
    });

    // 自适应画布尺寸
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(function () {
        if (state.zoomMode === 'fit') applyZoom();
      });
      resizeObserver.observe(els.drop);
    } else {
      window.addEventListener('resize', function () {
        if (state.zoomMode === 'fit') applyZoom();
      });
    }

    window.addEventListener('pagehide', function () {
      if (state.raw) {
        try { state.raw.close(); } catch (e) { /* ignore */ }
        state.raw = null;
      }
      if (renderer) { renderer.dispose(); renderer = null; }
    });
  }

  /* ------------------------------------------------------------------ *
   * 公共 API / 事件
   * ------------------------------------------------------------------ */

  function dispatch(name, detail) {
    try {
      root.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true }));
    } catch (e) { /* ignore */ }
  }

  function serializeMask(mask) {
    if (!mask) return null;
    return {
      id: mask.id,
      name: mask.name,
      type: mask.type,
      enabled: !!mask.enabled,
      show: !!mask.show,
      invert: !!mask.invert,
      feather: mask.feather,
      p1: { x: mask.p1.x, y: mask.p1.y },
      p2: { x: mask.p2.x, y: mask.p2.y },
      strokeCount: mask.strokes.length,
      brushPct: mask.brushPct,
      brushMode: mask.brushMode || 'add',
      adjusted: maskHasAdjustments(mask),
      local: Object.assign({}, mask.local)
    };
  }

  function snapshot() {
    var mask = activeMask();
    var masks = state.masks.map(serializeMask);
    var curves = {};
    CURVE_CHANNELS.forEach(function (ch) {
      curves[ch.key] = state.curves[ch.key].map(function (p) { return { x: p.x, y: p.y }; });
    });
    return {
      loaded: state.loaded,
      busy: state.busy,
      fileName: state.fileName,
      fileSize: state.fileSize,
      fileKind: state.fileKind,
      fileExt: state.fileExt,
      meta: state.meta ? {
        camera: state.meta.camera,
        lens: state.meta.lens,
        exposure: state.meta.exposure,
        width: state.meta.width,
        height: state.meta.height,
        format: state.meta.format
      } : null,
      fullSize: { w: state.fullSize.w, h: state.fullSize.h },
      preview: state.preview ? { w: state.preview.w, h: state.preview.h } : null,
      renderSize: { w: state.renderW, h: state.renderH },
      decodeMs: state.decodeMs,
      backend: state.backendLabel,
      before: state.before,
      adjust: Object.assign({}, state.adjust),
      local: mask ? Object.assign({}, mask.local) : defaultLocal(),
      curves: curves,
      paramCurve: Object.assign({}, state.paramCurve),
      curve: activeCurvePoints().map(function (p) { return { x: p.x, y: p.y }; }),
      curveChannel: state.curveChannel,
      curveOn: state.curveOn,
      geometry: cloneGeometry(state.geometry),
      cropEditing: !!state.cropEditing,
      masks: masks,
      maskCount: state.masks.length,
      activeMaskId: state.activeMaskId,
      mask: serializeMask(mask),
      zoom: { mode: state.zoomMode, pct: state.zoomPct },
      history: {
        index: historyIndex,
        entries: historyEntries.map(function (entry) { return entry.label; })
      },
      lastExport: state.lastExport ? {
        size: state.lastExport.size,
        width: state.lastExport.width,
        height: state.lastExport.height,
        type: state.lastExport.type,
        resolution: state.lastExport.resolution,
        ms: state.lastExport.ms,
        filename: state.lastExport.filename,
        reason: state.lastExport.reason
      } : null,
      status: els.status ? els.status.textContent : '',
      vendorBase: vendorBase
    };
  }

  var api = {
    version: VERSION,
    mount: mount,
    openFile: function (file) { return loadFile(file); },
    openPicker: openPicker,
    exportImage: exportImage,
    reset: resetAll,
    undo: undoHistory,
    redo: redoHistory,
    setAdjustment: function (key, value) { setAdjustment(key, value, false); },
    setLocalAdjustment: function (key, value) { setAdjustment(key, value, true); },
    setCurve: function (points, channel) { setCurvePoints(points, channel); },
    setCurveChannel: setCurveChannel,
    setParamCurve: function (key, value) { setParamCurve(key, value); },
    getParamCurve: function () { return Object.assign({}, state.paramCurve); },
    resetParamCurve: resetParamCurve,
    setGeometry: function (geometry) {
      if (!geometry || !state.loaded) return;
      historyFlush();
      var g = Object.assign({}, state.geometry, geometry);
      state.geometry = cloneGeometry(g);
      markHistory('几何调整');
      rebuildRenderSource({ fit: true });
    },
    rotate: rotateGeometry,
    flip: flipGeometry,
    setStraighten: setStraighten,
    beginCrop: beginCropMode,
    applyCrop: applyCropMode,
    cancelCrop: cancelCropMode,
    setCropAspect: setCropAspect,
    setCropRect: function (rect) {
      if (!state.cropEditing || !rect) return;
      state.cropRect = clampCropRect(rect);
      updateCropBox();
    },
    identifySmartMask: function (type) {
      var mask = activeMask();
      if (!mask || !isSmartMaskType(mask.type)) {
        mask = addMask(type || 'sky');
        return serializeMask(mask);
      }
      identifySmartMask(mask, true);
      return serializeMask(mask);
    },
    getHistory: function () {
      return {
        index: historyIndex,
        entries: historyEntries.map(function (entry) { return { label: entry.label, time: entry.time }; })
      };
    },
    goToHistory: function (index) {
      historyFlush();
      restoreHistoryEntry(Number(index));
    },
    getCurves: function () {
      var out = {};
      CURVE_CHANNELS.forEach(function (ch) {
        out[ch.key] = state.curves[ch.key].map(function (p) { return { x: p.x, y: p.y }; });
      });
      return out;
    },
    setMask: function (type, opts) {
      var mask = activeMask();
      if (!mask) {
        if (!type || type === 'none') return null;
        mask = addMask(type, opts);
        return serializeMask(mask);
      }
      setMaskType(type || 'none');
      mask = activeMask();
      if (!mask) return null;
      if (opts) {
        applyMaskOptions(mask, opts);
        if (mask.show) {
          for (var i = 0; i < state.masks.length; i++) {
            if (state.masks[i] !== mask) state.masks[i].show = false;
          }
        }
        if (isTexturedMaskType(mask.type)) scheduleMaskBuild(mask);
        updateMaskUI();
        updateAdjustOutputs();
        restoreBaselineIfNeeded();
        scheduleRender();
      }
      return serializeMask(mask);
    },
    addMask: function (type, opts) {
      var m = addMask(type || 'linear', opts);
      return serializeMask(m);
    },
    duplicateMask: function () { return serializeMask(duplicateActiveMask()); },
    removeMask: function (id) {
      var removed = id ? removeMaskById(id) : removeActiveMask();
      return removed ? serializeMask(removed) : null;
    },
    setActiveMask: setActiveMask,
    setMaskEnabled: setMaskEnabled,
    getMasks: function () { return state.masks.map(serializeMask); },
    getState: snapshot,
    renderNow: renderNow,
    getCanvas: function () { return els.canvas; },
    getRenderSource: function () { return state.renderSource; },
    getRoot: function () { return root; }
  };
  api.__mounted = true;

  // 自动挂载：支持脚本在 #raw-root 之前或之后加载，也支持页面稍后插入挂载点。
  function autoMount() {
    var el = document.getElementById('raw-root');
    if (el) {
      mount(el);
      return true;
    }
    return false;
  }

  window.RAWDevelop = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!autoMount() && typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(function () {
          if (autoMount()) mo.disconnect();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      }
    });
  } else {
    if (!autoMount() && typeof MutationObserver !== 'undefined') {
      var mo2 = new MutationObserver(function () {
        if (autoMount()) mo2.disconnect();
      });
      mo2.observe(document.documentElement, { childList: true, subtree: true });
    }
  }
})();
