const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// vm 里建的对象原型不同，比较前先转成普通对象
const plain = (value) => JSON.parse(JSON.stringify(value));

// 只模拟 popup.js 用到的 DOM：分段按钮组、圆按钮、文字节点
function createButton(value) {
  const classes = new Set();
  const attrs = {};
  return {
    dataset: { value },
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      }
    },
    setAttribute(name, val) {
      attrs[name] = val;
    },
    getAttribute(name) {
      return attrs[name];
    },
    closest() {
      return this;
    }
  };
}

function createElement(values = []) {
  const listeners = {};
  const buttons = values.map(createButton);
  return {
    textContent: '',
    className: '',
    parentElement: { textContent: '' },
    buttons,
    querySelectorAll() {
      return buttons;
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    dispatch(type, target) {
      listeners[type]({ target });
    },
    pick(value) {
      this.dispatch('click', buttons.find((b) => b.dataset.value === value));
    },
    on() {
      return buttons.filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.value);
    }
  };
}

function loadPopup(storage = {}, shortcut = 'Command+Shift+L') {
  const elements = {
    statusDot: createElement(),
    statusText: createElement(),
    shortcutKey: createElement(),
    reviewButton: createElement(),
    settingsButton: createElement(),
    enableSeg: createElement(['on', 'off']),
    themeSeg: createElement(['system', 'light', 'dark'])
  };
  const storageChangeListeners = [];
  const createdTabs = [];
  const storageSets = [];
  const messages = [];
  let openedOptions = 0;
  let domReadyListener = null;
  const documentElement = { dataset: {} };

  const context = {
    console,
    document: {
      documentElement,
      addEventListener(type, listener) {
        if (type === 'DOMContentLoaded') domReadyListener = listener;
      },
      getElementById(id) {
        return elements[id];
      }
    },
    matchMedia() {
      return { matches: false, addEventListener() {}, addListener() {} };
    },
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            callback({ apiBase: 'https://hover.sqw.org.cn', ...storage });
          },
          set(values) {
            storageSets.push(values);
          }
        },
        onChanged: {
          addListener(listener) {
            storageChangeListeners.push(listener);
          }
        }
      },
      runtime: {
        sendMessage(message) {
          messages.push(message);
          return { catch() {} };
        },
        getURL(p) {
          return 'chrome-extension://test/' + p;
        },
        openOptionsPage() {
          openedOptions += 1;
        }
      },
      tabs: {
        create(details) {
          createdTabs.push(details);
        }
      },
      commands: {
        getAll(callback) {
          callback(shortcut ? [{ name: 'toggle-enabled', shortcut }] : [{ name: 'toggle-enabled', shortcut: '' }]);
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
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context, { filename: 'popup.js' });

  assert.equal(typeof domReadyListener, 'function');
  domReadyListener();

  return {
    elements,
    storageChangeListeners,
    createdTabs,
    storageSets,
    messages,
    documentElement,
    openedOptions: () => openedOptions
  };
}

// 初始状态：未存储时总开关开、外观跟随系统；快捷键写进提示
{
  const h = loadPopup();
  assert.deepEqual(h.elements.enableSeg.on(), ['on']);
  assert.deepEqual(h.elements.themeSeg.on(), ['system']);
  assert.equal(h.documentElement.dataset.theme, 'light');
  assert.equal(h.elements.shortcutKey.textContent, 'Command+Shift+L');
}

// 没设快捷键：只留说明
{
  const h = loadPopup({}, '');
  assert.equal(h.elements.shortcutKey.parentElement.textContent, '暂停所有网站的划词');
}

// 总开关：写 storage 并广播给各标签页
{
  const h = loadPopup({ enabled: true });
  h.elements.enableSeg.pick('off');
  assert.deepEqual(h.elements.enableSeg.on(), ['off']);
  assert.deepEqual(plain(h.storageSets[h.storageSets.length - 1]), { enabled: false });
  assert.deepEqual(plain(h.messages[h.messages.length - 1]), { type: 'TOGGLE_ENABLED', enabled: false });

  h.storageChangeListeners.forEach((fn) => fn({ enabled: { newValue: true } }, 'local'));
  assert.deepEqual(h.elements.enableSeg.on(), ['on']);
}

// 外观：改的是默认外观，弹窗自己也立刻换
{
  const h = loadPopup({ themeMode: 'light' });
  assert.deepEqual(h.elements.themeSeg.on(), ['light']);
  h.elements.themeSeg.pick('dark');
  assert.deepEqual(plain(h.storageSets[h.storageSets.length - 1]), { themeMode: 'dark' });
  assert.equal(h.documentElement.dataset.theme, 'dark');

  h.storageChangeListeners.forEach((fn) => fn({ themeMode: { newValue: 'system' } }, 'local'));
  assert.deepEqual(h.elements.themeSeg.on(), ['system']);

  // sync 区的变化不影响
  h.storageChangeListeners.forEach((fn) => fn({ themeMode: { newValue: 'dark' } }, 'sync'));
  assert.deepEqual(h.elements.themeSeg.on(), ['system']);
}

// 两个圆按钮：复习打开复习页，齿轮打开设置页
{
  const h = loadPopup();
  h.elements.reviewButton.dispatch('click', {});
  assert.equal(h.createdTabs[0].url, 'chrome-extension://test/review.html');
  h.elements.settingsButton.dispatch('click', {});
  assert.equal(h.openedOptions(), 1);
}

// popup 只留总开关和外观，其余设置都搬去了设置页
{
  const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.match(popupHtml, /id="enableSeg"/);
  assert.match(popupHtml, /id="themeSeg"/);
  assert.match(popupHtml, /id="reviewButton"/);
  assert.match(popupHtml, /id="settingsButton"/);
  assert.doesNotMatch(popupHtml, /id="tokenInput"|id="apiBaseInput"|id="favoritesList"/);

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.options_ui.page, 'options.html');
  assert.equal(manifest.options_ui.open_in_tab, true);
}

console.log('popup-shortcut.test.js: all passed');
