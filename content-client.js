// ========================================================================
// content-client.js — background Port streaming client
// ========================================================================

(function () {
  'use strict';

  const LCT = globalThis.LCT;
  const state = LCT.state;

  function disconnectActivePort() {
    if (state.activePort) {
      try { state.activePort.disconnect(); } catch {}
      state.activePort = null;
    }
  }

  async function startStreaming(request, handlers) {
    disconnectActivePort();

    const port = chrome.runtime.connect({ name: 'translate' });
    state.activePort = port;

    port.postMessage({
      type: 'TRANSLATE_STREAM',
      requestId: request.id,
      text: request.text,
      context: request.context || '',
      model: request.model || null,
      lang: request.lang
    });

    port.onMessage.addListener((msg) => {
      if (!isCurrent(request.id)) return;
      if (msg.requestId && msg.requestId !== request.id) return;
      handlers.onMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      if (state.activePort === port) state.activePort = null;
      if (!isCurrent(request.id)) return;
      if (chrome.runtime.lastError) {
        handlers.onError(new Error(chrome.runtime.lastError.message));
      }
    });
  }

  function isCurrent(requestId) {
    return requestId === state.activeRequestId;
  }

  LCT.client = {
    disconnectActivePort,
    startStreaming,
    isCurrent
  };
})();
