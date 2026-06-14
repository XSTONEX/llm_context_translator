// ========================================================================
// content-selection.js — selection lifecycle, requests, retry, history
// ========================================================================

(function () {
  'use strict';

  const LCT = globalThis.LCT;
  const state = LCT.state;
  const constants = LCT.constants;

  let debounceTimer = null;
  let lastToggleValue = null;

  function getDebounceTimer() {
    return debounceTimer;
  }

  function setDebounceTimer(timer) {
    debounceTimer = timer;
  }

  function handleMouseUp(event) {
    if (!state.enabled) return;
    if (state.isDragging || state.isResizing) return;
    if (isEventInsidePanel(event)) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processSelection(), constants.DEBOUNCE_DELAY);
  }

  async function processSelection() {
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    if (!selectedText) {
      if (state.isVisible && !state.isPinned) LCT.panel.hidePanel();
      return;
    }

    if (selectedText === state.currentText && state.isVisible) return;
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const contextSentence = extractContextSentence(selection);

    const settings = await LCT.storage.getSettings();
    const lang = LCT.lang.resolve(settings.sourceLangMode, selectedText);
    const apiBase = await LCT.storage.getApiBase();
    const request = {
      id: ++state.activeRequestId,
      text: selectedText,
      context: contextSentence,
      rect,
      model: settings.model,
      lang,
      apiBase,
      startTime: Date.now()
    };

    state.currentText = selectedText;
    state.currentRequest = request;
    state.currentResponseData = null;

    // 缓存命中：直接渲染，不调用 LLM（重试按钮可强制刷新）
    const cached = await LCT.storage.getCachedLookup(request);
    if (cached) {
      serveFromCache(request, cached);
      return;
    }

    await runRequest(request);
  }

  function triggerTTS(request, data) {
    if (request.lang !== 'ja') {
      LCT.tts.fetchTTS(request.text);
      return;
    }
    const ttsText = (data && (data.kana || data.query)) || request.text;
    LCT.tts.fetchTTS(ttsText);
  }

  function serveFromCache(request, data) {
    if (!LCT.client.isCurrent(request.id)) return;
    triggerTTS(request, data);
    LCT.panel.showProgressivePanel(request.rect, request);
    LCT.panel.finalizeStreamingPanel(data, { lang: request.lang }, request);
    LCT.panel.showTimingBar(null, request.model, request.lang, true);
    LCT.panel.repositionPanel(request.rect);
    LCT.storage.addHistory(data, request);
  }

  async function retryCurrentRequest() {
    const previous = state.currentRequest;
    if (!previous) return;
    const request = {
      ...previous,
      id: ++state.activeRequestId,
      startTime: Date.now(),
      apiBase: await LCT.storage.getApiBase()
    };
    state.currentRequest = request;
    state.currentResponseData = null;
    await runRequest(request);
  }

  async function runRequest(request) {
    let ttsTriggered = false;
    if (request.lang !== 'ja') {
      LCT.tts.fetchTTS(request.text);
      ttsTriggered = true;
    } else {
      LCT.tts.cleanup();
    }

    LCT.panel.showProgressivePanel(request.rect, request);

    const receivedData = {
      lang: request.lang,
      query: null,
      isWord: null,
      phonetic: null,
      kana: null,
      romaji: null,
      dictionaryForm: null,
      morphology: null,
      translation: null,
      definitions: null,
      syntaxAnalysis: null,
      contextAnalysis: null,
      keyExpressions: null
    };

    LCT.client.startStreaming(request, {
      onMessage: async (msg) => {
        switch (msg.type) {
          case 'field':
            receivedData[msg.name] = msg.value;
            LCT.panel.updateProgressiveField(msg.name, msg.value, receivedData);
            if (request.lang === 'ja' && !ttsTriggered) {
              if (msg.name === 'isWord' && msg.value === false) {
                LCT.tts.fetchTTS(receivedData.query || request.text);
                ttsTriggered = true;
              } else if (msg.name === 'kana' && msg.value) {
                LCT.tts.fetchTTS(msg.value);
                ttsTriggered = true;
              }
            }
            break;

          case 'text':
            if (msg.name === 'translation') {
              if (!receivedData.isWord) {
                receivedData.translation = msg.value;
                LCT.panel.updateTranslationText(msg.value, receivedData);
              }
            } else if (msg.name.startsWith('syntaxAnalysis.')) {
              LCT.panel.updateSyntaxSubfield(msg.name.split('.')[1], msg.value);
            } else if (msg.name.startsWith('contextAnalysis.')) {
              LCT.panel.updateContextSubfield(msg.name.split('.')[1], msg.value);
            }
            break;

          case 'done': {
            if (!msg.data) {
              LCT.panel.showErrorPanel('后端连接中断，请重试', request);
              LCT.client.disconnectActivePort();
              break;
            }
            const elapsed = ((Date.now() - request.startTime) / 1000).toFixed(2);
            LCT.panel.finalizeStreamingPanel(msg.data, receivedData, request);
            LCT.panel.showTimingBar(elapsed, request.model, request.lang);
            LCT.panel.repositionPanel(request.rect);
            if (msg.data) {
              await LCT.storage.addHistory(msg.data, request);
              await LCT.storage.setCachedLookup(request, msg.data);
            }
            LCT.client.disconnectActivePort();
            break;
          }

          case 'error':
            LCT.panel.showErrorPanel(msg.message, request);
            LCT.client.disconnectActivePort();
            break;
        }
      },
      onError: (err) => {
        LCT.panel.showErrorPanel(err, request);
      }
    });
  }


  function extractContextSentence(selection) {
    try {
      const anchorNode = selection.anchorNode;
      if (!anchorNode) return '';

      const parentEl =
        anchorNode.nodeType === Node.TEXT_NODE
          ? anchorNode.parentElement
          : anchorNode;
      if (!parentEl) return '';

      const fullText = parentEl.textContent || '';
      if (!fullText.trim()) return '';

      const selectedText = selection.toString().trim();
      const sentences = fullText.split(/(?<=[.?!。？！\n])\s*/);

      for (const sentence of sentences) {
        if (sentence.includes(selectedText)) return sentence.trim();
      }

      return fullText.trim().slice(0, 500);
    } catch {
      return '';
    }
  }

  function isEventInsidePanel(event) {
    const panel = LCT.panel.getPanel();
    const host = LCT.panel.getHost();
    if (!panel || !state.isVisible) return false;
    const path = event.composedPath();
    return path.some((el) => el === panel || el === host);
  }

  function handleToggle(enabled) {
    if (enabled === lastToggleValue) return;
    lastToggleValue = enabled;
    state.enabled = enabled;

    if (!enabled) {
      LCT.panel.forceCleanup();
      LCT.panel.showToast('划词翻译已关闭');
    } else {
      LCT.panel.showToast('划词翻译已开启');
    }
  }

  function init() {
    chrome.storage.local.get(['enabled'], (result) => {
      state.enabled = result.enabled !== undefined ? result.enabled : true;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.enabled) {
        handleToggle(changes.enabled.newValue);
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'TOGGLE_ENABLED') {
        handleToggle(message.enabled);
        sendResponse({ received: true });
      }
      return false;
    });

    document.addEventListener('mouseup', handleMouseUp, false);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.isVisible) {
        LCT.panel.hidePanel();
      }
    });

    const bodyObserver = new MutationObserver(() => {
      const host = LCT.panel.getHost();
      if (host && !document.body.contains(host)) {
        LCT.panel.initShadowDOM();
      }
    });
    bodyObserver.observe(document.body, { childList: true });
  }

  LCT.selection = {
    init,
    retryCurrentRequest,
    getDebounceTimer,
    setDebounceTimer
  };
})();
