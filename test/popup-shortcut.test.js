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
    options: [],
    selectedIndex: 0,
    children: [],
    className: '',
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
    apiBaseInput: createElement('apiBaseInput'),
    modelInfo: createElement('modelInfo'),
    modelSelect: createElement('modelSelect'),
    shortcutKey: createElement('shortcutKey'),
    shortcutCustomizeButton: createElement('shortcutCustomizeButton'),
    favoritesList: createElement('favoritesList'),
    historyList: createElement('historyList')
  };
  const storageChangeListeners = [];
  const createdTabs = [];
  let domReadyListener = null;

  const context = {
    console,
    DEFAULT_API_BASE: 'https://hover.sqw.org.cn',
    document: {
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
        }
      },
      runtime: {
        sendMessage() {
          return { catch() {} };
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
              shortcut: 'Command+Shift+Y'
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

assert.equal(harness.elements.shortcutKey.textContent, 'Command+Shift+Y');
assert.equal(harness.elements.shortcutKey.title, 'Command+Shift+Y');

harness.elements.shortcutCustomizeButton.dispatch('click');
assert.equal(harness.createdTabs.length, 1);
assert.equal(harness.createdTabs[0].url, 'chrome://extensions/shortcuts');

harness.storageChangeListeners[0](
  {
    enabled: { newValue: false }
  },
  'local'
);
assert.equal(harness.elements.enableToggle.checked, false);
