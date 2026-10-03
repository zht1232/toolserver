/* JWT 解析器模块 —— 纯原生JS，无依赖：本地 Base64URL 解码 Header/Payload 并展示常见时间字段 */
(function () {
  'use strict';

  /* ---------- 元素引用 ---------- */
  var input = document.getElementById('jwt-input');
  var statusEl = document.getElementById('jwt-status');
  var headerEl = document.getElementById('jwt-header');
  var payloadEl = document.getElementById('jwt-payload');
  var timesEl = document.getElementById('jwt-times');

  /* 元素不存在时静默退出，避免初始状态报错 */
  if (!input) {
    return;
  }

  var COLOR_OK = '#34D399';
  var COLOR_ERR = '#FB7185';
  var COLOR_WAIT = '#94A3B8';
  var COLOR_MUTED = '#8A8F98';

  var TIME_FIELDS = [
    { key: 'iat', label: 'iat (签发时间)' },
    { key: 'exp', label: 'exp (过期时间)' },
    { key: 'nbf', label: 'nbf (生效时间)' }
  ];

  /* ---------- 工具函数 ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(text, color) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = text;
    statusEl.style.color = color || '';
  }

  function errorText(e) {
    return e && e.message ? e.message : String(e);
  }

  /* 清空三块展示区（Header / Payload / 时间字段） */
  function resetViews() {
    if (headerEl) {
      headerEl.textContent = '—';
    }
    if (payloadEl) {
      payloadEl.textContent = '—';
    }
    if (timesEl) {
      timesEl.innerHTML = '';
    }
  }

  /* ---------- Base64URL 解码（JWT 用 - _ 替代 + /，并省略末尾 = 填充） ---------- */
  function base64UrlDecode(segment) {
    if (typeof segment !== 'string' || segment === '') {
      throw new Error('Base64URL 片段为空');
    }

    var base64 = segment.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    var padding = base64.length % 4;
    if (padding === 1) {
      throw new Error('Base64URL 长度非法');
    }
    if (padding) {
      base64 += padding === 2 ? '==' : '=';
    }
    if (typeof atob !== 'function') {
      throw new Error('当前环境不支持 atob');
    }

    /* atob 得到的是“二进制字符串”，每个字符对应一个字节 */
    var binary = atob(base64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }

    /* payload 通常是 UTF-8 编码的 JSON（可能含中文），不能直接当字符串用，否则中文乱码 */
    if (typeof TextDecoder === 'function') {
      return new TextDecoder('utf-8').decode(bytes);
    }
    var escaped = '';
    for (var j = 0; j < len; j++) {
      escaped += '%' + (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
    }
    try {
      return decodeURIComponent(escaped);
    } catch (e) {
      return binary;
    }
  }

  /* 解码并 JSON.parse 一段 JWT 片段，失败时抛出带原因的错误 */
  function parseSegment(segment) {
    var text = base64UrlDecode(segment);
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 解析失败: ' + errorText(e));
    }
    if (obj === null || typeof obj !== 'object' || Object.prototype.toString.call(obj) === '[object Array]') {
      throw new Error('解码结果不是 JSON 对象');
    }
    return obj;
  }

  /* ---------- 时间字段展示 ---------- */
  function formatLocal(seconds) {
    var d = new Date(seconds * 1000);
    if (isNaN(d.getTime())) {
      return null;
    }
    try {
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return d.toLocaleString();
    }
  }

  function renderTimes(payload) {
    if (!timesEl) {
      return;
    }
    if (payload === null || typeof payload !== 'object') {
      timesEl.innerHTML = '';
      return;
    }

    var html = '';
    var found = 0;

    for (var i = 0; i < TIME_FIELDS.length; i++) {
      var key = TIME_FIELDS[i].key;
      var label = TIME_FIELDS[i].label;
      if (!Object.prototype.hasOwnProperty.call(payload, key)) {
        continue;
      }
      found++;

      var value = payload[key];
      var timeHtml;
      var extraHtml = '';

      if (typeof value === 'number' && isFinite(value)) {
        var local = formatLocal(value);
        timeHtml = local === null
          ? '<span class="muted">（时间戳超出可表示范围）</span>'
          : escapeHtml(local);
        if (key === 'exp') {
          if (Date.now() > value * 1000) {
            extraHtml = ' <span style="color:' + COLOR_ERR + '">（已过期）</span>';
          } else {
            extraHtml = ' <span style="color:' + COLOR_OK + '">（有效）</span>';
          }
        }
      } else {
        timeHtml = '<span class="muted">（非数字，无法按时间戳解析）</span>';
      }

      html += '<div class="kv"><span>' + escapeHtml(label) + '</span><b>' +
        '<span class="muted">' + escapeHtml(String(value)) + '</span> → ' + timeHtml + extraHtml +
        '</b></div>';
    }

    if (found === 0) {
      timesEl.innerHTML = '<div class="muted" style="color:' + COLOR_MUTED + '">' +
        '（payload 中未发现 iat / exp / nbf 字段）</div>';
      return;
    }
    timesEl.innerHTML = html;
  }

  /* ---------- 主流程 ---------- */
  function parse() {
    var raw = typeof input.value === 'string' ? input.value : '';
    var token = raw.replace(/^\s+|\s+$/g, '');

    if (token === '') {
      resetViews();
      setStatus('等待输入 JWT…', COLOR_WAIT);
      return;
    }

    var parts = token.split('.');
    if (parts.length !== 3) {
      resetViews();
      setStatus('✗ 不是合法的 JWT 格式（应为 header.payload.signature）', COLOR_ERR);
      return;
    }

    var headerObj;
    var payloadObj;

    try {
      headerObj = parseSegment(parts[0]);
    } catch (e) {
      resetViews();
      setStatus('✗ Header 解析失败: ' + errorText(e), COLOR_ERR);
      return;
    }

    try {
      payloadObj = parseSegment(parts[1]);
    } catch (e) {
      if (headerEl) {
        headerEl.textContent = JSON.stringify(headerObj, null, 2);
      }
      if (payloadEl) {
        payloadEl.textContent = '—';
      }
      if (timesEl) {
        timesEl.innerHTML = '';
      }
      setStatus('✗ Payload 解析失败: ' + errorText(e), COLOR_ERR);
      return;
    }

    if (headerEl) {
      headerEl.textContent = JSON.stringify(headerObj, null, 2);
    }
    if (payloadEl) {
      payloadEl.textContent = JSON.stringify(payloadObj, null, 2);
    }
    renderTimes(payloadObj);
    setStatus('✓ 解析成功', COLOR_OK);
  }

  /* ---------- 事件绑定 ---------- */
  input.addEventListener('input', parse);

  /* 初始化：输入框为空时不报错，仅提示等待输入 */
  try {
    parse();
  } catch (e) {
    setStatus('✗ 解析失败: ' + errorText(e), COLOR_ERR);
  }
})();
