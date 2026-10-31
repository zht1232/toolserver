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

  var VERSION = '1.0.0';
  var PREVIEW_MAX_EDGE = 1600;
  var PREVIEW_MAX_PIXELS = 22e6; // 超过此像素数时预览改用半尺寸去马赛克
  var EXPORT_MAX_PIXELS = 80e6;
  var MAX_FILE_BYTES = 350 * 1024 * 1024;
  var MASK_PREVIEW_WIDTH = 768;
  var MASK_EXPORT_WIDTH = 2048;
  var MAX_MASKS = 8;
  var IDENTITY_CURVE = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  var CURVE_CHANNELS = [
    { key: 'rgb', label: 'RGB', short: 'RGB', color: '#0C7A69', curve: '#0C7A69' },
    { key: 'r', label: '红', short: '红', color: '#C0392B', curve: '#C0392B' },
    { key: 'g', label: '绿', short: '绿', color: '#1F7A4D', curve: '#1F7A4D' },
    { key: 'b', label: '蓝', short: '蓝', color: '#2F5EB8', curve: '#2F5EB8' }
  ];

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
    'image-off': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 3 18 18"/><path d="M8 15l2.5-3 2 2.2L15 11l3 4"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
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

  var LOCALS = [
    { key: 'exposure', label: '局部曝光', min: -3, max: 3, step: 0.05, def: 0, ev: true },
    { key: 'contrast', label: '局部对比', min: -100, max: 100, step: 1, def: 0 },
    { key: 'temperature', label: '局部色温', min: -100, max: 100, step: 1, def: 0 },
    { key: 'saturation', label: '局部饱和', min: -100, max: 100, step: 1, def: 0 }
  ];

  function defaultAdjust() {
    var o = {};
    ADJUSTMENTS.forEach(function (d) { o[d.key] = d.def; });
    return o;
  }
  function defaultLocal() {
    var o = {};
    LOCALS.forEach(function (d) { o[d.key] = d.def; });
    return o;
  }

  function fmtAdjust(def, v) {
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
    '  vec3 blurC = texture(u_image, v_uv + vec2(cpx.x, 0.0)).rgb',
    '             + texture(u_image, v_uv - vec2(cpx.x, 0.0)).rgb',
    '             + texture(u_image, v_uv + vec2(0.0, cpx.y)).rgb',
    '             + texture(u_image, v_uv - vec2(0.0, cpx.y)).rgb;',
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
    '    vec3 src = texture(u_image, v_uv).rgb;',
    '    if (u_before > 0.5) {',
    '      outColor = vec4(src, 1.0);',
    '      return;',
    '    }',
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
    '    vec3 n4 = texture(u_image, v_uv + vec2(spx.x, 0.0)).rgb',
    '            + texture(u_image, v_uv - vec2(spx.x, 0.0)).rgb',
    '            + texture(u_image, v_uv + vec2(0.0, spx.y)).rgb',
    '            + texture(u_image, v_uv - vec2(0.0, spx.y)).rgb;',
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
    'u_vignette', 'u_grain', 'u_sharpen', 'u_maskType', 'u_maskInvert', 'u_maskShow',
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
      this.bindMask(mask.type === 3 ? mask.id : null);
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
    this.bindMask(show && show.type === 3 ? show.id : null);
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

    return '' +
      '<div class="raw-head">' +
        '<div class="raw-head-main">' +
          '<div class="raw-eyebrow">Camera Raw · 本地显影</div>' +
          '<h2>RAW 显影</h2>' +
          '<p>解码 CR2 / CR3 / NEF / ARW / DNG / RAF / ORW 等相机原始文件，在浏览器内完成曝光、色彩、曲线与局部蒙版调整，并导出 JPEG / PNG。<b>图片不会上传</b>，关闭页面即清除。</p>' +
        '</div>' +
        '<div class="raw-head-actions">' +
          '<button type="button" class="raw-btn primary" data-act="open">' + icon('open') + '打开文件</button>' +
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
            '<summary>' + icon('sliders') + '<span>基本调整</span><span class="raw-sum-meta" id="raw-adj-sum">0 项</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-sliders" id="raw-adj-sliders">' + basicSliders + '</div>' +
              '<p class="raw-group-hint" style="margin:9px 0 0;font-size:10.5px;color:var(--raw-ink-3)">双击滑杆可单独复位。曝光以 EV 计算，色温 / 色调为相对相机白平衡的偏移。</p>' +
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
            '</div>' +
          '</details>' +

          '<details class="raw-group" open>' +
            '<summary>' + icon('mask') + '<span>蒙版</span><span class="raw-sum-meta" id="raw-mask-sum">1 个 · 蒙版 1</span>' +
              '<span class="raw-chev">' + icon('chevron') + '</span></summary>' +
            '<div class="raw-group-body">' +
              '<div class="raw-mask-list-head"><span>蒙版列表</span><span id="raw-mask-count">1 / 8</span></div>' +
              '<div class="raw-mask-list" id="raw-mask-list" aria-label="蒙版列表"></div>' +
              '<div class="raw-mask-list-actions">' +
                '<button type="button" class="raw-btn tiny" data-act="mask-add">＋ 添加蒙版</button>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-duplicate">复制当前</button>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-remove">删除当前</button>' +
              '</div>' +
              '<div class="raw-seg" id="raw-mask-seg" role="group" aria-label="蒙版类型">' +
                '<button type="button" data-mask="none">无</button>' +
                '<button type="button" data-mask="linear" class="is-active">线性渐变</button>' +
                '<button type="button" data-mask="radial">径向渐变</button>' +
                '<button type="button" data-mask="brush">画笔</button>' +
              '</div>' +
              '<p class="raw-mask-note" id="raw-mask-note"><b>线性渐变</b>：在画面上从起点拖到终点，<b>终点一侧</b>为蒙版内；可调羽化与局部参数。</p>' +
              '<div class="raw-mask-actions">' +
                '<label class="raw-check"><input type="checkbox" id="raw-mask-invert">反转</label>' +
                '<label class="raw-check"><input type="checkbox" id="raw-mask-show">显示蒙版</label>' +
                '<button type="button" class="raw-btn tiny" data-act="mask-clear">清除范围</button>' +
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
    return type === 'linear' ? '线性' : type === 'radial' ? '径向' : type === 'brush' ? '画笔' : '未启用';
  }

  function defaultGeometry(type) {
    if (type === 'radial') return { p1: { x: 0.5, y: 0.5 }, p2: { x: 0.28, y: 0.28 } };
    if (type === 'brush') return { p1: { x: 0.2, y: 0.5 }, p2: { x: 0.8, y: 0.5 } };
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
    if (opts.p1) mask.p1 = { x: clamp(Number(opts.p1.x), 0, 1), y: clamp(Number(opts.p1.y), 0, 1) };
    if (opts.p2) mask.p2 = { x: clamp(Number(opts.p2.x), 0, 1), y: clamp(Number(opts.p2.y), 0, 1) };
    if (opts.strokes) {
      mask.strokes = opts.strokes.map(function (stroke) {
        var pts = stroke.points || stroke || [];
        return {
          radius: stroke.radius != null ? Number(stroke.radius) : Math.max(0.005, mask.brushPct / 200),
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
    type = type === 'radial' || type === 'brush' || type === 'none' ? type : 'linear';
    var geo = defaultGeometry(type);
    var mask = {
      id: 'mask-' + maskSeq,
      name: '蒙版 ' + maskSeq,
      type: type,
      enabled: true,
      show: false,
      invert: false,
      feather: type === 'brush' ? 0.35 : 0.45,
      p1: geo.p1,
      p2: geo.p2,
      strokes: [],
      brushPct: 8,
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
      histogram: null,
      decodeMs: 0,
      previewDecodeMs: 0,
      backendLabel: 'WebGL2',
      sourceNote: '',
      sourceWarn: false,
      adjust: defaultAdjust(),
      before: false,
      curves: createCurves(),
      curveChannel: 'rgb',
      curveLut: null,
      curveOn: false,
      curveDragging: -1,
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
      maskSum: $('#raw-mask-sum', root),
      maskSeg: $('#raw-mask-seg', root),
      maskList: $('#raw-mask-list', root),
      maskCount: $('#raw-mask-count', root),
      maskNote: $('#raw-mask-note', root),
      maskInvert: $('#raw-mask-invert', root),
      maskShow: $('#raw-mask-show', root),
      maskFeather: $('#raw-mask-feather', root),
      maskFeatherV: $('#raw-mask-feather-v', root),
      brushRow: $('#raw-brush-size-row', root),
      brushSize: $('#raw-brush-size', root),
      brushSizeV: $('#raw-brush-size-v', root),
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
    updateCurveUI();
    updateBeforeLabel();
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
      els.footRight.textContent = state.preview.w + '×' + state.preview.h + ' 预览 · ' + state.backendLabel;
    } else {
      els.footRight.textContent = '本地解码 · 不上传';
    }
  }

  function baselineStatus() {
    if (!state.loaded || !state.preview) return '等待载入 RAW 或图片…';
    return '已载入 ' + state.fileName + ' · ' + state.preview.w + '×' + state.preview.h +
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

    els.canvas.width = result.preview.w;
    els.canvas.height = result.preview.h;
    renderer.setSource(result.preview.canvas);
    ensureCurveLut();
    if (curveCtx) drawCurve();
    refreshAllMaskTextures();
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

  function maskTypeCode(type) {
    return type === 'linear' ? 1 : type === 'radial' ? 2 : type === 'brush' ? 3 : 0;
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
      masks: masks,
      showMask: showMask
    };
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderNow();
    });
  }

  function renderNow() {
    if (!renderer || !state.preview) return;
    try {
      renderer.render(renderParams(false));
    } catch (e) {
      console.error('[raw] render failed', e);
      setStatus(describeError(e), 'err');
    }
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
    ADJUSTMENTS.forEach(function (d) {
      var out = root.querySelector('[data-out-adj="' + d.key + '"]');
      if (out) {
        out.textContent = fmtAdjust(d, state.adjust[d.key]);
        out.classList.toggle('is-set', Math.abs(state.adjust[d.key] - d.def) > 1e-9);
      }
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
  }

  function findDef(key, list) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function setAdjustment(key, value, local, silent) {
    var def = findDef(key, local ? LOCALS : ADJUSTMENTS);
    if (!def) return;
    var v = clamp(Number(value), def.min, def.max);
    var localMask = null;
    if (local) {
      localMask = activeMask();
      if (!localMask) localMask = addMask('linear');
      if (!localMask) return;
      localMask.local[key] = v;
    } else {
      state.adjust[key] = v;
    }
    var input = root.querySelector('[data-' + (local ? 'local' : 'adj') + '="' + key + '"]');
    if (input && Number(input.value) !== v) input.value = v;
    updateAdjustOutputs();
    if (localMask) updateMaskBadge(localMask);
    restoreBaselineIfNeeded();
    if (!silent) scheduleRender();
  }

  function resetAdjustment(key, local) {
    var def = findDef(key, local ? LOCALS : ADJUSTMENTS);
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

  // 先应用 RGB 复合曲线，再应用对应单通道曲线，生成 256×3 LUT（R/G/B 各一行）。
  function buildCurveLut() {
    var evaluators = {};
    var identity = true;
    for (var c = 0; c < CURVE_CHANNELS.length; c++) {
      var key = CURVE_CHANNELS[c].key;
      var pts = state.curves[key].slice().sort(function (a, b) { return a.x - b.x; });
      evaluators[key] = makeCurveEvaluator(pts);
      if (identity && !isPointsIdentity(state.curves[key])) identity = false;
    }
    var lut = new Uint8Array(256 * 3 * 4);
    for (var i = 0; i < 256; i++) {
      var x = i / 255;
      var comp = clamp(evaluators.rgb(x), 0, 1);
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
    if (els.curveSum) els.curveSum.textContent = info.label + ' · ' + (identity ? '线性' : '已调整');
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

  function setCurvePoints(points, channel) {
    channel = state.curves[channel] ? channel : state.curveChannel;
    var pts = (points || []).map(function (p) {
      return { x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1) };
    });
    if (!pts.length) pts = cloneCurvePoints(IDENTITY_CURVE);
    pts.sort(function (a, b) { return a.x - b.x; });
    state.curves[channel] = pts;
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
    setCurvePoints(points, channel);
  }

  /* ------------------------------------------------------------------ *
   * 蒙版
   * ------------------------------------------------------------------ */

  var MASK_LABELS = { none: '未启用', linear: '线性渐变', radial: '径向渐变', brush: '画笔' };

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
    els.brushRow.hidden = !mask || mask.type !== 'brush';
    if (mask) {
      els.brushSize.value = String(mask.brushPct);
      els.brushSizeV.textContent = mask.brushPct + '%';
    }
    els.canvas.classList.toggle('is-masking', hasMask && mask.enabled);
    els.maskNote.classList.toggle('is-empty', !hasMask);
    if (!mask) {
      els.maskNote.innerHTML = '尚未添加蒙版。点击“添加蒙版”后可在预览画面上拖动定义范围，局部调整只作用于蒙版内。';
    } else if (!hasMask) {
      els.maskNote.innerHTML = '当前蒙版类型为“无”。选择线性、径向或画笔后即可在画面上绘制范围。';
    } else if (mask.type === 'linear') {
      els.maskNote.innerHTML = '<b>线性渐变</b>：在画面上从起点拖到终点，<b>终点一侧</b>为蒙版内；多个蒙版按列表顺序叠加。';
    } else if (mask.type === 'radial') {
      els.maskNote.innerHTML = '<b>径向渐变</b>：从中心向外拖动改变椭圆范围；勾选“显示蒙版”可检查当前活动蒙版的覆盖区域。';
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
    if (type === mask.type) return;
    if (mask.type === 'brush' && type !== 'brush') {
      if (renderer) renderer.clearMask(mask.id);
      delete previewMaskCanvases[mask.id];
    }
    mask.type = type;
    mask.show = false;
    mask.current = null;
    mask.dragMode = '';
    if (type === 'linear') {
      var lg = defaultGeometry('linear');
      mask.p1 = lg.p1;
      mask.p2 = lg.p2;
      mask.feather = 0.45;
    } else if (type === 'radial') {
      var rg = defaultGeometry('radial');
      mask.p1 = rg.p1;
      mask.p2 = rg.p2;
      mask.feather = 0.45;
    } else if (type === 'brush') {
      mask.feather = 0.35;
    }
    updateMaskUI();
    restoreBaselineIfNeeded();
    if (type === 'brush') scheduleMaskBuild(mask);
    else scheduleRender();
    dispatch('raw:mask', { type: type, id: mask.id });
  }

  function clearMaskRange() {
    var mask = activeMask();
    if (!mask) return;
    if (mask.type === 'linear' || mask.type === 'radial') {
      var geo = defaultGeometry(mask.type);
      mask.p1 = geo.p1;
      mask.p2 = geo.p2;
    } else if (mask.type === 'brush') {
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
    state.masks.push(mask);
    state.activeMaskId = mask.id;
    if (!silent) {
      updateMaskUI();
      updateAdjustOutputs();
      restoreBaselineIfNeeded();
      if (mask.type === 'brush') scheduleMaskBuild(mask);
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
    copy.enabled = src.enabled;
    copy.show = src.show;
    copy.invert = src.invert;
    copy.feather = src.feather;
    copy.p1 = { x: src.p1.x, y: src.p1.y };
    copy.p2 = { x: src.p2.x, y: src.p2.y };
    copy.brushPct = src.brushPct;
    copy.local = Object.assign({}, src.local);
    copy.strokes = src.strokes.map(function (stroke) {
      return {
        radius: stroke.radius,
        points: (stroke.points || []).map(function (p) { return { x: p.x, y: p.y }; })
      };
    });
    var idx = state.masks.indexOf(src);
    state.masks.splice(idx + 1, 0, copy);
    state.activeMaskId = copy.id;
    updateMaskUI();
    updateAdjustOutputs();
    restoreBaselineIfNeeded();
    if (copy.type === 'brush') scheduleMaskBuild(copy);
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
      if (state.activeMaskId === removed.id) {
        var next = state.masks[Math.min(i, state.masks.length - 1)];
        state.activeMaskId = next ? next.id : null;
      }
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
    updateMaskUI();
    updateAdjustOutputs();
    scheduleRender();
    dispatch('raw:masks', { action: 'enabled', id: mask.id, enabled: mask.enabled, count: state.masks.length });
  }

  function buildMaskCanvas(mask, targetWidth, srcW, srcH, reuse) {
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
    if (mask.type !== 'brush') return canvas;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < mask.strokes.length; i++) {
      var stroke = mask.strokes[i];
      var pts = stroke.points || [];
      if (!pts.length) continue;
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

  function refreshMaskTexture(mask) {
    if (!renderer || !state.preview || !mask) return;
    if (mask.type === 'brush') {
      var c = buildMaskCanvas(mask, MASK_PREVIEW_WIDTH, state.preview.w, state.preview.h, previewMaskCanvases[mask.id]);
      previewMaskCanvases[mask.id] = c;
      renderer.setMask(mask.id, c);
    } else {
      renderer.clearMask(mask.id);
      delete previewMaskCanvases[mask.id];
    }
  }

  function refreshAllMaskTextures() {
    if (!renderer || !state.preview) return;
    for (var i = 0; i < state.masks.length; i++) refreshMaskTexture(state.masks[i]);
  }

  function scheduleMaskBuild(mask) {
    mask = mask || activeMask();
    if (!mask || mask.type !== 'brush') return;
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
    if (!state.loaded || !mask || mask.type === 'none' || !mask.enabled || state.before) return;
    e.preventDefault();
    var uv = canvasUV(e);
    try { els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (mask.type === 'brush') {
      mask.current = {
        points: [uv],
        radius: Math.max(0.005, mask.brushPct / 200)
      };
      mask.strokes.push(mask.current);
      mask.dragMode = 'brush';
      scheduleMaskBuild(mask);
    } else if (mask.type === 'linear') {
      mask.dragMode = 'linear';
      mask._start = uv;
      mask._moved = false;
    } else if (mask.type === 'radial') {
      mask.dragMode = 'radial';
      mask._start = uv;
      mask._moved = false;
      mask.p1 = uv;
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
    } else if (mask.dragMode === 'radial' && !mask._moved) {
      mask.p2 = { x: 0.28, y: 0.28 };
      scheduleRender();
    }
    mask.dragMode = '';
    mask._start = null;
    updateMaskUI();
    try { els.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * 缩放 / 适应
   * ------------------------------------------------------------------ */

  function applyZoom() {
    if (!state.preview || !els.canvas) return;
    var w = state.preview.w;
    var h = state.preview.h;
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
      // 按列表顺序为每个画笔蒙版生成独立纹理；几何蒙版由着色器直接计算。
      var maskWidth = Math.min(MASK_EXPORT_WIDTH, Math.max(MASK_PREVIEW_WIDTH, width));
      for (var i = 0; i < state.masks.length; i++) {
        var m = state.masks[i];
        if (m.type !== 'brush' || !m.strokes.length) continue;
        var mc = buildMaskCanvas(m, maskWidth, width, height, null);
        r.setMask(m.id, mc);
        // texImage2D 已完成上传，及时释放大画布，避免多画笔蒙版导出占用过多内存。
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
    if (!state.previewCanvas) throw new Error('没有可导出的预览图。');
    var format = els.exportFormat.value;
    var quality = Number(els.exportQuality.value) / 100;
    var t0 = performance.now();
    var blob = await renderExportCanvas(state.previewCanvas, state.preview.w, state.preview.h, format, quality);
    var ms = performance.now() - t0;
    finalizeExport(blob, state.preview.w, state.preview.h, format, ms, 'preview', reason);
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
      setStatus('正在渲染调整与蒙版…', '', true);
      await nextFrame();
      sourceCanvas = makeExportSourceCanvas(decoded);
      var blob = await renderExportCanvas(sourceCanvas, decoded.w, decoded.h, format, quality);
      var totalMs = performance.now() - t0;
      var fromPreview = decoded.source === 'preview';
      finalizeExport(blob, decoded.w, decoded.h, format, totalMs,
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
    state.adjust = defaultAdjust();
    state.before = false;
    state.curves = createCurves();
    state.curveChannel = 'rgb';
    state.curveDragging = -1;
    for (var i = 0; i < state.masks.length; i++) {
      if (renderer) renderer.clearMask(state.masks[i].id);
    }
    previewMaskCanvases = Object.create(null);
    var freshMask = createMask('linear');
    state.masks = [freshMask];
    state.activeMaskId = freshMask.id;
    root.querySelectorAll('[data-adj]').forEach(function (input) {
      var def = findDef(input.getAttribute('data-adj'), ADJUSTMENTS);
      if (def) input.value = def.def;
    });
    updateAdjustOutputs();
    updateBeforeLabel();
    updateCurveLut(true);
    updateMaskUI();
    refreshAllMaskTextures();
    scheduleRender();
    state.zoomMode = 'fit';
    requestAnimationFrame(applyZoom);
    showExportResult('', false);
    setStatus('已重置全部调整与蒙版。', 'ok');
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
        } else if (act === 'mask-add') {
          addMask('linear');
        } else if (act === 'mask-duplicate') {
          duplicateActiveMask();
        } else if (act === 'mask-remove') {
          removeActiveMask();
        }
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

    // 滑杆
    root.querySelectorAll('[data-adj], [data-local]').forEach(bindSlider);

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
      decodeMs: state.decodeMs,
      backend: state.backendLabel,
      before: state.before,
      adjust: Object.assign({}, state.adjust),
      local: mask ? Object.assign({}, mask.local) : defaultLocal(),
      curves: curves,
      curve: activeCurvePoints().map(function (p) { return { x: p.x, y: p.y }; }),
      curveChannel: state.curveChannel,
      curveOn: state.curveOn,
      masks: masks,
      maskCount: state.masks.length,
      activeMaskId: state.activeMaskId,
      mask: serializeMask(mask),
      zoom: { mode: state.zoomMode, pct: state.zoomPct },
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
    setAdjustment: function (key, value) { setAdjustment(key, value, false); },
    setLocalAdjustment: function (key, value) { setAdjustment(key, value, true); },
    setCurve: function (points, channel) { setCurvePoints(points, channel); },
    setCurveChannel: setCurveChannel,
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
        if (mask.type === 'brush') scheduleMaskBuild(mask);
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
