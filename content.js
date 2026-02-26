// ========================================================================
// content.js — 内容脚本（主控文件）
// 职责：Shadow DOM 初始化、选词监听、面板渲染、坐标计算、拖拽缩放
// ========================================================================

(function () {
  'use strict';

  // ========== 区域 1: 常量与状态 ==========

  const PANEL_WIDTH = 360;
  const PANEL_MIN_WIDTH = 280;
  const PANEL_MIN_HEIGHT = 200;
  const PANEL_GAP = 10;
  const DEBOUNCE_DELAY = 200;
  const WORD_THRESHOLD = 3;

  const state = {
    enabled: true,
    isPinned: false,
    isDragging: false,
    isResizing: false,
    isVisible: false,
    dragOffset: { x: 0, y: 0 },
    currentText: ''
  };

  // SVG 图标
  const ICONS = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>',
    close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    speaker: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
  };

  // ========== 区域 2: Shadow DOM 初始化 ==========

  let shadowRoot = null;
  let hostElement = null;
  let panelElement = null;

  function initShadowDOM() {
    hostElement = document.createElement('div');
    hostElement.id = 'lct-extension-host';
    hostElement.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(hostElement);

    shadowRoot = hostElement.attachShadow({ mode: 'open' });

    loadStyles();
  }

  async function loadStyles() {
    try {
      const cssURL = chrome.runtime.getURL('styles.css');
      const response = await fetch(cssURL);
      const cssText = await response.text();

      if (shadowRoot.adoptedStyleSheets !== undefined) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        shadowRoot.adoptedStyleSheets = [sheet];
      } else {
        const styleEl = document.createElement('style');
        styleEl.textContent = cssText;
        shadowRoot.appendChild(styleEl);
      }
    } catch (err) {
      console.error('[LCT] Failed to load styles:', err);
      // 降级：内联关键样式
      const styleEl = document.createElement('style');
      styleEl.textContent = getFallbackCSS();
      shadowRoot.appendChild(styleEl);
    }
  }

  function getFallbackCSS() {
    return '.lct-panel{all:initial;position:fixed;width:360px;max-height:480px;overflow-y:auto;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;z-index:2147483647;display:none;box-sizing:border-box;padding:16px;}.lct-panel *{box-sizing:border-box;}';
  }

  // ========== 区域 3: 选词监听 ==========

  let debounceTimer = null;

  function handleMouseUp(event) {
    // 未启用时不处理新翻译
    if (!state.enabled) return;

    // 拖拽或缩放过程中不处理
    if (state.isDragging || state.isResizing) return;

    // 点击在面板内部，不处理
    if (isEventInsidePanel(event)) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => processSelection(), DEBOUNCE_DELAY);
  }

  function processSelection() {
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    // 空选区 → 若非固定则关闭
    if (!selectedText) {
      if (state.isVisible && !state.isPinned) {
        hidePanel();
      }
      return;
    }

    // 选区内容未变 → 不重复触发
    if (selectedText === state.currentText && state.isVisible) return;

    state.currentText = selectedText;

    // 获取选区坐标
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // 提取上下文句子
    const contextSentence = extractContextSentence(selection);

    // 记录请求开始时间
    const startTime = Date.now();

    // 从 storage 读取选中模型，然后发起请求
    chrome.storage.local.get(['selectedModel'], (result) => {
      const model = result.selectedModel || null;

      // 显示渐进式面板骨架
      showProgressivePanel(rect);

      // 通过 Port 长连接实现流式通信
      const port = chrome.runtime.connect({ name: 'translate' });

      // 跟踪已接收的数据
      const receivedData = {
        query: null,
        isWord: null,
        phonetic: null,
        translation: null,
        definitions: null,
        contextAnalysis: null,
        keyExpressions: null
      };

      port.postMessage({
        type: 'TRANSLATE_STREAM',
        text: selectedText,
        context: contextSentence,
        model: model
      });

      port.onMessage.addListener((msg) => {
        switch (msg.type) {
          case 'field':
            receivedData[msg.name] = msg.value;
            updateProgressiveField(msg.name, msg.value, receivedData);
            break;

          case 'text':
            if (msg.name === 'translation') {
              receivedData.translation = msg.value;
              updateTranslationText(msg.value, receivedData);
            } else if (msg.name.startsWith('contextAnalysis.')) {
              const subfield = msg.name.split('.')[1];
              updateContextSubfield(subfield, msg.value);
            }
            break;

          case 'done': {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            // 原地定格：不再全量重绘，只做收尾
            finalizeStreamingPanel(msg.data, receivedData);
            showTimingBar(elapsed, model);
            repositionPanel(rect);
            port.disconnect();
            break;
          }

          case 'error':
            console.error('[LCT] Stream error:', msg.message);
            hidePanel();
            port.disconnect();
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
          console.error('[LCT] Port error:', chrome.runtime.lastError);
          hidePanel();
        }
      });
    });
  }

  function isWordMode(text) {
    const spaceCount = (text.match(/\s+/g) || []).length;
    return spaceCount <= WORD_THRESHOLD;
  }

  function extractContextSentence(selection) {
    try {
      const anchorNode = selection.anchorNode;
      if (!anchorNode) return '';

      // 获取选区所在的父级块元素的文本
      const parentEl =
        anchorNode.nodeType === Node.TEXT_NODE
          ? anchorNode.parentElement
          : anchorNode;
      if (!parentEl) return '';

      const fullText = parentEl.textContent || '';
      if (!fullText.trim()) return '';

      // 用句号/问号/感叹号/换行符分割为句子
      const selectedText = selection.toString().trim();
      const sentences = fullText.split(/(?<=[.?!。？！\n])\s*/);

      // 找到包含选中文本的句子
      for (const sentence of sentences) {
        if (sentence.includes(selectedText)) {
          return sentence.trim();
        }
      }

      // 退化：返回段落文本（截取前 500 字符）
      return fullText.trim().slice(0, 500);
    } catch {
      return '';
    }
  }

  function isEventInsidePanel(event) {
    if (!panelElement || !state.isVisible) return false;
    const path = event.composedPath();
    return path.some((el) => el === panelElement || el === hostElement);
  }

  // ========== 区域 4: 坐标计算与视口防溢出 ==========

  function calculatePosition(selectionRect) {
    const panelRect = panelElement.getBoundingClientRect();
    const panelW = panelRect.width || PANEL_WIDTH;
    const panelH = panelRect.height || 300;

    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    // 水平定位：左对齐选区
    let left = selectionRect.left;
    if (left + panelW > vpW - PANEL_GAP) {
      left = vpW - panelW - PANEL_GAP;
    }
    if (left < PANEL_GAP) {
      left = PANEL_GAP;
    }

    // 垂直定位：默认在选区下方
    let top = selectionRect.bottom + PANEL_GAP;
    if (top + panelH > vpH - PANEL_GAP) {
      // 下方溢出 → 翻转到上方
      top = selectionRect.top - panelH - PANEL_GAP;
    }
    if (top < PANEL_GAP) {
      top = PANEL_GAP;
    }

    return { left, top };
  }

  // ========== 区域 5: 面板 DOM 构建与渲染 ==========

  function ensurePanel() {
    if (panelElement) return;
    panelElement = document.createElement('div');
    panelElement.classList.add('lct-panel');
    panelElement.style.pointerEvents = 'auto';
    shadowRoot.appendChild(panelElement);
  }

  // ---- 渐进式面板（流式场景） ----

  function createSkeletonLines(...classes) {
    const frag = document.createDocumentFragment();
    classes.forEach((cls) => {
      const line = document.createElement('div');
      line.classList.add('lct-skeleton-line', cls);
      frag.appendChild(line);
    });
    return frag;
  }

  function showProgressivePanel(selectionRect) {
    ensurePanel();
    panelElement.innerHTML = '';

    // 工具栏
    panelElement.appendChild(buildToolbar());

    // Header 骨架（query + phonetic）
    const header = document.createElement('div');
    header.classList.add('lct-progressive-header');
    header.style.display = 'block';
    header.style.padding = 'var(--lct-padding-sm, 12px) var(--lct-padding, 16px) 0';
    header.appendChild(createSkeletonLines('lct-skeleton-medium', 'lct-skeleton-thick'));
    panelElement.appendChild(header);

    // Translation 骨架
    const transSection = document.createElement('div');
    transSection.classList.add('lct-progressive-translation');
    transSection.style.display = 'block';
    transSection.appendChild(createSkeletonLines('lct-skeleton-long'));
    panelElement.appendChild(transSection);

    // Definitions 骨架
    const defsSection = document.createElement('div');
    defsSection.classList.add('lct-progressive-definitions');
    defsSection.style.display = 'block';
    defsSection.appendChild(createSkeletonLines('lct-skeleton-short', 'lct-skeleton-medium'));
    panelElement.appendChild(defsSection);

    // ContextAnalysis 骨架
    const ctxSection = document.createElement('div');
    ctxSection.classList.add('lct-progressive-context');
    ctxSection.style.display = 'block';
    ctxSection.appendChild(createSkeletonLines('lct-skeleton-short', 'lct-skeleton-long', 'lct-skeleton-medium'));
    panelElement.appendChild(ctxSection);

    // KeyExpressions 骨架（长句模式才显示，初始隐藏）
    const exprSection = document.createElement('div');
    exprSection.classList.add('lct-progressive-expressions');
    exprSection.style.display = 'none';
    panelElement.appendChild(exprSection);

    // 底部状态栏占位区
    const statusBar = document.createElement('div');
    statusBar.classList.add('lct-status-bar');
    statusBar.style.display = 'none';
    panelElement.appendChild(statusBar);

    // 缩放手柄（从一开始就存在）
    const resizeHandle = document.createElement('div');
    resizeHandle.classList.add('lct-resize-handle');
    panelElement.appendChild(resizeHandle);

    bindPanelEvents();

    panelElement.style.display = 'block';
    panelElement.style.opacity = '0';
    panelElement.style.transform = 'scale(0.96) translateY(-4px)';
    panelElement.style.width = PANEL_WIDTH + 'px';
    panelElement.style.height = '';
    panelElement.style.maxHeight = '480px';

    requestAnimationFrame(() => {
      const pos = calculatePosition(selectionRect);
      panelElement.style.left = pos.left + 'px';
      panelElement.style.top = pos.top + 'px';

      requestAnimationFrame(() => {
        panelElement.style.opacity = '1';
        panelElement.style.transform = 'scale(1) translateY(0)';
        state.isVisible = true;
      });
    });
  }

  // ---- 渐进式字段更新 ----

  function updateProgressiveField(fieldName, value, receivedData) {
    if (!panelElement) return;

    switch (fieldName) {
      case 'query':
      case 'isWord':
        // query 和 isWord 都到齐后渲染 header
        if (receivedData.query !== null && receivedData.isWord !== null) {
          renderProgressiveHeader(receivedData);
        }
        break;

      case 'phonetic': {
        const header = panelElement.querySelector('.lct-progressive-header');
        if (header && header.style.display !== 'none' && value) {
          const existing = header.querySelector('.lct-phonetic');
          if (!existing) {
            const phonetic = document.createElement('span');
            phonetic.classList.add('lct-phonetic');
            phonetic.textContent = value;
            const wordSpan = header.querySelector('.lct-word');
            if (wordSpan) {
              wordSpan.after(phonetic);
            }
          }
        }
        break;
      }

      case 'definitions': {
        const section = panelElement.querySelector('.lct-progressive-definitions');
        if (section && value) {
          // 清除骨架占位，渲染释义
          section.style.display = 'block';
          section.innerHTML = '';
          const defsEl = buildDefinitions({ definitions: value, query: receivedData.query });
          while (defsEl.firstChild) {
            section.appendChild(defsEl.firstChild);
          }
          section.classList.add('lct-fade-in');
        }
        break;
      }

      case 'contextAnalysis': {
        // 如果已经由流式子字段事件渲染了 context card，跳过
        const section = panelElement.querySelector('.lct-progressive-context');
        if (section && value && !section.querySelector('.lct-context-label')) {
          section.style.display = 'block';
          section.innerHTML = '';
          const ctxEl = buildContextAnalysis({ contextAnalysis: value });
          while (ctxEl.firstChild) {
            section.appendChild(ctxEl.firstChild);
          }
          section.classList.add('lct-fade-in');
        }
        break;
      }

      case 'keyExpressions': {
        const section = panelElement.querySelector('.lct-progressive-expressions');
        if (section && value && value.length > 0) {
          section.style.display = 'block';
          section.innerHTML = '';
          const exprEl = buildKeyExpressions(value);
          while (exprEl.firstChild) {
            section.appendChild(exprEl.firstChild);
          }
          section.classList.add('lct-fade-in');
        }
        break;
      }
    }
  }

  function renderProgressiveHeader(receivedData) {
    const header = panelElement.querySelector('.lct-progressive-header');
    if (!header) return;

    // 清除骨架占位
    header.innerHTML = '';
    header.style.display = 'flex';
    header.style.padding = '';

    // 句子模式下隐藏 definitions 骨架（不会有释义）
    if (!receivedData.isWord) {
      const defsSection = panelElement.querySelector('.lct-progressive-definitions');
      if (defsSection) defsSection.style.display = 'none';
    }

    if (receivedData.isWord) {
      header.classList.add('lct-word-header');

      const word = document.createElement('span');
      word.classList.add('lct-word');
      word.textContent = receivedData.query;
      header.appendChild(word);

      if (receivedData.phonetic) {
        const phonetic = document.createElement('span');
        phonetic.classList.add('lct-phonetic');
        phonetic.textContent = receivedData.phonetic;
        header.appendChild(phonetic);
      }

      const speakerBtn = createIconButton('speaker', ICONS.speaker);
      speakerBtn.classList.add('lct-speaker');
      speakerBtn.title = '发音（暂未实现）';
      header.appendChild(speakerBtn);
    } else {
      header.classList.add('lct-sentence-section');

      const original = document.createElement('div');
      original.classList.add('lct-original');
      original.textContent = receivedData.query;
      header.appendChild(original);
    }

    header.classList.add('lct-fade-in');
  }

  function updateTranslationText(value, receivedData) {
    if (!panelElement) return;

    const section = panelElement.querySelector('.lct-progressive-translation');
    if (!section) return;

    section.style.display = 'block';

    let textEl = section.querySelector('.lct-translation-streaming');
    if (!textEl) {
      // 首次调用：清除骨架占位，创建流式文本节点
      section.innerHTML = '';

      textEl = document.createElement('div');
      textEl.classList.add('lct-translation-streaming');
      section.appendChild(textEl);

      // 添加闪烁光标
      const cursor = document.createElement('span');
      cursor.classList.add('lct-cursor');
      section.appendChild(cursor);
    }

    textEl.textContent = value;

    // 自动滚动到底部
    panelElement.scrollTop = panelElement.scrollHeight;
  }

  // ---- contextAnalysis 子字段流式更新 ----

  function ensureContextCardSkeleton() {
    const section = panelElement.querySelector('.lct-progressive-context');
    if (!section) return null;

    // 已构建过则直接返回
    if (section.querySelector('.lct-context-label')) return section;

    // 清除骨架占位，构建 context card 结构
    section.innerHTML = '';
    section.style.display = 'block';

    // 标题行
    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-context-title-row');
    const label = document.createElement('span');
    label.classList.add('lct-context-label');
    label.textContent = '语境解析';
    titleRow.appendChild(label);
    section.appendChild(titleRow);

    // 核心翻译容器（初始隐藏）
    const core = document.createElement('div');
    core.classList.add('lct-core-translation');
    core.style.display = 'none';
    const coreText = document.createElement('span');
    coreText.classList.add('lct-core-translation-text');
    core.appendChild(coreText);
    section.appendChild(core);

    // 详细解析容器（初始隐藏）
    const analysis = document.createElement('div');
    analysis.classList.add('lct-analysis-text');
    analysis.style.display = 'none';
    section.appendChild(analysis);

    // 用法说明容器（初始隐藏）
    const usage = document.createElement('div');
    usage.classList.add('lct-usage-text');
    usage.style.display = 'none';
    section.appendChild(usage);

    section.classList.add('lct-fade-in');
    return section;
  }

  function updateContextSubfield(subfield, value) {
    if (!panelElement) return;

    const section = ensureContextCardSkeleton();
    if (!section) return;

    // 子字段 → DOM 选择器映射
    const nodeMap = {
      coreTranslation: '.lct-core-translation-text',
      analysis: '.lct-analysis-text',
      usage: '.lct-usage-text'
    };

    const selector = nodeMap[subfield];
    if (!selector) return;

    const textNode = section.querySelector(selector);
    if (!textNode) return;

    // 设置文本内容
    textNode.textContent = value;

    // 显示容器
    if (subfield === 'coreTranslation') {
      textNode.parentElement.style.display = '';
    } else {
      textNode.style.display = '';
    }

    // 管理光标：只在当前活跃子字段末尾显示
    section.querySelectorAll('.lct-cursor').forEach((c) => c.remove());
    const container = subfield === 'coreTranslation' ? textNode.parentElement : textNode;
    let cursor = container.querySelector('.lct-cursor');
    if (!cursor) {
      cursor = document.createElement('span');
      cursor.classList.add('lct-cursor');
      container.appendChild(cursor);
    }

    // 自动滚动到底部
    panelElement.scrollTop = panelElement.scrollHeight;
  }

  function showTimingBar(elapsed, modelId) {
    if (!panelElement) return;

    const statusBar = panelElement.querySelector('.lct-status-bar');
    if (!statusBar) return;

    // 查找模型显示名称
    chrome.storage.local.get(['modelList'], (result) => {
      const models = result.modelList || [];
      const model = models.find((m) => m.id === modelId);
      const displayName = model ? model.name : (modelId || 'Default');

      statusBar.textContent = '\u23F1 ' + elapsed + 's \u00B7 ' + displayName;
      statusBar.style.display = 'block';
      statusBar.classList.add('lct-fade-in');
    });
  }

  // ---- 流式完成：原地定格 ----

  function finalizeStreamingPanel(data, receivedData) {
    if (!panelElement) return;

    // 1. 移除所有光标
    panelElement.querySelectorAll('.lct-cursor').forEach((c) => c.remove());

    // 2. 移除残留的骨架占位
    panelElement.querySelectorAll('.lct-skeleton-line').forEach((s) => s.remove());

    // 3. 移除 streaming indicator（如果还在）
    const indicator = panelElement.querySelector('.lct-streaming-indicator');
    if (indicator) indicator.remove();

    if (!data) return;

    // 4a. 兜底补全 header（如果 field 事件未到达）
    if (data.query !== undefined && data.isWord !== undefined) {
      const header = panelElement.querySelector('.lct-progressive-header');
      if (header && !header.querySelector('.lct-word') && !header.querySelector('.lct-original')) {
        renderProgressiveHeader(data);
      }
    }

    // 4b. 兜底补全：确保所有文本字段有完整值
    if (data.translation) {
      const transSection = panelElement.querySelector('.lct-progressive-translation');
      if (transSection && !transSection.querySelector('.lct-translation-streaming')) {
        // translation 的 text 事件可能从未到达，手动创建
        transSection.innerHTML = '';
        transSection.style.display = 'block';
        const textEl = document.createElement('div');
        textEl.classList.add('lct-translation-streaming');
        transSection.appendChild(textEl);
      }
    }
    ensureFieldComplete('.lct-translation-streaming', data.translation);
    if (data.contextAnalysis) {
      // 确保 context card 已构建
      ensureContextCardSkeleton();
      ensureFieldComplete('.lct-core-translation-text', data.contextAnalysis.coreTranslation);
      ensureFieldComplete('.lct-analysis-text', data.contextAnalysis.analysis);
      ensureFieldComplete('.lct-usage-text', data.contextAnalysis.usage);

      // 确保容器可见
      const section = panelElement.querySelector('.lct-progressive-context');
      if (section) {
        const core = section.querySelector('.lct-core-translation');
        if (core && data.contextAnalysis.coreTranslation) core.style.display = '';
        const analysis = section.querySelector('.lct-analysis-text');
        if (analysis && data.contextAnalysis.analysis) analysis.style.display = '';
        const usage = section.querySelector('.lct-usage-text');
        if (usage && data.contextAnalysis.usage) usage.style.display = '';
      }

      // 添加核心翻译的操作按钮（发音 + 复制）
      addCoreTranslationButtons(data.contextAnalysis.coreTranslation);
    }

    // 5. 如果 definitions 尚未渲染
    if (data.definitions && !receivedData.definitions) {
      updateProgressiveField('definitions', data.definitions, { ...receivedData, ...data });
    }

    // 6. 如果 keyExpressions 尚未渲染
    if (data.keyExpressions && data.keyExpressions.length > 0 && !receivedData.keyExpressions) {
      updateProgressiveField('keyExpressions', data.keyExpressions, { ...receivedData, ...data });
    }

    // 7. 隐藏未使用的骨架区域
    if (!data.definitions) {
      const defsSection = panelElement.querySelector('.lct-progressive-definitions');
      if (defsSection) defsSection.style.display = 'none';
    }
    if (!data.contextAnalysis) {
      const ctxSection = panelElement.querySelector('.lct-progressive-context');
      if (ctxSection) ctxSection.style.display = 'none';
    }
    if (!data.keyExpressions || data.keyExpressions.length === 0) {
      const exprSection = panelElement.querySelector('.lct-progressive-expressions');
      if (exprSection) exprSection.style.display = 'none';
    }

    // 8. 应用查询词高亮
    applyHighlighting(data.query);
  }

  function ensureFieldComplete(selector, value) {
    if (!value || !panelElement) return;
    const el = panelElement.querySelector(selector);
    if (el) el.textContent = value;
  }

  function addCoreTranslationButtons(coreTranslationText) {
    if (!panelElement || !coreTranslationText) return;
    const core = panelElement.querySelector('.lct-core-translation');
    if (!core || core.querySelector('[data-action="speaker"]')) return;

    const speakerBtn = createIconButton('speaker', ICONS.speaker);
    speakerBtn.title = '发音（暂未实现）';
    core.appendChild(speakerBtn);

    const copyBtn = createIconButton('copy-context', ICONS.copy);
    copyBtn.title = '复制核心翻译';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(coreTranslationText);
      copyBtn.classList.add('lct-copied');
      setTimeout(() => copyBtn.classList.remove('lct-copied'), 1500);
    });
    core.appendChild(copyBtn);
  }

  function applyHighlighting(query) {
    if (!query || !panelElement) return;

    // 高亮例句中的查询词
    panelElement.querySelectorAll('.lct-example').forEach((el) => {
      const text = el.textContent;
      if (text) el.innerHTML = highlightWord(text, query);
    });

    // 高亮分析文本中的查询词
    const analysisEl = panelElement.querySelector('.lct-analysis-text');
    if (analysisEl && analysisEl.textContent) {
      analysisEl.innerHTML = highlightWord(analysisEl.textContent, query);
    }
  }

  // ---- 最终面板渲染（非流式降级路径） ----

  function renderPanel(data, isWord) {
    ensurePanel();
    panelElement.innerHTML = '';

    // 工具栏
    panelElement.appendChild(buildToolbar());

    if (isWord) {
      // 单词模式
      panelElement.appendChild(buildWordHeader(data));
      panelElement.appendChild(buildDefinitions(data));
    } else {
      // 长句模式
      panelElement.appendChild(buildSentenceTranslation(data));
    }

    // 语境解析卡片
    panelElement.appendChild(buildContextAnalysis(data));

    // 高级表达卡片（仅长句模式）
    if (!isWord && data.keyExpressions && data.keyExpressions.length > 0) {
      panelElement.appendChild(buildKeyExpressions(data.keyExpressions));
    }

    // 底部状态栏占位（showTimingBar 会填充）
    const statusBar = document.createElement('div');
    statusBar.classList.add('lct-status-bar');
    statusBar.style.display = 'none';
    panelElement.appendChild(statusBar);

    // 缩放手柄
    const resizeHandle = document.createElement('div');
    resizeHandle.classList.add('lct-resize-handle');
    panelElement.appendChild(resizeHandle);

    // 绑定面板内部事件
    bindPanelEvents();
  }

  function repositionPanel(selectionRect) {
    requestAnimationFrame(() => {
      const pos = calculatePosition(selectionRect);
      panelElement.style.left = pos.left + 'px';
      panelElement.style.top = pos.top + 'px';
    });
  }

  function buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.classList.add('lct-toolbar');

    // 拖拽区域
    const dragZone = document.createElement('div');
    dragZone.classList.add('lct-drag-zone');

    // 6 个拖拽提示小圆点
    const dots = document.createElement('div');
    dots.classList.add('lct-drag-dots');
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement('div');
      dot.classList.add('lct-drag-dot');
      dots.appendChild(dot);
    }
    dragZone.appendChild(dots);
    toolbar.appendChild(dragZone);

    // 按钮组
    const actions = document.createElement('div');
    actions.classList.add('lct-toolbar-actions');
    actions.appendChild(createIconButton('copy', ICONS.copy));
    actions.appendChild(createIconButton('pin', ICONS.pin));
    actions.appendChild(createIconButton('close', ICONS.close));
    toolbar.appendChild(actions);

    return toolbar;
  }

  function createIconButton(name, svgHTML) {
    const btn = document.createElement('button');
    btn.classList.add('lct-icon-btn');
    btn.dataset.action = name;
    btn.innerHTML = svgHTML;
    return btn;
  }

  function buildWordHeader(data) {
    const header = document.createElement('div');
    header.classList.add('lct-word-header');

    const word = document.createElement('span');
    word.classList.add('lct-word');
    word.textContent = data.query;
    header.appendChild(word);

    if (data.phonetic) {
      const phonetic = document.createElement('span');
      phonetic.classList.add('lct-phonetic');
      phonetic.textContent = data.phonetic;
      header.appendChild(phonetic);
    }

    const speakerBtn = createIconButton('speaker', ICONS.speaker);
    speakerBtn.classList.add('lct-speaker');
    speakerBtn.title = '发音（暂未实现）';
    header.appendChild(speakerBtn);

    return header;
  }

  function buildDefinitions(data) {
    const container = document.createElement('div');
    container.classList.add('lct-definitions');

    if (!data.definitions || data.definitions.length === 0) return container;

    data.definitions.forEach((def) => {
      const item = document.createElement('div');
      item.classList.add('lct-def-item');

      const pos = document.createElement('span');
      pos.classList.add('lct-pos');
      pos.textContent = def.partOfSpeech;
      item.appendChild(pos);

      const meaning = document.createElement('span');
      meaning.classList.add('lct-meaning');
      meaning.textContent = def.meaning;
      item.appendChild(meaning);

      container.appendChild(item);

      // 例句
      if (def.examples && def.examples.length > 0) {
        def.examples.forEach((ex) => {
          const exEl = document.createElement('div');
          exEl.classList.add('lct-example');
          exEl.innerHTML = highlightWord(ex.sentence, data.query);
          container.appendChild(exEl);

          if (ex.translation) {
            const exTrans = document.createElement('div');
            exTrans.classList.add('lct-example-trans');
            exTrans.textContent = ex.translation;
            container.appendChild(exTrans);
          }
        });
      }
    });

    return container;
  }

  function highlightWord(sentence, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(' + escaped + ')', 'gi');
    // 安全处理：先转义 HTML，再插入 <mark>
    const safe = sentence
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return safe.replace(regex, '<mark class="lct-highlight">$1</mark>');
  }

  function buildSentenceTranslation(data) {
    const section = document.createElement('div');
    section.classList.add('lct-sentence-section');

    const original = document.createElement('div');
    original.classList.add('lct-original');
    original.textContent = data.query;
    section.appendChild(original);

    const translation = document.createElement('div');
    translation.classList.add('lct-translation');
    translation.textContent = data.translation;
    section.appendChild(translation);

    return section;
  }

  function buildContextAnalysis(data) {
    const card = document.createElement('div');
    card.classList.add('lct-context-card');

    if (!data.contextAnalysis) return card;

    // 标题行
    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-context-title-row');

    const label = document.createElement('span');
    label.classList.add('lct-context-label');
    label.textContent = '语境解析';
    titleRow.appendChild(label);

    card.appendChild(titleRow);

    // 核心翻译
    if (data.contextAnalysis.coreTranslation) {
      const core = document.createElement('div');
      core.classList.add('lct-core-translation');

      const coreText = document.createElement('span');
      coreText.textContent = data.contextAnalysis.coreTranslation;
      core.appendChild(coreText);

      // 发音图标占位
      const speakerBtn = createIconButton('speaker', ICONS.speaker);
      speakerBtn.title = '发音（暂未实现）';
      core.appendChild(speakerBtn);

      // 复制图标
      const copyBtn = createIconButton('copy-context', ICONS.copy);
      copyBtn.title = '复制核心翻译';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(data.contextAnalysis.coreTranslation);
        copyBtn.classList.add('lct-copied');
        setTimeout(() => copyBtn.classList.remove('lct-copied'), 1500);
      });
      core.appendChild(copyBtn);

      card.appendChild(core);
    }

    // 详细解析
    if (data.contextAnalysis.analysis) {
      const analysis = document.createElement('div');
      analysis.classList.add('lct-analysis-text');
      analysis.textContent = data.contextAnalysis.analysis;
      card.appendChild(analysis);
    }

    // 用法说明
    if (data.contextAnalysis.usage) {
      const usage = document.createElement('div');
      usage.classList.add('lct-usage-text');
      usage.textContent = data.contextAnalysis.usage;
      card.appendChild(usage);
    }

    return card;
  }

  function buildKeyExpressions(expressions) {
    const card = document.createElement('div');
    card.classList.add('lct-expressions-card');

    if (!expressions || expressions.length === 0) return card;

    // 标题行
    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-expressions-title-row');

    const label = document.createElement('span');
    label.classList.add('lct-expressions-label');
    label.textContent = '高级表达';
    titleRow.appendChild(label);

    card.appendChild(titleRow);

    // 每个表达项
    expressions.forEach((expr) => {
      const item = document.createElement('div');
      item.classList.add('lct-expression-item');

      const phrase = document.createElement('span');
      phrase.classList.add('lct-expression-phrase');
      phrase.textContent = expr.phrase;
      item.appendChild(phrase);

      const meaning = document.createElement('span');
      meaning.classList.add('lct-expression-meaning');
      meaning.textContent = expr.meaning;
      item.appendChild(meaning);

      card.appendChild(item);
    });

    return card;
  }

  // ========== 区域 6: 面板生命周期 ==========

  function hidePanel() {
    if (!panelElement || !state.isVisible) return;

    panelElement.style.opacity = '0';
    panelElement.style.transform = 'scale(0.96) translateY(-4px)';

    setTimeout(() => {
      if (panelElement) {
        panelElement.style.display = 'none';
      }
      state.isVisible = false;
      state.isPinned = false;
      state.currentText = '';

      // 重置钉子按钮状态
      if (panelElement) {
        const pinBtn = panelElement.querySelector('[data-action="pin"]');
        if (pinBtn) pinBtn.classList.remove('lct-active');
      }
    }, 200);
  }

  // ========== 区域 7: 面板内部事件 ==========

  function bindPanelEvents() {
    if (!panelElement) return;

    // 使用事件委托处理工具栏按钮
    panelElement.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      if (action === 'close') {
        hidePanel();
      } else if (action === 'pin') {
        togglePin();
      } else if (action === 'copy') {
        handleCopy(btn);
      }
    });

    // 拖拽
    const dragZone = panelElement.querySelector('.lct-drag-zone');
    if (dragZone) {
      dragZone.addEventListener('mousedown', onDragStart);
    }

    // 缩放
    const resizeHandle = panelElement.querySelector('.lct-resize-handle');
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', onResizeStart);
    }
  }

  function togglePin() {
    state.isPinned = !state.isPinned;
    const pinBtn = panelElement.querySelector('[data-action="pin"]');
    if (pinBtn) {
      pinBtn.classList.toggle('lct-active', state.isPinned);
    }
  }

  function handleCopy(btn) {
    navigator.clipboard.writeText(state.currentText).then(() => {
      btn.classList.add('lct-copied');
      setTimeout(() => btn.classList.remove('lct-copied'), 1500);
    });
  }

  // ========== 区域 8: 拖拽系统 ==========

  function onDragStart(e) {
    e.preventDefault();
    e.stopPropagation();

    state.isDragging = true;

    // 拖拽自动固定
    if (!state.isPinned) {
      state.isPinned = true;
      const pinBtn = panelElement.querySelector('[data-action="pin"]');
      if (pinBtn) pinBtn.classList.add('lct-active');
    }

    const panelRect = panelElement.getBoundingClientRect();
    state.dragOffset.x = e.clientX - panelRect.left;
    state.dragOffset.y = e.clientY - panelRect.top;

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = 'none';
  }

  function onDragMove(e) {
    if (!state.isDragging) return;

    const panelRect = panelElement.getBoundingClientRect();
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    let newLeft = e.clientX - state.dragOffset.x;
    let newTop = e.clientY - state.dragOffset.y;

    // 边界约束
    newLeft = Math.max(0, Math.min(newLeft, vpW - panelRect.width));
    newTop = Math.max(0, Math.min(newTop, vpH - panelRect.height));

    panelElement.style.left = newLeft + 'px';
    panelElement.style.top = newTop + 'px';
  }

  function onDragEnd() {
    state.isDragging = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.body.style.userSelect = '';
  }

  // ========== 区域 9: 缩放系统 ==========

  function onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();

    state.isResizing = true;

    const panelRect = panelElement.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = panelRect.width;
    const startH = panelRect.height;
    const panelLeft = panelRect.left;
    const panelTop = panelRect.top;

    function onResizeMove(e) {
      if (!state.isResizing) return;

      const vpW = window.innerWidth;
      const vpH = window.innerHeight;

      let newW = startW + (e.clientX - startX);
      let newH = startH + (e.clientY - startY);

      // 最小尺寸
      newW = Math.max(PANEL_MIN_WIDTH, newW);
      newH = Math.max(PANEL_MIN_HEIGHT, newH);

      // 最大尺寸：不超出视口
      newW = Math.min(newW, vpW - panelLeft);
      newH = Math.min(newH, vpH - panelTop);

      panelElement.style.width = newW + 'px';
      panelElement.style.height = newH + 'px';
      panelElement.style.maxHeight = 'none';
    }

    function onResizeEnd() {
      state.isResizing = false;
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeEnd);
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
    document.body.style.userSelect = 'none';
  }

  // ========== 区域 10: 全局事件绑定与初始化 ==========

  function init() {
    if (!document.body) return;

    // 从 storage 读取启用状态
    chrome.storage.local.get(['enabled'], (result) => {
      state.enabled = result.enabled !== undefined ? result.enabled : true;
    });

    // 监听 storage 变化，实时更新 enabled
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.enabled) {
        state.enabled = changes.enabled.newValue;
      }
    });

    initShadowDOM();

    // 选词监听
    document.addEventListener('mouseup', handleMouseUp, false);

    // ESC 关闭（忽略固定状态）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.isVisible) {
        hidePanel();
      }
    });

    // SPA 导航保护：如果宿主元素被移除，重新初始化
    const bodyObserver = new MutationObserver(() => {
      if (hostElement && !document.body.contains(hostElement)) {
        initShadowDOM();
      }
    });
    bodyObserver.observe(document.body, { childList: true });
  }

  // 确保 DOM 就绪后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
