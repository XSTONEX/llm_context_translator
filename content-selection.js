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
    if (isEventInsidePanel(event) || LCT.trigger.containsEvent(event)) return;

    clearTimeout(debounceTimer);
    if (state.triggerMode === 'icon') {
      // 图标只是 DOM，不发请求，松手就显示：等 300ms 防抖的话，顺势一滑会在图标出现前就划过去。
      // 延到下一轮任务再读选区，双击/三击时以最后一次松手为准
      const pointer = { x: event.clientX, y: event.clientY };
      debounceTimer = setTimeout(() => processSelection(pointer), 0);
      return;
    }
    debounceTimer = setTimeout(() => processSelection(), constants.DEBOUNCE_DELAY);
  }

  // 每次松手递增；异步读设置期间若又松手，旧的这次作废
  let selectionSeq = 0;

  async function processSelection(pointer) {
    const seq = ++selectionSeq;
    const selection = window.getSelection();
    const rawText = selection ? selection.toString() : '';
    const selectedText = collapseWhitespace(rawText);

    if (!selectedText) {
      LCT.trigger.hide();
      if (state.isVisible && !state.isPinned) LCT.panel.hidePanel();
      return;
    }

    if (selectedText === state.currentText && state.isVisible) {
      LCT.trigger.hide();
      return;
    }
    if (!selection || selection.rangeCount === 0) return;

    const settings = await LCT.storage.getSettings();
    if (seq !== selectionSeq) return;
    const lang = LCT.lang.resolve(settings.sourceLangMode, selectedText);
    if (settings.wordsOnly && !isWordOrPhrase(selectedText, lang)) {
      LCT.trigger.hide();
      if (state.isVisible && !state.isPinned) LCT.panel.hidePanel();
      return;
    }

    // 在松手这一刻记下选区：触发时网页可能已改掉选区，翻译的必须是用户看到的这段
    const range = selection.getRangeAt(0);
    const snapshot = {
      text: selectedText,
      context: extractContext(range, rawText),
      rect: range.getBoundingClientRect(),
      model: settings.model,
      lang
    };

    if (state.triggerMode === 'icon' && pointer) {
      // 选中只是候选：未固定的旧面板先收起；固定面板保持原样，碰到图标才替换内容
      if (state.isVisible && !state.isPinned) LCT.panel.hidePanel();
      LCT.trigger.show(pointer, () => startLookup(snapshot));
      return;
    }

    await startLookup(snapshot);
  }

  async function startLookup(snapshot) {
    const apiBase = await LCT.storage.getApiBase();
    const request = {
      id: ++state.activeRequestId,
      text: snapshot.text,
      context: snapshot.context,
      rect: snapshot.rect,
      model: snapshot.model,
      lang: snapshot.lang,
      apiBase,
      startTime: Date.now()
    };

    state.currentText = snapshot.text;
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
    LCT.tts.autoPlay();
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
      LCT.tts.autoPlay();
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
                LCT.tts.autoPlay();
                ttsTriggered = true;
              } else if (msg.name === 'kana' && msg.value) {
                LCT.tts.fetchTTS(msg.value);
                LCT.tts.autoPlay();
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
            // 日语兜底：流式过程中没等到 kana（LLM 未返回或为空）时，
            // 用与缓存路径一致的规则（kana || query）触发 TTS，避免喇叭按钮失效
            if (request.lang === 'ja' && !ttsTriggered) {
              triggerTTS(request, msg.data);
              LCT.tts.autoPlay();
              ttsTriggered = true;
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


  // 网页源码的换行缩进、跨段的 \n\n 都压成一个空格；日文换行两侧是全角字符时直接拼上
  function collapseWhitespace(text) {
    return text
      .replace(/([\u3001-\u30ff\u3400-\u9fff\uff01-\uffef])\s*\n\s*(?=[\u3001-\u30ff\u3400-\u9fff\uff01-\uffef])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const CONTEXT_SIDE_LIMIT = 300;
  // 句末：英文标点（可带右引号/括号）后面是到头，或空白 + 大写/数字开头（避开 U.S. spends、3.14）；中日文标点直接算
  const SENTENCE_END = /[.?!]['"’”)\]]*(?=\s+['"‘“(\[]*[A-Z0-9]|\s*$)|[。？！]/g;

  // 选区所在的块级元素（段落 / 列表项 / 单元格…）；文字直接挂在 body 下时不取上下文
  function closestBlock(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const display = getComputedStyle(el).display;
      if (display !== 'inline' && display !== 'contents') return el;
      el = el.parentElement;
    }
    return null;
  }

  // 上下文 = 选区前补到句首 + 选区全文 + 选区后补到句末（两侧各不超过 CONTEXT_SIDE_LIMIT 字）。
  // 必须完整包含选区：只给其中一句的话，LLM 会以为用户只想翻那一句
  function extractContext(range, rawText) {
    try {
      let before = '';
      const startBlock = closestBlock(range.startContainer);
      if (startBlock) {
        const head = document.createRange();
        head.setStart(startBlock, 0);
        head.setEnd(range.startContainer, range.startOffset);
        before = head.toString().slice(-CONTEXT_SIDE_LIMIT);
        // 带上选区开头几个字再判断：before 以 "U.S. " 结尾时要看选区是不是小写开头
        let cut = -1;
        for (const match of (before + rawText.slice(0, 8)).matchAll(SENTENCE_END)) {
          if (match.index < before.length) cut = match.index + match[0].length;
        }
        if (cut >= 0) before = before.slice(cut);
      }

      let after = '';
      const endBlock = closestBlock(range.endContainer);
      if (endBlock && !/[.?!。？！]["'”’)\]]*$/.test(rawText.trim())) {
        const tail = document.createRange();
        tail.setStart(range.endContainer, range.endOffset);
        tail.setEnd(endBlock, endBlock.childNodes.length);
        after = tail.toString().slice(0, CONTEXT_SIDE_LIMIT);
        const match = after.match(new RegExp(SENTENCE_END.source));
        if (match) after = after.slice(0, match.index + match[0].length);
      }

      return collapseWhitespace(before + rawText + after);
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
    chrome.storage.local.get(['enabled', TTS_ENABLED_KEY, TRIGGER_MODE_KEY], (result) => {
      state.enabled = result.enabled !== undefined ? result.enabled : true;
      LCT.tts.setEnabled(resolveTtsEnabled(result[TTS_ENABLED_KEY]));
      state.triggerMode = normalizeTriggerMode(result[TRIGGER_MODE_KEY]);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.enabled) {
        handleToggle(changes.enabled.newValue);
      }
      if (area === 'local' && changes[TTS_ENABLED_KEY]) {
        LCT.tts.setEnabled(resolveTtsEnabled(changes[TTS_ENABLED_KEY].newValue));
      }
      if (area === 'local' && changes[TRIGGER_MODE_KEY]) {
        state.triggerMode = normalizeTriggerMode(changes[TRIGGER_MODE_KEY].newValue);
        if (state.triggerMode !== 'icon') LCT.trigger.hide({ immediate: true });
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
