// 进制转换与位运算模块
(function () {
  'use strict';

  var ERR_COLOR = '#FB7185';
  var OK_COLOR = '#34D399';

  var decInput = document.getElementById('rx-dec');
  var hexInput = document.getElementById('rx-hex');
  var octInput = document.getElementById('rx-oct');
  var binInput = document.getElementById('rx-bin');
  var statusBox = document.getElementById('rx-status');

  var aInput = document.getElementById('rx-a');
  var opSelect = document.getElementById('rx-op');
  var bInput = document.getElementById('rx-b');
  var calcBtn = document.getElementById('rx-calc');
  var resultBox = document.getElementById('rx-result');
  var bitsBox = document.getElementById('rx-bits');

  // ---------- 基础工具 ----------

  function hasBigInt() {
    return typeof BigInt === 'function';
  }

  function setStatus(text, color) {
    if (!statusBox) {
      return;
    }
    statusBox.textContent = text;
    statusBox.style.color = color || '';
  }

  function setResult(text) {
    if (!resultBox) {
      return;
    }
    resultBox.textContent = text;
    resultBox.style.color = '#FB7185';
  }

  function setResultOk(text) {
    if (!resultBox) {
      return;
    }
    resultBox.textContent = text;
    resultBox.style.color = OK_COLOR;
  }

  function setBits(text) {
    if (!bitsBox) {
      return;
    }
    bitsBox.textContent = text;
    bitsBox.style.color = '';
  }

  function getValue(input) {
    return input ? input.value : '';
  }

  function setValue(input, value) {
    if (input) {
      input.value = value;
    }
  }

  function trimAll(text) {
    return String(text).replace(/^\s+|\s+$/g, '');
  }

  function stripPrefix(text, prefix) {
    var lower = text.toLowerCase();
    if (lower.indexOf(prefix) === 0) {
      return text.slice(prefix.length);
    }
    return text;
  }

  // 把一个字符串解析成指定位数的整数，返回 { value }
  // value 在 BigInt 可用时是 BigInt，否则是 Number（parseInt 同样能处理大小写与前缀）
  function parseInBase(text, base, prefix) {
    var raw = trimAll(text);
    if (raw === '') {
      return { empty: true };
    }
    var body = stripPrefix(raw, prefix);
    if (body.charAt(0) === '-') {
      body = body.slice(1);
    }
    if (!validDigits(body, base)) {
      return { error: true };
    }
    var lower = body.toLowerCase();
    if (hasBigInt()) {
      return { value: BigInt(prefix + lower) };
    }
    return { value: parseInt(prefix + lower, base) };
  }

  function validDigits(text, base) {
    var i;
    var ch;
    var code;
    var limit = base <= 10 ? 47 + base : 0;
    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      code = ch.charCodeAt(0);
      if (base <= 10) {
        if (code < 48 || code > limit) {
          return false;
        }
      } else {
        if (!(code >= 48 && code <= 57) && !(code >= 97 && code <= 102) && !(code >= 65 && code <= 70)) {
          return false;
        }
      }
    }
    return true;
  }

  function isValidDecimal(text) {
    var raw = trimAll(text);
    if (raw === '') {
      return false;
    }
    if (raw.charAt(0) === '-' || raw.charAt(0) === '+') {
      raw = raw.slice(1);
    }
    return /^[0-9]+$/.test(raw);
  }

  function isNegativeValue(value) {
    if (!hasBigInt()) {
      return Number(value) < 0;
    }
    return BigInt(value) < BigInt(0);
  }

  function absOf(value) {
    if (!hasBigInt()) {
      return Math.abs(Number(value));
    }
    if (BigInt(value) < BigInt(0)) {
      return -BigInt(value);
    }
    return BigInt(value);
  }

  // 输出时统一成字符串，负数把符号提到前缀前面：-0xFF 而不是 0x-FF
  function toBaseString(value, base) {
    var negative = isNegativeValue(value);
    var absText = absOf(value).toString(base);
    if (base === 16) {
      absText = absText.toUpperCase();
    }
    return negative ? '-' + absText : absText;
  }

  // BigInt 优先，极旧环境退回 Number
  function toNumberFromDecimal(text) {
    var raw = trimAll(text);
    if (hasBigInt()) {
      return BigInt(raw);
    }
    return parseInt(raw, 10);
  }

  // ---------- 进制互转 ----------

  var CONVERTERS = {
    dec: {
      input: null,
      errorText: '✗ 十进制格式错误'
    },
    hex: {
      input: null,
      errorText: '✗ 十六进制格式错误'
    },
    oct: {
      input: null,
      errorText: '✗ 八进制格式错误'
    },
    bin: {
      input: null,
      errorText: '✗ 二进制格式错误'
    }
  };

  function parseByKind(kind, text) {
    if (kind === 'dec') {
      if (!isValidDecimal(text)) {
        return { error: true };
      }
      var raw = trimAll(text);
      if (hasBigInt()) {
        return { value: BigInt(raw) };
      }
      return { value: parseInt(raw, 10) };
    }
    if (kind === 'hex') {
      return parseInBase(text, 16, '0x');
    }
    if (kind === 'oct') {
      return parseInBase(text, 8, '0o');
    }
    return parseInBase(text, 2, '0b');
  }

  function clearAllFields() {
    setValue(decInput, '');
    setValue(hexInput, '');
    setValue(octInput, '');
    setValue(binInput, '');
    setStatus('', '');
  }

  // 单个输入框变化时联动更新其余三个，source 用来跳过自身
  function syncFrom(kind) {
    try {
      var info = CONVERTERS[kind];
      if (!info) {
        return;
      }
      var text = getValue(info.input);
      var trimmed = trimAll(text);

      if (trimmed === '') {
        clearAllFields();
        return;
      }

      var parsed = parseByKind(kind, trimmed);
      if (parsed.error) {
        setStatus(info.errorText, ERR_COLOR);
        return;
      }

      var value = parsed.value;
      setStatus('✓ 已转换', OK_COLOR);

      if (kind !== 'dec') {
        setValue(decInput, value.toString(10));
      }
      if (kind !== 'hex') {
        setValue(hexInput, toBaseString(value, 16));
      }
      if (kind !== 'oct') {
        setValue(octInput, toBaseString(value, 8));
      }
      if (kind !== 'bin') {
        setValue(binInput, toBaseString(value, 2));
      }
    } catch (err) {
      var fallback = CONVERTERS[kind];
      setStatus(fallback ? fallback.errorText : '✗ 格式化错误', ERR_COLOR);
    }
  }

  function bindConverters() {
    CONVERTERS.dec.input = decInput;
    CONVERTERS.hex.input = hexInput;
    CONVERTERS.oct.input = octInput;
    CONVERTERS.bin.input = binInput;

    var kinds = ['dec', 'hex', 'oct', 'bin'];
    var i;
    var current;
    for (i = 0; i < kinds.length; i++) {
      current = kinds[i];
      (function (kind) {
        var info = CONVERTERS[kind];
        if (!info.input) {
          return;
        }
        info.input.addEventListener('input', function () {
          syncFrom(kind);
        });
      })(current);
    }
  }

  // ---------- 位运算 ----------

  function readOperand(input, label) {
    var raw = trimAll(getValue(input));
    if (raw === '') {
      return { error: '操作数' + label + '不能为空' };
    }
    if (!isValidDecimal(raw)) {
      return { error: '操作数' + label + '不是合法的十进制整数' };
    }
    try {
      return { value: toNumberFromDecimal(raw) };
    } catch (err) {
      return { error: '操作数' + label + '解析失败' };
    }
  }

  function toShiftCount(value, label) {
    var text = value.toString(10);
    if (text.charAt(0) === '-') {
      return { error: '位数' + label + '不能为负数' };
    }
    return { value: value };
  }

  function compute(op, a, b) {
    if (op === 'and') {
      return a & b;
    }
    if (op === 'or') {
      return a | b;
    }
    if (op === 'xor') {
      return a ^ b;
    }
    if (op === 'shl') {
      return a << b;
    }
    if (op === 'shr') {
      return a >> b;
    }
    throw new Error('未知的运算符');
  }

  // 进制前缀要放在负号后面：-0xFF 而不是 0x-FF
  function toPrefixedString(value, base, prefix) {
    var negative = isNegativeValue(value);
    var text = absOf(value).toString(base);
    if (base === 16) {
      text = text.toUpperCase();
    }
    return (negative ? '-' : '') + prefix + text;
  }

  function buildBitsView(value) {
    var mask = hasBigInt() ? BigInt(0xFFFFFFFF) : 0xFFFFFFFF;
    var low;
    if (hasBigInt()) {
      low = value & mask;
    } else {
      low = (value & mask) >>> 0;
    }
    var binText = low.toString(2);
    while (binText.length < 32) {
      binText = '0' + binText;
    }
    if (binText.length > 32) {
      binText = binText.slice(binText.length - 32);
    }
    return binText.slice(0, 8) + ' ' + binText.slice(8, 16) + ' ' + binText.slice(16, 24) + ' ' + binText.slice(24, 32);
  }

  function calcuate() {
    try {
      var op = opSelect ? String(opSelect.value) : 'and';
      var aInfo = readOperand(aInput, 'A');
      if (aInfo.error) {
        setResult('✗ 计算失败: ' + aInfo.error);
        setBits('');
        return;
      }
      var bInfo = readOperand(bInput, 'B');
      if (bInfo.error) {
        setResult('✗ 计算失败: ' + bInfo.error);
        setBits('');
        return;
      }

      var a = aInfo.value;
      var b = bInfo.value;

      if (op === 'shl' || op === 'shr') {
        var shift = toShiftCount(b, 'B');
        if (shift.error) {
          setResult('✗ 计算失败: ' + shift.error);
          setBits('');
          return;
        }
        b = shift.value;
      }

      var result = compute(op, a, b);
      setResultOk(
        '结果 = ' + result.toString(10) + ' (十进制) = ' + toPrefixedString(result, 16, '0x') +
        ' (十六进制) = ' + toPrefixedString(result, 2, '0b') + ' (二进制)'
      );
      setBits(buildBitsView(result));
    } catch (err) {
      var reason = err && err.message ? err.message : '输入不合法';
      setResult('✗ 计算失败: ' + reason);
      setBits('');
    }
  }

  function bindCalculator() {
    if (calcBtn) {
      calcBtn.addEventListener('click', function () {
        calcuate();
      });
    }
    if (opSelect) {
      opSelect.addEventListener('change', function () {
        calcuate();
      });
    }
  }

  // ---------- 初始化 ----------

  function init() {
    try {
      bindConverters();
      bindCalculator();
      // 页面初始如果已有值就联动一次，全空则保持空白
      if (decInput && trimAll(decInput.value) !== '') {
        syncFrom('dec');
      } else if (hexInput && trimAll(hexInput.value) !== '') {
        syncFrom('hex');
      } else if (octInput && trimAll(octInput.value) !== '') {
        syncFrom('oct');
      } else if (binInput && trimAll(binInput.value) !== '') {
        syncFrom('bin');
      }
    } catch (err) {
      setStatus('✗ 初始化失败', ERR_COLOR);
    }
  }

  init();
})();
