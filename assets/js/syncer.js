/* 歌词打轴器：载入音频与歌词文本，按空格为每行打时间戳，导出标准 LRC */
(function () {
  'use strict';

  var audioInput = document.getElementById('sy-audio');
  var audioEl = document.getElementById('sy-audio-el');
  var audioName = document.getElementById('sy-audio-name');
  var textFile = document.getElementById('sy-text-file');
  var input = document.getElementById('sy-input');
  var loadBtn = document.getElementById('sy-load-text');
  var stampBtn = document.getElementById('sy-stamp');
  var undoBtn = document.getElementById('sy-undo');
  var shiftBtn = document.getElementById('sy-shift');
  var shiftVal = document.getElementById('sy-shift-val');
  var exportBtn = document.getElementById('sy-export');
  var linesBox = document.getElementById('sy-lines');
  var timeLabel = document.getElementById('sy-time');
  var countLabel = document.getElementById('sy-line-count');

  var lines = [];      // { text, time: null|number(ms) }
  var cursor = 0;      // 当前待打轴行
  var history = [];    // 撤销栈：[索引, 旧时间]
  var audioUrl = null;

  function fmt(ms) {
    if (ms === null || ms === undefined) return '--:--.--';
    var total = Math.max(0, ms);
    var m = Math.floor(total / 60000);
    var s = (total % 60000) / 1000;
    return ('0' + m).slice(-2) + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    linesBox.innerHTML = '';
    if (!lines.length) {
      linesBox.innerHTML = '<div class="line muted">尚未载入歌词行</div>';
      countLabel.textContent = '0 行';
      return;
    }
    lines.forEach(function (line, idx) {
      var div = document.createElement('div');
      div.className = 'line' + (idx === cursor ? ' cur' : '');
      div.innerHTML =
        '<span class="t mono' + (line.time !== null ? ' set' : '') + '">' + fmt(line.time) + '</span>' +
        '<span class="txt">' + escapeHtml(line.text) + '</span>' +
        '<span class="jump">' + (line.time !== null ? '跳到' : '定位') + '</span>';
      div.querySelector('.jump').addEventListener('click', function () {
        if (line.time !== null) audioEl.currentTime = line.time / 1000;
        cursor = idx;
        render();
      });
      linesBox.appendChild(div);
    });
    countLabel.textContent = lines.length + ' 行，已打轴 ' +
      lines.filter(function (l) { return l.time !== null; }).length + ' 行';
    var cur = linesBox.querySelector('.line.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- 载入素材 ---------- */
  audioInput.addEventListener('change', function () {
    var f = audioInput.files[0];
    if (!f) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(f);
    audioEl.src = audioUrl;
    audioName.textContent = f.name + ' · ' + TB.formatSize(f.size);
    audioInput.value = '';
  });

  textFile.addEventListener('change', async function () {
    var f = textFile.files[0];
    if (!f) return;
    input.value = await f.text();
    textFile.value = '';
    loadLyricLines();
  });

  function loadLyricLines() {
    var raw = input.value.replace(/\r/g, '');
    if (!raw.trim()) {
      alert('请先粘贴歌词文本或导入歌词文件。');
      return;
    }
    lines = [];
    raw.split('\n').forEach(function (line) {
      var m = line.match(/^\s*((?:\[\d+:\d+(?:\.\d+)?\])+)\s*(.*)$/);
      if (m) {
        var tags = m[1].match(/\[(\d+):(\d+(?:\.\d+)?)\]/g) || [];
        var text = m[2].trim();
        if (!text) return;
        tags.forEach(function (tag, i) {
          var tm = tag.match(/\[(\d+):(\d+(?:\.\d+)?)\]/);
          var ms = Math.round((parseInt(tm[1], 10) * 60 + parseFloat(tm[2])) * 1000);
          lines.push({ text: text, time: i === 0 ? ms : ms });
        });
      } else {
        var t = line.trim();
        if (!t) return;
        if (/^\[[a-z]+:/i.test(t)) return; // 跳过 [ti:] [ar:] 等元信息
        lines.push({ text: t, time: null });
      }
    });
    cursor = lines.findIndex(function (l) { return l.time === null; });
    if (cursor < 0) cursor = 0;
    history = [];
    render();
  }
  loadBtn.addEventListener('click', loadLyricLines);

  /* ---------- 打轴 ---------- */
  function stamp() {
    if (!lines.length) { alert('请先载入歌词行。'); return; }
    if (!audioEl.src) { alert('请先选择音频文件。'); return; }
    if (cursor >= lines.length) { cursor = lines.length - 1; }
    history.push([cursor, lines[cursor].time]);
    lines[cursor].time = Math.round(audioEl.currentTime * 1000);
    if (cursor < lines.length - 1) cursor++;
    render();
  }

  function undo() {
    if (!history.length) return;
    var last = history.pop();
    lines[last[0]].time = last[1];
    cursor = last[0];
    render();
  }

  stampBtn.addEventListener('click', stamp);
  undoBtn.addEventListener('click', undo);

  audioEl.addEventListener('timeupdate', function () {
    timeLabel.textContent = fmt(Math.round(audioEl.currentTime * 1000));
  });

  document.addEventListener('keydown', function (e) {
    var page = document.getElementById('page-syncer');
    if (!page || page.classList.contains('hidden')) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (audioEl.paused) audioEl.play(); else stamp();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
  });

  /* ---------- 整轴平移与导出 ---------- */
  shiftBtn.addEventListener('click', function () {
    var ms = parseInt(shiftVal.value, 10) || 0;
    if (!ms) return;
    lines.forEach(function (l) {
      if (l.time !== null) l.time = Math.max(0, l.time + ms);
    });
    shiftVal.value = 0;
    render();
  });

  exportBtn.addEventListener('click', function () {
    var tagged = lines.filter(function (l) { return l.time !== null; });
    if (!tagged.length) { alert('还没有已打轴的歌词行。'); return; }
    var out = tagged
      .sort(function (a, b) { return a.time - b.time; })
      .map(function (l) { return '[' + fmt(l.time) + ']' + l.text; })
      .join('\n');
    TB.download(new Blob(['\ufeff' + out], { type: 'text/plain;charset=utf-8' }), 'lyrics-synced.lrc');
  });

  render();
})();
