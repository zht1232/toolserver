/* 专业修图工作区：按需加载 editor/ 里的 BitMappery 应用，避免首屏拉取编辑器资源。 */
(function () {
  'use strict';

  var frame = document.getElementById('retouch-frame');
  var stage = document.getElementById('retouch-stage');
  var cover = document.getElementById('retouch-cover');
  if (!frame || !stage || !cover) return;

  var loading = false;
  var loaded = false;

  function loadEditor() {
    if (loading || loaded) return;
    loading = true;
    // 立即让工作区可见；即使 iframe 的 load 事件在缓存命中时被错过，也不会卡在空白封面。
    frame.classList.remove('hidden');
    cover.classList.add('hidden');
    stage.classList.add('is-live');
    frame.addEventListener('load', function () {
      loading = false;
      loaded = true;
    }, { once: true });
    frame.src = 'editor/';
  }

  ['retouch-open', 'retouch-start'].forEach(function (id) {
    var btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', loadEditor);
  });
})();
