/* 颜色转换：HEX / RGB / HSL 三向联动 + 滑块 + 预设色 + 明暗梯度（点击复制） */
(function () {
  'use strict';

  var hexEl = document.getElementById('color-hex');
  var rgbEl = document.getElementById('color-rgb');
  var hslEl = document.getElementById('color-hsl');
  var picker = document.getElementById('color-picker');
  var stage = document.getElementById('color-preview');
  var readout = document.getElementById('color-readout');
  var tints = document.getElementById('color-tints');
  var contrastBox = document.getElementById('color-contrast');
  var presetsBox = document.getElementById('color-presets');

  if (!hexEl || !rgbEl || !hslEl) { return; }

  var rsR = document.getElementById('rs-r'), rsRVal = document.getElementById('rs-r-val');
  var rsG = document.getElementById('rs-g'), rsGVal = document.getElementById('rs-g-val');
  var rsB = document.getElementById('rs-b'), rsBVal = document.getElementById('rs-b-val');
  var rsH = document.getElementById('rs-h'), rsHVal = document.getElementById('rs-h-val');
  var rsS = document.getElementById('rs-s'), rsSVal = document.getElementById('rs-s-val');
  var rsL = document.getElementById('rs-l'), rsLVal = document.getElementById('rs-l-val');

  var PRESETS = [
    '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#22C55E',
    '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1',
    '#8B5CF6', '#A855F7', '#D946EF', '#EC4899', '#F43F5E', '#64748B',
    '#334155', '#0A0C10', '#FFFFFF', '#5EEAD4', '#818CF8', '#F472B6'
  ];

  function hexToRgb(hex) {
    var h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
    }).join('').toUpperCase();
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    if (s === 0) {
      var v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var conv = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return {
      r: Math.round(conv(h + 1 / 3) * 255),
      g: Math.round(conv(h) * 255),
      b: Math.round(conv(h - 1 / 3) * 255)
    };
  }

  function luminance(rgb) {
    var f = function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
  }

  function copyText(text, el) {
    if (window.TB && typeof window.TB.copy === 'function') {
      window.TB.copy(text, el);
    }
  }

  function applyRgb(rgb, skip) {
    var hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

    if (skip !== 'hex') hexEl.value = hex;
    if (skip !== 'rgb') rgbEl.value = rgb.r + ', ' + rgb.g + ', ' + rgb.b;
    if (skip !== 'hsl') hslEl.value = hsl.h + '°, ' + hsl.s + '%, ' + hsl.l + '%';
    if (picker) picker.value = hex.toLowerCase();

    if (skip !== 'slider-rgb') {
      if (rsR) { rsR.value = rgb.r; rsRVal.textContent = rgb.r; }
      if (rsG) { rsG.value = rgb.g; rsGVal.textContent = rgb.g; }
      if (rsB) { rsB.value = rgb.b; rsBVal.textContent = rgb.b; }
    }
    if (skip !== 'slider-hsl') {
      if (rsH) { rsH.value = hsl.h; rsHVal.textContent = hsl.h; }
      if (rsS) { rsS.value = hsl.s; rsSVal.textContent = hsl.s; }
      if (rsL) { rsL.value = hsl.l; rsLVal.textContent = hsl.l; }
    }

    if (stage) stage.style.background = hex;

    var white = (1.05) / (luminance(rgb) + 0.05);
    var black = (luminance(rgb) + 0.05) / 0.05;
    var textColor = white > black ? '#fff' : '#0A0C10';

    if (readout) {
      readout.style.color = textColor;
      readout.innerHTML = '<b style="font-size:16px">' + hex + '</b>' +
        '　rgb(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ')　hsl(' + hsl.h + ', ' + hsl.s + '%, ' + hsl.l + '%)';
    }

    // 明暗梯度
    var steps = [95, 85, 70, 55, 40, 25, 15];
    if (tints) {
      tints.innerHTML = steps.map(function (l) {
        var c = hslToRgb(hsl.h, hsl.s, l);
        var h2 = rgbToHex(c.r, c.g, c.b);
        var dark = luminance(c) > 0.5 ? ' dark-text' : '';
        return '<div class="' + dark.trim() + '" data-hex="' + h2 + '" title="点击复制 ' + h2 + '" style="background:' + h2 + '">' + h2 + '</div>';
      }).join('');
    }

    // 对比度参考卡片
    if (contrastBox) {
      contrastBox.innerHTML =
        '<div style="background:' + hex + ';color:#fff">白字对比度<br><b>' + white.toFixed(2) + ':1</b></div>' +
        '<div style="background:' + hex + ';color:#0A0C10">黑字对比度<br><b>' + black.toFixed(2) + ':1</b></div>';
    }
  }

  hexEl.addEventListener('input', function () {
    var rgb = hexToRgb(hexEl.value);
    if (rgb) applyRgb(rgb, 'hex');
  });
  rgbEl.addEventListener('input', function () {
    var parts = rgbEl.value.split(/[,\s]+/).map(Number);
    if (parts.length >= 3 && parts.every(function (n) { return !isNaN(n); })) {
      applyRgb({ r: parts[0], g: parts[1], b: parts[2] }, 'rgb');
    }
  });
  hslEl.addEventListener('input', function () {
    var m = hslEl.value.match(/(-?\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
    if (m) applyRgb(hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])), 'hsl');
  });
  if (picker) {
    picker.addEventListener('input', function () {
      var rgb = hexToRgb(picker.value);
      if (rgb) applyRgb(rgb);
    });
  }

  // RGB 滑块
  function bindRgbSlider(el, key) {
    if (!el) return;
    el.addEventListener('input', function () {
      var rgb = hexToRgb(hexEl.value) || { r: 0, g: 0, b: 0 };
      rgb[key] = parseInt(el.value, 10);
      applyRgb(rgb, 'slider-rgb');
    });
  }
  bindRgbSlider(rsR, 'r');
  bindRgbSlider(rsG, 'g');
  bindRgbSlider(rsB, 'b');

  // HSL 滑块
  function bindHslSlider() {
    [rsH, rsS, rsL].forEach(function (el) {
      if (!el) return;
      el.addEventListener('input', function () {
        var h = rsH ? parseFloat(rsH.value) : 0;
        var s = rsS ? parseFloat(rsS.value) : 0;
        var l = rsL ? parseFloat(rsL.value) : 0;
        applyRgb(hslToRgb(h, s, l), 'slider-hsl');
      });
    });
  }
  bindHslSlider();

  // 预设色板
  if (presetsBox) {
    presetsBox.innerHTML = PRESETS.map(function (c) {
      return '<div class="swatch-chip" data-hex="' + c + '" title="' + c + '" style="background:' + c + '"></div>';
    }).join('');
    presetsBox.addEventListener('click', function (e) {
      var target = e.target;
      while (target && target !== presetsBox && !target.getAttribute('data-hex')) {
        target = target.parentNode;
      }
      if (target && target.getAttribute) {
        var hex = target.getAttribute('data-hex');
        if (hex) {
          var rgb = hexToRgb(hex);
          if (rgb) applyRgb(rgb);
        }
      }
    });
  }

  // 明暗梯度点击复制
  if (tints) {
    tints.addEventListener('click', function (e) {
      var target = e.target;
      while (target && target !== tints && !target.getAttribute('data-hex')) {
        target = target.parentNode;
      }
      if (target && target.getAttribute) {
        var hex = target.getAttribute('data-hex');
        if (hex) copyText(hex, target);
      }
    });
  }

  // HEX 文本点击整体可快速复制（在 readout 上点击复制当前 HEX）
  if (readout) {
    readout.style.cursor = 'pointer';
    readout.addEventListener('click', function () {
      copyText(hexEl.value, readout);
    });
  }

  applyRgb({ r: 32, g: 89, b: 192 });
})();
