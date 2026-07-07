// ========================================================================
// popup.js — Popup 控制面板逻辑
// ========================================================================

'use strict';

const STATUS_CHECK_TIMEOUT = 3000;
const HISTORY_LIMIT = 50;

document.addEventListener('DOMContentLoaded', init);

function init() {
  const els = {
    statusDot: document.getElementById('statusDot'),
    enableToggle: document.getElementById('enableToggle'),
    langSelect: document.getElementById('langSelect'),
    ttsPlayModeSelect: document.getElementById('ttsPlayModeSelect'),
    apiBaseInput: document.getElementById('apiBaseInput'),
    tokenInput: document.getElementById('tokenInput'),
    modelInfo: document.getElementById('modelInfo'),
    modelSelect: document.getElementById('modelSelect'),
    shortcutKey: document.getElementById('shortcutKey'),
    shortcutCustomizeButton: document.getElementById('shortcutCustomizeButton'),
    favoritesList: document.getElementById('favoritesList'),
    historyList: document.getElementById('historyList'),
    reviewButton: document.getElementById('reviewButton'),
    exportButton: document.getElementById('exportButton'),
  };

  const toggleSwitch = els.enableToggle.closest('.toggle-switch');
  toggleSwitch.classList.add('no-transition');

  // 访问令牌存在 chrome.storage.sync（随 Chrome 账号跨设备同步）
  chrome.storage.sync.get(['accessToken'], (result) => {
    els.tokenInput.value = result.accessToken || '';
    // 读到 token 后再强制同步生词本（首次填 token 的场景也能立即拉取）
    if (typeof LCTFavorites !== 'undefined') LCTFavorites.sync({ force: true });
  });

  function saveToken() {
    const value = els.tokenInput.value.trim();
    chrome.storage.sync.get(['accessToken'], (result) => {
      if ((result.accessToken || '') === value) return;
      chrome.storage.sync.set({ accessToken: value }, () => {
        // 令牌变化后立即用新令牌重新同步生词本（首次填 token 无需重开 popup）
        if (typeof LCTFavorites !== 'undefined') LCTFavorites.sync({ force: true });
      });
    });
  }
  els.tokenInput.addEventListener('blur', saveToken);
  els.tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.tokenInput.blur();
  });

  chrome.storage.local.get(
    ['enabled', 'apiBase', 'selectedModel', 'sourceLangMode', 'targetLang', 'ttsPlayMode', 'lookupHistory', 'favoriteLookups'],
    (result) => {
      const enabled = result.enabled !== undefined ? result.enabled : true;
      const apiBase = result.apiBase || DEFAULT_API_BASE;
      const savedModel = result.selectedModel || null;
      const sourceLangMode = result.sourceLangMode || result.targetLang || 'auto';

      els.enableToggle.checked = enabled;
      els.apiBaseInput.value = apiBase;
      els.langSelect.value = sourceLangMode;
      els.ttsPlayModeSelect.value = result.ttsPlayMode || 'off';

      toggleSwitch.offsetHeight;
      toggleSwitch.classList.remove('no-transition');

      checkStatus(apiBase, els.statusDot, els.modelInfo);
      loadModels(apiBase, els.modelSelect, els.modelInfo, savedModel);
      loadShortcut(els.shortcutKey);
      renderLookupList(els.historyList, result.lookupHistory || [], { removable: false });
      renderLookupList(els.favoritesList, result.favoriteLookups || [], { removable: true });
    },
  );

  els.langSelect.addEventListener('change', () => {
    chrome.storage.local.set({
      sourceLangMode: els.langSelect.value,
      targetLang: els.langSelect.value === 'auto' ? 'en' : els.langSelect.value,
    });
  });

  els.ttsPlayModeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ ttsPlayMode: els.ttsPlayModeSelect.value });
  });

  els.enableToggle.addEventListener('change', () => {
    const enabled = els.enableToggle.checked;
    chrome.storage.local.set({ enabled });
    chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED', enabled }).catch(() => {});
  });

  els.shortcutCustomizeButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  els.reviewButton.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  });

  els.exportButton.addEventListener('click', () => {
    chrome.storage.local.get(['favoriteLookups'], (result) => {
      const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
      if (favorites.length === 0) {
        flashButton(els.exportButton, '暂无收藏');
        return;
      }
      const csv = buildFavoritesCsv(favorites);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadText(csv, `生词本_${stamp}.csv`, 'text/csv;charset=utf-8');
    });
  });

  els.apiBaseInput.addEventListener('blur', () => {
    let value = els.apiBaseInput.value.trim();
    if (!value) value = DEFAULT_API_BASE;
    value = value.replace(/\/+$/, '');
    els.apiBaseInput.value = value;

    chrome.storage.local.set({ apiBase: value });
    checkStatus(value, els.statusDot, els.modelInfo);
    loadModels(value, els.modelSelect, els.modelInfo, null);
  });

  els.apiBaseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.apiBaseInput.blur();
  });

  els.modelSelect.addEventListener('change', () => {
    const selectedId = els.modelSelect.value;
    chrome.storage.local.set({ selectedModel: selectedId });
    const selectedOption = els.modelSelect.options[els.modelSelect.selectedIndex];
    els.modelInfo.textContent = selectedOption ? '当前模型: ' + selectedOption.text : '当前模型: --';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lookupHistory) {
      renderLookupList(els.historyList, changes.lookupHistory.newValue || [], { removable: false });
    }
    if (changes.favoriteLookups) {
      renderLookupList(els.favoritesList, changes.favoriteLookups.newValue || [], { removable: true });
    }
    if (changes.enabled) {
      els.enableToggle.checked = changes.enabled.newValue !== undefined ? changes.enabled.newValue : true;
    }
  });
}

function loadShortcut(shortcutKeyEl) {
  if (!chrome.commands || !chrome.commands.getAll) {
    shortcutKeyEl.textContent = '未设置';
    return;
  }

  chrome.commands.getAll((commands) => {
    const command = commands.find((item) => item.name === 'toggle-enabled');
    shortcutKeyEl.textContent = command && command.shortcut ? command.shortcut : '未设置';
    shortcutKeyEl.title = shortcutKeyEl.textContent;
  });
}

async function loadModels(apiBase, selectEl, modelInfoEl, savedModel) {
  selectEl.disabled = true;
  selectEl.innerHTML = '<option value="">加载中...</option>';
  modelInfoEl.textContent = '当前模型: 正在加载';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);

    const response = await fetch(`${apiBase}/api/models`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const defaultModelId = data.default;

    selectEl.innerHTML = '';
    const groups = {};
    for (const model of models) {
      if (!groups[model.provider]) groups[model.provider] = [];
      groups[model.provider].push(model);
    }

    for (const [provider, providerModels] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = provider;
      for (const model of providerModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        optgroup.appendChild(option);
      }
      selectEl.appendChild(optgroup);
    }

    const targetModel = savedModel || defaultModelId;
    if (targetModel) selectEl.value = targetModel;
    if (!selectEl.value && selectEl.options.length > 0) selectEl.selectedIndex = 0;

    const selectedOption = selectEl.options[selectEl.selectedIndex];
    modelInfoEl.textContent = selectedOption ? '当前模型: ' + selectedOption.text : '当前模型: 无可用模型';
    selectEl.disabled = models.length === 0;
    chrome.storage.local.set({ modelList: models });
    // 把实际生效的选择写回 storage：换后端地址或已存模型下架时，
    // 避免翻译请求继续携带失效的旧模型 ID
    if (selectEl.value && selectEl.value !== savedModel) {
      chrome.storage.local.set({ selectedModel: selectEl.value });
    }
  } catch {
    chrome.storage.local.get(['modelList', 'selectedModel'], (result) => {
      const cachedModels = Array.isArray(result.modelList) ? result.modelList : [];
      if (cachedModels.length > 0) {
        hydrateModelSelect(selectEl, cachedModels, result.selectedModel);
        modelInfoEl.textContent = '当前模型: 使用缓存列表';
        selectEl.disabled = false;
      } else {
        selectEl.innerHTML = '<option value="">加载失败</option>';
        selectEl.disabled = true;
        modelInfoEl.textContent = '当前模型: 连接失败';
      }
    });
  }
}

function hydrateModelSelect(selectEl, models, savedModel) {
  selectEl.innerHTML = '';
  const groups = {};
  for (const model of models) {
    if (!groups[model.provider]) groups[model.provider] = [];
    groups[model.provider].push(model);
  }
  for (const [provider, providerModels] of Object.entries(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = provider;
    for (const model of providerModels) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      optgroup.appendChild(option);
    }
    selectEl.appendChild(optgroup);
  }
  if (savedModel) selectEl.value = savedModel;
}

async function checkStatus(apiBase, statusDot, modelInfo) {
  setStatusDot(statusDot, 'checking');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);

  try {
    const response = await fetch(`${apiBase}/api/status`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatusDot(statusDot, 'online');
  } catch {
    clearTimeout(timeoutId);
    setStatusDot(statusDot, 'offline');
    modelInfo.textContent = '当前模型: 连接失败';
  }
}

function setStatusDot(dot, status) {
  dot.className = 'status-dot';
  dot.classList.add(`status-${status}`);
}

function renderLookupList(container, items, options) {
  container.innerHTML = '';
  const visible = Array.isArray(items) ? items.slice(0, HISTORY_LIMIT) : [];
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.classList.add('empty-state');
    empty.textContent = options.removable ? '暂无收藏' : '暂无记录';
    container.appendChild(empty);
    return;
  }

  visible.forEach((item) => {
    const row = document.createElement('div');
    row.classList.add('lookup-item');

    const main = document.createElement('div');
    main.classList.add('lookup-main');
    const query = document.createElement('div');
    query.classList.add('lookup-query');
    query.textContent = item.query || '--';
    main.appendChild(query);
    const sub = document.createElement('div');
    sub.classList.add('lookup-sub');
    sub.textContent = [langLabel(item.lang), item.coreTranslation].filter(Boolean).join(' · ');
    main.appendChild(sub);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.classList.add('lookup-actions');
    const copyBtn = document.createElement('button');
    copyBtn.classList.add('mini-btn');
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.query || '');
    });
    actions.appendChild(copyBtn);

    if (options.removable) {
      const removeBtn = document.createElement('button');
      removeBtn.classList.add('mini-btn');
      removeBtn.textContent = '删除';
      removeBtn.addEventListener('click', () => removeFavorite(item));
      actions.appendChild(removeBtn);
    }

    row.appendChild(actions);
    container.appendChild(row);
  });
}

function removeFavorite(item) {
  chrome.storage.local.get(['favoriteLookups'], (result) => {
    const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
    const target = lookupKey(item);
    chrome.storage.local.set({
      favoriteLookups: favorites.filter((entry) => lookupKey(entry) !== target),
    });
    // 同步删除后端，否则下次同步时该词条会从后端拉回来（失败不阻塞本地删除）
    if (typeof LCTFavorites !== 'undefined') {
      LCTFavorites.remove(item.lang, item.query).catch(() => {});
    }
  });
}

function lookupKey(item) {
  return [item.lang || 'en', (item.query || '').trim().toLowerCase()].join('::');
}

function langLabel(lang) {
  return lang === 'ja' ? '日本語' : 'English';
}

// 把收藏导出为 CSV：正面=词条，背面=读音+释义，可直接导入 Anki / Excel
function buildFavoritesCsv(items) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['正面', '背面', '语言']];
  items.forEach((item) => {
    const front = item.query || '';
    const reading = item.phonetic ? '[' + item.phonetic + '] ' : '';
    const defs = (item.definitions || [])
      .map((d) => (d.partOfSpeech ? d.partOfSpeech + ' ' : '') + (d.meaning || ''))
      .filter(Boolean)
      .join('；');
    const core = item.coreTranslation || item.translation || '';
    const back = (reading + core).trim() + (defs ? '\n' + defs : '');
    rows.push([front, back, langLabel(item.lang)]);
  });
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

function downloadText(text, filename, mime) {
  // 加 UTF-8 BOM，保证 Excel 正确识别中文
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flashButton(btn, message) {
  const original = btn.textContent;
  btn.textContent = message;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}
