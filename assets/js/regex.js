/* 正则表达式测试器模块 —— 纯原生JS，无依赖 */
(function () {
  'use strict';

  /* ---------- 元素引用 ---------- */
  var patternInput = document.getElementById('regex-pattern');
  var flagsInput = document.getElementById('regex-flags');
  var presetsSelect = document.getElementById('regex-presets');
  var statusEl = document.getElementById('regex-status');
  var inputArea = document.getElementById('regex-input');
  var highlightEl = document.getElementById('regex-highlight');
  var countEl = document.getElementById('regex-count');
  var matchesEl = document.getElementById('regex-matches');

  /* 元素不存在时静默退出，避免初始状态报错 */
  if (!patternInput || !inputArea) {
    return;
  }

  var COLOR_OK = '#34D399';
  var COLOR_ERR = '#FB7185';
  var MAX_MATCHES = 5000;
  var debounceTimer = null;

  /* ---------- 工具函数 ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function debounce(fn, wait) {
    return function () {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        fn();
      }, wait);
    };
  }

  function setStatus(text, color) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = text;
    statusEl.style.color = color || '';
  }

  function clearOutput() {
    if (highlightEl) {
      highlightEl.innerHTML = '';
    }
    if (matchesEl) {
      matchesEl.innerHTML = '';
    }
    if (countEl) {
      countEl.textContent = '0 处';
    }
  }

  /* 收集匹配结果：返回 { list: [...], truncated: bool } */
  function collectMatches(re) {
    var text = inputArea.value;
    var list = [];
    var truncated = false;
    var global = re.global;
    var m;

    try {
      if (!global) {
        m = re.exec(text);
        if (m) {
          list.push({
            index: m.index,
            end: m.index + m[0].length,
            value: m[0],
            groups: m.slice(1)
          });
        }
        return { list: list, truncated: false };
      }

      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        list.push({
          index: m.index,
          end: m.index + m[0].length,
          value: m[0],
          groups: m.slice(1)
        });
        if (list.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        /* 空匹配（如 a*）防死循环：手动推进 lastIndex */
        if (m[0] === '') {
          re.lastIndex = re.lastIndex + 1;
        }
      }
    } catch (e) {
      return { list: list, truncated: truncated };
    }
    return { list: list, truncated: truncated };
  }

  /* 高亮渲染：按匹配位置切分文本，交替两种 mark class */
  function renderHighlight(text, list) {
    if (!highlightEl) {
      return;
    }
    if (!list.length) {
      highlightEl.innerHTML = escapeHtml(text);
      return;
    }
    var html = '';
    var cursor = 0;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var start = item.index;
      var end = item.end;
      if (start < cursor) {
        continue; /* 重叠匹配理论上不会出现，防御性跳过 */
      }
      html += escapeHtml(text.slice(cursor, start));
      html += '<span class="' + (i % 2 === 0 ? 'regex-mark' : 'regex-mark alt') + '">' +
        escapeHtml(text.slice(start, end)) + '</span>';
      cursor = end;
    }
    html += escapeHtml(text.slice(cursor));
    highlightEl.innerHTML = html;
  }

  /* 匹配列表渲染 */
  function renderMatches(list) {
    if (!matchesEl) {
      return;
    }
    if (!list.length) {
      matchesEl.innerHTML = '<div class="muted">没有匹配</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      html += '<div class="filerow">';
      html += '<div class="muted mono">#' + (i + 1) + ' · index ' + item.index +
        ' · 长度 ' + item.value.length + '</div>';
      html += '<div><code class="mono">' + escapeHtml(item.value) + '</code></div>';
      if (item.groups && item.groups.length) {
        for (var g = 0; g < item.groups.length; g++) {
          var gv = item.groups[g];
          html += '<div class="muted mono">group ' + (g + 1) + ': ' +
            (gv === undefined ? '(未参与匹配)' : escapeHtml(gv)) + '</div>';
        }
      }
      html += '</div>';
    }
    matchesEl.innerHTML = html;
  }

  /* ---------- 主流程 ---------- */
  function update() {
    var pattern = patternInput ? patternInput.value : '';
    var flags = flagsInput ? flagsInput.value : '';
    var text = inputArea.value;

    /* 空 pattern：显示原文，不高亮 */
    if (pattern === '') {
      setStatus('', '');
      clearOutput();
      if (highlightEl) {
        highlightEl.innerHTML = text === '' ? '' : escapeHtml(text);
      }
      return;
    }

    setStatus('', '');

    var re;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      setStatus('正则语法错误: ' + (e && e.message ? e.message : String(e)), COLOR_ERR);
      clearOutput();
      if (highlightEl) {
        highlightEl.innerHTML = text === '' ? '' : escapeHtml(text);
      }
      return;
    }

    /* 构造成功但文本为空：仅提示有效 */
    if (text === '') {
      setStatus('✓ 正则有效', COLOR_OK);
      clearOutput();
      if (highlightEl) {
        highlightEl.innerHTML = '';
      }
      return;
    }

    setStatus('✓ 正则有效', COLOR_OK);

    var result;
    try {
      result = collectMatches(re);
    } catch (e) {
      setStatus('匹配出错: ' + (e && e.message ? e.message : String(e)), COLOR_ERR);
      clearOutput();
      if (highlightEl) {
        highlightEl.innerHTML = escapeHtml(text);
      }
      return;
    }

    var list = result.list;
    if (result.truncated) {
      setStatus('✓ 正则有效（结果过多，仅显示前 ' + MAX_MATCHES + ' 条）', COLOR_OK);
    }

    renderHighlight(text, list);
    renderMatches(list);
    if (countEl) {
      countEl.textContent = list.length + ' 处';
    }
  }

  var debouncedUpdate = debounce(update, 150);

  /* ---------- 事件绑定 ---------- */
  patternInput.addEventListener('input', debouncedUpdate);
  inputArea.addEventListener('input', debouncedUpdate);
  if (flagsInput) {
    flagsInput.addEventListener('input', debouncedUpdate);
  }

  if (presetsSelect) {
    presetsSelect.addEventListener('change', function () {
      var value = presetsSelect.value;
      if (!value) {
        return;
      }
      patternInput.value = value;
      update();
    });
  }

  /* 初始化：无任何输入时不报错，仅保证状态区干净 */
  try {
    update();
  } catch (e) {
    setStatus('初始化失败: ' + (e && e.message ? e.message : String(e)), COLOR_ERR);
  }
})();
