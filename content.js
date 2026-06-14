// ========================================================================
// content.js — content script entrypoint
// ========================================================================

(function () {
  'use strict';

  function init() {
    if (!document.body) return;
    globalThis.LCT.panel.initShadowDOM();
    globalThis.LCT.selection.init();
    // 同步生词本（TTL 节流，不会每个页面都打后端）
    if (globalThis.LCTFavorites) globalThis.LCTFavorites.sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
