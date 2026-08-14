const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(id = '') {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    checked: false,
    value: '',
    textContent: '',
    title: '',
    innerHTML: '',
    disabled: false,
    draggable: false,
    options: [],
    selectedIndex: 0,
    children: [],
    className: '',
    dataset: {},
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      }
    },
    closest() {
      return createElement();
    },
    setAttribute() {},
    querySelectorAll() {
      return [];
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    dispatch(type) {
      listeners[type]();
    }
  };
}

function loadPopup() {
  const elements = {
    statusDot: createElement('statusDot'),
    enableToggle: createElement('enableToggle'),
    langSelect: createElement('langSelect'),
    ttsPlayModeSelect: createElement('ttsPlayModeSelect'),
    themeSelect: createElement('themeSelect'),
    apiBaseInput: createElement('apiBaseInput'),
    tokenInput: createElement('tokenInput'),
    modelInfo: createElement('modelInfo'),
    modelSelect: createElement('modelSelect'),
    shortcutKey: createElement('shortcutKey'),
    shortcutCustomizeButton: createElement('shortcutCustomizeButton'),
    favoritesList: createElement('favoritesList'),
    historyList: createElement('historyList'),
    reviewButton: createElement('reviewButton'),
    exportButton: createElement('exportButton'),
    copyFieldList: createElement('copyFieldList')
  };
  const storageChangeListeners = [];
  const createdTabs = [];
  let domReadyListener = null;

  const context = {
    console,
    DEFAULT_API_BASE: 'https://hover.sqw.org.cn',
    DEFAULT_THEME_MODE: 'system',
    THEME_MODE_KEY: 'themeMode',
    COPY_WORD_FIELDS_KEY: 'copyWordFields',
    COPY_WORD_FIELD_LABELS: { word: '单词', phonetic: '音标', definition: '释义' },
    getDefaultCopyWordFields() {
      return [
        { key: 'word', enabled: false },
        { key: 'phonetic', enabled: false },
        { key: 'definition', enabled: true }
      ];
    },
    normalizeCopyWordFields(value) {
      return Array.isArray(value) && value.length
        ? value
        : [
            { key: 'word', enabled: false },
            { key: 'phonetic', enabled: false },
            { key: 'definition', enabled: true }
          ];
    },
    normalizeThemeMode(mode) {
      return mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
    },
    resolveEffectiveTheme(mode) {
      if (mode === 'light' || mode === 'dark') return mode;
      return 'light';
    },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        addListener() {},
      };
    },
    document: {
      documentElement: {
        dataset: {},
      },
      addEventListener(type, listener) {
        if (type === 'DOMContentLoaded') domReadyListener = listener;
      },
      getElementById(id) {
        return elements[id];
      },
      createElement() {
        return createElement();
      }
    },
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            callback({
              enabled: true,
              apiBase: 'https://hover.sqw.org.cn',
              lookupHistory: [],
              favoriteLookups: []
            });
          },
          set() {}
        },
        onChanged: {
          addListener(listener) {
            storageChangeListeners.push(listener);
          }
        },
        sync: {
          get(keys, callback) {
            callback({});
          },
          set() {}
        }
      },
      runtime: {
        sendMessage() {
          return { catch() {} };
        },
        getURL(path) {
          return 'chrome-extension://test/' + path;
        }
      },
      tabs: {
        create(details) {
          createdTabs.push(details);
        }
      },
      commands: {
        getAll(callback) {
          callback([
            {
              name: 'toggle-enabled',
              shortcut: 'Command+Shift+L'
            }
          ]);
        }
      }
    },
    fetch: async () => {
      throw new Error('network disabled');
    },
    setTimeout,
    clearTimeout,
    AbortController
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'),
    context,
    { filename: 'popup.js' }
  );

  assert.equal(typeof domReadyListener, 'function');
  domReadyListener();

  return { elements, storageChangeListeners, createdTabs };
}

const harness = loadPopup();

assert.equal(harness.elements.shortcutKey.textContent, 'Command+Shift+L');
assert.equal(harness.elements.shortcutKey.title, 'Command+Shift+L');

harness.elements.shortcutCustomizeButton.dispatch('click');
assert.equal(harness.createdTabs.length, 1);
assert.equal(harness.createdTabs[0].url, 'chrome://extensions/shortcuts');

harness.elements.reviewButton.dispatch('click');
assert.equal(harness.createdTabs.length, 2);
assert.equal(harness.createdTabs[1].url, 'chrome-extension://test/review.html');

harness.storageChangeListeners[0](
  {
    enabled: { newValue: false }
  },
  'local'
);
assert.equal(harness.elements.enableToggle.checked, false);
