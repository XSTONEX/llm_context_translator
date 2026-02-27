// ========================================================================
// popup.js — Popup 控制面板逻辑
// 职责：读写 chrome.storage、检测后端连通性、展示/切换模型
// ========================================================================

'use strict';

const STATUS_CHECK_TIMEOUT = 3000;

document.addEventListener('DOMContentLoaded', init);

function init() {
  const statusDot = document.getElementById('statusDot');
  const enableToggle = document.getElementById('enableToggle');
  const apiBaseInput = document.getElementById('apiBaseInput');
  const modelInfo = document.getElementById('modelInfo');
  const modelSelect = document.getElementById('modelSelect');

  // 加载已保存的设置（禁用过渡动画，防止开关闪动）
  const toggleSwitch = enableToggle.closest('.toggle-switch');
  toggleSwitch.classList.add('no-transition');

  chrome.storage.local.get(['enabled', 'apiBase', 'selectedModel'], (result) => {
    const enabled = result.enabled !== undefined ? result.enabled : true;
    const apiBase = result.apiBase || DEFAULT_API_BASE;
    const savedModel = result.selectedModel || null;

    enableToggle.checked = enabled;
    apiBaseInput.value = apiBase;

    // 强制重排后恢复过渡动画
    toggleSwitch.offsetHeight;
    toggleSwitch.classList.remove('no-transition');

    // 检测连通性 + 加载模型列表
    checkStatus(apiBase, statusDot, modelInfo);
    loadModels(apiBase, modelSelect, modelInfo, savedModel);
  });

  // Toggle 切换事件
  enableToggle.addEventListener('change', () => {
    const enabled = enableToggle.checked;
    chrome.storage.local.set({ enabled });
    chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED', enabled }).catch(() => {});
  });

  // 后端地址 blur 事件
  apiBaseInput.addEventListener('blur', () => {
    let value = apiBaseInput.value.trim();
    if (!value) {
      value = DEFAULT_API_BASE;
      apiBaseInput.value = value;
    }
    value = value.replace(/\/+$/, '');
    apiBaseInput.value = value;

    chrome.storage.local.set({ apiBase: value });
    checkStatus(value, statusDot, modelInfo);
    loadModels(value, modelSelect, modelInfo, null);
  });

  // Enter 键触发 blur
  apiBaseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apiBaseInput.blur();
  });

  // 模型选择变更
  modelSelect.addEventListener('change', () => {
    const selectedId = modelSelect.value;
    chrome.storage.local.set({ selectedModel: selectedId });

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    modelInfo.textContent = '当前模型: ' + selectedOption.text;
  });
}

async function loadModels(apiBase, selectEl, modelInfoEl, savedModel) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);

    const response = await fetch(`${apiBase}/api/models`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const models = data.models;
    const defaultModelId = data.default;

    // 清空并重建下拉选项
    selectEl.innerHTML = '';

    // 按 provider 分组
    const groups = {};
    for (const model of models) {
      if (!groups[model.provider]) {
        groups[model.provider] = [];
      }
      groups[model.provider].push(model);
    }

    // 构建 optgroup
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

    // 设置选中值
    const targetModel = savedModel || defaultModelId;
    if (targetModel) {
      selectEl.value = targetModel;
    }

    // 更新模型信息显示
    const selectedOption = selectEl.options[selectEl.selectedIndex];
    if (selectedOption) {
      modelInfoEl.textContent = '当前模型: ' + selectedOption.text;
    }

    // 缓存模型列表到 storage（供 content.js 显示名查找）
    chrome.storage.local.set({ modelList: models });

  } catch {
    selectEl.innerHTML = '<option value="">加载失败</option>';
  }
}

async function checkStatus(apiBase, statusDot, modelInfo) {
  setStatusDot(statusDot, 'checking');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);

  try {
    const response = await fetch(`${apiBase}/api/status`, {
      signal: controller.signal,
    });
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
