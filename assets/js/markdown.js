// Markdown实时预览模块（内置轻量Markdown解析器）
(function () {
  'use strict';

  var TOKEN = '\u0001';
  var MAX_DEPTH = 8;

  /* ================= 通用工具 ================= */

  function trim(text) {
    return String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
  }

  // 把所有可能形成标签的字符转义掉，后续只替换成自己生成的标签
  function escapeHtml(text) {
    var str = String(text == null ? '' : text);
    str = str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    str = str.replace(/&/g, '&amp;');
    str = str.replace(/</g, '&lt;');
    str = str.replace(/>/g, '&gt;');
    str = str.replace(/"/g, '&quot;');
    str = str.replace(/'/g, '&#39;');
    return str;
  }

  var SAFE_SCHEMES = {
    'http:': 1,
    'https:': 1,
    'mailto:': 1,
    'tel:': 1,
    'ftp:': 1,
    'ftps:': 1
  };

  // 基础 URL 校验：剔除控制字符与引号，只允许 http/https/mailto/tel/ftp 与相对地址
  function sanitizeUrl(url) {
    var cleaned = String(url == null ? '' : url);
    cleaned = cleaned.replace(/[\u0000-\u0020\u007f\u2000-\u200f\u2028\u2029\ufeff]/g, '');
    cleaned = cleaned.replace(/[<>"`\\]/g, '');
    if (cleaned === '') {
      return '';
    }
    var lower = cleaned.toLowerCase();
    if (lower.indexOf('javascript:') !== -1 || lower.indexOf('vbscript:') !== -1 ||
        lower.indexOf('data:') !== -1 || lower.indexOf('file:') !== -1) {
      return '';
    }
    var m = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(cleaned);
    if (m) {
      var scheme = m[1].toLowerCase() + ':';
      if (!SAFE_SCHEMES[scheme]) {
        return '';
      }
    }
    return cleaned;
  }

  // 还原占位符，占位符内部还可能嵌套占位符（例如链接文字里的行内代码）
  function restoreTokens(text, tokens) {
    var guard = 0;
    var re = new RegExp(TOKEN + '(\\d+)' + TOKEN, 'g');
    var out = String(text == null ? '' : text);
    while (re.test(out) && guard < 20) {
      re.lastIndex = 0;
      out = out.replace(re, function (all, num) {
        var idx = parseInt(num, 10);
        return tokens[idx] == null ? '' : tokens[idx];
      });
      guard++;
    }
    return out.replace(new RegExp(TOKEN + '\\d*' + TOKEN, 'g'), '');
  }

  /* ================= 行内语法 ================= */

  // 传入的必须是已经转义过的文本；生成的标签全部由本函数产出
  function renderInline(escapedText) {
    var tokens = [];
    var work = String(escapedText == null ? '' : escapedText);

    function protect(html) {
      tokens.push(html);
      return TOKEN + (tokens.length - 1) + TOKEN;
    }

    // 1. 行内代码优先占位，避免内部被当成 markdown 语法
    work = work.replace(/`([^`\n]+)`/g, function (all, code) {
      return protect('<code>' + code + '</code>');
    });

    // 2. 图片
    work = work.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, function (all, alt, url) {
      var safe = sanitizeUrl(url);
      if (safe === '') {
        return alt;
      }
      return protect('<img src="' + safe + '" alt="' + alt + '">');
    });

    // 3. 链接
    work = work.replace(/\[([^\]]*)\]\(([^)]*)\)/g, function (all, text, url) {
      var safe = sanitizeUrl(url);
      if (safe === '') {
        return text;
      }
      return protect('<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' +
        renderInline(text) + '</a>');
    });

    // 4. 粗体、斜体：长的模式先匹配，先 ** 再 *
    work = work.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
    work = work.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    work = work.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
    work = work.replace(/\*(?=\S)([^*\n]*[^\s*])\*/g, '<em>$1</em>');
    work = work.replace(/(^|[^\w])_(?=\S)([^_\n]*?[^\s_])_(?=[^\w]|$)/g, '$1<em>$2</em>');

    return restoreTokens(work, tokens);
  }

  function inline(text) {
    return renderInline(escapeHtml(text));
  }

  /* ================= 块级识别 ================= */

  var RE_FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
  var RE_HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*)$/;
  var RE_UL = /^\s{0,3}[-*+][ \t]+(.*)$/;
  var RE_OL = /^\s{0,3}(\d{1,9})[.)][ \t]+(.*)$/;
  var RE_QUOTE = /^\s{0,3}>[ \t]?(.*)$/;

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  function isFenceOpen(line) {
    var m = RE_FENCE.exec(line);
    if (!m) {
      return false;
    }
    if (m[2].indexOf('`') !== -1) {
      return false;
    }
    return true;
  }

  function isHr(line) {
    var t = line.replace(/[ \t]/g, '');
    if (t.length < 3) {
      return false;
    }
    if (!/^[-*_]+$/.test(t)) {
      return false;
    }
    var c = t.charAt(0);
    var i;
    for (i = 1; i < t.length; i++) {
      if (t.charAt(i) !== c) {
        return false;
      }
    }
    return true;
  }

  function splitRow(line) {
    var s = String(line).replace(/\\\|/g, '\u0002');
    s = s.replace(/^\s*\|/, '');
    s = s.replace(/\|\s*$/, '');
    var parts = s.split('|');
    var out = [];
    var i;
    for (i = 0; i < parts.length; i++) {
      out.push(trim(parts[i]).replace(/\u0002/g, '|'));
    }
    return out;
  }

  function isTableSeparator(line) {
    if (line.indexOf('-') === -1) {
      return false;
    }
    if (!/^[\s|:\-]+$/.test(line)) {
      return false;
    }
    var cells = splitRow(line);
    if (cells.length === 0) {
      return false;
    }
    var i;
    for (i = 0; i < cells.length; i++) {
      if (!/^:?-+:?$/.test(cells[i])) {
        return false;
      }
    }
    return true;
  }

  // 段落在遇到这些行时必须断开
  function isBlockStart(lines, idx) {
    var line = lines[idx];
    if (isBlank(line) || isFenceOpen(line) || isHr(line)) {
      return true;
    }
    if (RE_HEADING.test(line) || RE_QUOTE.test(line) || RE_UL.test(line) || RE_OL.test(line)) {
      return true;
    }
    if (line.indexOf('|') !== -1 && idx + 1 < lines.length && isTableSeparator(lines[idx + 1])) {
      return true;
    }
    return false;
  }

  /* ================= 块级解析 ================= */

  function parseCodeBlock(lines, idx) {
    var m = RE_FENCE.exec(lines[idx]);
    var ch = m[1].charAt(0);
    var len = m[1].length;
    var info = trim(m[2] || '');
    var body = [];
    var i = idx + 1;
    var closeRe = new RegExp('^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
    while (i < lines.length) {
      if (closeRe.test(lines[i])) {
        i++;
        break;
      }
      body.push(lines[i]);
      i++;
    }
    var lang = info.replace(/[^A-Za-z0-9_+\-.#]/g, '').slice(0, 24);
    var cls = lang !== '' ? ' class="language-' + lang + '"' : '';
    return {
      html: '<pre><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>',
      next: i
    };
  }

  function parseHeading(line) {
    var m = RE_HEADING.exec(line);
    var level = m[1].length;
    var text = m[2].replace(/[ \t]+#+[ \t]*$/, '');
    return '<h' + level + '>' + inline(text) + '</h' + level + '>';
  }

  function parseTable(lines, idx) {
    var head = splitRow(lines[idx]);
    var rows = [];
    var i = idx + 2;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line) || line.indexOf('|') === -1) {
        break;
      }
      rows.push(splitRow(line));
      i++;
    }
    var html = '<table><thead><tr>';
    var c;
    for (c = 0; c < head.length; c++) {
      html += '<th>' + inline(head[c]) + '</th>';
    }
    html += '</tr></thead><tbody>';
    var r;
    for (r = 0; r < rows.length; r++) {
      html += '<tr>';
      for (c = 0; c < head.length; c++) {
        html += '<td>' + inline(rows[r][c] == null ? '' : rows[r][c]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return { html: html, next: i };
  }

  function parseQuote(lines, idx, depth) {
    var inner = [];
    var i = idx;
    while (i < lines.length) {
      var m = RE_QUOTE.exec(lines[i]);
      if (!m) {
        break;
      }
      inner.push(m[1]);
      i++;
    }
    var body;
    if (depth >= MAX_DEPTH) {
      body = '<p>' + escapeHtml(inner.join(' ')) + '</p>';
    } else {
      body = parseBlocks(inner, depth + 1);
    }
    if (body === '') {
      body = '<p></p>';
    }
    return { html: '<blockquote>' + body + '</blockquote>', next: i };
  }

  function parseList(lines, idx, ordered) {
    var items = [];
    var start = 1;
    var i = idx;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) {
        break;
      }
      var m = ordered ? RE_OL.exec(line) : RE_UL.exec(line);
      if (m) {
        if (ordered && items.length === 0) {
          start = parseInt(m[1], 10) || 1;
        }
        items.push(ordered ? m[2] : m[1]);
        i++;
        continue;
      }
      // 缩进的续行并入上一条
      if (items.length > 0 && /^([ \t]{2,}|\t)/.test(line)) {
        items[items.length - 1] += ' ' + trim(line);
        i++;
        continue;
      }
      break;
    }
    var html = ordered ? '<ol' + (start !== 1 ? ' start="' + start + '"' : '') + '>' : '<ul>';
    var j;
    for (j = 0; j < items.length; j++) {
      html += '<li>' + inline(items[j]) + '</li>';
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html: html, next: i };
  }

  function parseParagraph(lines, idx) {
    var parts = [];
    var i = idx;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) {
        break;
      }
      if (i > idx && isBlockStart(lines, i)) {
        break;
      }
      parts.push({ text: trim(line), hard: / {2,}$/.test(line) });
      i++;
    }
    var html = '';
    var j;
    for (j = 0; j < parts.length; j++) {
      html += inline(parts[j].text);
      if (j < parts.length - 1) {
        html += parts[j].hard ? '<br>' : ' ';
      }
    }
    return { html: '<p>' + html + '</p>', next: i };
  }

  function parseBlocks(lines, depth) {
    if (typeof depth !== 'number') {
      depth = 0;
    }
    var out = '';
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      var res;
      if (isFenceOpen(line)) {
        res = parseCodeBlock(lines, i);
      } else if (RE_HEADING.test(line)) {
        out += parseHeading(line);
        i++;
        continue;
      } else if (isHr(line)) {
        out += '<hr>';
        i++;
        continue;
      } else if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        res = parseTable(lines, i);
      } else if (RE_QUOTE.test(line)) {
        res = parseQuote(lines, i, depth);
      } else if (RE_UL.test(line)) {
        res = parseList(lines, i, false);
      } else if (RE_OL.test(line)) {
        res = parseList(lines, i, true);
      } else {
        res = parseParagraph(lines, i);
      }
      out += res.html;
      i = res.next;
    }
    return out;
  }

  /* ================= 主入口 ================= */

  function markdownToHtml(source) {
    var text = String(source == null ? '' : source);
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (trim(text) === '') {
      return '';
    }
    return parseBlocks(text.split('\n'), 0);
  }

  /* ================= 导出文档 ================= */

  var EXPORT_CSS = 'body{max-width:820px;margin:0 auto;padding:32px 20px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'line-height:1.7;color:#24292f;background:#fff;}' +
    'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .6em;}' +
    'h1{font-size:2em;border-bottom:1px solid #e5e7eb;padding-bottom:.3em;}' +
    'h2{font-size:1.5em;border-bottom:1px solid #e5e7eb;padding-bottom:.3em;}' +
    'h3{font-size:1.25em;}h4{font-size:1em;}h5{font-size:.9em;}h6{font-size:.85em;color:#57606a;}' +
    'p,ul,ol,blockquote,table,pre{margin:0 0 1em;}' +
    'code{background:#f3f4f6;padding:.15em .35em;border-radius:4px;' +
    'font-family:Consolas,Monaco,"Courier New",monospace;font-size:.92em;}' +
    'pre{background:#f6f8fa;padding:14px 16px;border-radius:6px;overflow:auto;}' +
    'pre code{background:none;padding:0;font-size:.9em;}' +
    'blockquote{padding:0 1em;color:#57606a;border-left:4px solid #d0d7de;}' +
    'table{border-collapse:collapse;}' +
    'th,td{border:1px solid #d0d7de;padding:6px 12px;}' +
    'th{background:#f6f8fa;}' +
    'img{max-width:100%;}' +
    'hr{height:1px;border:0;background:#d0d7de;margin:1.6em 0;}';

  function pickTitle(html) {
    var m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    var raw = m ? m[1] : '';
    raw = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
    raw = trim(raw);
    if (raw === '') {
      raw = 'Markdown 导出';
    }
    if (raw.length > 60) {
      raw = raw.slice(0, 60) + '...';
    }
    return raw;
  }

  function buildExportDocument(bodyHtml) {
    var body = bodyHtml === '' ? '<p></p>' : bodyHtml;
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      '<title>' + pickTitle(body) + '</title>\n' +
      '<style>\n' + EXPORT_CSS + '\n</style>\n' +
      '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  }

  /* ================= 页面绑定 ================= */

  var inputEl = document.getElementById('md-input');
  var previewEl = document.getElementById('md-preview');
  var exportBtn = document.getElementById('md-export-html');
  var copyBtn = document.getElementById('md-copy');

  var debounceTimer = null;
  var lastHtml = '';

  function renderNow() {
    if (!inputEl || !previewEl) {
      return;
    }
    var source = inputEl.value == null ? '' : inputEl.value;
    if (trim(source) === '') {
      lastHtml = '';
      previewEl.innerHTML = '';
      return;
    }
    try {
      lastHtml = markdownToHtml(source);
      previewEl.innerHTML = lastHtml;
    } catch (err) {
      lastHtml = '<p class="md-error">渲染出错</p>';
      previewEl.innerHTML = lastHtml;
    }
  }

  function onInputChange() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      renderNow();
    }, 100);
  }

  function onExportClick() {
    try {
      var source = inputEl ? (inputEl.value == null ? '' : inputEl.value) : '';
      var body;
      try {
        body = markdownToHtml(source);
      } catch (err) {
        body = '<p>渲染出错</p>';
      }
      var doc = buildExportDocument(body);
      var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
      window.TB.download(blob, 'export.html');
    } catch (err2) {
      if (previewEl) {
        previewEl.innerHTML = '<p class="md-error">渲染出错</p>';
      }
    }
  }

  function onCopyClick() {
    try {
      var source = inputEl ? (inputEl.value == null ? '' : inputEl.value) : '';
      window.TB.copy(source, this);
    } catch (err) {
      /* 复制失败时静默处理，不影响页面 */
    }
  }

  function init() {
    if (inputEl) {
      inputEl.addEventListener('input', onInputChange);
    }
    if (exportBtn) {
      exportBtn.addEventListener('click', onExportClick);
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', onCopyClick);
    }
    // 输入框本来为空时不做任何渲染，预览区保持空白
    if (inputEl && trim(inputEl.value == null ? '' : inputEl.value) !== '') {
      renderNow();
    }
  }

  try {
    init();
  } catch (err) {
    /* 初始化异常不影响页面其它功能 */
  }

  // 暴露解析函数，方便复用与调试
  try {
    if (typeof window !== 'undefined') {
      window.TB = window.TB || {};
      if (!window.TB.markdownToHtml) {
        window.TB.markdownToHtml = markdownToHtml;
      }
    }
  } catch (err3) {
    /* 忽略 */
  }
})();
