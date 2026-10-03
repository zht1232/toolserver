// Cron表达式解析与生成模块
(function () {
  'use strict';

  var MAX_ITERATIONS = 1051200;
  var NEXT_COUNT = 10;

  var DOW_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  var FIELD_DEFS = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12 },
    { min: 0, max: 7, remap7: true }
  ];

  function byId(id) {
    return document.getElementById(id);
  }

  function clearNode(node) {
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function formatList(numbers) {
    var i;
    var parts = [];
    for (i = 0; i < numbers.length; i++) {
      parts.push('' + numbers[i]);
    }
    return parts.join(', ');
  }

  function isFullRange(numbers, min, max) {
    var expected = max - min + 1;
    return numbers.length > 0 && numbers.length >= expected;
  }

  function parseField(expression, min, max, remap7) {
    var text = ('' + expression).replace(/^\s+|\s+$/g, '');
    var seen = {};
    var values = [];
    var maxValue = max;

    if (text === '') {
      throw new Error('字段不能为空');
    }

    function addValue(number) {
      var value = number;
      if (remap7 && value === 7) {
        value = 0;
      }
      if (!isFinite(value) || Math.floor(value) !== value) {
        throw new Error('数值 "' + number + '" 不是整数');
      }
      if (value < min || value > max) {
        throw new Error('数值 ' + number + ' 超出允许范围 ' + min + '-' + max);
      }
      if (!seen[value]) {
        seen[value] = true;
        values.push(value);
      }
    }

    function parseBound(token, label) {
      if (!/^\d+$/.test(token)) {
        throw new Error(label + ' "' + token + '" 不是有效数字');
      }
      return parseInt(token, 10);
    }

    function collectStep(from, to, step) {
      var i;
      if (!isFinite(step) || Math.floor(step) !== step) {
        throw new Error('步长 "' + step + '" 不是整数');
      }
      if (step < 1) {
        throw new Error('步长必须大于 0');
      }
      if (from > to) {
        throw new Error('范围起点 ' + from + ' 大于终点 ' + to);
      }
      for (i = from; i <= to; i += step) {
        addValue(i);
      }
    }

    function parseItem(item) {
      var slash = item.indexOf('/');
      var base = item;
      var step = null;
      var dash;
      var from;
      var to;
      if (slash >= 0) {
        base = item.substring(0, slash);
        step = parseBound(item.substring(slash + 1), '步长');
      }
      if (base === '*') {
        if (maxValue > 59) {
          maxValue = 59;
        }
        collectStep(min, maxValue, step === null ? 1 : step);
        return;
      }
      if (base === '') {
        throw new Error('缺少 "/" 前面的基础部分');
      }
      dash = base.indexOf('-');
      if (dash >= 0) {
        from = parseBound(base.substring(0, dash), '范围起点');
        to = parseBound(base.substring(dash + 1), '范围终点');
        if (from < min || from > max || to < min || to > max) {
          throw new Error('范围 ' + base + ' 超出允许范围 ' + min + '-' + max);
        }
        collectStep(from, to, step === null ? 1 : step);
        return;
      }
      addValue(parseBound(base, '数值'));
      if (step !== null) {
        throw new Error('"' + item + '" 的步长只能用在 "*" 或范围上');
      }
    }

    var items = text.split(',');
    var i;
    for (i = 0; i < items.length; i++) {
      parseItem(items[i]);
    }
    if (values.length === 0) {
      throw new Error('字段 "' + text + '" 没有匹配到任何数值');
    }
    values.sort(function (a, b) {
      return a - b;
    });
    return values;
  }

  function parseCron(expression) {
    var text = ('' + expression).replace(/^\s+|\s+$/g, '');
    var tokens;
    var parsed = [];
    var i;
    if (text === '') {
      throw new Error('表达式为空');
    }
    tokens = text.split(/\s+/);
    if (tokens.length !== 5) {
      throw new Error('需要 5 个字段(分钟 小时 日 月 星期)，当前收到 ' + tokens.length + ' 个');
    }
    for (i = 0; i < 5; i++) {
      parsed.push(parseField(tokens[i], FIELD_DEFS[i].min, FIELD_DEFS[i].max, FIELD_DEFS[i].remap7));
    }
    return {
      minutes: parsed[0],
      hours: parsed[1],
      doms: parsed[2],
      months: parsed[3],
      dows: parsed[4],
      tokens: tokens
    };
  }

  function formatDowNames(dows) {
    var texts = [];
    var i = 0;
    var j;
    var len;
    var k;
    while (i < dows.length) {
      j = i;
      while (j + 1 < dows.length && dows[j + 1] === dows[j] + 1) {
        j++;
      }
      len = j - i + 1;
      if (len >= 3) {
        texts.push(DOW_NAMES[dows[i]].substring(2) + '至' + DOW_NAMES[dows[j]].substring(2));
      } else {
        for (k = i; k <= j; k++) {
          texts.push(DOW_NAMES[dows[k]].substring(2));
        }
      }
      i = j + 1;
    }
    return texts.join('、');
  }

  function buildDayText(parsed) {
    var domAll = isFullRange(parsed.doms, 1, 31);
    var dowAll = isFullRange(parsed.dows, 0, 6);
    var domText = domAll ? '' : '每月 ' + formatList(parsed.doms) + ' 日';
    var dowText = dowAll ? '' : '每星期' + formatDowNames(parsed.dows);
    if (domText !== '' && dowText !== '') {
      return domText + ' 或 ' + dowText;
    }
    return domText !== '' ? domText : dowText;
  }

  function describeCron(expression) {
    var parsed = parseCron(expression);
    var minutes = parsed.minutes;
    var hours = parsed.hours;
    var minuteAll = isFullRange(minutes, 0, 59);
    var hourAll = isFullRange(hours, 0, 23);
    var dayText = buildDayText(parsed);
    var times = [];
    var i;
    var timeText;

    if (minuteAll && hourAll) {
      timeText = '每分钟执行一次';
    } else if (minuteAll) {
      timeText = hours.length === 1 ?
        '在 ' + pad2(hours[0]) + ' 点的每分钟执行一次' :
        '在 ' + formatList(hours) + ' 点的每分钟执行一次';
    } else if (hourAll) {
      timeText = minutes.length === 1 && minutes[0] === 0 ?
        '每小时的整点执行一次' :
        '每小时的第 ' + formatList(minutes) + ' 分钟执行一次';
    } else if (hours.length === 1) {
      timeText = '在 ' + pad2(hours[0]) + ':' + pad2(minutes[0]) + ' 执行';
    } else {
      for (i = 0; i < hours.length; i++) {
        times.push(pad2(hours[i]) + ':' + pad2(minutes[0]));
      }
      timeText = minutes.length === 1 ?
        '在 ' + times.join('、') + ' 执行' :
        '在 ' + times.join('、') + ' 的第 ' + formatList(minutes) + ' 分钟执行';
    }

    if (dayText === '') {
      return timeText;
    }
    if (timeText.indexOf('在 ') === 0) {
      return dayText + '的 ' + timeText.substring(2);
    }
    return dayText + '，' + timeText;
  }

  function pad4(value) {
    var text = '' + value;
    while (text.length < 4) {
      text = '0' + text;
    }
    return text;
  }

  function formatTime(date) {
    return pad4(date.getFullYear()) + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) +
      ' (' + DOW_NAMES[date.getDay()] + ')';
  }

  function findNextRuns(parsed, count, maxIterations) {
    var results = [];
    var minuteSet = {};
    var hourSet = {};
    var domSet = {};
    var monthSet = {};
    var dowSet = {};
    var i;
    var candidate;
    var iterations = 0;
    var domOk;
    var dowOk;

    for (i = 0; i < parsed.minutes.length; i++) {
      minuteSet[parsed.minutes[i]] = true;
    }
    for (i = 0; i < parsed.hours.length; i++) {
      hourSet[parsed.hours[i]] = true;
    }
    for (i = 0; i < parsed.doms.length; i++) {
      domSet[parsed.doms[i]] = true;
    }
    for (i = 0; i < parsed.months.length; i++) {
      monthSet[parsed.months[i]] = true;
    }
    for (i = 0; i < parsed.dows.length; i++) {
      dowSet[parsed.dows[i]] = true;
    }

    candidate = new Date();
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    while (results.length < count && iterations < maxIterations) {
      iterations++;
      if (monthSet[candidate.getMonth() + 1] === true &&
          hourSet[candidate.getHours()] === true &&
          minuteSet[candidate.getMinutes()] === true) {
        domOk = domSet[candidate.getDate()] === true;
        dowOk = dowSet[candidate.getDay()] === true;
        if (parsed.tokens[2] === '*' || parsed.tokens[4] === '*') {
          if (domOk && dowOk) {
            results.push(formatTime(candidate));
          }
        } else if (domOk || dowOk) {
          results.push(formatTime(candidate));
        }
      }
      candidate = new Date(candidate.getTime() + 60000);
    }

    return {
      list: results,
      truncated: iterations >= maxIterations
    };
  }

  function renderMessage(node, text, color) {
    if (!node) {
      return;
    }
    clearNode(node);
    node.textContent = text;
    node.style.color = color;
  }

  function renderNextRuns(node, runs, truncated) {
    var i;
    var line;
    if (!node) {
      return;
    }
    clearNode(node);
    for (i = 0; i < runs.length; i++) {
      line = document.createElement('div');
      line.textContent = (i + 1) + '. ' + runs[i];
      node.appendChild(line);
    }
    if (truncated) {
      line = document.createElement('div');
      line.textContent = '未能在合理范围内找到匹配时间（表达式可能存在冲突，如 2月30日）';
      line.style.color = '#FB7185';
      node.appendChild(line);
    }
  }

  function renderError(descNode, nextNode, error) {
    var message = error && error.message ? error.message : ('' + error);
    renderMessage(descNode, '✗ 表达式格式错误: ' + message, '#FB7185');
    if (nextNode) {
      clearNode(nextNode);
    }
  }

  var elements = {
    input: byId('cron-input'),
    desc: byId('cron-desc'),
    next: byId('cron-next'),
    min: byId('cron-min'),
    hour: byId('cron-hour'),
    dom: byId('cron-dom'),
    mon: byId('cron-mon'),
    dow: byId('cron-dow'),
    build: byId('cron-build'),
    built: byId('cron-built')
  };

  function updateFromInput() {
    var expression;
    var description;
    var parsed;
    var next;
    try {
      expression = elements.input ? elements.input.value : '';
      if (expression === undefined || expression === null) {
        expression = '';
      }
      description = describeCron(expression);
      renderMessage(elements.desc, '✓ ' + description, '#34D399');
      parsed = parseCron(expression);
      next = findNextRuns(parsed, NEXT_COUNT, MAX_ITERATIONS);
      renderNextRuns(elements.next, next.list, next.truncated);
    } catch (error) {
      try {
        renderError(elements.desc, elements.next, error);
      } catch (inner) {
        if (elements.desc) {
          elements.desc.textContent = '✗ 表达式格式错误: ' + (inner && inner.message ? inner.message : inner);
        }
      }
    }
  }

  function makeCopyLink(expression) {
    var link = document.createElement('a');
    link.href = '#';
    link.className = 'link';
    link.textContent = '[点击复制]';
    link.addEventListener('click', function (event) {
      event.preventDefault();
      try {
        if (window.TB && typeof window.TB.copy === 'function') {
          window.TB.copy(expression, link);
        } else if (window.prompt) {
          window.prompt('复制下面的表达式 (Ctrl+C):', expression);
        }
      } catch (error) {
        if (window.console && window.console.log) {
          window.console.log(error);
        }
      }
    });
    return link;
  }

  function renderBuiltResult(text, expression, description) {
    var line;
    if (!elements.built) {
      return;
    }
    clearNode(elements.built);
    line = document.createElement('div');
    line.appendChild(document.createTextNode(text));
    if (expression) {
      line.appendChild(makeCopyLink(expression));
    }
    elements.built.appendChild(line);
    if (description) {
      line = document.createElement('div');
      line.textContent = description;
      elements.built.appendChild(line);
    }
  }

  function buildAt() {
    var values = [];
    var fields = [elements.min, elements.hour, elements.dom, elements.mon, elements.dow];
    var expression;
    var i;
    try {
      for (i = 0; i < fields.length; i++) {
        if (!fields[i]) {
          renderBuiltResult('生成失败: 缺少第 ' + (i + 1) + ' 个输入框', '', '');
          return;
        }
        values.push(fields[i].value.replace(/^\s+|\s+$/g, ''));
      }
      expression = values.join(' ');
      if (expression.replace(/\s+/g, '') === '') {
        renderBuiltResult('生成失败: 请先填写五个字段', '', '');
        return;
      }
      if (elements.input) {
        elements.input.value = expression;
      }
      renderBuiltResult('生成结果: ' + expression + ' — 复制: ', expression, '');
      updateFromInput();
    } catch (error) {
      try {
        renderBuiltResult('生成失败: ' + (error && error.message ? error.message : error), '', '');
      } catch (inner) {
        if (elements.built) {
          elements.built.textContent = '生成失败';
        }
      }
    }
  }

  if (elements.input) {
    elements.input.addEventListener('input', updateFromInput);
  }
  if (elements.build) {
    elements.build.addEventListener('click', buildAt);
  }

  updateFromInput();
})();
