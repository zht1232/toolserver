/* 歌词工具：
 * 1. 歌词自动匹配 - 双歌词源：
 *    a. 本站中转（server.py 提供的 /api/nc/* 网易云接口，需用自带服务器启动）
 *    b. LRCLIB 开放歌词库（浏览器直连，纯静态托管时的兜底）
 * 2. LRC 时间轴偏移 / 去时间轴 / 下载
 */
(function () {
  'use strict';

  /* ================= 歌词自动匹配 ================= */

  var songInput = document.getElementById('lyrics-song');
  var artistInput = document.getElementById('lyrics-artist');
  var searchBtn = document.getElementById('lyrics-search');
  var status = document.getElementById('lyrics-status');
  var resultsBox = document.getElementById('lyrics-results');
  var fileInput = document.getElementById('lyrics-file');
  var fileNameSpan = document.getElementById('lyrics-file-name');

  var proxyAvailable = null; // null=未检测
  var matchCache = {};

  function setStatus(msg, isErr) {
    status.textContent = msg;
    status.style.color = isErr ? '#c20c0c' : '';
  }

  // 检测本站是否由 server.py 提供服务（支持 /api/nc/* 中转）
  async function detectProxy() {
    if (proxyAvailable !== null) return proxyAvailable;
    try {
      var r = await fetch('api/ping', { method: 'GET' });
      proxyAvailable = r.ok && (await r.json()).ok === true;
    } catch (e) {
      proxyAvailable = false;
    }
    return proxyAvailable;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- 歌词源 A：本站中转（网易云） ---- */
  async function searchNetease(song, artist) {
    var keyword = artist ? song + ' ' + artist : song;
    var r = await fetch('api/nc/search?s=' + encodeURIComponent(keyword));
    if (!r.ok) throw new Error(r.status === 429 ? '网易云暂时限流' : '中转搜索失败');
    var data = await r.json();
    if (data.code && data.code !== 200) {
      throw new Error('网易云暂时限流：' + (data.msg || data.message || ('HTTP ' + data.code)));
    }
    var songs = (data.result && data.result.songs) || [];
    if (!songs.length) throw new Error('网易云没有搜索结果');
    return songs.slice(0, 15).map(function (s) {
      return {
        source: 'netease',
        id: s.id,
        name: s.name,
        artist: (s.artists || []).map(function (a) { return a.name; }).join('/'),
        album: s.album ? s.album.name : '',
        duration: s.duration || 0
      };
    });
  }

  async function fetchNeteaseLyric(id) {
    var r = await fetch('api/nc/lyric?id=' + id);
    if (!r.ok) throw new Error('歌词获取失败');
    var data = await r.json();
    var lrc = data.lrc && data.lrc.lyric ? data.lrc.lyric : '';
    var tlrc = data.tlyric && data.tlyric.lyric ? data.tlyric.lyric : '';
    return { synced: lrc, translated: tlrc };
  }

  /* ---- 歌词源 B：LRCLIB（浏览器直连） ---- */
  async function searchLrclib(song, artist) {
    var url = 'https://lrclib.net/api/search?track_name=' + encodeURIComponent(song);
    if (artist) url += '&artist_name=' + encodeURIComponent(artist);
    var r = await fetch(url);
    if (!r.ok) throw new Error('LRCLIB 搜索失败（HTTP ' + r.status + '）');
    var data = await r.json();
    if (!Array.isArray(data)) throw new Error('LRCLIB 返回内容异常');
    return data.slice(0, 10).map(function (s) {
      return {
        source: 'lrclib',
        id: s.id,
        name: s.trackName,
        artist: s.artistName || '',
        album: s.albumName || '',
        duration: (s.duration || 0) * 1000,
        _raw: s
      };
    });
  }

  function fmtDuration(ms) {
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function renderResults(items, song) {
    resultsBox.innerHTML = '';
    if (!items.length) {
      setStatus('没有找到匹配的歌词，试试只输入歌曲名，或检查拼写。', true);
      return;
    }
    setStatus('找到 ' + items.length + ' 条结果（来源：' +
      (items[0].source === 'netease' ? '网易云音乐 · 本站中转' : 'LRCLIB 开放歌词库') + '），点击加载歌词：');
    items.forEach(function (it) {
      var div = document.createElement('div');
      div.className = 'lyric-item';
      div.innerHTML =
        '<div class="title">' + escapeHtml(it.name) + '</div>' +
        '<div class="sub">' + escapeHtml(it.artist) +
        (it.album ? ' · ' + escapeHtml(it.album) : '') +
        (it.duration ? ' · ' + fmtDuration(it.duration) : '') + '</div>' +
        '<div class="actions-row"><button class="btn primary">加载歌词</button></div>' +
        '<div class="lyric-body"></div>';
      div.querySelector('button').addEventListener('click', async function () {
        var body = div.querySelector('.lyric-body');
        body.innerHTML = '<div class="muted">加载中…</div>';
        try {
          var lyric;
          if (it.source === 'netease') {
            var d = await fetchNeteaseLyric(it.id);
            lyric = d.translated ? mergeLyrics(d.synced, d.translated) : d.synced;
          } else {
            lyric = it._raw.syncedLyrics || it._raw.plainLyrics || '';
          }
          if (!lyric) { body.innerHTML = '<div class="muted">该歌曲暂无同步歌词。</div>'; return; }
          showLyric(body, lyric, it);
        } catch (e) {
          body.innerHTML = '<div class="muted" style="color:#c20c0c">' + escapeHtml(e.message) + '</div>';
        }
      });
      resultsBox.appendChild(div);
    });
  }

  // 合并原文+翻译为双语 LRC（相同时间戳的相邻排列）
  function mergeLyrics(lrc, tlrc) {
    var lines = [];
    [lrc, tlrc].forEach(function (text, pass) {
      text.split(/\r?\n/).forEach(function (line) {
        var m = line.match(/^(\[[\d:.\]]+\])(.*)$/);
        if (!m || !m[2].trim()) return;
        var t = parseTime(m[1]);
        if (t === null) return;
        lines.push({ t: t, tag: m[1], text: m[2], pass: pass });
      });
    });
    lines.sort(function (a, b) { return a.t - b.t || a.pass - b.pass; });
    return lines.map(function (l) { return l.tag + l.text; }).join('\n');
  }

  function parseTime(tag) {
    var m = tag.match(/\[(\d+):(\d+(?:\.\d+)?)\]/);
    if (!m) return null;
    return Math.round((parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000);
  }

  function showLyric(body, lyric, it) {
    var fileName = TB.safeName(it.name + (it.artist ? ' - ' + it.artist : '')) + '.lrc';
    body.innerHTML =
      '<div class="lyric-preview">' + escapeHtml(lyric.slice(0, 3000)) + '</div>' +
      '<div class="actions-row" style="display:flex;gap:8px">' +
      '<button class="btn primary" data-act="dl">⬇ 下载 ' + escapeHtml(fileName) + '</button>' +
      '<button class="btn" data-act="copy">复制歌词</button></div>';
    body.querySelector('[data-act="dl"]').addEventListener('click', function () {
      TB.download(new Blob(['﻿' + lyric], { type: 'text/plain;charset=utf-8' }), fileName);
    });
    body.querySelector('[data-act="copy"]').addEventListener('click', function (e) {
      TB.copy(lyric, e.target);
    });
  }

  /* 供其它模块（如音乐解密页）复用的歌词检索接口：
   * 传入歌名/歌手，返回统一结构的候选列表；内部已处理中转优先、LRCLIB 兜底。
   * 返回的每一项可直接传给 LyricsTool.fetchLyric 取同步歌词文本。
   */
  async function searchLyricCandidates(song, artist) {
    if (!song) return [];
    var all = [];
    var seen = {};
    var errors = [];
    var attempted = 0;
    function append(items) {
      (items || []).forEach(function (item) {
        var key = String(item.name || '').toLowerCase() + '|' + String(item.artist || '').toLowerCase();
        if (!seen[key]) { seen[key] = true; all.push(item); }
      });
    }
    if (await detectProxy()) {
      attempted++;
      try { append(await searchNetease(song, artist)); } catch (e) { errors.push(e.message); }
    }
    attempted++;
    try { append(await searchLrclib(song, artist)); } catch (e) { errors.push(e.message); }
    if (!all.length && errors.length === attempted) throw new Error(errors.join('；'));
    return all;
  }

  async function matchLyric(song, artist) {
    var cacheKey = String(song || '').trim().toLowerCase() + '|' + String(artist || '').trim().toLowerCase();
    if (matchCache[cacheKey]) return matchCache[cacheKey];
    var candidates = [], errors = [], sources = [];
    if (await detectProxy()) sources.push({ name: '网易云', search: function () { return searchNetease(song, artist); } });
    sources.push({ name: 'LRCLIB', search: function () { return searchLrclib(song, artist); } });
    for (var s = 0; s < sources.length; s++) {
      var found;
      try { found = await sources[s].search(); }
      catch (searchError) { errors.push(sources[s].name + '搜索失败：' + searchError.message); continue; }
      candidates = candidates.concat(found || []);
      for (var i = 0; i < found.length; i++) {
        try {
          var lyric = await fetchLyricText(found[i]);
          if (lyric && lyric.trim()) {
            var matched = { item: found[i], lyric: lyric, candidates: candidates };
            matchCache[cacheKey] = matched;
            return matched;
          }
        } catch (fetchError) { errors.push(sources[s].name + '歌词读取失败：' + fetchError.message); }
      }
    }
    if (!candidates.length && errors.length === sources.length) throw new Error(errors.join('；'));
    var empty = { item: candidates[0] || null, lyric: '', candidates: candidates };
    matchCache[cacheKey] = empty;
    return empty;
  }

  async function fetchLyricText(item) {
    if (item.source === 'netease') {
      var d = await fetchNeteaseLyric(item.id);
      return d.translated ? mergeLyrics(d.synced, d.translated) : d.synced;
    }
    return (item._raw && (item._raw.syncedLyrics || item._raw.plainLyrics)) || '';
  }

  window.LyricsTool = {
    search: searchLyricCandidates,
    match: matchLyric,
    fetchLyric: fetchLyricText,
    safeLrcName: function (name, artist) {
      return TB.safeName(name + (artist ? ' - ' + artist : '')) + '.lrc';
    }
  };

  searchBtn.addEventListener('click', async function () {
    var song = songInput.value.trim();
    var artist = artistInput.value.trim();
    if (!song) { setStatus('请输入歌曲名。', true); return; }
    setStatus('搜索中…');
    resultsBox.innerHTML = '';
    try {
      var items;
      if (await detectProxy()) {
        items = await searchNetease(song, artist);
      } else {
        items = await searchLrclib(song, artist);
      }
      renderResults(items, song);
    } catch (e) {
      // 中转失败时兜底 LRCLIB
      try {
        var items2 = await searchLrclib(song, artist);
        renderResults(items2, song);
      } catch (e2) {
        setStatus('搜索失败：' + e.message + '；备用源也失败：' + e2.message, true);
      }
    }
  });
  songInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchBtn.click(); });
  artistInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchBtn.click(); });

  // 使用音乐页选定的文件名顺序填入歌名与歌手。
  fileInput.addEventListener('change', function () {
    var f = fileInput.files[0];
    if (!f) return;
    var base = f.name.replace(/\.[^.]+$/, '');
    fileNameSpan.textContent = f.name;
    var orderInput = document.getElementById('lyrics-file-order');
    var order = orderInput ? orderInput.value : 'artist-title';
    var splitAt = order === 'artist-title' ? base.indexOf(' - ') : base.lastIndexOf(' - ');
    if (order !== 'title' && splitAt >= 0) {
      if (order === 'artist-title') {
        artistInput.value = base.slice(0, splitAt).trim();
        songInput.value = base.slice(splitAt + 3).trim();
      } else {
        songInput.value = base.slice(0, splitAt).trim();
        artistInput.value = base.slice(splitAt + 3).trim();
      }
    } else {
      songInput.value = base.trim();
      artistInput.value = '';
    }
    fileInput.value = '';
  });

  /* ================= LRC 时间轴工具 ================= */

  var lrcInput = document.getElementById('lrc-input');
  var lrcOutput = document.getElementById('lrc-output');
  var lrcFile = document.getElementById('lrc-file');

  lrcFile.addEventListener('change', async function () {
    var f = lrcFile.files[0];
    if (!f) return;
    lrcInput.value = await f.text();
    lrcFile.value = '';
  });

  function shiftLrc(text, offsetMs) {
    return text.split(/\r?\n/).map(function (line) {
      return line.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, function (_, mm, ss) {
        var ms = Math.round((parseInt(mm, 10) * 60 + parseFloat(ss)) * 1000) + offsetMs;
        if (ms < 0) ms = 0;
        var m2 = Math.floor(ms / 60000);
        var s2 = (ms % 60000) / 1000;
        return '[' + ('0' + m2).slice(-2) + ':' + (s2 < 10 ? '0' : '') + s2.toFixed(2) + ']';
      });
    }).join('\n');
  }

  document.getElementById('lrc-apply').addEventListener('click', function () {
    var offset = parseInt(document.getElementById('lrc-offset').value, 10);
    if (isNaN(offset) || offset === 0) { alert('请先填写非零的偏移毫秒数。'); return; }
    if (!lrcInput.value.trim()) { alert('请先粘贴或导入歌词。'); return; }
    lrcOutput.value = shiftLrc(lrcInput.value, offset);
  });

  document.getElementById('lrc-strip').addEventListener('click', function () {
    var text = (lrcOutput.value || lrcInput.value).trim();
    if (!text) { alert('请先粘贴或导入歌词。'); return; }
    var out = text.split(/\r?\n/)
      .map(function (l) { return l.replace(/\[[^\]]*\]/g, '').trim(); })
      .filter(function (l) { return l; })
      .join('\n');
    lrcOutput.value = out;
  });

  document.getElementById('lrc-download').addEventListener('click', function () {
    var text = lrcOutput.value || lrcInput.value;
    if (!text.trim()) { alert('没有可下载的内容。'); return; }
    var isLrc = /\[\d+:\d+/.test(text);
    TB.download(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }),
      'lyrics.' + (isLrc ? 'lrc' : 'txt'));
  });

  document.getElementById('lrc-copy').addEventListener('click', function (e) {
    var text = lrcOutput.value || lrcInput.value;
    if (text.trim()) TB.copy(text, e.target);
  });
})();
