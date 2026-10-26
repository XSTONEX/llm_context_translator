const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(tagName) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    className: '',
    innerHTML: '',
    textContent: '',
    title: '',
    attributes: {},
    listeners: {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    attachShadow() {
      const shadowRoot = createElement('shadow-root');
      shadowRoot.adoptedStyleSheets = [];
      return shadowRoot;
    },
    querySelector(selector) {
      return findElement(this, selector);
    },
    getBoundingClientRect() {
      return {
        left: Number.parseFloat(this.style.left) || 0,
        top: Number.parseFloat(this.style.top) || 0,
        width: Number.parseFloat(this.style.width) || 360,
        height: Number.parseFloat(this.style.height) || 300
      };
    }
  };

  let innerHTML = '';
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      if (value === '') {
        element.children.forEach((child) => {
          child.parentNode = null;
        });
        element.children = [];
      }
    }
  });

  const classes = new Set();
  element.classList = {
    add(...names) {
      names.forEach((name) => classes.add(name));
      element.className = Array.from(classes).join(' ');
    },
    remove(...names) {
      names.forEach((name) => classes.delete(name));
      element.className = Array.from(classes).join(' ');
    },
    contains(name) {
      return classes.has(name);
    },
    toggle(name, force) {
      const shouldAdd = force === undefined ? !classes.has(name) : force;
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      element.className = Array.from(classes).join(' ');
      return shouldAdd;
    }
  };

  return element;
}

function findElement(root, selector) {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = findElement(child, selector);
    if (nested) return nested;
  }
  return null;
}

function matches(element, selector) {
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }
  const actionMatch = selector.match(/^\[data-action="([^"]+)"\]$/);
  if (actionMatch) {
    return element.dataset.action === actionMatch[1];
  }
  return false;
}

function loadPanelModule(storageData) {
  const body = createElement('body');
  const docListeners = {};
  const context = {
    console,
    globalThis: {},
    window: { innerWidth: 1200, innerHeight: 800 },
    document: {
      body,
      createElement,
      addEventListener(type, listener) {
        docListeners[type] = listener;
      },
      removeEventListener(type) {
        delete docListeners[type];
      }
    },
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            keys.forEach((key) => {
              if (key in storageData) result[key] = storageData[key];
            });
            callback(result);
          },
          set(values) {
            Object.assign(storageData, values);
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        getURL() {
          return 'styles.css';
        }
      }
    },
    fetch: async () => ({ text: async () => '' }),
    CSSStyleSheet: function CSSStyleSheet() {
      this.replaceSync = () => {};
    },
    requestAnimationFrame(callback) {
      callback();
    },
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  context.LCT = context.globalThis.LCT = {
    state: {
      isPinned: false,
      isVisible: false,
      panelEventsBound: false,
      dragEventsBound: false,
      ttsCache: new Map()
    },
    constants: {
      PANEL_WIDTH: 360,
      PANEL_MIN_WIDTH: 280,
      PANEL_MIN_HEIGHT: 200,
      PANEL_GAP: 10
    },
    ICONS: {
      retry: '<svg></svg>',
      star: '<svg></svg>',
      copy: '<svg></svg>',
      pin: '<svg></svg>',
      close: '<svg></svg>',
      check: '<svg></svg>'
    },
    lang: {
      label: (lang) => lang
    },
    tts: {
      cleanup() {}
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'content-panel.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'content-panel.js' });
  context.LCT.docListeners = docListeners;
  return context.LCT;
}

const rect = { left: 100, right: 150, top: 100, bottom: 120 };
const noop = () => {};

// 1. 拖拽缩放：高度写进 max-height 而不是固定 height，并存进 storage
const storage = {};
let LCT = loadPanelModule(storage);
LCT.panel.showProgressivePanel(rect, { lang: 'en' });
let panel = LCT.panel.getPanel();
assert.equal(panel.style.width, '360px');
assert.equal(panel.style.maxHeight, '480px');

const handle = panel.querySelector('.lct-resize-handle');
handle.listeners.mousedown({ clientX: 500, clientY: 500, preventDefault: noop, stopPropagation: noop });
LCT.docListeners.mousemove({ clientX: 560, clientY: 600 });
assert.equal(panel.style.height, '');
assert.equal(panel.style.width, '420px');
assert.equal(panel.style.maxHeight, '400px');
LCT.docListeners.mouseup();
assert.deepEqual({ ...storage.panelSize }, { width: 420, height: 400 });

// 2. 新页面加载后，打开面板直接用记住的尺寸
LCT = loadPanelModule({ panelSize: { width: 420, height: 400 } });
LCT.panel.showProgressivePanel(rect, { lang: 'en' });
panel = LCT.panel.getPanel();
assert.equal(panel.style.width, '420px');
assert.equal(panel.style.height, '');
assert.equal(panel.style.maxHeight, '400px');

// 3. 记住的尺寸超出当前视口时按视口收窄
LCT = loadPanelModule({ panelSize: { width: 2000, height: 2000 } });
LCT.panel.showProgressivePanel(rect, { lang: 'en' });
panel = LCT.panel.getPanel();
assert.equal(panel.style.width, '1180px');
assert.equal(panel.style.maxHeight, '780px');

// 4. 存储里是脏数据时回退默认尺寸
LCT = loadPanelModule({ panelSize: { width: 'abc' } });
LCT.panel.showProgressivePanel(rect, { lang: 'en' });
panel = LCT.panel.getPanel();
assert.equal(panel.style.width, '360px');
assert.equal(panel.style.maxHeight, '480px');
