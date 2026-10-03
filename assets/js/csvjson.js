/* CSV/JSON/Markdown表格互转模块 */
(function () {
  'use strict';

  /* ==================== 元素与常量 ==================== */
  var fromSel = document.getElementById('cj-from');
  var toSel = document.getElementById('cj-to');
  var headerChk = document.getElementById('cj-header');
  var convertBtn = document.getElementById('cj-convert');
  var copyBtn = document.getElementById('cj-copy');
  var statusEl = document.getElementById('cj-status');
  var inputEl = document.getElementById('cj-input');
  var outputEl = document.getElementById('cj-output');

  var OK_COLOR = '#34D399';
  var ERR_COLOR = '#FB7185';

  var ERR_JSON = '✗ JSON 解析失败: 应为对象数组';
  var ERR_MD = '✗ Markdown 表格格式错误: 缺少表头分隔行';

  /* ==================== 基础工具 ==================== */
  function isArray(value) {
    if (Array.isArray) return Array.isArray(value);
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function ownKeys(obj) {
    var keys = [];
    var k;
    for (k in obj) {
      if (hasOwn(obj, k)) keys.push(k);
    }
    return keys;
  }

  function trim(text) {
    return String(text).replace(/^\s+|\s+$/g, '');
  }

  function isBlank(text) {
    if (text === null || text === undefined) return true;
    return String(text).replace(/\s/g, '') === '';
  }

  function errorText(e, fallback) {
    var msg = '';
    if (e && e.message) msg = String(e.message);
    if (msg.indexOf('✗') === 0) return msg;
    if (msg) return fallback + '（' + msg + '）';
    return fallback;
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = isError ? ERR_COLOR : OK_COLOR;
  }

  function useHeaderRow() {
    if (!headerChk) return true;
    return !!headerChk.checked;
  }

  function colName(index) {
    return '列' + (index + 1);
  }

  function makeHeaders(count) {
    var list = [];
    var i;
    for (i = 0; i < count; i++) list.push(colName(i));
    return list;
  }

  function emptyResult() {
    return { headers: [], rows: [] };
  }

  /* 任意值转成文本（CSV / Markdown 输出用） */
  function valueToText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return String(value);
      }
    }
    return String(value);
  }

  function maxWidthOf(list) {
    var width = 0;
    var i;
    if (!isArray(list)) return 0;
    for (i = 0; i < list.length; i++) {
      if (isArray(list[i]) && list[i].length > width) width = list[i].length;
    }
    return width;
  }

  /* 统一中间结构：补齐表头，保证每个数据行都是数组 */
  function normalizeResult(result) {
    var out = emptyResult();
    var i;
    var width;

    if (result && isArray(result.headers)) out.headers = result.headers.slice(0);
    if (result && isArray(result.rows)) out.rows = result.rows.slice(0);

    width = out.headers.length;
    for (i = 0; i < out.rows.length; i++) {
      if (!isArray(out.rows[i])) out.rows[i] = [out.rows[i]];
      if (out.rows[i].length > width) width = out.rows[i].length;
    }

    for (i = 0; i < width; i++) {
      if (i >= out.headers.length) {
        out.headers.push(colName(i));
      } else if (out.headers[i] === null || out.headers[i] === undefined) {
        out.headers[i] = colName(i);
      } else {
        out.headers[i] = valueToText(out.headers[i]);
      }
    }
    return out;
  }

  /* ==================== CSV 解析 ==================== */
  function parseCsvText(text) {
    var result = emptyResult();
    try {
      if (isBlank(text)) return result;

      var source = String(text);
      var table = [];
      var row = [];
      var field = '';
      var inQuotes = false;
      var i = 0;
      var ch;

      while (i < source.length) {
        ch = source.charAt(i);

        if (inQuotes) {
          if (ch === '"') {
            if (source.charAt(i + 1) === '"') {
              field += '"';
              i += 2;
            } else {
              inQuotes = false;
              i += 1;
            }
          } else {
            field += ch;
            i += 1;
          }
          continue;
        }

        if (ch === '"') {
          inQuotes = true;
          i += 1;
          continue;
        }
        if (ch === ',') {
          row.push(field);
          field = '';
          i += 1;
          continue;
        }
        if (ch === '\r') {
          row.push(field);
          field = '';
          table.push(row);
          row = [];
          i += (source.charAt(i + 1) === '\n') ? 2 : 1;
          continue;
        }
        if (ch === '\n') {
          row.push(field);
          field = '';
          table.push(row);
          row = [];
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
      }
      /* 最后一行没有换行符结尾时补上 */
      if (field !== '' || row.length > 0) {
        row.push(field);
        table.push(row);
      }

      if (table.length === 0) return result;

      if (useHeaderRow()) {
        result.headers = table[0].slice(0);
        result.rows = table.slice(1);
      } else {
        result.headers = makeHeaders(maxWidthOf(table));
        result.rows = table.slice(0);
      }
      return result;
    } catch (e) {
      throw new Error(errorText(e, '✗ CSV 解析失败'));
    }
  }

  /* ==================== JSON 解析 ==================== */
  function parseJsonText(text) {
    var result = emptyResult();
    try {
      if (isBlank(text)) return result;

      var data = null;
      var parsed = true;
      try {
        data = JSON.parse(String(text));
      } catch (e0) {
        parsed = false;
      }
      if (!parsed || !isArray(data)) throw new Error(ERR_JSON);
      if (data.length === 0) return result;

      var i, j, k;
      var item;
      var hasArray = false;
      var hasObject = false;
      var hasOther = false;

      for (i = 0; i < data.length; i++) {
        item = data[i];
        if (isArray(item)) {
          hasArray = true;
        } else if (item !== null && typeof item === 'object') {
          hasObject = true;
        } else {
          hasOther = true;
        }
      }

      var mode = '';
      if (!hasOther) {
        if (hasArray && hasObject) {
          mode = isArray(data[0]) ? 'array' : 'object';
        } else if (hasArray) {
          mode = 'array';
        } else if (hasObject) {
          mode = 'object';
        }
      }
      if (mode === '') throw new Error(ERR_JSON);

      /* 纯二维数组：第一个子数组长度决定列数 */
      if (mode === 'array') {
        var cols = data[0].length;
        if (!cols) cols = maxWidthOf(data);
        result.headers = makeHeaders(cols);
        result.rows = [];
        for (i = 0; i < data.length; i++) result.rows.push(data[i].slice(0));
        return result;
      }

      /* 对象数组：收集出现过的所有 key（先第一个对象的顺序，后出现的新 key 追加） */
      var headers = [];
      var seen = {};
      var keys;
      for (i = 0; i < data.length; i++) {
        keys = ownKeys(data[i]);
        for (j = 0; j < keys.length; j++) {
          k = keys[j];
          if (!hasOwn(seen, k)) {
            seen[k] = true;
            headers.push(k);
          }
        }
      }

      var rows = [];
      var row;
      for (i = 0; i < data.length; i++) {
        row = [];
        for (j = 0; j < headers.length; j++) {
          k = headers[j];
          row.push(hasOwn(data[i], k) ? data[i][k] : '');
        }
        rows.push(row);
      }
      result.headers = headers;
      result.rows = rows;
      return result;
    } catch (e) {
      throw new Error(errorText(e, ERR_JSON));
    }
  }

  /* ==================== Markdown 表格解析 ==================== */
  /* Markdown 表格语法自带表头行，因此第一行始终作为 headers */
  function splitMdRow(line) {
    var placeholder = '\u0001';
    var s = String(line === null || line === undefined ? '' : line);
    s = s.replace(/\\\|/g, placeholder);
    s = trim(s);
    if (s.charAt(0) === '|') s = s.substring(1);
    if (s.length > 0 && s.charAt(s.length - 1) === '|') s = s.substring(0, s.length - 1);

    var parts = s.split('|');
    var out = [];
    var i;
    for (i = 0; i < parts.length; i++) {
      out.push(trim(parts[i]).split(placeholder).join('|'));
    }
    return out;
  }

  function isMdSeparatorLine(line) {
    var s = trim(line);
    if (s === '') return false;
    if (s.indexOf('-') === -1) return false;
    /* 只允许 - : 空格 | 组成的行，兼容 :---: / --- / ---|--- 等对齐写法 */
    return /^[\s\-:|]+$/.test(s);
  }

  function parseMdText(text) {
    var result = emptyResult();
    try {
      if (isBlank(text)) return result;

      var raw = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      var lines = [];
      var i;
      for (i = 0; i < raw.length; i++) {
        if (raw[i].replace(/\s/g, '') !== '') lines.push(raw[i]);
      }
      if (lines.length === 0) return result;
      if (lines.length < 2 || !isMdSeparatorLine(lines[1])) throw new Error(ERR_MD);

      result.headers = splitMdRow(lines[0]);
      result.rows = [];
      for (i = 2; i < lines.length; i++) result.rows.push(splitMdRow(lines[i]));
      return result;
    } catch (e) {
      throw new Error(errorText(e, ERR_MD));
    }
  }

  /* ==================== CSV 生成 ==================== */
  function csvCell(value) {
    var s = valueToText(value);
    if (/[",\r\n]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function csvLine(cells) {
    var parts = [];
    var i;
    for (i = 0; i < cells.length; i++) parts.push(csvCell(cells[i]));
    return parts.join(',');
  }

  function genCsvText(result, withHeader) {
    try {
      if (!result) return '';
      if (result.headers.length === 0 && result.rows.length === 0) return '';

      var lines = [];
      var i;
      if (withHeader && result.headers.length > 0) lines.push(csvLine(result.headers));
      for (i = 0; i < result.rows.length; i++) lines.push(csvLine(result.rows[i]));
      return lines.join('\n');
    } catch (e) {
      throw new Error(errorText(e, '✗ CSV 生成失败'));
    }
  }

  /* ==================== JSON 生成 ==================== */
  function genJsonText(result) {
    try {
      if (!result) return '[]';
      var headers = result.headers;
      var out = [];
      var i, j;
      var row;
      var obj;
      for (i = 0; i < result.rows.length; i++) {
        row = result.rows[i];
        obj = {};
        for (j = 0; j < headers.length; j++) {
          /* 缺失的列补空字符串；null / 数字 / 嵌套对象等原始值保持原样 */
          obj[headers[j]] = (row[j] === undefined) ? '' : row[j];
        }
        out.push(obj);
      }
      return JSON.stringify(out, null, 2);
    } catch (e) {
      throw new Error(errorText(e, '✗ JSON 生成失败'));
    }
  }

  /* ==================== Markdown 表格生成 ==================== */
  function mdCell(value) {
    return valueToText(value).replace(/\|/g, '\\|');
  }

  function mdLine(cells) {
    var parts = [];
    var i;
    for (i = 0; i < cells.length; i++) parts.push(mdCell(cells[i]));
    return '| ' + parts.join(' | ') + ' |';
  }

  function genMdText(result) {
    try {
      if (!result) return '';
      var headers = result.headers.length > 0 ? result.headers : makeHeaders(maxWidthOf(result.rows));
      if (headers.length === 0 && result.rows.length === 0) return '';

      var lines = [];
      var i, j;
      var row;
      lines.push(mdLine(headers));
      lines.push(mdLine(makeSeparators(headers.length)));
      for (i = 0; i < result.rows.length; i++) {
        row = [];
        for (j = 0; j < headers.length; j++) {
          row.push(j < result.rows[i].length ? result.rows[i][j] : '');
        }
        lines.push(mdLine(row));
      }
      return lines.join('\n');
    } catch (e) {
      throw new Error(errorText(e, '✗ Markdown 表格生成失败'));
    }
  }

  function makeSeparators(count) {
    var list = [];
    var i;
    for (i = 0; i < count; i++) list.push('---');
    return list;
  }

  /* ==================== 主转换流程 ==================== */
  function doConvert() {
    try {
      if (!inputEl || !outputEl) {
        setStatus('✗ 页面缺少必要的输入或输出元素', true);
        return;
      }

      var from = fromSel ? String(fromSel.value) : 'csv';
      var to = toSel ? String(toSel.value) : 'json';
      var text = (inputEl.value === null || inputEl.value === undefined) ? '' : String(inputEl.value);

      var parsed;
      if (from === 'csv') {
        parsed = parseCsvText(text);
      } else if (from === 'json') {
        parsed = parseJsonText(text);
      } else if (from === 'md') {
        parsed = parseMdText(text);
      } else {
        outputEl.value = '';
        setStatus('✗ 不支持的输入格式: ' + from, true);
        return;
      }

      var result = normalizeResult(parsed);

      var out;
      if (to === 'csv') {
        out = genCsvText(result, useHeaderRow());
      } else if (to === 'json') {
        out = genJsonText(result);
      } else if (to === 'md') {
        out = genMdText(result);
      } else {
        outputEl.value = '';
        setStatus('✗ 不支持的目标格式: ' + to, true);
        return;
      }

      outputEl.value = out;
      setStatus('✓ 转换成功，共 ' + result.rows.length + ' 行 ' + result.headers.length + ' 列', false);
    } catch (e) {
      try {
        if (outputEl) outputEl.value = '';
      } catch (e2) { /* 忽略清空失败 */ }
      setStatus(errorText(e, '✗ 转换失败'), true);
    }
  }

  /* ==================== 复制结果 ==================== */
  function doCopy(btn) {
    try {
      var text = outputEl ? String(outputEl.value) : '';
      if (text === '') return;
      if (window.TB && typeof window.TB.copy === 'function') {
        window.TB.copy(text, btn || copyBtn);
      } else {
        setStatus('✗ 复制功能不可用', true);
      }
    } catch (e) {
      setStatus(errorText(e, '✗ 复制失败'), true);
    }
  }

  /* ==================== 事件绑定 ==================== */
  function bind(el, type, handler) {
    if (el && el.addEventListener) el.addEventListener(type, handler, false);
  }

  try {
    bind(convertBtn, 'click', function () {
      doConvert();
    });
    bind(copyBtn, 'click', function () {
      doCopy(this);
    });
  } catch (e) {
    setStatus(errorText(e, '✗ 初始化失败'), true);
  }
})();
