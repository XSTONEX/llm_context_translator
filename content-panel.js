// ========================================================================
// content-panel.js — Shadow DOM, panel rendering, actions, drag/resize
// ========================================================================

(function () {
  'use strict';

  const LCT = globalThis.LCT;
  const state = LCT.state;
  const constants = LCT.constants;
  const ICONS = LCT.ICONS;

  let shadowRoot = null;
  let hostElement = null;
  let panelElement = null;
  let toastElement = null;
  let toastTimer = null;

  function getPanel() {
    return panelElement;
  }

  function getHost() {
    return hostElement;
  }

  function getShadowRoot() {
    return shadowRoot;
  }

  function initShadowDOM() {
    if (!document.body) return;
    if (hostElement && document.body.contains(hostElement)) return;

    hostElement = document.createElement('div');
    hostElement.id = 'lct-extension-host';
    hostElement.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(hostElement);

    shadowRoot = hostElement.attachShadow({ mode: 'open' });
    panelElement = null;
    state.panelEventsBound = false;
    state.dragEventsBound = false;

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
      const styleEl = document.createElement('style');
      styleEl.textContent = getFallbackCSS();
      shadowRoot.appendChild(styleEl);
    }
  }

  function getFallbackCSS() {
    return '.lct-panel{all:initial;position:fixed;width:360px;max-height:480px;overflow-y:auto;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;z-index:2147483647;display:none;box-sizing:border-box;padding:16px;}.lct-panel *{box-sizing:border-box;}';
  }

  function ensurePanel() {
    if (panelElement) return panelElement;
    if (!shadowRoot) initShadowDOM();
    panelElement = document.createElement('div');
    panelElement.classList.add('lct-panel');
    panelElement.style.pointerEvents = 'auto';
    shadowRoot.appendChild(panelElement);
    bindPanelEvents();
    return panelElement;
  }

  function calculatePosition(selectionRect) {
    const panelRect = panelElement.getBoundingClientRect();
    const panelW = panelRect.width || constants.PANEL_WIDTH;
    const panelH = panelRect.height || 300;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    let left = selectionRect.left;
    if (left + panelW > vpW - constants.PANEL_GAP) {
      left = vpW - panelW - constants.PANEL_GAP;
    }
    if (left < constants.PANEL_GAP) left = constants.PANEL_GAP;

    let top = selectionRect.bottom + constants.PANEL_GAP;
    if (top + panelH > vpH - constants.PANEL_GAP) {
      top = selectionRect.top - panelH - constants.PANEL_GAP;
    }
    if (top < constants.PANEL_GAP) top = constants.PANEL_GAP;

    return { left, top };
  }

  function repositionPanel(selectionRect) {
    if (!panelElement || !selectionRect || state.isPinned) return;
    requestAnimationFrame(() => {
      const pos = calculatePosition(selectionRect);
      panelElement.style.left = pos.left + 'px';
      panelElement.style.top = pos.top + 'px';
    });
  }

  function createIconButton(name, svgHTML, title) {
    const btn = document.createElement('button');
    btn.classList.add('lct-icon-btn');
    btn.dataset.action = name;
    btn.innerHTML = svgHTML;
    if (title) btn.title = title;
    btn.setAttribute('aria-label', title || name);
    return btn;
  }

  function buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.classList.add('lct-toolbar');

    const dragZone = document.createElement('div');
    dragZone.classList.add('lct-drag-zone');

    const dots = document.createElement('div');
    dots.classList.add('lct-drag-dots');
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement('div');
      dot.classList.add('lct-drag-dot');
      dots.appendChild(dot);
    }
    dragZone.appendChild(dots);
    toolbar.appendChild(dragZone);

    const actions = document.createElement('div');
    actions.classList.add('lct-toolbar-actions');
    actions.appendChild(createIconButton('retry', ICONS.retry, '重试'));
    const favoriteBtn = createIconButton('favorite', ICONS.star, '收藏');
    favoriteBtn.style.display = 'none';
    actions.appendChild(favoriteBtn);
    actions.appendChild(createIconButton('copy', ICONS.copy, '复制'));
    const pinBtn = createIconButton('pin', ICONS.pin, '固定');
    pinBtn.classList.toggle('lct-active', state.isPinned);
    actions.appendChild(pinBtn);
    actions.appendChild(createIconButton('close', ICONS.close, '关闭'));
    toolbar.appendChild(actions);

    return toolbar;
  }

  function appendResizeHandle() {
    const resizeHandle = document.createElement('div');
    resizeHandle.classList.add('lct-resize-handle');
    panelElement.appendChild(resizeHandle);
    bindDragResizeEvents();
  }

  function showProgressivePanel(selectionRect, request) {
    ensurePanel();
    const keepPinnedPosition = state.isPinned && state.isVisible;
    panelElement.innerHTML = '';

    panelElement.appendChild(buildToolbar());

    const loading = document.createElement('div');
    loading.classList.add('lct-initial-loading');
    const spinner = document.createElement('span');
    spinner.classList.add('lct-spinner');
    const text = document.createElement('span');
    text.textContent = '正在解析 ' + LCT.lang.label(request.lang) + '...';
    loading.appendChild(spinner);
    loading.appendChild(text);
    panelElement.appendChild(loading);

    appendResizeHandle();

    panelElement.style.display = 'block';
    if (keepPinnedPosition) {
      panelElement.style.opacity = '1';
      panelElement.style.transform = 'scale(1) translateY(0)';
      return;
    }

    panelElement.style.opacity = '0';
    panelElement.style.transform = 'scale(0.96) translateY(-4px)';
    panelElement.style.width = constants.PANEL_WIDTH + 'px';
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

  function ensureProgressiveScaffold(isWord) {
    if (!panelElement) return;
    if (panelElement.querySelector('.lct-progressive-header')) return;

    const loading = panelElement.querySelector('.lct-initial-loading');
    if (loading) loading.remove();
    const resize = panelElement.querySelector('.lct-resize-handle');
    if (resize) resize.remove();

    const header = document.createElement('div');
    header.classList.add('lct-progressive-header');
    panelElement.appendChild(header);

    if (!isWord) {
      const transSection = document.createElement('div');
      transSection.classList.add('lct-progressive-translation');
      transSection.appendChild(createSkeletonLines('lct-skeleton-long'));
      panelElement.appendChild(transSection);
    }

    if (isWord) {
      const morphSection = document.createElement('div');
      morphSection.classList.add('lct-progressive-morphology');
      morphSection.style.display = 'none';
      panelElement.appendChild(morphSection);

      const defsSection = document.createElement('div');
      defsSection.classList.add('lct-progressive-definitions');
      defsSection.appendChild(createSkeletonLines('lct-skeleton-short', 'lct-skeleton-medium'));
      panelElement.appendChild(defsSection);
    }

    const ctxSection = document.createElement('div');
    ctxSection.classList.add('lct-progressive-context');
    ctxSection.appendChild(createSkeletonLines('lct-skeleton-short', 'lct-skeleton-long', 'lct-skeleton-medium'));
    panelElement.appendChild(ctxSection);

    if (!isWord) {
      const syntaxSection = document.createElement('div');
      syntaxSection.classList.add('lct-progressive-syntax');
      syntaxSection.appendChild(createSkeletonLines('lct-skeleton-short', 'lct-skeleton-long', 'lct-skeleton-medium'));
      panelElement.appendChild(syntaxSection);

      const exprSection = document.createElement('div');
      exprSection.classList.add('lct-progressive-expressions');
      exprSection.style.display = 'none';
      panelElement.appendChild(exprSection);
    }

    const statusBar = document.createElement('div');
    statusBar.classList.add('lct-status-bar');
    statusBar.style.display = 'none';
    panelElement.appendChild(statusBar);

    appendResizeHandle();
  }

  function createSkeletonLines(...classes) {
    const frag = document.createDocumentFragment();
    classes.forEach((cls) => {
      const line = document.createElement('div');
      line.classList.add('lct-skeleton-line', cls);
      frag.appendChild(line);
    });
    return frag;
  }

  function renderLangMetaField(fieldName, value, lang) {
    if (!panelElement || (!value && value !== null)) return;
    const config = LCT.lang.metaConfig[lang] || LCT.lang.metaConfig.en;

    const headerField = config.headerFields.find((f) => f.key === fieldName);
    if (headerField) {
      if (!value) return;
      const header = panelElement.querySelector('.lct-progressive-header');
      if (header && !header.querySelector('.' + headerField.cls)) {
        const el = document.createElement('span');
        el.classList.add(headerField.cls);
        el.textContent = headerField.format(value);
        const speaker = header.querySelector('.lct-speaker');
        if (speaker) header.insertBefore(el, speaker);
        else header.appendChild(el);
      }
      return;
    }

    const section = config.extraSections.find((f) => f.key === fieldName);
    if (section && section.condition(value)) {
      if (!panelElement.querySelector('.' + section.cls)) {
        const el = document.createElement('div');
        el.classList.add(section.cls, 'lct-fade-in');
        el.textContent = section.format(value);
        const target = panelElement.querySelector('.lct-progressive-definitions');
        if (target) target.parentNode.insertBefore(el, target);
      }
    }
  }

  function updateProgressiveField(fieldName, value, receivedData) {
    if (!panelElement) return;

    switch (fieldName) {
      case 'query':
      case 'isWord':
        if (receivedData.query !== null && receivedData.isWord !== null) {
          ensureProgressiveScaffold(Boolean(receivedData.isWord));
          renderProgressiveHeader(receivedData);
        }
        break;

      case 'phonetic':
      case 'kana':
      case 'romaji':
      case 'dictionaryForm':
        renderLangMetaField(fieldName, value, receivedData.lang);
        break;

      case 'morphology':
        updateMorphology(value);
        break;

      case 'definitions':
        updateDefinitions(value, receivedData);
        break;

      case 'contextAnalysis':
        updateContextAnalysis(value);
        break;

      case 'syntaxAnalysis':
        updateSyntaxAnalysis(value, receivedData);
        break;

      case 'keyExpressions':
        updateKeyExpressions(value);
        break;
    }
  }

  function renderProgressiveHeader(receivedData) {
    const header = panelElement.querySelector('.lct-progressive-header');
    if (!header || header.dataset.rendered === 'true') return;

    header.innerHTML = '';
    header.dataset.rendered = 'true';
    header.style.display = 'flex';
    header.style.padding = '';

    if (receivedData.isWord) {
      header.classList.add('lct-word-header');

      const word = document.createElement('span');
      word.classList.add('lct-word');
      word.textContent = receivedData.query;
      header.appendChild(word);

      const langConfig = LCT.lang.metaConfig[receivedData.lang] || LCT.lang.metaConfig.en;
      langConfig.headerFields.forEach((field) => {
        if (receivedData[field.key]) {
          const el = document.createElement('span');
          el.classList.add(field.cls);
          el.textContent = field.format(receivedData[field.key]);
          header.appendChild(el);
        }
      });
    } else {
      header.classList.add('lct-sentence-section');
      const original = document.createElement('div');
      original.classList.add('lct-original');
      original.textContent = receivedData.query;
      header.appendChild(original);
    }

    const speakerBtn = createIconButton('speaker', ICONS.speaker, '发音');
    speakerBtn.classList.add('lct-speaker');
    header.appendChild(speakerBtn);
    header.classList.add('lct-fade-in');
    LCT.tts.updateSpeakerButtonState();
  }

  function updateTranslationText(value) {
    if (!panelElement) return;

    const section = panelElement.querySelector('.lct-progressive-translation');
    if (!section) return;

    section.style.display = 'block';
    let textEl = section.querySelector('.lct-translation-streaming');
    if (!textEl) {
      section.innerHTML = '';
      textEl = document.createElement('div');
      textEl.classList.add('lct-translation-streaming');
      section.appendChild(textEl);
      const cursor = document.createElement('span');
      cursor.classList.add('lct-cursor');
      section.appendChild(cursor);
    }

    textEl.textContent = value;
    panelElement.scrollTop = panelElement.scrollHeight;
  }

  function updateMorphology(value) {
    const section = panelElement.querySelector('.lct-progressive-morphology');
    if (!section || !Array.isArray(value) || value.length === 0) return;

    section.style.display = 'flex';
    section.innerHTML = '';
    value.forEach((item) => {
      if (!item || !item.form) return;
      const pill = document.createElement('span');
      pill.classList.add('lct-morphology-pill');
      pill.textContent = (item.type ? item.type + ': ' : '') + item.form;
      section.appendChild(pill);
    });
    section.classList.add('lct-fade-in');
  }

  function updateDefinitions(value, receivedData) {
    const section = panelElement.querySelector('.lct-progressive-definitions');
    if (!section || !value) return;
    section.style.display = 'block';
    section.innerHTML = '';
    const defsEl = buildDefinitions({ definitions: value, query: receivedData.query });
    while (defsEl.firstChild) section.appendChild(defsEl.firstChild);
    section.classList.add('lct-fade-in');
  }

  function updateContextAnalysis(value) {
    const section = panelElement.querySelector('.lct-progressive-context');
    if (section && value && !section.querySelector('.lct-context-label')) {
      section.style.display = 'block';
      section.innerHTML = '';
      const ctxEl = buildContextAnalysis({ contextAnalysis: value });
      while (ctxEl.firstChild) section.appendChild(ctxEl.firstChild);
      section.classList.add('lct-fade-in');
    }
  }

  function updateSyntaxAnalysis(value, receivedData) {
    const section = panelElement.querySelector('.lct-progressive-syntax');
    if (section && value && !section.querySelector('.lct-syntax-label')) {
      section.style.display = 'block';
      section.innerHTML = '';
      const syntaxEl = buildSyntaxAnalysis(value, receivedData.query, receivedData.lang);
      while (syntaxEl.firstChild) section.appendChild(syntaxEl.firstChild);
      section.classList.add('lct-fade-in');
    }
  }

  function updateKeyExpressions(value) {
    const section = panelElement.querySelector('.lct-progressive-expressions');
    if (section && value && value.length > 0) {
      section.style.display = 'block';
      section.innerHTML = '';
      const exprEl = buildKeyExpressions(value);
      while (exprEl.firstChild) section.appendChild(exprEl.firstChild);
      section.classList.add('lct-fade-in');
    }
  }

  function ensureContextCardSkeleton() {
    const section = panelElement.querySelector('.lct-progressive-context');
    if (!section) return null;
    if (section.querySelector('.lct-context-label')) return section;

    section.innerHTML = '';
    section.style.display = 'block';

    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-context-title-row');
    const label = document.createElement('span');
    label.classList.add('lct-context-label');
    label.textContent = '语境解析';
    titleRow.appendChild(label);
    section.appendChild(titleRow);

    const core = document.createElement('div');
    core.classList.add('lct-core-translation');
    core.style.display = 'none';
    const coreText = document.createElement('span');
    coreText.classList.add('lct-core-translation-text');
    core.appendChild(coreText);
    section.appendChild(core);

    const analysis = document.createElement('div');
    analysis.classList.add('lct-analysis-text');
    analysis.style.display = 'none';
    section.appendChild(analysis);

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

    const nodeMap = {
      coreTranslation: '.lct-core-translation-text',
      analysis: '.lct-analysis-text',
      usage: '.lct-usage-text'
    };
    const selector = nodeMap[subfield];
    if (!selector) return;

    const textNode = section.querySelector(selector);
    if (!textNode) return;
    textNode.textContent = value;

    if (subfield === 'coreTranslation') textNode.parentElement.style.display = '';
    else textNode.style.display = '';

    section.querySelectorAll('.lct-cursor').forEach((c) => c.remove());
    const container = subfield === 'coreTranslation' ? textNode.parentElement : textNode;
    const cursor = document.createElement('span');
    cursor.classList.add('lct-cursor');
    container.appendChild(cursor);
    panelElement.scrollTop = panelElement.scrollHeight;
  }

  function ensureSyntaxCardSkeleton() {
    const section = panelElement.querySelector('.lct-progressive-syntax');
    if (!section) return null;
    if (section.querySelector('.lct-syntax-label')) return section;

    section.innerHTML = '';
    section.style.display = 'block';

    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-syntax-title-row');
    const label = document.createElement('span');
    label.classList.add('lct-syntax-label');
    label.textContent = '语法拆解';
    titleRow.appendChild(label);
    section.appendChild(titleRow);

    const flowContainer = document.createElement('div');
    flowContainer.classList.add('lct-syntax-inline-flow');
    flowContainer.style.display = 'none';
    section.appendChild(flowContainer);

    const explanation = document.createElement('div');
    explanation.classList.add('lct-syntax-explanation');
    explanation.style.display = 'none';
    section.appendChild(explanation);

    section.classList.add('lct-fade-in');
    return section;
  }

  function updateSyntaxSubfield(subfield, value) {
    if (!panelElement) return;
    const section = ensureSyntaxCardSkeleton();
    if (!section || subfield !== 'structureExplanation') return;

    const textNode = section.querySelector('.lct-syntax-explanation');
    if (!textNode) return;
    textNode.textContent = value;
    textNode.style.display = '';

    section.querySelectorAll('.lct-cursor').forEach((c) => c.remove());
    const cursor = document.createElement('span');
    cursor.classList.add('lct-cursor');
    textNode.appendChild(cursor);
    panelElement.scrollTop = panelElement.scrollHeight;
  }

  function renderSpacedSyntax(container, components, query) {
    let currentIndex = 0;
    components.forEach((comp) => {
      if (comp.isOmitted) {
        appendSyntaxNode(container, comp, '(' + comp.text + ')', true);
        return;
      }

      const matchIndex = query.indexOf(comp.text, currentIndex);
      if (matchIndex !== -1) {
        if (matchIndex > currentIndex) {
          container.appendChild(document.createTextNode(query.substring(currentIndex, matchIndex)));
        }
        appendSyntaxNode(container, comp, comp.text, false);
        currentIndex = matchIndex + comp.text.length;
      } else {
        container.appendChild(document.createTextNode(comp.text + ' '));
      }
    });

    if (currentIndex < query.length) {
      container.appendChild(document.createTextNode(query.substring(currentIndex)));
    }
  }

  function renderUnspacedSyntax(container, components, query) {
    let currentIndex = 0;
    components.forEach((comp) => {
      if (comp.isOmitted) {
        appendSyntaxNode(container, comp, '(' + comp.text + ')', true);
        return;
      }

      const matchIndex = query.indexOf(comp.text, currentIndex);
      if (matchIndex !== -1) {
        if (matchIndex > currentIndex) {
          container.appendChild(document.createTextNode(query.substring(currentIndex, matchIndex)));
        }
        appendSyntaxNode(container, comp, comp.text, false);
        currentIndex = matchIndex + comp.text.length;
      } else {
        container.appendChild(document.createTextNode(comp.text));
      }
    });

    if (currentIndex < query.length) {
      container.appendChild(document.createTextNode(query.substring(currentIndex)));
    }
  }

  function appendSyntaxNode(container, comp, text, omitted) {
    const span = document.createElement('span');
    span.classList.add('lct-syntax-node');
    if (omitted) span.classList.add('lct-syntax-node--omitted');
    span.setAttribute('data-role', comp.role);
    span.setAttribute('data-type', comp.type);
    span.textContent = text;
    container.appendChild(span);
  }

  function renderInlineComponents(container, inlineComponents, query, lang) {
    container.innerHTML = '';
    if (!query) {
      inlineComponents.forEach((comp) => appendSyntaxNode(
        container,
        comp,
        comp.isOmitted ? '(' + comp.text + ')' : comp.text,
        Boolean(comp.isOmitted),
      ));
      return;
    }

    if (lang === 'ja') renderUnspacedSyntax(container, inlineComponents, query);
    else renderSpacedSyntax(container, inlineComponents, query);
  }

  function buildSyntaxAnalysis(syntaxAnalysis, query, lang) {
    const card = document.createElement('div');
    card.classList.add('lct-syntax-card');
    if (!syntaxAnalysis) return card;

    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-syntax-title-row');
    const label = document.createElement('span');
    label.classList.add('lct-syntax-label');
    label.textContent = '语法拆解';
    titleRow.appendChild(label);
    card.appendChild(titleRow);

    if (syntaxAnalysis.inlineComponents && syntaxAnalysis.inlineComponents.length > 0) {
      const flowContainer = document.createElement('div');
      flowContainer.classList.add('lct-syntax-inline-flow');
      renderInlineComponents(flowContainer, syntaxAnalysis.inlineComponents, query, lang);
      card.appendChild(flowContainer);
    }

    if (syntaxAnalysis.structureExplanation) {
      const explanation = document.createElement('div');
      explanation.classList.add('lct-syntax-explanation');
      explanation.textContent = syntaxAnalysis.structureExplanation;
      card.appendChild(explanation);
    }

    return card;
  }

  function showTimingBar(elapsed, modelId, lang) {
    if (!panelElement) return;
    const statusBar = panelElement.querySelector('.lct-status-bar');
    if (!statusBar) return;

    chrome.storage.local.get(['modelList'], (result) => {
      const models = result.modelList || [];
      const model = models.find((m) => m.id === modelId);
      const displayName = model ? model.name : (modelId || 'Default');
      statusBar.textContent = '\u23F1 ' + elapsed + 's · ' + LCT.lang.label(lang) + ' · ' + displayName;
      statusBar.style.display = 'block';
      statusBar.classList.add('lct-fade-in');
    });
  }

  function finalizeStreamingPanel(data, receivedData, request) {
    if (!panelElement) return;

    panelElement.querySelectorAll('.lct-cursor').forEach((c) => c.remove());
    panelElement.querySelectorAll('.lct-skeleton-line').forEach((s) => s.remove());
    const indicator = panelElement.querySelector('.lct-streaming-indicator');
    if (indicator) indicator.remove();

    if (!data) return;

    if (data.query !== undefined && data.isWord !== undefined) {
      ensureProgressiveScaffold(Boolean(data.isWord));
      const header = panelElement.querySelector('.lct-progressive-header');
      if (header && !header.querySelector('.lct-word') && !header.querySelector('.lct-original')) {
        renderProgressiveHeader({ ...data, lang: receivedData.lang });
      }
    }

    if (data.morphology && data.morphology.length > 0) updateMorphology(data.morphology);

    if (!data.isWord && data.translation) {
      const transSection = panelElement.querySelector('.lct-progressive-translation');
      if (transSection && !transSection.querySelector('.lct-translation-streaming')) {
        transSection.innerHTML = '';
        transSection.style.display = 'block';
        const textEl = document.createElement('div');
        textEl.classList.add('lct-translation-streaming');
        transSection.appendChild(textEl);
      }
      ensureFieldComplete('.lct-translation-streaming', data.translation);
    }

    if (data.contextAnalysis) {
      ensureContextCardSkeleton();
      ensureFieldComplete('.lct-core-translation-text', data.contextAnalysis.coreTranslation);
      ensureFieldComplete('.lct-analysis-text', data.contextAnalysis.analysis);
      ensureFieldComplete('.lct-usage-text', data.contextAnalysis.usage);

      const section = panelElement.querySelector('.lct-progressive-context');
      if (section) {
        const core = section.querySelector('.lct-core-translation');
        if (core && data.contextAnalysis.coreTranslation) core.style.display = '';
        const analysis = section.querySelector('.lct-analysis-text');
        if (analysis && data.contextAnalysis.analysis) analysis.style.display = '';
        const usage = section.querySelector('.lct-usage-text');
        if (usage && data.contextAnalysis.usage) usage.style.display = '';
      }

      addCoreTranslationButtons(data.contextAnalysis.coreTranslation);
    }

    if (data.syntaxAnalysis && !data.isWord) {
      ensureSyntaxCardSkeleton();
      const syntaxSection = panelElement.querySelector('.lct-progressive-syntax');
      if (syntaxSection) {
        if (data.syntaxAnalysis.inlineComponents && data.syntaxAnalysis.inlineComponents.length > 0) {
          let flowContainer = syntaxSection.querySelector('.lct-syntax-inline-flow');
          if (!flowContainer) {
            flowContainer = document.createElement('div');
            flowContainer.classList.add('lct-syntax-inline-flow');
            syntaxSection.appendChild(flowContainer);
          }
          flowContainer.style.display = '';
          renderInlineComponents(flowContainer, data.syntaxAnalysis.inlineComponents, data.query, receivedData.lang);
        }

        ensureFieldComplete('.lct-syntax-explanation', data.syntaxAnalysis.structureExplanation);
        const explanation = syntaxSection.querySelector('.lct-syntax-explanation');
        if (explanation && data.syntaxAnalysis.structureExplanation) explanation.style.display = '';
      }
    }

    const langConfig = LCT.lang.metaConfig[receivedData.lang] || LCT.lang.metaConfig.en;
    langConfig.extraSections.forEach((section) => {
      const val = data[section.key];
      if (val !== undefined && section.condition(val) && !panelElement.querySelector('.' + section.cls)) {
        renderLangMetaField(section.key, val, receivedData.lang);
      }
    });

    state.currentResponseData = data;

    if (data.definitions && !receivedData.definitions) {
      updateProgressiveField('definitions', data.definitions, { ...receivedData, ...data });
    }
    if (data.syntaxAnalysis && !receivedData.syntaxAnalysis && !data.isWord) {
      updateProgressiveField('syntaxAnalysis', data.syntaxAnalysis, { ...receivedData, ...data });
    }
    if (data.keyExpressions && data.keyExpressions.length > 0 && !receivedData.keyExpressions) {
      updateProgressiveField('keyExpressions', data.keyExpressions, { ...receivedData, ...data });
    }

    hideUnusedSections(data);
    applyHighlighting(data.query);
    syncFavoriteButton(data, request);
  }

  function hideUnusedSections(data) {
    if (!data.definitions || data.definitions.length === 0) {
      const defsSection = panelElement.querySelector('.lct-progressive-definitions');
      if (defsSection) defsSection.style.display = 'none';
    }
    if (!data.morphology || data.morphology.length === 0) {
      const morphSection = panelElement.querySelector('.lct-progressive-morphology');
      if (morphSection) morphSection.style.display = 'none';
    }
    if (!data.contextAnalysis) {
      const ctxSection = panelElement.querySelector('.lct-progressive-context');
      if (ctxSection) ctxSection.style.display = 'none';
    }
    if (!data.keyExpressions || data.keyExpressions.length === 0) {
      const exprSection = panelElement.querySelector('.lct-progressive-expressions');
      if (exprSection) exprSection.style.display = 'none';
    }
    if (!data.syntaxAnalysis || data.isWord) {
      const syntaxSection = panelElement.querySelector('.lct-progressive-syntax');
      if (syntaxSection) syntaxSection.style.display = 'none';
    }
    if (data.isWord) {
      const transSection = panelElement.querySelector('.lct-progressive-translation');
      if (transSection) transSection.style.display = 'none';
    }
  }

  function ensureFieldComplete(selector, value) {
    if (!value || !panelElement) return;
    const el = panelElement.querySelector(selector);
    if (el) el.textContent = value;
  }

  function addCoreTranslationButtons(coreTranslationText) {
    if (!panelElement || !coreTranslationText) return;
    const core = panelElement.querySelector('.lct-core-translation');
    if (!core || core.querySelector('[data-action="copy-context"]')) return;

    const copyBtn = createIconButton('copy-context', ICONS.copy, '复制核心翻译');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(coreTranslationText);
      showCopyFeedback(copyBtn);
    });
    core.appendChild(copyBtn);
  }

  function applyHighlighting(query) {
    if (!query || !panelElement) return;

    panelElement.querySelectorAll('.lct-example').forEach((el) => {
      const text = el.textContent;
      if (text) el.innerHTML = highlightWord(text, query);
    });

    const analysisEl = panelElement.querySelector('.lct-analysis-text');
    if (analysisEl && analysisEl.textContent) {
      analysisEl.innerHTML = highlightWord(analysisEl.textContent, query);
    }
  }

  function buildWordHeader(data, lang) {
    const header = document.createElement('div');
    header.classList.add('lct-word-header');

    const word = document.createElement('span');
    word.classList.add('lct-word');
    word.textContent = data.query;
    header.appendChild(word);

    const langConfig = LCT.lang.metaConfig[lang] || LCT.lang.metaConfig.en;
    langConfig.headerFields.forEach((field) => {
      if (data[field.key]) {
        const el = document.createElement('span');
        el.classList.add(field.cls);
        el.textContent = field.format(data[field.key]);
        header.appendChild(el);
      }
    });

    const speakerBtn = createIconButton('speaker', ICONS.speaker, '发音');
    speakerBtn.classList.add('lct-speaker');
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
    const safe = sentence
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return safe.replace(regex, '<mark class="lct-highlight">$1</mark>');
  }

  function buildContextAnalysis(data) {
    const card = document.createElement('div');
    card.classList.add('lct-context-card');
    if (!data.contextAnalysis) return card;

    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-context-title-row');
    const label = document.createElement('span');
    label.classList.add('lct-context-label');
    label.textContent = '语境解析';
    titleRow.appendChild(label);
    card.appendChild(titleRow);

    if (data.contextAnalysis.coreTranslation) {
      const core = document.createElement('div');
      core.classList.add('lct-core-translation');
      const coreText = document.createElement('span');
      coreText.classList.add('lct-core-translation-text');
      coreText.textContent = data.contextAnalysis.coreTranslation;
      core.appendChild(coreText);

      const copyBtn = createIconButton('copy-context', ICONS.copy, '复制核心翻译');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(data.contextAnalysis.coreTranslation);
        showCopyFeedback(copyBtn);
      });
      core.appendChild(copyBtn);
      card.appendChild(core);
    }

    if (data.contextAnalysis.analysis) {
      const analysis = document.createElement('div');
      analysis.classList.add('lct-analysis-text');
      analysis.textContent = data.contextAnalysis.analysis;
      card.appendChild(analysis);
    }

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

    const titleRow = document.createElement('div');
    titleRow.classList.add('lct-expressions-title-row');
    const label = document.createElement('span');
    label.classList.add('lct-expressions-label');
    label.textContent = '高级表达';
    titleRow.appendChild(label);
    card.appendChild(titleRow);

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

  function showErrorPanel(error, request) {
    ensurePanel();
    panelElement.innerHTML = '';
    panelElement.appendChild(buildToolbar());

    const card = document.createElement('div');
    card.classList.add('lct-error-card');

    const title = document.createElement('div');
    title.classList.add('lct-error-title');
    title.textContent = '翻译暂时失败';
    card.appendChild(title);

    const message = document.createElement('div');
    message.classList.add('lct-error-message');
    message.textContent = normalizeErrorMessage(error);
    card.appendChild(message);

    const meta = document.createElement('div');
    meta.classList.add('lct-error-meta');
    meta.textContent = request && request.apiBase ? '后端地址: ' + request.apiBase : '请检查后端地址与网络连接';
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.classList.add('lct-error-actions');
    const retryBtn = document.createElement('button');
    retryBtn.classList.add('lct-text-btn');
    retryBtn.dataset.action = 'retry';
    retryBtn.textContent = '重试';
    actions.appendChild(retryBtn);
    const settingsBtn = document.createElement('button');
    settingsBtn.classList.add('lct-text-btn', 'lct-text-btn-secondary');
    settingsBtn.dataset.action = 'open-settings';
    settingsBtn.textContent = '打开设置';
    actions.appendChild(settingsBtn);
    card.appendChild(actions);

    panelElement.appendChild(card);
    appendResizeHandle();
    panelElement.style.display = 'block';
    panelElement.style.opacity = '1';
    panelElement.style.transform = 'scale(1) translateY(0)';
    state.isVisible = true;
  }

  function normalizeErrorMessage(error) {
    const message = typeof error === 'string' ? error : (error && error.message) || '未知错误';
    if (message === 'The user aborted a request.') return '请求已取消';
    if (/failed to fetch/i.test(message)) return '无法连接后端服务';
    return message;
  }

  function showToast(message) {
    if (!shadowRoot) return;

    if (!toastElement) {
      toastElement = document.createElement('div');
      toastElement.classList.add('lct-toast');
      shadowRoot.appendChild(toastElement);
    }

    clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.style.display = 'block';
    toastElement.classList.remove('lct-toast-visible');
    toastElement.offsetHeight;
    toastElement.classList.add('lct-toast-visible');

    toastTimer = setTimeout(() => {
      toastElement.classList.remove('lct-toast-visible');
      setTimeout(() => {
        if (toastElement) toastElement.style.display = 'none';
      }, 300);
    }, 2000);
  }

  function hidePanel() {
    if (!panelElement || !state.isVisible) return;

    panelElement.style.opacity = '0';
    panelElement.style.transform = 'scale(0.96) translateY(-4px)';

    setTimeout(() => {
      if (panelElement) panelElement.style.display = 'none';
      state.isVisible = false;
      state.isPinned = false;
      state.currentText = '';
      state.currentResponseData = null;
      LCT.tts.cleanup();

      if (panelElement) {
        const pinBtn = panelElement.querySelector('[data-action="pin"]');
        if (pinBtn) pinBtn.classList.remove('lct-active');
      }
    }, 200);
  }

  function forceCleanup() {
    clearTimeout(LCT.selection.getDebounceTimer());
    LCT.selection.setDebounceTimer(null);
    LCT.client.disconnectActivePort();
    LCT.tts.cleanup();

    if (panelElement) {
      panelElement.style.transition = 'none';
      panelElement.style.display = 'none';
      panelElement.style.opacity = '0';
      requestAnimationFrame(() => {
        if (panelElement) panelElement.style.transition = '';
      });
    }

    state.isVisible = false;
    state.isPinned = false;
    state.isDragging = false;
    state.isResizing = false;
    state.currentText = '';
    state.currentResponseData = null;
    state.currentRequest = null;
  }

  function bindPanelEvents() {
    if (!panelElement || state.panelEventsBound) return;
    state.panelEventsBound = true;

    panelElement.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      if (action === 'close') {
        hidePanel();
      } else if (action === 'pin') {
        togglePin();
      } else if (action === 'copy') {
        handleCopy(btn);
      } else if (action === 'speaker') {
        LCT.tts.handleSpeakerClick();
      } else if (action === 'retry') {
        LCT.selection.retryCurrentRequest();
      } else if (action === 'favorite') {
        await handleFavorite(btn);
      } else if (action === 'open-settings') {
        showToast('请点击浏览器工具栏中的扩展图标打开设置');
      }
    });
  }

  function bindDragResizeEvents() {
    if (!panelElement) return;

    const dragZone = panelElement.querySelector('.lct-drag-zone');
    if (dragZone && !dragZone.dataset.bound) {
      dragZone.dataset.bound = 'true';
      dragZone.addEventListener('mousedown', onDragStart);
    }

    const resizeHandle = panelElement.querySelector('.lct-resize-handle');
    if (resizeHandle && !resizeHandle.dataset.bound) {
      resizeHandle.dataset.bound = 'true';
      resizeHandle.addEventListener('mousedown', onResizeStart);
    }
  }

  function togglePin() {
    state.isPinned = !state.isPinned;
    const pinBtn = panelElement.querySelector('[data-action="pin"]');
    if (pinBtn) pinBtn.classList.toggle('lct-active', state.isPinned);
  }

  function showCopyFeedback(btn) {
    const originalHTML = btn.innerHTML;
    btn.innerHTML = ICONS.check;
    btn.classList.add('lct-copied');
    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.classList.remove('lct-copied');
    }, 1500);
  }

  function handleCopy(btn) {
    const data = state.currentResponseData;
    let text;
    if (data && data.isWord && data.definitions && data.definitions.length > 0) {
      text = data.definitions.map((def) => `${def.partOfSpeech} ${def.meaning}`).join('\n');
    } else if (data && data.translation) {
      text = data.translation;
    } else {
      text = state.currentText;
    }
    navigator.clipboard.writeText(text || '').then(() => showCopyFeedback(btn));
  }

  async function handleFavorite(btn) {
    const data = state.currentResponseData;
    const request = state.currentRequest;
    if (!data || !data.isWord || !request) {
      showToast('仅单词模式可收藏');
      return;
    }
    const isFavorite = await LCT.storage.toggleFavorite(data, request);
    btn.classList.toggle('lct-active', isFavorite);
    showToast(isFavorite ? '已收藏' : '已取消收藏');
  }

  async function syncFavoriteButton(data, request) {
    const btn = panelElement && panelElement.querySelector('[data-action="favorite"]');
    if (!btn) return;
    btn.style.display = data && data.isWord ? '' : 'none';
    if (!data || !data.isWord) return;
    const isFavorite = await LCT.storage.isFavorite(data.query, request.lang);
    btn.classList.toggle('lct-active', isFavorite);
  }

  function onDragStart(e) {
    e.preventDefault();
    e.stopPropagation();
    state.isDragging = true;

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

    function onResizeMove(moveEvent) {
      if (!state.isResizing) return;
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;

      let newW = startW + (moveEvent.clientX - startX);
      let newH = startH + (moveEvent.clientY - startY);
      newW = Math.max(constants.PANEL_MIN_WIDTH, newW);
      newH = Math.max(constants.PANEL_MIN_HEIGHT, newH);
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

  LCT.panel = {
    initShadowDOM,
    getPanel,
    getHost,
    getShadowRoot,
    ensurePanel,
    showProgressivePanel,
    updateProgressiveField,
    updateTranslationText,
    updateContextSubfield,
    updateSyntaxSubfield,
    finalizeStreamingPanel,
    showTimingBar,
    repositionPanel,
    showErrorPanel,
    showToast,
    hidePanel,
    forceCleanup,
    createIconButton,
    showCopyFeedback
  };
})();
