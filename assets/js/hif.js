/* HIF / HEIF -> sRGB JPEG，批量上传到本站服务器内存转换 */
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
  var summary = document.getElementById('hif-summary');
  var statusEl = document.getElementById('hif-status');
  var progress = document.getElementById('hif-progress');
  var progressTrack = document.getElementById('hif-progress-track');
  var progressFill = document.getElementById('hif-progress-fill');
  var resultCount = document.getElementById('hif-result-count');

  var MAX_FILES = 30;
  var MAX_FILE_BYTES = 80 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 500 * 1024 * 1024;

  var files = [];
  var usedNames = {};
  var running = false;
  var serverReady = false;

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

    convertBtn.disabled = running || !serverReady || !files.length || pending === 0;
    convertBtn.textContent = files.length && pending === 0 ? '全部已转换' : '开始批量转换';
    zipBtn.disabled = running || done === 0;
    clearBtn.disabled = running || !files.length;
    input.disabled = running;
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

  function convertOne(item, done) {
    item.state = 'busy';
    item.row.classList.remove('is-error');
    item.cover.textContent = fileExt(item.file.name);
    item.cover.classList.remove('is-done');
    item.metaEl.textContent = fmtSize(item.file.size) + ' · ' + fileExt(item.file.name) + ' · 转换中';
    item.metaEl.removeAttribute('title');
    item.downloadBtn.disabled = true;
    setItemState(item, '上传中', 'is-busy');

    var xhr = new XMLHttpRequest();
    var url = 'api/hif/convert?name=' + encodeURIComponent(item.file.name) +
      '&q=' + encodeURIComponent(qualitySel.value);
    xhr.open('POST', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 240000;

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
        item.blob = blob;
        item.outName = uniqueOutputName(item.file.name);
        item.width = parseInt(xhr.getResponseHeader('X-Output-Width'), 10) || 0;
        item.height = parseInt(xhr.getResponseHeader('X-Output-Height'), 10) || 0;
        item.state = 'done';
        setItemState(item, '完成', 'is-done');
        item.cover.textContent = 'JPG';
        item.cover.classList.add('is-done');
        item.metaEl.textContent = fmtSize(item.file.size) + ' → ' + fmtSize(blob.size) +
          (item.width ? ' · ' + item.width + '×' + item.height : '') + ' · sRGB';
        item.downloadBtn.disabled = false;
        done(true);
        return;
      }
      failItem(item, parseError(xhr.response, xhr.status));
      done(false);
    };
    xhr.onerror = function () {
      failItem(item, '网络中断或服务器不可达');
      done(false);
    };
    xhr.ontimeout = function () {
      failItem(item, '转换超时（超过 4 分钟）');
      done(false);
    };
    xhr.onabort = function () {
      failItem(item, '请求已取消');
      done(false);
    };
    xhr.send(item.file);
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
    setStatus(serverReady ? '已清空。选择 HIF 文件开始转换。' : '服务未就绪。');
    refresh();
  });

  qualitySel.addEventListener('change', function () {
    if (!running) setStatus('JPEG 质量已设为 ' + qualitySel.value + '；仅影响之后转换的文件。');
  });

  input.addEventListener('change', function () {
    addFiles(input.files);
    input.value = '';
  });
  drop.addEventListener('click', function (e) {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') input.click();
  });
  TB.bindDropzone(drop, addFiles);

  refresh();
  fetch('api/ping', { cache: 'no-store' }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (info) {
    var hif = info && info.hifConvert;
    serverReady = !!(hif && hif.ready);
    if (serverReady) {
      setStatus('服务器就绪：选择 HIF 文件开始，单张上限 ' +
        (hif.maxUploadMB || 80) + ' MB。');
    } else if (hif && hif.error) {
      setStatus('HIF 转换依赖未安装：请在服务器执行 pip install -r requirements.txt。');
    } else {
      setStatus('当前未连接转换服务器：HIF 功能需要自带 server.py，纯静态托管不可用。');
    }
    refresh();
  }).catch(function () {
    serverReady = false;
    setStatus('当前未连接转换服务器：HIF 功能需要自带 server.py。');
    refresh();
  });
})();
