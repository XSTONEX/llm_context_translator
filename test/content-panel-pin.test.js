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

function loadPanelModule() {
  const body = createElement('body');
  const context = {
    console,
    globalThis: {},
    window: { innerWidth: 1200, innerHeight: 800 },
    document: {
      body,
      createElement,
      addEventListener() {},
      removeEventListener() {}
    },
    chrome: {
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
  return context.LCT;
}

const LCT = loadPanelModule();

LCT.panel.showProgressivePanel(
  { left: 100, right: 150, top: 100, bottom: 120 },
  { lang: 'en' }
);
const panel = LCT.panel.getPanel();
const firstLeft = panel.style.left;
const firstTop = panel.style.top;

LCT.state.isPinned = true;
const firstPinButton = panel.querySelector('[data-action="pin"]');
firstPinButton.classList.add('lct-active');

LCT.panel.showProgressivePanel(
  { left: 700, right: 760, top: 500, bottom: 530 },
  { lang: 'en' }
);

assert.equal(panel.style.left, firstLeft);
assert.equal(panel.style.top, firstTop);
assert.equal(LCT.state.isPinned, true);
assert.equal(panel.querySelector('[data-action="pin"]').classList.contains('lct-active'), true);
