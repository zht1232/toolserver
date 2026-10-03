/* 歌词工具：
 * 1. 歌词自动匹配 - LRCLIB 优先（搜索直接返回歌词），本站网易云中转兜底；
 *    单曲手动搜索仍以网易云结果优先展示。
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
  var proxyPromise = null;
  var matchCache = {};
  var matchPending = {};
  var neteaseSearchTail = Promise.resolve();
  var neteasePausedUntil = 0;

  function setStatus(msg, isErr) {
    status.textContent = msg;
    status.style.color = isErr ? '#c20c0c' : '';
  }

  // 检测本站是否由 server.py 提供服务（支持 /api/nc/* 中转）
  async function detectProxy() {
    if (proxyAvailable !== null) return Promise.resolve(proxyAvailable);
    if (proxyPromise) return proxyPromise;
    proxyPromise = (async function () {
      try {
        var r = await fetch('api/ping', { method: 'GET' });
        proxyAvailable = r.ok && (await r.json()).ok === true;
      } catch (e) {
        proxyAvailable = false;
      }
      return proxyAvailable;
    })();
    try { return await proxyPromise; }
    finally { proxyPromise = null; }
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
    if (!r.ok) {
      if (r.status === 429) neteasePausedUntil = Date.now() + 60000;
      throw new Error(r.status === 429 ? '网易云暂时限流' : '中转搜索失败');
    }
    var data = await r.json();
    if (data.code && data.code !== 200) {
      if (data.code === 405 || data.code === 429) neteasePausedUntil = Date.now() + 60000;
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
    return data.slice(0, 20).map(function (s) {
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

  function normalizeMatchText(value) {
    var text = String(value || '').toLowerCase();
    try { text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* Older engines may not implement normalize. */ }
    return text.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/\b(?:remix|mix|edit|featuring|feat|ft)\b.*$/, ' ')
      .replace(/\b(?:remaster(?:ed)?|version|radio edit|single edit|album edit|official audio|lyrics)\b/g, ' ')
      .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim();
  }

  function textSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
    var left = a.split(/\s+/), right = b.split(/\s+/), leftSet = {}, rightSet = {}, common = 0;
    left.forEach(function (word) { leftSet[word] = true; });
    right.forEach(function (word) { rightSet[word] = true; });
    left.forEach(function (word) { if (rightSet[word]) common++; });
    var total = Object.keys(leftSet).length + Object.keys(rightSet).length - common;
    return total ? common / total : 0;
  }

  function candidateScore(song, artist, item) {
    var titleScore = textSimilarity(normalizeMatchText(song), normalizeMatchText(item.name));
    var artistScore = artist ? textSimilarity(normalizeMatchText(artist), normalizeMatchText(item.artist)) : 1;
    return { title: titleScore, total: titleScore * 0.82 + artistScore * 0.18 };
  }

  function bestLrclibCandidate(song, artist, candidates) {
    var ranked = [];
    (candidates || []).forEach(function (item) {
      var lyric = item._raw && (item._raw.syncedLyrics || item._raw.plainLyrics);
      if (!lyric || !lyric.trim()) return;
      var score = candidateScore(song, artist, item);
      if (score.title < 0.5 || score.total < 0.55) return;
      ranked.push({ item: item, lyric: lyric, score: score.total });
    });
    ranked.sort(function (a, b) { return b.score - a.score; });
    return ranked[0] || null;
  }

  function searchNeteaseForMatch(song, artist) {
    var task = neteaseSearchTail.then(function () {
      if (Date.now() < neteasePausedUntil) throw new Error('网易云暂时限流，正在冷却；已优先尝试 LRCLIB');
      return searchNetease(song, artist);
    });
    neteaseSearchTail = task.then(function () { return null; }, function () { return null; });
    return task;
  }

  async function matchLyric(song, artist) {
    var cacheKey = normalizeMatchText(song) + '|' + normalizeMatchText(artist);
    if (matchCache[cacheKey]) return matchCache[cacheKey];
    if (matchPending[cacheKey]) return matchPending[cacheKey];
    matchPending[cacheKey] = (async function () {
      var candidates = [], errors = [];

      // LRCLIB returns lyrics with its search results, so a successful match
      // takes one request instead of a search plus a separate lyric request.
      try {
        var lrclib = await searchLrclib(song, artist);
        candidates = candidates.concat(lrclib || []);
        var best = bestLrclibCandidate(song, artist, lrclib);
        if (best) return { item: best.item, lyric: best.lyric, candidates: candidates, source: 'lrclib' };
      } catch (searchError) { errors.push('LRCLIB 搜索失败：' + searchError.message); }

      // Only ask NetEase when LRCLIB has no credible lyric. Queue this fallback
      // and open a 60-second circuit after an upstream 429/405 response.
      if (await detectProxy() && Date.now() >= neteasePausedUntil) {
        try {
          var netease = await searchNeteaseForMatch(song, artist);
          candidates = candidates.concat(netease || []);
          netease.sort(function (a, b) {
            return candidateScore(song, artist, b).total - candidateScore(song, artist, a).total;
          });
          for (var i = 0; i < netease.length; i++) {
            try {
              var lyric = await fetchLyricText(netease[i]);
              if (lyric && lyric.trim()) return { item: netease[i], lyric: lyric, candidates: candidates, source: 'netease' };
            } catch (fetchError) { errors.push('网易云歌词读取失败：' + fetchError.message); }
          }
        } catch (searchError) { errors.push('网易云搜索失败：' + searchError.message); }
      }

      if (!candidates.length && errors.length) throw new Error(errors.join('；'));
      return { item: candidates[0] || null, lyric: '', candidates: candidates };
    })().then(function (matched) {
      matchCache[cacheKey] = matched;
      return matched;
    }).finally(function () {
      delete matchPending[cacheKey];
    });
    return matchPending[cacheKey];
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
