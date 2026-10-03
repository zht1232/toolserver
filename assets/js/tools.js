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
    var wmBrush = document.getElementById('img-wm-brush');
    var wmStatus = document.getElementById('img-wm-status');
    var wmProgress = document.getElementById('img-wm-progress');
    var wmProgressTrack = document.getElementById('img-wm-progress-track');
    var wmProgressFill = document.getElementById('img-wm-progress-fill');
    var wmMode = document.getElementById('img-wm-mode');
    var wmModeNote = document.getElementById('img-wm-mode-note');
    var wmAutoButton = document.getElementById('img-wm-auto');
    var wmApplyButton = document.getElementById('img-wm-apply');
    var wmThreshold = document.getElementById('img-wm-threshold');
    var wmAutoBoxes = [];
    var srcFile = null;
    var srcObjectUrl = '', outObjectUrl = '', wmCanvasFile = null;
    var wmMaskCanvas = document.createElement('canvas');
    var wmStrokes = [], wmCurrentStroke = null, wmDrawing = false;

    function loadFile(f) {
      if (!f || !/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) { alert('请选择 PNG、JPEG、WebP、GIF 或 BMP 图片。'); return; }
      if (f.size > 100 * 1024 * 1024) { alert('图片超过 100 MB，为保护浏览器内存未加载。'); return; }
      resetWatermarkProgress();
      srcFile = f;
      if (srcObjectUrl) URL.revokeObjectURL(srcObjectUrl);
      srcObjectUrl = URL.createObjectURL(f);
      srcImg.src = srcObjectUrl;
      srcImg.onload = function () {
        document.getElementById('img-src-info').textContent =
          srcImg.naturalWidth + '×' + srcImg.naturalHeight + ' · ' + TB.formatSize(f.size);
        panel.classList.remove('hidden');
        convert(false);
        if (location.hash === '#watermark' || !wmPanel.classList.contains('hidden')) openWatermarkTool();
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
      if (wmCanvasFile === srcFile && wmCanvas.width === srcImg.naturalWidth && wmCanvas.height === srcImg.naturalHeight) {
        drawWatermarkCanvas();
        return;
      }
      wmCanvas.width = srcImg.naturalWidth;
      wmCanvas.height = srcImg.naturalHeight;
      wmMaskCanvas.width = srcImg.naturalWidth;
      wmMaskCanvas.height = srcImg.naturalHeight;
      wmCanvasFile = srcFile;
      wmStrokes = [];
      wmAutoBoxes = [];
      drawWatermarkCanvas();
    }

    function openWatermarkTool() {
      if (!wmPanel) return;
      wmPanel.classList.remove('hidden');
      if (!srcFile || !srcImg.naturalWidth) {
        if (wmStatus) wmStatus.textContent = '请先在上方选择图片；载入后会显示整张图片的画布。';
        if (drop) drop.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (srcImg.naturalWidth * srcImg.naturalHeight > 12000000) {
        wmStrokes = [];
        wmCanvas.width = 0; wmCanvas.height = 0;
        wmMaskCanvas.width = 0; wmMaskCanvas.height = 0;
        wmCanvasFile = null;
        if (wmStatus) wmStatus.textContent = '图片超过 1200 万像素；请先本地压缩并重新上传较小版本。';
        wmPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      syncWatermarkCanvas();
      if (wmStatus) {
        if (wmMode && wmMode.value === 'browser') {
          wmStatus.textContent = '浏览器本地模式：图片不会上传。自动检测与本地修补首次合计约 65 MiB，之后模型会缓存。';
        } else {
          wmStatus.textContent = srcFile.size > 20 * 1024 * 1024 ? '服务器修补单张限制为 20 MiB，请先压缩并重新上传较小图片。' : '正在检查服务器 AI 模型…';
          fetch('api/ping').then(function (r) { return r.json(); }).then(function (info) {
            if (srcFile.size > 20 * 1024 * 1024) return;
            wmStatus.textContent = info.watermarkAi && info.watermarkAi.ready ?
              '服务器模型已就绪。图片与遮罩会在你运行修补时上传。水印检测仍在此浏览器本地运行。' :
              ((info.watermarkAi && info.watermarkAi.reason) || '服务器 AI 模型尚未就绪。');
          }).catch(function () { wmStatus.textContent = '无法连接服务器 AI 接口，请通过本站 HTTPS 地址使用。'; });
        }
      }
      wmPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    window.openWatermarkTool = openWatermarkTool;

    function updateWatermarkMode() {
      var browser = !wmMode || wmMode.value === 'browser';
      if (wmModeNote) wmModeNote.textContent = browser ?
        '自动检测模型约 10.5 MiB，浏览器运行库约 27 MiB，本地修补模型约 26.8 MiB；自动检测加本地修补首次合计约 65 MiB。模型会缓存到此浏览器，支持 WebGPU 时优先用 GPU，否则回退 CPU。图片和遮罩只在浏览器处理。' :
        '自动检测仍在浏览器本地完成（检测模型加运行库首次约 38 MiB）；修补时会将原图与遮罩上传到本站服务器。';
      if (wmStatus && wmPanel && !wmPanel.classList.contains('hidden') && srcFile) {
        wmStatus.textContent = browser ? '浏览器本地模式：图片不会上传。模型会按需下载并缓存。' : '服务器模式：自动检测在浏览器本地运行；修补时会上传图片和遮罩。';
      }
    }

    if (wmMode) wmMode.addEventListener('change', updateWatermarkMode);

    function localModelProgress(percent, message) {
      if (percent >= 100) setWatermarkProgress('complete', 100, message);
      else if (percent > 0) setWatermarkProgress('upload', percent, message + '：' + percent + '%');
      else setWatermarkProgress('busy', percent, message);
    }

    function setWatermarkProgress(mode, value, message) {
      if (wmProgress) wmProgress.classList.remove('hidden');
      if (wmProgressFill && wmProgressTrack) {
        wmProgressFill.classList.toggle('is-indeterminate', mode === 'busy');
        if (mode === 'busy') {
          wmProgressFill.style.width = '34%';
          wmProgressTrack.removeAttribute('aria-valuenow');
          wmProgressTrack.setAttribute('aria-busy', 'true');
        } else {
          wmProgressFill.style.width = value + '%';
          wmProgressTrack.setAttribute('aria-valuenow', String(value));
          wmProgressTrack.removeAttribute('aria-busy');
        }
      }
      if (wmStatus && message) wmStatus.textContent = message;
    }

    function resetWatermarkProgress() {
      if (wmProgress) wmProgress.classList.add('hidden');
      if (wmProgressFill) {
        wmProgressFill.classList.remove('is-indeterminate');
        wmProgressFill.style.width = '0%';
      }
      if (wmProgressTrack) {
        wmProgressTrack.setAttribute('aria-valuenow', '0');
        wmProgressTrack.removeAttribute('aria-busy');
      }
    }

    function readBlobText(blob) {
      return new Promise(function (resolve) {
        if (blob && blob.text) { blob.text().then(resolve, function () { resolve(''); }); return; }
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { resolve(''); };
        reader.readAsText(blob || new Blob());
      });
    }

    function postWatermarkForm(form) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'api/watermark/inpaint', true);
        xhr.responseType = 'blob';
        xhr.timeout = 180000;
        xhr.upload.onprogress = function (event) {
          if (!event.lengthComputable || !event.total) return;
          var percent = Math.min(99, Math.round(event.loaded * 100 / event.total));
          setWatermarkProgress('upload', percent, '正在上传图片与遮罩：' + percent + '%');
        };
        xhr.upload.onload = function () {
          setWatermarkProgress('busy', 0, '上传完成，服务器 AI 正在修补…');
        };
        xhr.onprogress = function (event) {
          if (!event.lengthComputable || !event.total) return;
          var percent = Math.min(99, 65 + Math.round(event.loaded * 34 / event.total));
          setWatermarkProgress('download', percent, '正在接收修补结果：' + Math.round(event.loaded * 100 / event.total) + '%');
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300 && xhr.response && /^image\//.test(xhr.response.type)) {
            resolve(xhr.response);
            return;
          }
          readBlobText(xhr.response).then(function (text) {
            var error = {};
            try { error = JSON.parse(text); } catch (ignore) { /* use HTTP status below */ }
            reject(new Error(error.error || ('服务器返回 HTTP ' + xhr.status)));
          });
        };
        xhr.onerror = function () { reject(new Error('网络连接中断')); };
        xhr.ontimeout = function () { reject(new Error('服务器处理超时，请缩小修补区域后重试')); };
        xhr.onabort = function () { reject(new Error('修补请求已取消')); };
        xhr.send(form);
      });
    }

    function canvasPoint(e) {
      var box = wmCanvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(wmCanvas.width, (e.clientX - box.left) * wmCanvas.width / box.width)),
        y: Math.max(0, Math.min(wmCanvas.height, (e.clientY - box.top) * wmCanvas.height / box.height))
      };
    }

    function drawStroke(ctx, stroke, color) {
      if (!stroke.points.length) return;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = stroke.width;
      if (stroke.points.length === 1) {
        ctx.beginPath(); ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (var i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawWatermarkCanvas() {
      if (!wmCanvas || !srcImg.naturalWidth) return;
      var ctx = wmCanvas.getContext('2d'), maskCtx = wmMaskCanvas.getContext('2d');
      ctx.clearRect(0, 0, wmCanvas.width, wmCanvas.height);
      ctx.drawImage(srcImg, 0, 0);
      maskCtx.fillStyle = '#ffffff'; maskCtx.fillRect(0, 0, wmMaskCanvas.width, wmMaskCanvas.height);
      wmAutoBoxes.forEach(function (box) {
        var padX = Math.max(5, (box.x2 - box.x1) * 0.08), padY = Math.max(5, (box.y2 - box.y1) * 0.12);
        var x = Math.max(0, box.x1 - padX), y = Math.max(0, box.y1 - padY);
        var w = Math.min(wmCanvas.width, box.x2 + padX) - x, h = Math.min(wmCanvas.height, box.y2 + padY) - y;
        ctx.fillStyle = 'rgba(255, 45, 96, 0.3)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255, 45, 96, 0.95)'; ctx.lineWidth = Math.max(2, Math.min(6, wmCanvas.width / 500));
        ctx.strokeRect(x, y, w, h);
        maskCtx.fillStyle = '#000000'; maskCtx.fillRect(x, y, w, h);
      });
      wmStrokes.forEach(function (stroke) {
        drawStroke(ctx, stroke, 'rgba(255, 45, 96, 0.55)');
        drawStroke(maskCtx, stroke, '#000000');
      });
    }

    if (wmButton) wmButton.addEventListener('click', openWatermarkTool);
    if (wmCanvas) {
      wmCanvas.addEventListener('pointerdown', function (e) {
        if (!srcImg.naturalWidth || e.button !== 0) return;
        wmDrawing = true;
        wmCurrentStroke = { points: [canvasPoint(e)], width: parseInt(wmBrush.value, 10) };
        wmStrokes.push(wmCurrentStroke);
        wmCanvas.setPointerCapture(e.pointerId);
        drawWatermarkCanvas();
      });
      wmCanvas.addEventListener('pointermove', function (e) {
        if (!wmDrawing || !wmCurrentStroke) return;
        wmCurrentStroke.points.push(canvasPoint(e));
        drawWatermarkCanvas();
      });
      function stopStroke() { wmDrawing = false; wmCurrentStroke = null; }
      wmCanvas.addEventListener('pointerup', stopStroke);
      wmCanvas.addEventListener('pointercancel', stopStroke);
    }
    if (wmBrush) wmBrush.addEventListener('input', function () {
      document.getElementById('img-wm-brush-val').textContent = wmBrush.value;
    });
    if (wmThreshold) wmThreshold.addEventListener('input', function () {
      document.getElementById('img-wm-threshold-val').textContent = wmThreshold.value;
    });
    document.getElementById('img-wm-undo').addEventListener('click', function () {
      if (wmStrokes.length) wmStrokes.pop();
      else wmAutoBoxes.pop();
      drawWatermarkCanvas();
    });
    document.getElementById('img-wm-clear').addEventListener('click', function () {
      wmStrokes = []; wmAutoBoxes = []; drawWatermarkCanvas();
    });
    async function performWatermarkRepair(button) {
      if (!srcFile || (!wmStrokes.length && !wmAutoBoxes.length)) {
        if (wmStatus) wmStatus.textContent = '请先自动检测，或用画笔涂出水印区域。';
        return false;
      }
      var localMode = !wmMode || wmMode.value === 'browser';
      if (!localMode && srcFile.size > 20 * 1024 * 1024) {
        if (wmStatus) wmStatus.textContent = '服务器修补单张限制为 20 MiB，请先压缩并重新上传较小图片。';
        return false;
      }
      var otherButton = button === wmAutoButton ? wmApplyButton : wmAutoButton;
      button.disabled = true;
      if (otherButton) otherButton.disabled = true;
      if (wmMode) wmMode.disabled = true;
      setWatermarkProgress('busy', 0, localMode ? '正在准备浏览器本地修补…' : '正在准备图片与遮罩…');
      try {
        var blob, providerLabel;
        if (localMode) {
          if (!window.WatermarkLocal) throw new Error('浏览器 AI 模块未载入，请刷新页面重试');
          var sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = wmCanvas.width; sourceCanvas.height = wmCanvas.height;
          sourceCanvas.getContext('2d').drawImage(srcImg, 0, 0);
          blob = await window.WatermarkLocal.inpaint(sourceCanvas, wmMaskCanvas, localModelProgress);
          providerLabel = '浏览器本地推理';
        } else {
          var maskBlob = await new Promise(function (resolve) { wmMaskCanvas.toBlob(resolve, 'image/png'); });
          if (!maskBlob) throw new Error('遮罩编码失败');
          var form = new FormData();
          form.append('image', srcFile, srcFile.name);
          form.append('mask', maskBlob, 'mask.png');
          setWatermarkProgress('upload', 0, '准备上传图片与遮罩…');
          blob = await postWatermarkForm(form);
          providerLabel = 'MI-GAN 服务器推理';
        }
        setWatermarkProgress('complete', 100, '修补完成，正在准备下载…');
        var extension = blob.type === 'image/png' ? 'png' : 'webp';
        if (outObjectUrl) URL.revokeObjectURL(outObjectUrl);
        var objectUrl = URL.createObjectURL(blob);
        outObjectUrl = objectUrl;
        outImg.src = objectUrl;
        document.getElementById('img-out-info').textContent = wmCanvas.width + '×' + wmCanvas.height + ' · ' + TB.formatSize(blob.size) + ' · ' + providerLabel;
        panel.classList.remove('hidden');
        TB.download(blob, TB.safeName(srcFile.name.replace(/\.[^.]+$/, '') + '-AI修补') + '.' + extension);
        if (wmStatus) wmStatus.textContent = localMode ? 'AI 修补完成；原图和遮罩全程留在此浏览器，没有上传。' : 'AI 修补完成；原图和遮罩只在服务器内存处理，未写入服务器文件。';
        return true;
      } catch (error) {
        resetWatermarkProgress();
        if (wmStatus) wmStatus.textContent = 'AI 修补失败：' + error.message;
        return false;
      } finally {
        button.disabled = false;
        if (otherButton) otherButton.disabled = false;
        if (wmMode) wmMode.disabled = false;
      }
    }

    if (wmApplyButton) wmApplyButton.addEventListener('click', function (e) { performWatermarkRepair(e.currentTarget); });
    if (wmAutoButton) wmAutoButton.addEventListener('click', async function (e) {
      var button = e.currentTarget;
      if (!srcFile || !srcImg.naturalWidth) { if (wmStatus) wmStatus.textContent = '请先选择要处理的图片。'; return; }
      if (!window.WatermarkLocal) { if (wmStatus) wmStatus.textContent = '浏览器 AI 模块未载入，请刷新页面重试。'; return; }
      if ((!wmMode || wmMode.value === 'server') && srcFile.size > 20 * 1024 * 1024) {
        if (wmStatus) wmStatus.textContent = '服务器修补单张限制为 20 MiB，请先压缩并重新上传较小图片。';
        return;
      }
      button.disabled = true;
      if (wmApplyButton) wmApplyButton.disabled = true;
      if (wmMode) wmMode.disabled = true;
      setWatermarkProgress('busy', 0, '正在启动浏览器水印检测…');
      try {
        var sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = wmCanvas.width; sourceCanvas.height = wmCanvas.height;
        sourceCanvas.getContext('2d').drawImage(srcImg, 0, 0);
        var threshold = wmThreshold ? parseInt(wmThreshold.value, 10) / 100 : 0.5;
        var boxes = await window.WatermarkLocal.detect(sourceCanvas, localModelProgress, threshold);
        wmAutoBoxes = boxes;
        drawWatermarkCanvas();
        if (!boxes.length) {
          resetWatermarkProgress();
          if (wmStatus) wmStatus.textContent = '没有检测到水印候选。可降低识别灵敏度重试，或用画笔手动标记。';
          return;
        }
        if (wmStatus) wmStatus.textContent = '检测到 ' + boxes.length + ' 个候选区域（红框）；正在按当前模式修补整张图片…';
        await performWatermarkRepair(button);
      } catch (error) {
        resetWatermarkProgress();
        if (wmStatus) wmStatus.textContent = '自动检测失败：' + error.message;
      } finally {
        button.disabled = false;
        if (wmApplyButton) wmApplyButton.disabled = false;
        if (wmMode) wmMode.disabled = false;
      }
    });

    var wmCacheClear = document.getElementById('img-wm-cache-clear');
    if (wmCacheClear) wmCacheClear.addEventListener('click', async function (e) {
      if (!window.WatermarkLocal) { if (wmStatus) wmStatus.textContent = '浏览器 AI 模块未载入。'; return; }
      if ((wmAutoButton && wmAutoButton.disabled) || (wmApplyButton && wmApplyButton.disabled)) {
        if (wmStatus) wmStatus.textContent = 'AI 正在运行，请完成当前任务后再清除缓存。';
        return;
      }
      e.currentTarget.disabled = true;
      try {
        await window.WatermarkLocal.clearCache();
        if (wmStatus) wmStatus.textContent = '已清除本浏览器缓存的检测和修补模型。下次使用时会重新下载。';
      } catch (error) { if (wmStatus) wmStatus.textContent = '清除模型缓存失败：' + error.message; }
      e.currentTarget.disabled = false;
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
