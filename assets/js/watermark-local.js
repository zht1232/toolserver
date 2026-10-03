/* Browser-local watermark detection and inpainting. Models stay in Cache Storage. */
(function () {
  'use strict';

  var CACHE_NAME = 'localtools-watermark-models-v1';
  var MODEL_URLS = {
    detector: '/api/ai/models/detector?v=f3638870eedb',
    inpainter: '/api/ai/models/inpainter?v=6f1f3530a1a2'
  };
  var MODEL_SHA256 = {
    detector: 'f3638870eedb2ac4ea202d25da35ac2ae520ba33d572479d1d9cfc671aaa253e',
    inpainter: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b'
  };
  var modelPromises = Object.create(null);
  var sessionPromises = Object.create(null);
  var runtimePromise = null;

  function report(progress, percent, message) {
    if (typeof progress === 'function') progress(percent, message);
  }

  async function verifyModel(bytes, name) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('当前浏览器无法校验 AI 模型文件');
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    var actual = Array.prototype.map.call(new Uint8Array(digest), function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
    if (actual !== MODEL_SHA256[name]) throw new Error('AI 模型校验失败，请刷新页面后重试');
    return bytes;
  }

  function cachedModel(name, progress) {
    if (!MODEL_URLS[name]) return Promise.reject(new Error('未知 AI 模型'));
    if (modelPromises[name]) return modelPromises[name];
    modelPromises[name] = (async function () {
      var url = MODEL_URLS[name], cacheKey = new URL(url, window.location.origin).href, cache = null;
      if (window.caches && window.caches.open) {
        try { cache = await window.caches.open(CACHE_NAME); } catch (ignore) { cache = null; }
      }
      if (cache) {
        var saved = await cache.match(cacheKey);
        if (saved) {
          report(progress, 100, name === 'detector' ? '从浏览器缓存读取检测模型' : '从浏览器缓存读取修补模型');
          try { return await verifyModel(new Uint8Array(await saved.arrayBuffer()), name); }
          catch (error) { await cache.delete(cacheKey); throw error; }
        }
      }

      var response = await fetch(cacheKey, { cache: 'force-cache' });
      if (!response.ok) throw new Error('模型下载失败（HTTP ' + response.status + '）');
      var total = parseInt(response.headers.get('Content-Length') || '0', 10), loaded = 0, chunks = [];
      if (response.body && response.body.getReader) {
        var reader = response.body.getReader(), part;
        while (true) {
          part = await reader.read();
          if (part.done) break;
          chunks.push(part.value);
          loaded += part.value.length;
          report(progress, total ? Math.min(99, Math.round(loaded * 100 / total)) : 0,
            '正在下载到浏览器：' + Math.round(loaded / 1048576 * 10) / 10 + ' MiB');
        }
      } else {
        var data = new Uint8Array(await response.arrayBuffer());
        chunks.push(data);
        loaded = data.length;
        report(progress, 99, '模型下载完成，正在缓存到浏览器…');
      }
      var bytes = new Uint8Array(loaded), offset = 0;
      chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
      if (!bytes.length) throw new Error('模型文件为空');
      await verifyModel(bytes, name);
      if (cache) {
        try { await cache.put(cacheKey, new Response(bytes.slice(), { headers: { 'Content-Type': 'application/octet-stream' } })); }
        catch (error) { report(progress, 100, '已下载模型；浏览器空间不足，关闭页面后可能需要重新下载'); return bytes; }
      }
      report(progress, 100, cache ? '模型已保存到浏览器缓存' : '模型已载入（此浏览器未提供持久模型缓存）');
      return bytes;
    })().catch(function (error) {
      delete modelPromises[name];
      throw error;
    });
    return modelPromises[name];
  }

  function loadRuntime() {
    if (window.ort) return Promise.resolve(window.ort);
    if (runtimePromise) return runtimePromise;
    runtimePromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/api/ai/runtime/ort.webgpu.min.js?v=1.30.0';
      script.async = true;
      script.onload = function () {
        if (!window.ort) { runtimePromise = null; reject(new Error('浏览器 AI 运行库未能启动')); return; }
        window.ort.env.wasm.wasmPaths = '/api/ai/runtime/';
        window.ort.env.wasm.numThreads = 1;
        resolve(window.ort);
      };
      script.onerror = function () { runtimePromise = null; reject(new Error('无法载入浏览器 AI 运行库')); };
      document.head.appendChild(script);
    });
    return runtimePromise;
  }

  function modelSession(name, progress, cpuOnly) {
    var sessionKey = cpuOnly ? name + '-cpu' : name;
    if (!cpuOnly && sessionPromises[name + '-cpu']) return sessionPromises[name + '-cpu'];
    if (sessionPromises[sessionKey]) return sessionPromises[sessionKey];
    sessionPromises[sessionKey] = (async function () {
      var ort = await loadRuntime();
      var bytes = await cachedModel(name, progress);
      report(progress, 0, '正在启动浏览器 AI 模型…');
      var providers = !cpuOnly && window.navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
      try {
        var session = await ort.InferenceSession.create(bytes, {
          executionProviders: providers,
          graphOptimizationLevel: 'all'
        });
        session._localtoolsProvider = providers[0] === 'webgpu' ? 'WebGPU / WASM' : 'WASM CPU';
        report(progress, 100, '浏览器模型已就绪 · ' + session._localtoolsProvider);
        return session;
      } catch (gpuError) {
        if (providers[0] !== 'webgpu') throw gpuError;
        report(progress, 0, 'GPU 不兼容，正在切换浏览器 CPU…');
        var fallback = await ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        fallback._localtoolsProvider = 'WASM CPU';
        report(progress, 100, '浏览器模型已就绪 · WASM CPU');
        return fallback;
      }
    })().catch(function (error) {
      delete sessionPromises[sessionKey];
      throw error;
    });
    return sessionPromises[sessionKey];
  }

  async function runWithFallback(name, session, feeds, progress) {
    try {
      return { outputs: await session.run(feeds), session: session };
    } catch (error) {
      if (session._localtoolsProvider !== 'WebGPU / WASM') throw error;
      report(progress, 0, 'GPU 推理未完成，正在切换浏览器 CPU…');
      if (session.release) {
        try { await session.release(); } catch (ignore) { /* release may fail after a device error */ }
      }
      delete sessionPromises[name];
      var cpuSession = await modelSession(name, progress, true);
      return { outputs: await cpuSession.run(feeds), session: cpuSession };
    }
  }

  function intersectionOverUnion(a, b) {
    var x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
    var x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
    var intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    var areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
    var areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
    var union = areaA + areaB - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function decodeDetections(output, width, height, resizedWidth, resizedHeight, threshold) {
    var dims = output.dims, data = output.data;
    if (!dims || dims.length !== 3 || dims[0] !== 1 || dims[1] !== 5) {
      throw new Error('水印检测模型输出结构不兼容');
    }
    var anchors = dims[2], found = [], sx = resizedWidth / width, sy = resizedHeight / height;
    for (var i = 0; i < anchors; i++) {
      var score = data[4 * anchors + i];
      if (!Number.isFinite(score) || score < threshold) continue;
      var cx = data[i], cy = data[anchors + i], bw = data[2 * anchors + i], bh = data[3 * anchors + i];
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(bw) || !Number.isFinite(bh)) continue;
      var box = {
        x1: Math.max(0, Math.min(width, (cx - bw / 2) / sx)),
        y1: Math.max(0, Math.min(height, (cy - bh / 2) / sy)),
        x2: Math.max(0, Math.min(width, (cx + bw / 2) / sx)),
        y2: Math.max(0, Math.min(height, (cy + bh / 2) / sy)),
        score: score
      };
      if (box.x2 - box.x1 >= 3 && box.y2 - box.y1 >= 3) found.push(box);
    }
    found.sort(function (a, b) { return b.score - a.score; });
    var selected = [];
    found.forEach(function (box) {
      if (selected.length >= 20) return;
      for (var i = 0; i < selected.length; i++) {
        if (intersectionOverUnion(box, selected[i]) > 0.5) return;
      }
      selected.push(box);
    });
    return selected;
  }

  async function detect(canvas, progress, threshold) {
    if (!canvas || !canvas.width || !canvas.height) throw new Error('请先选择图片');
    var session = await modelSession('detector', progress);
    report(progress, 0, '正在检测整张图片中的可见水印…');
    var maxEdge = 640, scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
    var resizedWidth = Math.max(1, Math.floor(Number((canvas.width * scale).toFixed(2))));
    var resizedHeight = Math.max(1, Math.floor(Number((canvas.height * scale).toFixed(2))));
    var inputCanvas = document.createElement('canvas');
    inputCanvas.width = maxEdge; inputCanvas.height = maxEdge;
    var ctx = inputCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, maxEdge, maxEdge);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, resizedWidth, resizedHeight);
    var rgba = ctx.getImageData(0, 0, maxEdge, maxEdge).data;
    var plane = maxEdge * maxEdge, input = new Float32Array(3 * plane);
    for (var i = 0; i < plane; i++) {
      var src = i * 4;
      input[i] = rgba[src] / 255;
      input[plane + i] = rgba[src + 1] / 255;
      input[plane * 2 + i] = rgba[src + 2] / 255;
    }
    var ort = await loadRuntime();
    var tensor = new ort.Tensor('float32', input, [1, 3, maxEdge, maxEdge]);
    var run = await runWithFallback('detector', session, { images: tensor }, progress);
    var outputs = run.outputs;
    var result = decodeDetections(outputs.output0, canvas.width, canvas.height, resizedWidth, resizedHeight, threshold || 0.5);
    if (tensor.dispose) tensor.dispose();
    Object.keys(outputs).forEach(function (key) { if (outputs[key].dispose) outputs[key].dispose(); });
    report(progress, 100, '自动检测到 ' + result.length + ' 个候选区域');
    return result;
  }

  async function inpaint(imageCanvas, maskCanvas, progress) {
    if (!imageCanvas || imageCanvas.width !== maskCanvas.width || imageCanvas.height !== maskCanvas.height) {
      throw new Error('图片与遮罩尺寸不一致');
    }
    var session = await modelSession('inpainter', progress);
    report(progress, 0, '正在浏览器本地修补选中区域…');
    var width = imageCanvas.width, height = imageCanvas.height, pixels = width * height;
    if (!pixels || pixels > 12000000) throw new Error('本地修补限制为 1200 万像素');
    var imageData = imageCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
    var maskData = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
    var rgb = new Uint8Array(pixels * 3), mask = new Uint8Array(pixels), transparent = false;
    for (var i = 0; i < pixels; i++) {
      var src = i * 4;
      if (imageData.data[src + 3] < 255) transparent = true;
      rgb[i] = imageData.data[src];
      rgb[pixels + i] = imageData.data[src + 1];
      rgb[pixels * 2 + i] = imageData.data[src + 2];
      mask[i] = maskData.data[src] >= 128 ? 255 : 0;
    }
    var ort = await loadRuntime();
    var imageTensor = new ort.Tensor('uint8', rgb, [1, 3, height, width]);
    var maskTensor = new ort.Tensor('uint8', mask, [1, 1, height, width]);
    var run = await runWithFallback('inpainter', session, { image: imageTensor, mask: maskTensor }, progress);
    session = run.session;
    var output = run.outputs;
    var generated = output[Object.keys(output)[0]].data;
    for (var i = 0; i < pixels; i++) {
      if (mask[i] === 255) continue;
      var dest = i * 4;
      imageData.data[dest] = generated[i];
      imageData.data[dest + 1] = generated[pixels + i];
      imageData.data[dest + 2] = generated[pixels * 2 + i];
    }
    if (imageTensor.dispose) imageTensor.dispose();
    if (maskTensor.dispose) maskTensor.dispose();
    Object.keys(output).forEach(function (key) { if (output[key].dispose) output[key].dispose(); });
    var resultCanvas = document.createElement('canvas');
    resultCanvas.width = width; resultCanvas.height = height;
    resultCanvas.getContext('2d').putImageData(imageData, 0, 0);
    var blob = await new Promise(function (resolve) {
      resultCanvas.toBlob(resolve, transparent ? 'image/png' : 'image/webp', 0.92);
    });
    if (!blob) throw new Error('浏览器无法编码修补结果');
    report(progress, 100, '本地修补完成 · ' + session._localtoolsProvider);
    return blob;
  }

  async function clearCache() {
    var sessions = Object.keys(sessionPromises).map(function (name) {
      return sessionPromises[name].then(function (session) {
        if (session && session.release) return session.release();
      }, function () {});
    });
    await Promise.all(sessions);
    if (window.caches && window.caches.delete) await window.caches.delete(CACHE_NAME);
    modelPromises = Object.create(null);
    sessionPromises = Object.create(null);
  }

  window.WatermarkLocal = {
    detect: detect,
    inpaint: inpaint,
    clearCache: clearCache
  };
})();
