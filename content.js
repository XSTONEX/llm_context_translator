// ========================================================================
// content.js — content script entrypoint
// ========================================================================

(function () {
  'use strict';

  function init() {
    if (!document.body) return;
    globalThis.LCT.panel.initShadowDOM();
    globalThis.LCT.selection.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
