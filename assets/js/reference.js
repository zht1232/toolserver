// 速查表模块（HTTP状态码/ASCII/正则）
(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * 1. 静态数据集
   * ------------------------------------------------------------- */

  // HTTP 状态码：code 状态码 / name 英文名 / desc 中文说明
  var HTTP_DATA = [
    { code: '100', name: 'Continue', desc: '客户端应继续发送请求的剩余部分，服务器已收到请求头' },
    { code: '101', name: 'Switching Protocols', desc: '服务器应客户端请求切换协议，如升级到 WebSocket' },
    { code: '200', name: 'OK', desc: '请求成功，响应体包含所请求的资源' },
    { code: '201', name: 'Created', desc: '请求成功并创建了新资源，通常用于 POST 提交' },
    { code: '202', name: 'Accepted', desc: '请求已接受但尚未处理完成，处理结果异步返回' },
    { code: '204', name: 'No Content', desc: '请求成功但响应体为空，常用于删除或更新操作' },
    { code: '206', name: 'Partial Content', desc: '服务器成功返回资源的一部分，用于断点续传或分片下载' },
    { code: '301', name: 'Moved Permanently', desc: '资源已永久移动到新地址，后续请求都应使用新地址' },
    { code: '302', name: 'Found', desc: '资源临时移动到新地址，后续请求仍应使用原地址' },
    { code: '303', name: 'See Other', desc: '请用 GET 方法访问另一个地址查看结果，常用于表单提交后跳转' },
    { code: '304', name: 'Not Modified', desc: '资源未修改，可直接使用本地缓存，响应体为空' },
    { code: '307', name: 'Temporary Redirect', desc: '临时重定向且保持原有请求方法和请求体不变' },
    { code: '308', name: 'Permanent Redirect', desc: '永久重定向且保持原有请求方法和请求体不变' },
    { code: '400', name: 'Bad Request', desc: '请求报文存在语法错误或参数不合法，服务器无法理解' },
    { code: '401', name: 'Unauthorized', desc: '请求需要身份认证，客户端未提供或提供的凭证无效' },
    { code: '402', name: 'Payment Required', desc: '保留状态码，表示需要付费后才能访问该资源' },
    { code: '403', name: 'Forbidden', desc: '服务器理解请求但拒绝执行，通常是没有访问权限' },
    { code: '404', name: 'Not Found', desc: '请求的资源不存在' },
    { code: '405', name: 'Method Not Allowed', desc: '请求方法不被目标资源支持，如对只读接口发起 POST' },
    { code: '406', name: 'Not Acceptable', desc: '服务器无法生成符合请求头 Accept 要求的响应' },
    { code: '408', name: 'Request Timeout', desc: '服务器等待请求超时，客户端在约定时间内没有完成发送' },
    { code: '409', name: 'Conflict', desc: '请求与目标资源的当前状态冲突，如并发修改或重名' },
    { code: '410', name: 'Gone', desc: '资源已被永久删除且不会再提供，客户端应清除相关链接' },
    { code: '413', name: 'Payload Too Large', desc: '请求体超过了服务器允许处理的大小上限' },
    { code: '414', name: 'URI Too Long', desc: '请求的 URL 长度超过服务器能够处理的范围' },
    { code: '415', name: 'Unsupported Media Type', desc: '请求体的媒体类型不被服务器支持，如上传了错误的格式' },
    { code: '418', name: "I'm a teapot", desc: '愚人节玩笑状态码：服务器是一个茶壶，无法煮咖啡' },
    { code: '422', name: 'Unprocessable Entity', desc: '请求格式正确但语义有误，如字段校验失败' },
    { code: '429', name: 'Too Many Requests', desc: '在给定时间内请求次数过多，触发了限流' },
    { code: '500', name: 'Internal Server Error', desc: '服务器内部错误，遇到了未预期的异常' },
    { code: '501', name: 'Not Implemented', desc: '服务器不支持该请求所需的功能，尚未实现' },
    { code: '502', name: 'Bad Gateway', desc: '作为网关或代理的服务器从上游服务器收到无效响应' },
    { code: '503', name: 'Service Unavailable', desc: '服务器暂时无法处理请求，多因过载或停机维护' },
    { code: '504', name: 'Gateway Timeout', desc: '作为网关或代理的服务器等待上游服务器响应超时' },
    { code: '505', name: 'HTTP Version Not Supported', desc: '服务器不支持请求中使用的 HTTP 协议版本' }
  ];

  // ASCII 控制字符（0-31）与 127 的标准缩写
  var ASCII_CTRL = [
    'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
    'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
    'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
    'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'
  ];

  var CTRL_DESC = {
    NUL: '空字符',
    SOH: '标题开始',
    STX: '正文开始',
    ETX: '正文结束',
    EOT: '传输结束',
    ENQ: '询问',
    ACK: '确认应答',
    BEL: '响铃',
    BS: '退格',
    TAB: '水平制表符',
    LF: '换行',
    VT: '垂直制表符',
    FF: '换页',
    CR: '回车',
    SO: '移出（切换为备用字符集）',
    SI: '移入（切换回标准字符集）',
    DLE: '数据链路转义',
    DC1: '设备控制 1（XON）',
    DC2: '设备控制 2',
    DC3: '设备控制 3（XOFF）',
    DC4: '设备控制 4',
    NAK: '否定应答',
    SYN: '同步空闲',
    ETB: '传输块结束',
    CAN: '取消',
    EM: '介质中断',
    SUB: '替换',
    ESC: '转义',
    FS: '文件分隔符',
    GS: '组分隔符',
    RS: '记录分隔符',
    US: '单元分隔符',
    DEL: '删除',
    SPACE: '空格'
  };

  // 正则速查：title 用途 / pattern 表达式 / sample 示例
  var REGEX_DATA = [
    { title: '邮箱', pattern: '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$', sample: 'user.name+tag@example.co.uk' },
    { title: '手机号（中国大陆）', pattern: '^1[3-9]\\d{9}$', sample: '13812345678' },
    { title: 'URL', pattern: '^https?:\\/\\/[^\\s]+$', sample: 'https://example.com/a/b?x=1' },
    { title: 'IPv4 地址', pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$', sample: '192.168.1.1' },
    { title: '日期 YYYY-MM-DD', pattern: '^\\d{4}-\\d{2}-\\d{2}$', sample: '2024-05-20' },
    { title: '十六进制颜色', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$', sample: '#1a2b3c 或 #fff' },
    { title: '身份证号（18 位）', pattern: '^\\d{17}[\\dXx]$', sample: '11010519491231002X' },
    { title: '整数', pattern: '^-?\\d+$', sample: '-42' },
    { title: '浮点数', pattern: '^-?\\d+(\\.\\d+)?$', sample: '-3.14' },
    { title: '中文字符', pattern: '[\\u4e00-\\u9fa5]', sample: '中文abc' },
    { title: '空白行', pattern: '^\\s*$', sample: '（只含空格或制表符的一行）' },
    { title: 'HTML 标签', pattern: '<[^>]+>', sample: '<div class="box">' }
  ];

  // 生成 0-127 的 ASCII 表（十进制 / 十六进制 / 字符 / 说明）
  function buildAsciiData() {
    var list = [];
    var i;
    var name;
    var desc;
    for (i = 0; i < 128; i++) {
      if (i < 32) {
        name = ASCII_CTRL[i];
        desc = CTRL_DESC[name] || '控制字符';
      } else if (i === 32) {
        name = 'SPACE';
        desc = CTRL_DESC.SPACE;
      } else if (i === 127) {
        name = 'DEL';
        desc = CTRL_DESC.DEL;
      } else {
        name = String.fromCharCode(i);
        desc = '可打印字符';
      }
      list.push({
        dec: String(i),
        hex: '0x' + (i < 16 ? '0' + i.toString(16).toUpperCase() : i.toString(16).toUpperCase()),
        char: name,
        desc: desc
      });
    }
    return list;
  }

  // 三个数据集统一结构：data / columns / kinds
  var DATASETS = {
    http: {
      data: HTTP_DATA,
      columns: [
        { title: '状态码', key: 'code' },
        { title: '名称', key: 'name' },
        { title: '说明', key: 'desc' }
      ],
      kinds: ['code', 'name', 'desc']
    },
    ascii: {
      data: buildAsciiData(),
      columns: [
        { title: '十进制', key: 'dec' },
        { title: '十六进制', key: 'hex' },
        { title: '字符', key: 'char' },
        { title: '说明', key: 'desc' }
      ],
      kinds: ['dec', 'hex', 'char', 'desc']
    },
    regex: {
      data: REGEX_DATA,
      columns: [
        { title: '用途', key: 'title' },
        { title: '表达式', key: 'pattern' },
        { title: '示例', key: 'sample' }
      ],
      kinds: ['title', 'pattern', 'sample']
    }
  };

  var tabOrder = ['http', 'ascii', 'regex'];
  var currentType = 'http';
  var tabsRoot = null;
  var filterInput = null;
  var contentRoot = null;

  /* ---------------------------------------------------------------
   * 2. 工具函数
   * ------------------------------------------------------------- */

  // HTML 转义，避免正则表达式、HTML 标签示例等破坏页面结构
  function escapeHtml(value) {
    var text = (value === null || value === undefined) ? '' : String(value);
    text = text.replace(/&/g, '&amp;');
    text = text.replace(/</g, '&lt;');
    text = text.replace(/>/g, '&gt;');
    text = text.replace(/"/g, '&quot;');
    text = text.replace(/'/g, '&#39;');
    return text;
  }

  function normalizeType(type) {
    if (DATASETS[type]) {
      return type;
    }
    return 'http';
  }

  // 单条记录是否命中关键词（对所有字段做忽略大小写的包含匹配）
  function matchItem(item, fields, keyword) {
    var i;
    var value;
    if (!keyword) {
      return true;
    }
    for (i = 0; i < fields.length; i++) {
      value = item[fields[i]];
      if (value === null || value === undefined) {
        continue;
      }
      if (String(value).toLowerCase().indexOf(keyword) !== -1) {
        return true;
      }
    }
    return false;
  }

  function filterData(type, keyword) {
    var dataset = DATASETS[type];
    var result = [];
    var i;
    var raw = '';
    if (keyword) {
      raw = String(keyword).replace(/^\s+|\s+$/g, '').toLowerCase();
    }
    for (i = 0; i < dataset.data.length; i++) {
      if (matchItem(dataset.data[i], dataset.kinds, raw)) {
        result.push(dataset.data[i]);
      }
    }
    return result;
  }

  /* ---------------------------------------------------------------
   * 3. 渲染逻辑
   * ------------------------------------------------------------- */

  function buildTable(type, rows) {
    var dataset = DATASETS[type];
    var html = [];
    var i;
    var j;
    var col;
    var row;

    html.push('<table class="ftable mono">');

    html.push('<thead><tr>');
    for (j = 0; j < dataset.columns.length; j++) {
      col = dataset.columns[j];
      html.push('<th>' + escapeHtml(col.title) + '</th>');
    }
    html.push('</tr></thead>');

    if (rows.length === 0) {
      html.push('<tbody><tr><td class="muted" colspan="' + dataset.columns.length + '">没有匹配的结果</td></tr></tbody>');
    } else {
      html.push('<tbody>');
      for (i = 0; i < rows.length; i++) {
        row = rows[i];
        html.push('<tr>');
        for (j = 0; j < dataset.columns.length; j++) {
          col = dataset.columns[j];
          html.push('<td>' + escapeHtml(row[col.key]) + '</td>');
        }
        html.push('</tr>');
      }
      html.push('</tbody>');
    }

    html.push('</table>');
    return html.join('');
  }

  function render() {
    try {
      if (!contentRoot) {
        return;
      }
      currentType = normalizeType(currentType);
      var keyword = filterInput ? filterInput.value : '';
      var rows = filterData(currentType, keyword);
      contentRoot.innerHTML = buildTable(currentType, rows);
    } catch (e) {
      if (contentRoot) {
        contentRoot.innerHTML = '<p class="muted">渲染失败，请刷新页面重试</p>';
      }
    }
  }

  /* ---------------------------------------------------------------
   * 4. 事件绑定
   * ------------------------------------------------------------- */

  function setActiveTab(type) {
    var buttons = tabsRoot ? tabsRoot.getElementsByTagName('button') : null;
    var i;
    var button;
    var value;
    if (!buttons) {
      return;
    }
    for (i = 0; i < buttons.length; i++) {
      button = buttons[i];
      value = button.getAttribute('data-tab');
      if (value === type) {
        if (button.className.indexOf('active') === -1) {
          button.className = button.className ? button.className + ' active' : 'active';
        }
      } else {
        button.className = button.className.replace(/(^|\s)active(\s|$)/g, ' ').replace(/^\s+|\s+$/g, '');
      }
    }
  }

  function switchTab(type) {
    try {
      currentType = normalizeType(type);
      setActiveTab(currentType);
      // 保留筛选词，切换标签后继续用同一个关键词过滤
      render();
    } catch (e) {
      // 忽略异常，保持页面可用
    }
  }

  function onTabsClick(event) {
    try {
      var target = event.target || event.srcElement;
      var type = null;
      while (target && target !== tabsRoot) {
        if (target.getAttribute) {
          type = target.getAttribute('data-tab');
          if (type) {
            break;
          }
        }
        type = null;
        target = target.parentNode;
      }
      if (!type) {
        return;
      }
      if (tabOrder.indexOf(type) === -1) {
        return;
      }
      switchTab(type);
    } catch (e) {
      // 忽略异常
    }
  }

  function onFilterInput() {
    try {
      render();
    } catch (e) {
      // 忽略异常
    }
  }

  function findInitialTab() {
    var buttons = tabsRoot ? tabsRoot.getElementsByTagName('button') : null;
    var i;
    var value;
    if (!buttons) {
      return 'http';
    }
    for (i = 0; i < buttons.length; i++) {
      value = buttons[i].getAttribute('data-tab');
      if (value && DATASETS[value] && buttons[i].className.indexOf('active') !== -1) {
        return value;
      }
    }
    return 'http';
  }

  function init() {
    try {
      tabsRoot = document.getElementById('ref-tabs');
      filterInput = document.getElementById('ref-filter');
      contentRoot = document.getElementById('ref-content');

      if (tabsRoot) {
        tabsRoot.addEventListener('click', onTabsClick, false);
      }
      if (filterInput) {
        filterInput.addEventListener('input', onFilterInput, false);
      }

      // 页面加载时默认显示 HTML 中已带 active 的标签（缺省为 http 全部列表）
      currentType = findInitialTab();
      setActiveTab(currentType);
      render();
    } catch (e) {
      if (contentRoot) {
        contentRoot.innerHTML = '<p class="muted">初始化失败，请刷新页面重试</p>';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, false);
  } else {
    init();
  }
})();
