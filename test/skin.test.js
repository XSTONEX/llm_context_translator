const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// vm 里的对象换成本 realm 的，deepEqual 才不会因为原型不同而失败
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------- config：皮肤是全局一份，不进站点配置 ----------
{
  const context = { console };
  vm.createContext(context);
  vm.runInContext(read('config.js'), context);

  assert.equal(context.DEFAULT_SKIN, 'paper');
  assert.deepEqual(plain(context.SKINS), ['paper', 'clear']);
  assert.equal(context.normalizeSkin('clear'), 'clear');
  assert.equal(context.normalizeSkin('paper'), 'paper');
  assert.equal(context.normalizeSkin('lab'), 'paper');
  assert.equal(context.normalizeSkin(undefined), 'paper');

  assert.equal(context.SITE_SETTING_KEYS.includes('skin'), false, 'skin is not a per-site key');
  const profiles = context.normalizeSiteProfiles([{ domain: 'x.com', overrides: { skin: 'clear', ttsEnabled: false } }]);
  assert.deepEqual(plain(profiles), [{ domain: 'x.com', overrides: { ttsEnabled: false } }], 'site overrides drop skin');
}

// ---------- theme-boot：扩展页打开时尽早写上 data-skin ----------
function runThemeBoot(stored) {
  const documentElement = { dataset: {} };
  const context = {
    document: { documentElement },
    matchMedia: () => ({ matches: false }),
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            keys.forEach((key) => {
              if (key in stored) result[key] = stored[key];
            });
            callback(result);
          }
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(read('theme-boot.js'), context);
  return documentElement.dataset;
}

assert.equal(runThemeBoot({ skin: 'clear' }).skin, 'clear');
assert.equal(runThemeBoot({}).skin, 'paper');
assert.equal(runThemeBoot({ skin: 'nonsense', themeMode: 'dark' }).skin, 'paper');
assert.equal(runThemeBoot({ themeMode: 'dark' }).theme, 'dark');

// ---------- 网页面板：host 上的 data-skin 跟着设定走，明净不加载衬线字体 ----------
function createElement(tagName) {
  const classes = new Set();
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    attributes: {},
    listeners: {},
    textContent: '',
    innerHTML: '',
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    attachShadow() {
      const shadow = createElement('shadow-root');
      shadow.adoptedStyleSheets = [];
      return shadow;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    contains(node) {
      return this.children.includes(node);
    },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      }
    }
  };
  return element;
}

function loadPanel(stored) {
  const storageListeners = [];
  const fetched = [];
  const body = createElement('body');
  const context = {
    console,
    window: { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: {
      body,
      createElement,
      fonts: { add() {} },
      addEventListener() {},
      removeEventListener() {}
    },
    FontFace: function FontFace() {
      this.load = async () => this;
    },
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            keys.forEach((key) => {
              if (key in stored) result[key] = stored[key];
            });
            callback(result);
          },
          set(values) {
            Object.assign(stored, values);
          }
        },
        onChanged: {
          addListener(listener) {
            storageListeners.push(listener);
          }
        }
      },
      runtime: {
        getURL: (file) => file
      }
    },
    fetch: async (url) => {
      fetched.push(url);
      return { text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    },
    CSSStyleSheet: function CSSStyleSheet() {
      this.replaceSync = () => {};
    },
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  context.LCT = {
    state: { panelEventsBound: false, dragEventsBound: false, ttsCache: new Map() },
    constants: { PANEL_WIDTH: 360, PANEL_MIN_WIDTH: 280, PANEL_MIN_HEIGHT: 200, PANEL_GAP: 10 },
    ICONS: { retry: '', star: '', copy: '', pin: '', close: '', check: '' },
    settings: {
      load(callback) {
        if (callback) callback({ themeMode: 'system', copyWordFields: null });
      },
      get: () => ({ themeMode: 'system', copyWordFields: null }),
      onChange() {}
    },
    lang: { label: (lang) => lang },
    tts: { cleanup() {} }
  };
  vm.createContext(context);
  vm.runInContext(read('config.js'), context);
  vm.runInContext(read('content-panel.js'), context);

  return {
    panel: context.LCT.panel,
    fetched,
    change(changes) {
      storageListeners.forEach((listener) => listener(changes, 'local'));
    }
  };
}

(async () => {
  {
    const h = loadPanel({ skin: 'clear' });
    h.panel.initShadowDOM();
    assert.equal(h.panel.getHost().dataset.skin, 'clear');
    h.panel.ensurePanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.fetched.filter((url) => url.startsWith('fonts/')), [], 'clear skin loads no fonts');

    // 在设置页切回纸页：面板立刻换皮，并补上衬线字体
    h.change({ skin: { newValue: 'paper' } });
    assert.equal(h.panel.getHost().dataset.skin, 'paper');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(h.fetched.some((url) => url.startsWith('fonts/')), 'switching to paper loads the serif fonts');
  }

  {
    const h = loadPanel({});
    h.panel.initShadowDOM();
    assert.equal(h.panel.getHost().dataset.skin, 'paper', 'paper is the default skin');
    h.panel.ensurePanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(h.fetched.some((url) => url.startsWith('fonts/')), 'paper skin loads the serif fonts');
  }

  // ---------- 样式：两套皮肤各自有浅色和夜间 ----------
  const panelCss = read('styles.css');
  assert.match(panelCss, /:host\(\[data-skin="clear"\]\) \{/);
  assert.match(panelCss, /:host\(\[data-skin="clear"\]\[data-theme="dark"\]\) \{/);

  const clearCss = read('clear.css');
  assert.match(clearCss, /:root\[data-skin="clear"\] \{/);
  assert.match(clearCss, /:root\[data-skin="clear"\]\[data-theme="dark"\] \{/);

  // clear.css 要排在页面自己的样式后面，同等优先级时才盖得住
  ['popup.html', 'options.html', 'review.html'].forEach((file) => {
    const html = read(file);
    assert.match(html, /<script src="theme-boot\.js"><\/script>/, file + ' boots theme and skin');
    const styleEnd = html.indexOf('</style>');
    const clearLink = html.indexOf('<link rel="stylesheet" href="clear.css">');
    assert.ok(clearLink > styleEnd && styleEnd > 0, file + ' links clear.css after its own styles');
  });

  // ---------- 设置页：皮肤只在默认配置里出现 ----------
  const options = read('options.js');
  assert.match(options, /key: 'skin',[\s\S]*?type: 'skin',[\s\S]*?global: true/);
  assert.match(options, /group\.items\.filter\(\(item\) => !item\.global\)/, 'site editor skips global items');
  assert.match(options, /chrome\.storage\.local\.set\(\{ \[SKIN_KEY\]: state\.skin \}\)/);
  assert.match(options, /\['paper', '纸页'\], \['clear', '明净'\]/);

  console.log('skin.test.js: all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
