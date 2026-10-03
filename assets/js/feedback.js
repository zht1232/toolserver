/* 建议与反馈：只提交用户主动填写的文字，不上传本地文件。 */
(function () {
  'use strict';
  var type = document.getElementById('feedback-type');
  var message = document.getElementById('feedback-message');
  var contact = document.getElementById('feedback-contact');
  var status = document.getElementById('feedback-status');
  if (!type || !message || !contact || !status) return;

  function payload() {
    return { type: type.value, message: message.value.trim(), contact: contact.value.trim(), sentAt: new Date().toISOString() };
  }
  function text() {
    var p = payload();
    return '[LOCALTOOLS 反馈]\n类型：' + p.type + '\n内容：' + p.message + '\n联系方式：' + (p.contact || '未填写') + '\n时间：' + p.sentAt;
  }
  function setStatus(s, err) { status.textContent = s; status.className = 'logline mono' + (err ? ' err' : ''); }

  document.getElementById('feedback-copy').addEventListener('click', function (e) {
    if (!message.value.trim()) { setStatus('请先填写反馈内容。', true); return; }
    TB.copy(text(), e.currentTarget);
    setStatus('反馈内容已复制。');
  });
  document.getElementById('feedback-download').addEventListener('click', function () {
    if (!message.value.trim()) { setStatus('请先填写反馈内容。', true); return; }
    TB.download(new Blob([text()], { type: 'text/plain;charset=utf-8' }), 'localtools-feedback-' + Date.now() + '.txt');
    setStatus('反馈文件已下载。');
  });
  document.getElementById('feedback-submit').addEventListener('click', async function (e) {
    var p = payload();
    if (!p.message) { setStatus('请先填写反馈内容。', true); return; }
    var btn = e.currentTarget;
    btn.disabled = true;
    try {
      var r = await fetch('api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      var data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || '提交失败');
      setStatus('感谢反馈，已提交。');
      message.value = ''; contact.value = '';
    } catch (err) {
      setStatus('在线提交失败：' + err.message + '。可以使用复制或下载按钮发送。', true);
    }
    btn.disabled = false;
  });
})();
