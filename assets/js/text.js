/* 文本处理：字数统计、大小写、去重去空行、清理标签 */
(function () {
  'use strict';

  var input = document.getElementById('text-input');
  var stats = document.getElementById('text-stats');

  function updateStats() {
    var t = input.value;
    var chars = Array.from(t).length;
    var charsNoSpace = Array.from(t.replace(/\s/g, '')).length;
    var lines = t ? t.split('\n').length : 0;
    var nonEmpty = t ? t.split('\n').filter(function (l) { return l.trim(); }).length : 0;
    var cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (t.match(/[A-Za-z0-9']+/g) || []).length;
    var bytes = new Blob([t]).size;
    stats.innerHTML =
      '<span>字符 <b>' + chars + '</b></span>' +
      '<span>不含空白 <b>' + charsNoSpace + '</b></span>' +
      '<span>汉字 <b>' + cjk + '</b></span>' +
      '<span>英文词 <b>' + words + '</b></span>' +
      '<span>行数 <b>' + lines + '</b></span>' +
      '<span>非空行 <b>' + nonEmpty + '</b></span>' +
      '<span>UTF-8 <b>' + TB.formatSize(bytes) + '</b></span>';
  }

  input.addEventListener('input', updateStats);
  updateStats();

  function mapLines(fn) {
    input.value = input.value.split('\n').map(fn).join('\n');
    updateStats();
  }

  document.getElementById('text-upper').addEventListener('click', function () {
    input.value = input.value.toUpperCase();
    updateStats();
  });
  document.getElementById('text-lower').addEventListener('click', function () {
    input.value = input.value.toLowerCase();
    updateStats();
  });
  document.getElementById('text-title').addEventListener('click', function () {
    input.value = input.value.replace(/[A-Za-z][A-Za-z']*/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
    updateStats();
  });
  document.getElementById('text-trim').addEventListener('click', function () {
    mapLines(function (l) { return l.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); });
  });
  document.getElementById('text-dedupe').addEventListener('click', function () {
    var seen = {};
    input.value = input.value.split('\n').filter(function (l) {
      var k = l.trim();
      if (!k) return true;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).join('\n');
    updateStats();
  });
  document.getElementById('text-blank').addEventListener('click', function () {
    input.value = input.value.split('\n').filter(function (l) { return l.trim(); }).join('\n');
    updateStats();
  });
  document.getElementById('text-bracket').addEventListener('click', function () {
    input.value = input.value.replace(/[【\[（(][^】\]）)]*[】\]）)]/g, '').replace(/\s{2,}/g, ' ');
    updateStats();
  });
  document.getElementById('text-copy').addEventListener('click', function (e) {
    if (input.value) TB.copy(input.value, e.currentTarget);
  });
})();
