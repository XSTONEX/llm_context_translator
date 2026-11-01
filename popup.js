// ========================================================================
// popup.js — 弹出窗口：总开关、外观，以及复习 / 设置两个入口
// 其余设置都在全屏设置页 options.html
// ========================================================================

'use strict';

const STATUS_CHECK_TIMEOUT = 3000;

document.addEventListener('DOMContentLoaded', init);

function init() {
  const els = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    shortcutKey: document.getElementById('shortcutKey'),
    reviewButton: document.getElementById('reviewButton'),
    settingsButton: document.getElementById('settingsButton'),
    enableSeg: document.getElementById('enableSeg'),
    themeSeg: document.getElementById('themeSeg')
  };

  let themeMode = DEFAULT_THEME_MODE;

  function markSeg(seg, value) {
    seg.querySelectorAll('button[data-value]').forEach((btn) => {
      const on = btn.dataset.value === value;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setEnabledView(enabled) {
    markSeg(els.enableSeg, enabled ? 'on' : 'off');
  }

  function setThemeView(mode) {
    themeMode = normalizeThemeMode(mode);
    markSeg(els.themeSeg, themeMode);
    document.documentElement.dataset.theme = resolveEffectiveTheme(themeMode);
  }

  chrome.storage.local.get(['enabled', 'apiBase', THEME_MODE_KEY], (result) => {
    setEnabledView(result.enabled !== false);
    setThemeView(result[THEME_MODE_KEY]);
    checkStatus(result.apiBase || DEFAULT_API_BASE, els);
  });

  els.enableSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    const enabled = btn.dataset.value === 'on';
    setEnabledView(enabled);
    chrome.storage.local.set({ enabled });
    chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED', enabled }).catch(() => {});
  });

  els.themeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    setThemeView(btn.dataset.value);
    chrome.storage.local.set({ [THEME_MODE_KEY]: themeMode });
  });

  els.reviewButton.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  });

  els.settingsButton.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });

  loadShortcut(els.shortcutKey);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) setEnabledView(changes.enabled.newValue !== false);
    if (changes[THEME_MODE_KEY]) setThemeView(changes[THEME_MODE_KEY].newValue);
  });

  try {
    const mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (themeMode === 'system') setThemeView('system');
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onSystemThemeChange);
    else if (mediaQuery.addListener) mediaQuery.addListener(onSystemThemeChange);
  } catch (e) {
    // matchMedia 不可用时忽略
  }

  // 打开 popup 时顺手同步一次生词本（换设备后第一次打开就能拉回来）
  if (typeof LCTFavorites !== 'undefined') LCTFavorites.sync({ force: true });
}

// 把 Chrome 里实际设置的快捷键写进提示；没设置时只留说明
function loadShortcut(el) {
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll((commands) => {
    const command = commands.find((item) => item.name === 'toggle-enabled');
    if (command && command.shortcut) el.textContent = command.shortcut;
    else el.parentElement.textContent = '暂停所有网站的划词';
  });
}

async function checkStatus(apiBase, els) {
  els.statusDot.className = 'status-dot is-checking';
  els.statusText.textContent = '检查中';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);
  try {
    const response = await fetch(`${apiBase}/api/status`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    els.statusDot.className = 'status-dot is-online';
    els.statusText.textContent = '后端已连接';
  } catch {
    els.statusDot.className = 'status-dot is-offline';
    els.statusText.textContent = '后端连接失败';
  } finally {
    clearTimeout(timeoutId);
  }
}
