/* UUID与随机密码生成器模块 */
(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ==================== UUID 生成 ==================== */
  (function () {
    'use strict';

    var HEX = '0123456789abcdef';
    var countInput = document.getElementById('uuid-count');
    var genBtn = document.getElementById('uuid-gen');
    var copyBtn = document.getElementById('uuid-copy');
    var listBox = document.getElementById('uuid-list');
    var lastList = [];

    function bytesToUuid(bytes) {
      var hex = [];
      var i;
      for (i = 0; i < 16; i++) {
        hex.push(HEX.charAt((bytes[i] >> 4) & 0x0f) + HEX.charAt(bytes[i] & 0x0f));
      }
      return hex[0] + hex[1] + hex[2] + hex[3] + '-' +
        hex[4] + hex[5] + '-' +
        hex[6] + hex[7] + '-' +
        hex[8] + hex[9] + '-' +
        hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15];
    }

    function uuidV4() {
      var cryptoObj = window.crypto || window.msCrypto;
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
        return cryptoObj.randomUUID();
      }
      if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
        return '';
      }
      var bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      /* 第13位（版本号）固定为4 */
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      /* 第17位（变体位）固定为 8/9/a/b */
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return bytesToUuid(bytes);
    }

    function readCount() {
      var value = parseInt(countInput && countInput.value, 10);
      if (isNaN(value)) {
        return 5;
      }
      if (value < 1) {
        return 1;
      }
      if (value > 50) {
        return 50;
      }
      return value;
    }

    function currentList() {
      var list = [];
      var i;
      for (i = 0; i < lastList.length; i++) {
        list.push(lastList[i]);
      }
      return list;
    }

    function render(list) {
      lastList = list;
      var html = '';
      var i;
      for (i = 0; i < list.length; i++) {
        html += '<div class="filerow" data-uuid="' + escapeHtml(list[i]) + '" title="点击复制">' +
          '<span class="mono">' + escapeHtml(list[i]) + '</span>' +
          '<button type="button" class="uuid-one-copy">复制</button>' +
          '</div>';
      }
      if (listBox) {
        listBox.innerHTML = html;
      }
    }

    function generate() {
      var count = readCount();
      var list = [];
      var i;
      for (i = 0; i < count; i++) {
        var id = uuidV4();
        if (id) {
          list.push(id);
        }
      }
      if (list.length === 0) {
        lastList = [];
        if (listBox) {
          listBox.innerHTML = '<div class="filerow">当前环境不支持安全随机数，无法生成 UUID</div>';
        }
        return;
      }
      render(list);
    }

    if (genBtn) {
      genBtn.addEventListener('click', function () {
        generate();
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var list = currentList();
        if (list.length === 0) {
          return;
        }
        if (window.TB && typeof window.TB.copy === 'function') {
          window.TB.copy(list.join('\n'), this);
        }
      });
    }

    if (listBox) {
      listBox.addEventListener('click', function (event) {
        var target = event.target;
        var row = target;
        while (row && row !== listBox && !(row.getAttribute && row.getAttribute('data-uuid'))) {
          row = row.parentNode;
        }
        if (!row || row === listBox) {
          return;
        }
        var uuid = row.getAttribute('data-uuid');
        if (!uuid) {
          return;
        }
        var btn = null;
        if (target && target.className && String(target.className).indexOf('uuid-one-copy') !== -1) {
          btn = target;
        } else {
          btn = row.querySelector ? row.querySelector('.uuid-one-copy') : null;
        }
        if (window.TB && typeof window.TB.copy === 'function') {
          window.TB.copy(uuid, btn || row);
        }
      });
    }

    generate();
  })();

  /* ==================== 随机密码生成 ==================== */
  (function () {
    'use strict';

    var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var LOWER = 'abcdefghijklmnopqrstuvwxyz';
    var DIGIT = '0123456789';
    var SYMBOL = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    var FALLBACK_POOL = LOWER + DIGIT;

    var lenInput = document.getElementById('pw-len');
    var upperBox = document.getElementById('pw-upper');
    var lowerBox = document.getElementById('pw-lower');
    var digitBox = document.getElementById('pw-digit');
    var symbolBox = document.getElementById('pw-symbol');
    var genBtn = document.getElementById('pw-gen');
    var copyBtn = document.getElementById('pw-copy');
    var output = document.getElementById('pw-output');
    var strengthBox = document.getElementById('pw-strength');

    function randomInt(max) {
      /* 返回 [0, max) 内的安全随机整数 */
      if (max <= 0) {
        return 0;
      }
      var cryptoObj = window.crypto || window.msCrypto;
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        var limit = Math.floor(4294967296 / max) * max;
        var buffer = new Uint32Array(1);
        var guard = 0;
        do {
          cryptoObj.getRandomValues(buffer);
          guard++;
        } while (buffer[0] >= limit && guard < 64);
        return buffer[0] % max;
      }
      /* 理论兜底：无 crypto 时退回 Math.random */
      return Math.floor(Math.random() * max);
    }

    function randomIndexes(size) {
      var result = [];
      var i;
      if (size <= 0) {
        return result;
      }
      var cryptoObj = window.crypto || window.msCrypto;
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        var buffer = new Uint32Array(size);
        cryptoObj.getRandomValues(buffer);
        for (i = 0; i < size; i++) {
          result.push(buffer[i] % size);
        }
        return result;
      }
      for (i = 0; i < size; i++) {
        result.push(Math.floor(Math.random() * size));
      }
      return result;
    }

    function shuffle(arr) {
      var indexes = randomIndexes(arr.length);
      var i;
      for (i = arr.length - 1; i > 0; i--) {
        var j = indexes[i] % (i + 1);
        var tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    }

    function readLength() {
      var value = parseInt(lenInput && lenInput.value, 10);
      if (isNaN(value)) {
        return 16;
      }
      if (value < 4) {
        return 4;
      }
      if (value > 128) {
        return 128;
      }
      return value;
    }

    function collectSets() {
      var sets = [];
      if (upperBox && upperBox.checked) {
        sets.push(UPPER);
      }
      if (lowerBox && lowerBox.checked) {
        sets.push(LOWER);
      }
      if (digitBox && digitBox.checked) {
        sets.push(DIGIT);
      }
      if (symbolBox && symbolBox.checked) {
        sets.push(SYMBOL);
      }
      return sets;
    }

    function pickChar(pool) {
      return pool.charAt(randomInt(pool.length));
    }

    function buildPassword(len, sets) {
      var chars = [];
      var pool = sets.join('');
      var i;
      if (sets.length === 0) {
        pool = FALLBACK_POOL;
        sets = [FALLBACK_POOL];
      }
      if (len < sets.length) {
        /* 长度不足以保证每类出现，直接从总池随机填满 */
        for (i = 0; i < len; i++) {
          chars.push(pickChar(pool));
        }
        return chars.join('');
      }
      /* 先保证每个被勾选类别至少出现一次 */
      for (i = 0; i < sets.length; i++) {
        chars.push(pickChar(sets[i]));
      }
      while (chars.length < len) {
        chars.push(pickChar(pool));
      }
      return shuffle(chars).join('');
    }

    function generate() {
      var len = readLength();
      var sets = collectSets();
      var usedFallback = sets.length === 0;
      var poolSize = 0;
      var i;
      var password = buildPassword(len, sets);

      if (usedFallback) {
        poolSize = FALLBACK_POOL.length;
      } else {
        for (i = 0; i < sets.length; i++) {
          poolSize += sets[i].length;
        }
      }

      if (output) {
        output.value = password;
      }
      evaluateStrength(len, poolSize, usedFallback);
    }

    function evaluateStrength(len, poolSize, usedFallback) {
      if (!strengthBox || poolSize <= 0) {
        return;
      }
      var bits = len * (Math.log(poolSize) / Math.LN2);
      var bitsText = Math.round(bits);
      var label;
      var color;
      var weight = '';
      if (bits < 40) {
        label = '弱';
        color = '#FB7185';
      } else if (bits < 60) {
        label = '中';
        color = '#FBBF24';
      } else if (bits <= 80) {
        label = '强';
        color = '#34D399';
      } else {
        label = '非常强 💪';
        color = '#34D399';
        weight = 'font-weight:700;';
      }
      var html = '<span style="color:' + color + ';' + weight + '">' +
        escapeHtml('强度：' + label + '（约 ' + bitsText + ' bits）') + '</span>';
      if (usedFallback) {
        html += ' <span style="color:#94A3B8;">' +
          escapeHtml('未选择任何字符集，已使用默认（小写+数字）') + '</span>';
      }
      strengthBox.innerHTML = html;
      strengthBox.style.color = color;
    }

    if (genBtn) {
      genBtn.addEventListener('click', function () {
        generate();
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var text = output ? output.value : '';
        if (!text) {
          return;
        }
        if (window.TB && typeof window.TB.copy === 'function') {
          window.TB.copy(text, this);
        }
      });
    }

    generate();
  })();
})();
