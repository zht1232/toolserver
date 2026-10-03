/* 通用小工具：图片转换 / JSON / 编解码 / 时间戳 / 哈希 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================= 图片格式转换 ================= */
  (function () {
    var drop = document.getElementById('img-drop');
    var input = document.getElementById('img-input');
    var panel = document.getElementById('img-panel');
    var srcImg = document.getElementById('img-src');
    var outImg = document.getElementById('img-out');
    var fmtSel = document.getElementById('img-format');
    var quality = document.getElementById('img-quality');
    var scale = document.getElementById('img-scale');
    var preset = document.getElementById('img-compress-preset');
    var wmButton = document.getElementById('img-watermark');
    var wmPanel = document.getElementById('img-watermark-panel');
    var wmCanvas = document.getElementById('img-wm-canvas');
    var srcFile = null;
    var srcObjectUrl = '', outObjectUrl = '';
    var wmStart = null, wmRect = null, wmDragging = false;

    function loadFile(f) {
      if (!f || !/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) { alert('请选择 PNG、JPEG、WebP、GIF 或 BMP 图片。'); return; }
      if (f.size > 100 * 1024 * 1024) { alert('图片超过 100 MB，为保护浏览器内存未加载。'); return; }
      srcFile = f;
      if (srcObjectUrl) URL.revokeObjectURL(srcObjectUrl);
      srcObjectUrl = URL.createObjectURL(f);
      srcImg.src = srcObjectUrl;
      srcImg.onload = function () {
        document.getElementById('img-src-info').textContent =
          srcImg.naturalWidth + '×' + srcImg.naturalHeight + ' · ' + TB.formatSize(f.size);
        panel.classList.remove('hidden');
        convert(false);
      };
      srcImg.onerror = function () {
        if (srcObjectUrl) URL.revokeObjectURL(srcObjectUrl);
        srcObjectUrl = '';
        alert('图片读取失败或格式不受当前浏览器支持。');
      };
    }

    input.addEventListener('change', function () { loadFile(input.files[0]); input.value = ''; });
    drop.addEventListener('click', function (e) {
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') input.click();
    });
    TB.bindDropzone(drop, function (files) { loadFile(files[0]); });

    quality.addEventListener('input', function () {
      document.getElementById('img-quality-val').textContent = quality.value;
      if (preset) preset.value = 'custom';
    });
    scale.addEventListener('input', function () {
      document.getElementById('img-scale-val').textContent = scale.value;
      if (preset) preset.value = 'custom';
    });
    if (preset) preset.addEventListener('change', function () {
      if (preset.value === 'balanced') { fmtSel.value = 'image/webp'; quality.value = '82'; scale.value = '100'; }
      else if (preset.value === 'small') { fmtSel.value = 'image/webp'; quality.value = '68'; scale.value = '85'; }
      else if (preset.value === 'jpeg') { fmtSel.value = 'image/jpeg'; quality.value = '82'; scale.value = '100'; }
      document.getElementById('img-quality-val').textContent = quality.value;
      document.getElementById('img-scale-val').textContent = scale.value;
      if (srcFile) convert(false);
    });
    [fmtSel, quality, scale].forEach(function (el) {
      el.addEventListener('change', function () { if (srcFile) convert(false); });
    });

    var lastBlob = null;
    function convert(autoDownload) {
      if (!srcImg.naturalWidth) return;
      var ratio = parseInt(scale.value, 10) / 100;
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(srcImg.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(srcImg.naturalHeight * ratio));
      var ctx = canvas.getContext('2d');
      // JPEG 不支持透明，先填白底
      if (fmtSel.value === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(srcImg, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { alert('当前浏览器不支持输出该格式'); return; }
        lastBlob = blob;
        if (outObjectUrl) URL.revokeObjectURL(outObjectUrl);
        outObjectUrl = URL.createObjectURL(blob);
        outImg.src = outObjectUrl;
        var reduction = srcFile && srcFile.size ? Math.round((1 - blob.size / srcFile.size) * 100) : 0;
        var sizeText = reduction > 0 ? ' · 减少 ' + reduction + '%' : (reduction < 0 ? ' · 增大 ' + Math.abs(reduction) + '%' : ' · 体积不变');
        document.getElementById('img-out-info').textContent =
          canvas.width + '×' + canvas.height + ' · ' + TB.formatSize(blob.size) + sizeText;
        if (fmtSel.value === 'image/png' && quality.value !== '100') {
          document.getElementById('img-out-info').textContent += '（PNG 无损格式不使用质量滑块）';
        }
        if (autoDownload) downloadOut();
      }, fmtSel.value, parseInt(quality.value, 10) / 100);
    }

    function downloadOut() {
      if (!lastBlob) return;
      var ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[lastBlob.type] || 'png';
      var base = srcFile ? srcFile.name.replace(/\.[^.]+$/, '') : 'image';
      TB.download(lastBlob, TB.safeName(base) + '.' + ext);
    }

    function syncWatermarkCanvas() {
      if (!wmCanvas || !srcImg.naturalWidth) return;
      wmCanvas.width = srcImg.naturalWidth;
      wmCanvas.height = srcImg.naturalHeight;
      wmCanvas.getContext('2d').drawImage(srcImg, 0, 0);
      wmRect = null;
    }

    function canvasPoint(e) {
      var box = wmCanvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(wmCanvas.width, (e.clientX - box.left) * wmCanvas.width / box.width)),
        y: Math.max(0, Math.min(wmCanvas.height, (e.clientY - box.top) * wmCanvas.height / box.height))
      };
    }

    function drawSelection() {
      if (!wmCanvas || !srcImg.naturalWidth) return;
      var ctx = wmCanvas.getContext('2d');
      ctx.drawImage(srcImg, 0, 0);
      if (!wmRect) return;
      ctx.save(); ctx.setLineDash([8, 5]); ctx.lineWidth = Math.max(2, wmCanvas.width / 500);
      ctx.strokeStyle = '#5EEAD4'; ctx.fillStyle = 'rgba(94,234,212,.16)';
      ctx.fillRect(wmRect.x, wmRect.y, wmRect.w, wmRect.h); ctx.strokeRect(wmRect.x, wmRect.y, wmRect.w, wmRect.h); ctx.restore();
    }

    if (wmButton) wmButton.addEventListener('click', function () {
      if (!srcFile) { alert('请先载入图片。'); return; }
      wmPanel.classList.remove('hidden');
      syncWatermarkCanvas();
      wmPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    if (wmCanvas) {
      wmCanvas.addEventListener('pointerdown', function (e) {
        wmDragging = true; wmStart = canvasPoint(e); wmRect = { x: wmStart.x, y: wmStart.y, w: 0, h: 0 }; wmCanvas.setPointerCapture(e.pointerId);
      });
      wmCanvas.addEventListener('pointermove', function (e) {
        if (!wmDragging) return;
        var p = canvasPoint(e); wmRect = { x: Math.min(wmStart.x, p.x), y: Math.min(wmStart.y, p.y), w: Math.abs(p.x - wmStart.x), h: Math.abs(p.y - wmStart.y) }; drawSelection();
      });
      wmCanvas.addEventListener('pointerup', function () { wmDragging = false; });
    }
    document.getElementById('img-wm-apply').addEventListener('click', function () {
      if (!srcFile || !wmRect || wmRect.w < 2 || wmRect.h < 2) { alert('请先框选水印区域。'); return; }
      var ctx = wmCanvas.getContext('2d'), r = wmRect, pixels = ctx.getImageData(0, 0, wmCanvas.width, wmCanvas.height), d = pixels.data;
      var sx = r.x, sy = r.y >= r.h ? r.y - r.h : (r.y + r.h < wmCanvas.height ? r.y + r.h : Math.max(0, r.y - 1));
      for (var y = 0; y < Math.floor(r.h); y++) for (var x = 0; x < Math.floor(r.w); x++) {
        var dx = Math.floor(r.x) + x, dy = Math.floor(r.y) + y, sourceY = Math.max(0, Math.min(wmCanvas.height - 1, sy + y));
        var from = (sourceY * wmCanvas.width + Math.max(0, Math.min(wmCanvas.width - 1, Math.floor(sx) + x))) * 4;
        var to = (dy * wmCanvas.width + dx) * 4;
        d[to] = d[from]; d[to + 1] = d[from + 1]; d[to + 2] = d[from + 2]; d[to + 3] = d[from + 3];
      }
      ctx.putImageData(pixels, 0, 0);
      var type = /^image\/(png|jpeg|webp)$/.test(srcFile.type) ? srcFile.type : 'image/png';
      wmCanvas.toBlob(function (blob) {
        if (!blob) { alert('图片编码失败，请换用 JPEG 或 WebP 再试。'); return; }
        var ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
        TB.download(blob, TB.safeName(srcFile.name.replace(/\.[^.]+$/, '') + '-去水印') + '.' + ext);
      }, type, parseInt(quality.value, 10) / 100);
    });

    document.getElementById('img-convert').addEventListener('click', function () { convert(true); });
  })();

  /* ================= JSON 格式化 ================= */
  (function () {
    var input = document.getElementById('json-input');
    var status = document.getElementById('json-status');

    function run(fn) {
      var text = input.value.trim();
      if (!text) { status.className = 'status err'; status.textContent = '请先输入 JSON。'; return null; }
      try {
        var result = fn(JSON.parse(text));
        status.className = 'status ok';
        status.textContent = '✓ JSON 有效';
        return result;
      } catch (e) {
        status.className = 'status err';
        status.textContent = '✗ ' + e.message;
        return null;
      }
    }

    document.getElementById('json-format').addEventListener('click', function () {
      var r = run(function (o) { return JSON.stringify(o, null, 2); });
      if (r !== null) input.value = r;
    });
    document.getElementById('json-format4').addEventListener('click', function () {
      var r = run(function (o) { return JSON.stringify(o, null, 4); });
      if (r !== null) input.value = r;
    });
    document.getElementById('json-minify').addEventListener('click', function () {
      var r = run(function (o) { return JSON.stringify(o); });
      if (r !== null) input.value = r;
    });
    document.getElementById('json-validate').addEventListener('click', function () {
      run(function (o) { return input.value; });
    });
    document.getElementById('json-copy').addEventListener('click', function (e) {
      if (input.value.trim()) TB.copy(input.value, e.target);
    });
  })();

  /* ================= 编解码 ================= */
  (function () {
    var currentTab = 'base64';
    var input = document.getElementById('enc-input');
    var output = document.getElementById('enc-output');
    var status = document.getElementById('enc-status');

    var codecs = {
      base64: {
        encode: function (s) {
          var bytes = new TextEncoder().encode(s);
          var bin = '';
          bytes.forEach(function (b) { bin += String.fromCharCode(b); });
          return btoa(bin);
        },
        decode: function (s) {
          var bin = atob(s.replace(/\s/g, ''));
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        }
      },
      url: {
        encode: function (s) { return encodeURIComponent(s); },
        decode: function (s) { return decodeURIComponent(s); }
      },
      unicode: {
        encode: function (s) {
          return Array.from(s).map(function (ch) {
            var hex = ch.codePointAt(0).toString(16).padStart(4, '0');
            return '\\u' + hex;
          }).join('');
        },
        decode: function (s) {
          return s.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
            return String.fromCodePoint(parseInt(h, 16));
          });
        }
      },
      html: {
        encode: function (s) {
          return s.replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
          });
        },
        decode: function (s) {
          var ta = document.createElement('textarea');
          ta.innerHTML = s;
          return ta.value;
        }
      }
    };

    document.querySelectorAll('#encode-tabs .tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('#encode-tabs .tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        currentTab = tab.getAttribute('data-tab');
        status.textContent = '';
      });
    });

    function doConvert(dir) {
      try {
        output.value = codecs[currentTab][dir](input.value);
        status.className = 'status ok';
        status.textContent = '✓ 完成';
      } catch (e) {
        status.className = 'status err';
        status.textContent = '✗ 失败：' + e.message;
      }
    }

    document.getElementById('enc-encode').addEventListener('click', function () { doConvert('encode'); });
    document.getElementById('enc-decode').addEventListener('click', function () { doConvert('decode'); });
    document.getElementById('enc-swap').addEventListener('click', function () {
      var t = input.value; input.value = output.value; output.value = t;
    });
    document.getElementById('enc-copy').addEventListener('click', function (e) {
      if (output.value) TB.copy(output.value, e.target);
    });
  })();

  /* ================= 时间戳 ================= */
  (function () {
    function tick() {
      var now = new Date();
      document.getElementById('ts-now').textContent = now.toLocaleString('zh-CN', { hour12: false });
      document.getElementById('ts-now-unix').textContent = Math.floor(now.getTime() / 1000) + ' 秒';
    }
    tick();
    setInterval(tick, 1000);

    document.getElementById('ts-to-date').addEventListener('click', function () {
      var v = document.getElementById('ts-input').value.trim();
      var n = Number(v);
      var out = document.getElementById('ts-date-result');
      if (!v || isNaN(n)) { out.textContent = '请输入数字时间戳'; return; }
      if (v.length <= 10) n *= 1000; // 秒级
      var d = new Date(n);
      if (isNaN(d.getTime())) { out.textContent = '无效时间戳'; return; }
      out.innerHTML = '本地时间：' + escapeHtml(d.toLocaleString('zh-CN', { hour12: false })) +
        '<br>UTC 时间：' + escapeHtml(d.toUTCString());
    });

    document.getElementById('date-to-ts').addEventListener('click', function () {
      var v = document.getElementById('date-input').value;
      var out = document.getElementById('ts-result');
      if (!v) { out.textContent = '请选择日期时间'; return; }
      var ms = new Date(v).getTime();
      out.textContent = '秒级：' + Math.floor(ms / 1000) + '　毫秒级：' + ms;
    });

    document.getElementById('date-now').addEventListener('click', function () {
      var now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      document.getElementById('date-input').value = now.toISOString().slice(0, 19);
    });
  })();

  /* ================= 哈希 ================= */
  (function () {
    var algos = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

    function toHex(buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    }

    async function hashData(data, boxId) {
      var box = document.getElementById(boxId);
      box.innerHTML = '<div class="muted">计算中…</div>';
      var upper = document.getElementById('hash-upper').checked;
      var rows = [];
      for (var i = 0; i < algos.length; i++) {
        var digest = await crypto.subtle.digest(algos[i], data);
        var hex = toHex(digest);
        if (upper) hex = hex.toUpperCase();
        rows.push('<div class="hash-row"><span class="algo">' + algos[i] + '</span><span class="val">' + hex + '</span></div>');
      }
      box.innerHTML = rows.join('');
    }

    document.getElementById('hash-calc').addEventListener('click', function () {
      var text = document.getElementById('hash-input').value;
      if (!text) return;
      hashData(new TextEncoder().encode(text), 'hash-results');
    });

    document.getElementById('hash-file').addEventListener('change', async function (e) {
      var f = e.target.files[0];
      if (!f) return;
      document.getElementById('hash-file-name').textContent = f.name + '（' + TB.formatSize(f.size) + '）';
      var buf = await f.arrayBuffer();
      hashData(buf, 'hash-file-results');
      e.target.value = '';
    });
  })();
})();
