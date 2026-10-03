// 文本Diff对比模块
(function () {
  'use strict';

  // 单边约 2000 行以上（左行数 * 右行数）时放弃精确 diff，避免 DP 表过大卡死
  var MAX_CELLS = 4000000;

  var runBtn = document.getElementById('diff-run');
  var trimBox = document.getElementById('diff-trim');
  var caseBox = document.getElementById('diff-ignorecase');
  var summaryEl = document.getElementById('diff-summary');
  var leftEl = document.getElementById('diff-left');
  var rightEl = document.getElementById('diff-right');
  var outputEl = document.getElementById('diff-output');

  if (!runBtn || !summaryEl || !leftEl || !rightEl || !outputEl) {
    return;
  }

  // 是否已经执行过对比（用于勾选项变化时自动重算）
  var hasRun = false;

  // ---------- 工具函数 ----------

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function splitLines(text) {
    if (typeof text !== 'string' || text === '') {
      return [];
    }
    return text.split('\n');
  }

  // 仅用于比较的归一化：不影响显示内容
  function normalizeLine(line) {
    var value = line;
    if (trimBox && trimBox.checked) {
      value = value.replace(/^[\s\uFEFF\xA0]+/, '').replace(/[\s\uFEFF\xA0]+$/, '');
    }
    if (caseBox && caseBox.checked) {
      value = value.toLowerCase();
    }
    return value;
  }

  function buildKeys(lines) {
    var keys = [];
    var i;
    for (i = 0; i < lines.length; i++) {
      keys.push(normalizeLine(lines[i]));
    }
    return keys;
  }

  function sameContent(leftKeys, rightKeys) {
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (var i = 0; i < leftKeys.length; i++) {
      if (leftKeys[i] !== rightKeys[i]) {
        return false;
      }
    }
    return true;
  }

  function createTable(size) {
    var i;
    if (typeof Int32Array === 'function') {
      return new Int32Array(size);
    }
    var table = new Array(size);
    for (i = 0; i < size; i++) {
      table[i] = 0;
    }
    return table;
  }

  // ---------- LCS 动态规划 + 回溯 ----------

  function buildOps(leftKeys, rightKeys) {
    var leftCount = leftKeys.length;
    var rightCount = rightKeys.length;
    var width = rightCount + 1;
    var table = createTable((leftCount + 1) * width);
    var i, j, index, upValue, leftValue;

    // dp[i][j]：left 前 i 行与 right 前 j 行的最长公共子序列长度
    for (i = 1; i <= leftCount; i++) {
      for (j = 1; j <= rightCount; j++) {
        index = i * width + j;
        if (leftKeys[i - 1] === rightKeys[j - 1]) {
          table[index] = table[(i - 1) * width + (j - 1)] + 1;
        } else {
          upValue = table[(i - 1) * width + j];
          leftValue = table[i * width + (j - 1)];
          table[index] = upValue >= leftValue ? upValue : leftValue;
        }
      }
    }

    // 从 dp[m][n] 倒着回溯到 dp[0][0]
    var ops = [];
    i = leftCount;
    j = rightCount;
    while (i > 0 && j > 0) {
      if (leftKeys[i - 1] === rightKeys[j - 1]) {
        ops.push({ type: 'same', left: i - 1, right: j - 1 });
        i = i - 1;
        j = j - 1;
      } else if (table[(i - 1) * width + j] > table[i * width + (j - 1)]) {
        // 当前行不在 LCS 中 -> 删除
        ops.push({ type: 'del', left: i - 1 });
        i = i - 1;
      } else {
        // 当前列不在 LCS 中 -> 新增
        ops.push({ type: 'add', right: j - 1 });
        j = j - 1;
      }
    }
    while (i > 0) {
      ops.push({ type: 'del', left: i - 1 });
      i = i - 1;
    }
    while (j > 0) {
      ops.push({ type: 'add', right: j - 1 });
      j = j - 1;
    }

    // 回溯得到的是倒序，reverse 成从头到尾
    ops.reverse();
    return ops;
  }

  // ---------- 渲染 ----------

  function renderOps(ops, leftLines, rightLines) {
    var html = [];
    var addCount = 0;
    var delCount = 0;
    var sameCount = 0;
    var i, op, text;

    for (i = 0; i < ops.length; i++) {
      op = ops[i];
      if (op.type === 'add') {
        addCount = addCount + 1;
        text = rightLines[op.right];
        html.push('<div class="diff-line diff-add">+ ' + escapeHtml(text) + '</div>');
      } else if (op.type === 'del') {
        delCount = delCount + 1;
        text = leftLines[op.left];
        html.push('<div class="diff-line diff-del">- ' + escapeHtml(text) + '</div>');
      } else {
        sameCount = sameCount + 1;
        text = leftLines[op.left];
        html.push('<div class="diff-line">  ' + escapeHtml(text) + '</div>');
      }
    }

    outputEl.innerHTML = html.join('');
    return { add: addCount, del: delCount, same: sameCount };
  }

  function renderOversize(leftCount, rightCount, identical) {
    outputEl.innerHTML =
      '<div class="diff-line">文本过大，已跳过逐行精确对比，仅显示整体统计</div>' +
      '<div class="diff-line">左侧行数：' + leftCount + '</div>' +
      '<div class="diff-line">右侧行数：' + rightCount + '</div>' +
      '<div class="diff-line">是否完全相同：' + (identical ? '是' : '否') + '</div>';
    summaryEl.textContent = '左侧 ' + leftCount + ' 行 · 右侧 ' + rightCount + ' 行 · ' +
      (identical ? '完全相同' : '存在差异');
  }

  // ---------- 主流程 ----------

  function runDiff() {
    try {
      summaryEl.style.color = '';

      var leftLines = splitLines(leftEl.value);
      var rightLines = splitLines(rightEl.value);

      // 边界：两侧均为空
      if (leftLines.length === 0 && rightLines.length === 0) {
        outputEl.innerHTML = '<div class="diff-line">两侧均为空文本</div>';
        summaryEl.textContent = '';
        hasRun = true;
        return;
      }

      var leftKeys = buildKeys(leftLines);
      var rightKeys = buildKeys(rightLines);

      // 保护：DP 表过大时只做整体统计
      if (leftLines.length * rightLines.length > MAX_CELLS) {
        renderOversize(leftLines.length, rightLines.length, sameContent(leftKeys, rightKeys));
        hasRun = true;
        return;
      }

      var ops = buildOps(leftKeys, rightKeys);
      var stats = renderOps(ops, leftLines, rightLines);

      if (stats.add === 0 && stats.del === 0) {
        summaryEl.textContent = '完全相同 · ' + stats.same + ' 行';
      } else {
        summaryEl.textContent = '新增 ' + stats.add + ' 行 · 删除 ' + stats.del +
          ' 行 · 相同 ' + stats.same + ' 行';
      }

      hasRun = true;
    } catch (err) {
      hasRun = true;
      outputEl.innerHTML = '';
      summaryEl.style.color = '#FB7185';
      summaryEl.textContent = '对比出错: ' + ((err && err.message) ? err.message : String(err));
    }
  }

  // 勾选项变化时，若已经点过对比则自动重算
  function handleOptionChange() {
    if (hasRun) {
      runDiff();
    }
  }

  runBtn.addEventListener('click', function () {
    runDiff();
  });

  if (trimBox) {
    trimBox.addEventListener('change', handleOptionChange);
  }
  if (caseBox) {
    caseBox.addEventListener('change', handleOptionChange);
  }
})();
