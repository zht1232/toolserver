/* HIF / HEIF -> sRGB JPEG：优先在浏览器本地解码与色调映射，失败时可选服务器兜底 */
(function () {
  'use strict';

  var drop = document.getElementById('hif-drop');
  if (!drop) return;

  var input = document.getElementById('hif-input');
  var listEl = document.getElementById('hif-list');
  var panel = document.getElementById('hif-files-panel');
  var convertBtn = document.getElementById('hif-convert');
  var zipBtn = document.getElementById('hif-zip');
  var clearBtn = document.getElementById('hif-clear');
  var qualitySel = document.getElementById('hif-quality');
  var exposureSel = document.getElementById('hif-exposure');
  var fallbackCheck = document.getElementById('hif-fallback');
  var summary = document.getElementById('hif-summary');
  var statusEl = document.getElementById('hif-status');
  var progress = document.getElementById('hif-progress');
  var progressTrack = document.getElementById('hif-progress-track');
  var progressFill = document.getElementById('hif-progress-fill');
  var resultCount = document.getElementById('hif-result-count');

  var MAX_FILES = 30;
  var MAX_FILE_BYTES = 80 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 500 * 1024 * 1024;
  var WORKER_URL = 'assets/js/hif-worker.js?v=20261025-01';

  var files = [];
  var usedNames = {};
  var running = false;
  var serverReady = false;
  var browserReady = !!(typeof Worker !== 'undefined' && typeof WebAssembly === 'object' &&
    typeof FileReader !== 'undefined' && typeof ImageData !== 'undefined' &&
    typeof Uint8Array !== 'undefined');
  var worker = null;
  var currentJob = null;
  var jobSeq = 0;

  function fmtSize(n) { return TB.formatSize(n); }

  function fileExt(name) {
    var m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toUpperCase() : 'HEIF';
  }

  function isHif(file) {
    return /\.(hif|heic|heif)$/i.test(file.name || '');
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'logline mono' + (cls ? ' ' + cls : '');
  }

  function setProgress(value, indeterminate) {
    progress.classList.remove('hidden');
    if (indeterminate) {
      progressFill.classList.add('is-indeterminate');
      progressFill.style.width = '34%';
      progressTrack.removeAttribute('aria-valuenow');
      progressTrack.setAttribute('aria-busy', 'true');
    } else {
      progressFill.classList.remove('is-indeterminate');
      progressFill.style.width = value + '%';
      progressTrack.setAttribute('aria-valuenow', String(value));
      progressTrack.removeAttribute('aria-busy');
    }
  }

  function hideProgress() {
    progress.classList.add('hidden');
    progressFill.classList.remove('is-indeterminate');
    progressFill.style.width = '0%';
    progressTrack.setAttribute('aria-valuenow', '0');
    progressTrack.removeAttribute('aria-busy');
  }

  function doneFiles() {
    return files.filter(function (item) { return item.state === 'done' && item.blob; });
  }

  function refresh() {
    var totalBytes = 0;
    files.forEach(function (item) { totalBytes += item.file.size; });
    var done = doneFiles().length;
    var pending = files.filter(function (item) { return item.state !== 'done'; }).length;

    if (!files.length) summary.textContent = '未选择文件';
    else summary.textContent = '已选 ' + files.length + ' 张 · ' + fmtSize(totalBytes) + (done ? ' · 已完成 ' + done : '');
    resultCount.textContent = files.length ? done + ' / ' + files.length + ' 完成' : '';
    panel.classList.toggle('hidden', !files.length);

    convertBtn.disabled = running || !files.length || pending === 0 || (!browserReady && !serverReady);
    convertBtn.textContent = files.length && pending === 0 ? '全部已转换' : '开始批量转换';
    zipBtn.disabled = running || done === 0;
    clearBtn.disabled = running || !files.length;
    input.disabled = running;
    if (fallbackCheck) fallbackCheck.disabled = running;
  }

  function setItemState(item, text, cls) {
    item.stateEl.textContent = text;
    item.stateEl.className = 'hif-state' + (cls ? ' ' + cls : '');
  }

  function makeRow(item) {
    var row = document.createElement('div');
    row.className = 'filerow hif-filerow';
    item.row = row;

    var cover = document.createElement('div');
    cover.className = 'filerow-cover empty hif-cover';
    cover.textContent = fileExt(item.file.name);
    item.cover = cover;

    var main = document.createElement('div');
    main.className = 'filerow-main';
    var nameEl = document.createElement('div');
    nameEl.className = 'filerow-name';
    nameEl.textContent = item.file.name;
    var metaEl = document.createElement('div');
    metaEl.className = 'filerow-sub';
    metaEl.textContent = fmtSize(item.file.size) + ' · ' + fileExt(item.file.name) + ' · 等待转换';
    main.appendChild(nameEl);
    main.appendChild(metaEl);
    item.metaEl = metaEl;

    var actions = document.createElement('div');
    actions.className = 'filerow-actions hif-row-actions';
    var stateEl = document.createElement('span');
    stateEl.className = 'hif-state';
    stateEl.textContent = '等待';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = '下载 JPG';
    btn.disabled = true;
    btn.addEventListener('click', function () {
      if (item.blob) TB.download(item.blob, item.outName);
    });
    actions.appendChild(stateEl);
    actions.appendChild(btn);
    item.stateEl = stateEl;
    item.downloadBtn = btn;

    row.appendChild(cover);
    row.appendChild(main);
    row.appendChild(actions);
    listEl.appendChild(row);
  }

  function addFiles(fileList) {
    if (running) {
      setStatus('正在转换，请等当前批次完成后再添加文件。');
      return;
    }
    var totalBytes = 0;
    files.forEach(function (item) { totalBytes += item.file.size; });
    var accepted = 0, rejected = 0, duplicates = 0, overflow = 0;

    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (!isHif(file)) { rejected++; continue; }
      if (file.size > MAX_FILE_BYTES) { rejected++; continue; }
      if (files.length >= MAX_FILES) { overflow++; break; }
      if (totalBytes + file.size > MAX_TOTAL_BYTES) { overflow++; break; }

      var duplicate = false;
      for (var j = 0; j < files.length; j++) {
        if (files[j].file.name === file.name && files[j].file.size === file.size &&
            files[j].file.lastModified === file.lastModified) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) { duplicates++; continue; }

      var item = {
        file: file,
        state: 'pending',
        blob: null,
        outName: '',
        width: 0,
        height: 0
      };
      files.push(item);
      totalBytes += file.size;
      makeRow(item);
      accepted++;
    }

    var messages = [];
    if (accepted) messages.push('已添加 ' + accepted + ' 张');
    if (rejected) messages.push(rejected + ' 张不是 HIF/HEIC 或超过 80 MB');
    if (duplicates) messages.push(duplicates + ' 张重复已跳过');
    if (overflow) messages.push('超出单次 30 张 / 500 MB 上限');
    if (messages.length) setStatus(messages.join('；') + '。');

    refresh();
  }

  function uniqueOutputName(name) {
    var base = TB.safeName(String(name).replace(/\.[^.]+$/, ''));
    var candidate = base + '_sdr.jpg';
    var index = 2;
    while (usedNames[candidate]) {
      candidate = base + '_sdr-' + index + '.jpg';
      index++;
    }
    usedNames[candidate] = true;
    return candidate;
  }

  function parseError(buffer, status) {
    if (buffer && buffer.byteLength) {
      try {
        var text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
        var data = JSON.parse(text);
        if (data && data.error) return data.error;
      } catch (e) { /* ignore */ }
    }
    return '转换失败（HTTP ' + status + '）';
  }

  function failItem(item, message) {
    item.state = 'error';
    item.blob = null;
    item.row.classList.add('is-error');
    item.cover.textContent = 'ERR';
    item.cover.classList.remove('is-done');
    setItemState(item, '失败', 'is-error');
    item.metaEl.textContent = '失败：' + message;
    item.metaEl.title = message;
    item.downloadBtn.disabled = true;
  }

  function finishItem(item, blob, meta, engine) {
    item.blob = blob;
    item.outName = uniqueOutputName(item.file.name);
    item.width = meta.width || 0;
    item.height = meta.height || 0;
    item.state = 'done';
    item.row.classList.remove('is-error');
    item.cover.textContent = 'JPG';
    item.cover.classList.add('is-done');
    setItemState(item, '完成', 'is-done');
    item.metaEl.textContent = fmtSize(item.file.size) + ' → ' + fmtSize(blob.size) +
      (item.width ? ' · ' + item.width + '×' + item.height : '') +
      ' · sRGB' + (engine ? ' · ' + engine : '');
    item.metaEl.removeAttribute('title');
    item.downloadBtn.disabled = false;
  }

  function cleanupWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    currentJob = null;
  }

  function encodeJpeg(item, result, done) {
    var canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      done(false, '浏览器不支持 Canvas 编码');
      return;
    }
    try {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height), 0, 0);
    } catch (err) {
      canvas.width = 0;
      canvas.height = 0;
      done(false, '浏览器内存不足，无法绘制这张图片');
      return;
    }
    var quality = parseInt(qualitySel.value, 10) || 96;
    var finished = false;
    function finish(blob) {
      if (finished) return;
      finished = true;
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) {
        done(false, '浏览器内存不足，无法生成 JPEG');
        return;
      }
      done(true, blob, result.meta);
    }
    try {
      canvas.toBlob(finish, 'image/jpeg', quality / 100);
    } catch (err) {
      finish(null);
    }
  }

  function startWorker(item, buffer, jobId, done) {
    var finished = false;
    function finish(ok, blob, meta, message, code) {
      if (finished) return;
      finished = true;
      cleanupWorker();
      if (ok) {
        finishItem(item, blob, meta || { width: item.width, height: item.height }, '本地');
        done(true);
        return;
      }
      if (fallbackCheck && fallbackCheck.checked && serverReady && code !== 'too-large') {
        setStatus('浏览器无法处理这张图片，改用服务器（会上传）…');
        item.metaEl.textContent = '浏览器无法处理，改用服务器转换…';
        item.state = 'busy';
        setItemState(item, '改用服务器…', 'is-busy');
        serverConvertOne(item, function (okServer) {
          done(okServer);
        });
        return;
      }
      failItem(item, message || '浏览器转换失败');
      if (code === 'too-large') setStatus('图片超过浏览器转换上限（6000 万像素）。');
      done(false);
    }

    try {
      worker = new Worker(WORKER_URL);
    } catch (err) {
      finish(false, null, null, '本地解码器启动失败', 'worker');
      return;
    }
    currentJob = { id: jobId, item: item, finish: finish };

    worker.onmessage = function (event) {
      var msg = event.data || {};
      if (!currentJob || msg.id !== currentJob.id) return;
      if (msg.type === 'progress') {
        if (msg.width && msg.height) {
          item.width = msg.width;
          item.height = msg.height;
        }
        if (msg.stage === 'engine') {
          setItemState(item, '加载解码器…', 'is-busy');
        } else if (msg.stage === 'decode') {
          setItemState(item, msg.value < 35 ? '解码中…' : '解码完成', 'is-busy');
          if (msg.width) item.metaEl.textContent = msg.width + '×' + msg.height + ' · 浏览器本地解码';
        } else if (msg.stage === 'tone') {
          setItemState(item, '色彩映射 ' + msg.value + '%', 'is-busy');
        }
        return;
      }
      if (msg.type === 'error') {
        finish(false, null, null, msg.message || '浏览器解码失败', msg.code || 'decode');
        return;
      }
      if (msg.type === 'done') {
        setItemState(item, '生成 JPEG…', 'is-busy');
        item.metaEl.textContent = msg.width + '×' + msg.height + ' · 浏览器本地编码中…';
        encodeJpeg(item, msg, function (ok, blob, meta) {
          if (!ok) {
            finish(false, null, null, '浏览器无法生成 JPEG', 'encode');
            return;
          }
          finish(true, blob, meta);
        });
      }
    };
    worker.onerror = function (event) {
      var message = event && event.message ? event.message : '本地解码器运行失败';
      finish(false, null, null, message, 'worker');
    };
    try {
      worker.postMessage({ type: 'convert', id: jobId, buffer: buffer, name: item.file.name, exposure: exposureSel ? (parseFloat(exposureSel.value) || 0) : 0 }, [buffer]);
    } catch (err) {
      finish(false, null, null, '无法把文件交给本地解码器', 'worker');
    }
  }

  function convertInBrowser(item, done) {
    item.state = 'busy';
    item.row.classList.remove('is-error');
    item.cover.textContent = fileExt(item.file.name);
    item.cover.classList.remove('is-done');
    item.metaEl.textContent = fmtSize(item.file.size) + ' · ' + fileExt(item.file.name) + ' · 浏览器本地转换';
    item.metaEl.removeAttribute('title');
    item.downloadBtn.disabled = true;
    setItemState(item, '读取文件…', 'is-busy');

    var jobId = ++jobSeq;
    var reader = new FileReader();
    reader.onload = function () {
      startWorker(item, reader.result, jobId, done);
    };
    reader.onerror = function () {
      failItem(item, '读取文件失败');
      done(false);
    };
    reader.onabort = function () {
      failItem(item, '读取文件已取消');
      done(false);
    };
    try {
      reader.readAsArrayBuffer(item.file);
    } catch (err) {
      failItem(item, '读取文件失败');
      done(false);
    }
  }

  function serverConvertOne(item, done) {
    item.state = 'busy';
    item.row.classList.remove('is-error');
    item.cover.textContent = fileExt(item.file.name);
    item.cover.classList.remove('is-done');
    item.metaEl.textContent = fmtSize(item.file.size) + ' · ' + fileExt(item.file.name) + ' · 服务器转换中';
    item.metaEl.removeAttribute('title');
    item.downloadBtn.disabled = true;
    setItemState(item, '上传中', 'is-busy');

    if (!serverReady) {
      failItem(item, '服务器转换不可用');
      done(false);
      return;
    }

    var xhr = new XMLHttpRequest();
    var url = 'api/hif/convert?name=' + encodeURIComponent(item.file.name) +
      '&q=' + encodeURIComponent(qualitySel.value) +
      '&ev=' + encodeURIComponent(exposureSel ? exposureSel.value : '0');
    xhr.open('POST', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 240000;
    var finished = false;
    function finish(ok, blob, meta, message) {
      if (finished) return;
      finished = true;
      if (ok) {
        finishItem(item, blob, meta, '服务器');
        done(true);
        return;
      }
      failItem(item, message || '服务器转换失败');
      done(false);
    }

    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        var percent = Math.round(e.loaded / e.total * 100);
        setItemState(item, '上传 ' + percent + '%', 'is-busy');
      }
    };
    xhr.upload.onload = function () {
      setItemState(item, '服务器转换中…', 'is-busy');
    };
    xhr.onload = function () {
      if (xhr.status === 200 && xhr.response && xhr.response.byteLength) {
        var blob = new Blob([xhr.response], { type: 'image/jpeg' });
        finish(true, blob, {
          width: parseInt(xhr.getResponseHeader('X-Output-Width'), 10) || 0,
          height: parseInt(xhr.getResponseHeader('X-Output-Height'), 10) || 0
        });
        return;
      }
      finish(false, null, null, parseError(xhr.response, xhr.status));
    };
    xhr.onerror = function () {
      finish(false, null, null, '网络中断或服务器不可达');
    };
    xhr.ontimeout = function () {
      finish(false, null, null, '转换超时（超过 4 分钟）');
    };
    xhr.onabort = function () {
      finish(false, null, null, '请求已取消');
    };
    xhr.send(item.file);
  }

  function convertOne(item, done) {
    var finished = false;
    function finish(ok) {
      if (finished) return;
      finished = true;
      done(ok);
    }

    if (browserReady) {
      convertInBrowser(item, finish);
      return;
    }
    if (serverReady) {
      serverConvertOne(item, finish);
      return;
    }
    failItem(item, '当前浏览器不支持本地转换，服务器也不可用');
    finish(false);
  }

  function startBatch() {
    if (running) return;
    var queue = files.filter(function (item) { return item.state !== 'done'; });
    if (!queue.length) {
      setStatus('没有待转换的文件。');
      return;
    }
    running = true;
    refresh();
    setProgress(0, false);
    var index = 0, ok = 0, failed = 0;

    function next() {
      if (index >= queue.length) {
        running = false;
        refresh();
        setProgress(100, false);
        setStatus('处理完成：成功 ' + ok + ' 张' +
          (failed ? '，失败 ' + failed + ' 张；可再次点击转换重试失败项。' : '。'),
          failed ? '' : 'status-ok');
        return;
      }
      var item = queue[index];
      index++;
      setStatus('正在处理 ' + index + ' / ' + queue.length + '：' + item.file.name);
      setProgress(Math.round((index - 1) / queue.length * 100), false);
      convertOne(item, function (success) {
        if (success) ok++;
        else failed++;
        setProgress(Math.round(index / queue.length * 100), false);
        refresh();
        next();
      });
    }
    next();
  }

  function dateStamp() {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  convertBtn.addEventListener('click', startBatch);

  zipBtn.addEventListener('click', function () {
    if (running) return;
    var done = doneFiles();
    if (!done.length) return;
    var entries = done.map(function (item) {
      return { name: item.outName, blob: item.blob };
    });
    var oldText = zipBtn.textContent;
    zipBtn.disabled = true;
    zipBtn.textContent = '打包中…';
    setStatus('正在打包 ' + entries.length + ' 个 JPEG…');
    function reset() {
      zipBtn.textContent = oldText;
      refresh();
    }
    TB.zip(entries).then(function (blob) {
      TB.download(blob, 'HIF转JPEG_' + dateStamp() + '.zip');
      setStatus('ZIP 已生成：' + entries.length + ' 个文件，' + fmtSize(blob.size) + '。', 'status-ok');
      reset();
    }).catch(function (err) {
      setStatus('打包失败：' + (err && err.message ? err.message : err), 'err');
      reset();
    });
  });

  clearBtn.addEventListener('click', function () {
    if (running) return;
    files = [];
    usedNames = {};
    listEl.innerHTML = '';
    hideProgress();
    setStatus(browserReady ? '已清空。图片只在浏览器本地转换。' : '服务未就绪。');
    refresh();
  });

  qualitySel.addEventListener('change', function () {
    if (!running) setStatus('JPEG 质量已设为 ' + qualitySel.value + '；仅影响之后转换的文件。');
  });

  if (exposureSel) {
    exposureSel.addEventListener('change', function () {
      if (!running) setStatus('曝光补偿已设为 ' + exposureSel.value + ' EV；仅影响之后转换的文件。');
    });
  }

  if (fallbackCheck) {
    fallbackCheck.addEventListener('change', function () {
      if (running) return;
      setStatus(fallbackCheck.checked
        ? '已开启服务器兜底：浏览器无法解码时会上传文件到本站服务器（仅内存处理）。'
        : '已关闭服务器兜底：图片不会上传，浏览器无法解码时会直接报错。');
    });
  }

  input.addEventListener('change', function () {
    addFiles(input.files);
    input.value = '';
  });
  drop.addEventListener('click', function (e) {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') input.click();
  });
  TB.bindDropzone(drop, addFiles);

  window.addEventListener('unload', function () {
    cleanupWorker();
  });

  refresh();
  setStatus(browserReady
    ? '浏览器本地转换就绪（图片不会上传）；首次转换需加载约 1.4 MB 解码器。'
    : '正在检测转换能力…');

  fetch('api/ping', { cache: 'no-store' }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (info) {
    var hif = info && info.hifConvert;
    serverReady = !!(hif && hif.ready);
    if (browserReady) {
      setStatus('浏览器本地转换就绪（图片不会上传）' +
        (serverReady ? '；浏览器无法解码时可回退服务器（默认开启）。' : '。'));
    } else if (serverReady) {
      setStatus('当前浏览器不支持本地解码，将使用服务器转换（会上传文件）。');
    } else if (hif && hif.error) {
      setStatus('浏览器不支持本地转换，服务器也未安装 HIF 依赖。');
    } else {
      setStatus('浏览器不支持本地转换，且当前没有可用的服务器。');
    }
    refresh();
  }).catch(function () {
    serverReady = false;
    if (browserReady) {
      setStatus('浏览器本地转换就绪（图片不会上传）；服务器兜底不可用。');
    } else {
      setStatus('当前浏览器不支持本地转换，且服务器不可用。');
    }
    refresh();
  });
})();
