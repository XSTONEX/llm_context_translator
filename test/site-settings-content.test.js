const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// config + core + 真实 content-selection；面板 / 请求 / 发音都换成计数桩
function loadOnHost(hostname, storageData, selectedText = '') {
  const calls = { startStreaming: 0, ttsEnabled: [], triggerHide: 0, hidePanel: 0 };
  const mouseupListeners = [];
  const storageChangeListeners = [];

  const context = {
    console,
    Date,
    Node: { TEXT_NODE: 3 },
    MutationObserver: class {
      observe() {}
    },
    location: { hostname },
    window: {
      getSelection() {
        return {
          toString() {
            return selectedText;
          },
          rangeCount: selectedText ? 1 : 0,
          getRangeAt() {
            return {
              getBoundingClientRect() {
                return { left: 0, top: 0, right: 10, bottom: 10 };
              }
            };
          },
          anchorNode: null
        };
      }
    },
    document: {
      addEventListener(type, fn) {
        if (type === 'mouseup') mouseupListeners.push(fn);
      },
      body: {}
    },
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            callback({ ...storageData });
          },
          set() {}
        },
        onChanged: {
          addListener(fn) {
            storageChangeListeners.push(fn);
          }
        }
      },
      runtime: {
        onMessage: {
          addListener() {}
        }
      }
    },
    setTimeout,
    clearTimeout,
    matchMedia() {
      return { matches: false };
    }
  };
  context.globalThis = context;

  const root = path.join(__dirname, '..');
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content-core.js'), 'utf8'), context);

  context.LCT.panel = {
    hidePanel() {
      calls.hidePanel += 1;
    },
    getPanel() {
      return null;
    },
    getHost() {
      return null;
    },
    showProgressivePanel() {},
    forceCleanup() {},
    showToast() {}
  };
  context.LCT.client = {
    startStreaming() {
      calls.startStreaming += 1;
    },
    isCurrent() {
      return true;
    },
    disconnectActivePort() {}
  };
  context.LCT.trigger = {
    show() {},
    hide() {
      calls.triggerHide += 1;
    },
    containsEvent() {
      return false;
    }
  };
  context.LCT.tts = {
    setEnabled(enabled) {
      calls.ttsEnabled.push(enabled);
      context.LCT.state.ttsEnabled = enabled;
    },
    fetchTTS() {},
    autoPlay() {},
    cleanup() {}
  };

  vm.runInContext(fs.readFileSync(path.join(root, 'content-selection.js'), 'utf8'), context);
  context.LCT.selection.init();

  return {
    LCT: context.LCT,
    calls,
    change(changes) {
      storageChangeListeners.forEach((fn) => fn(changes, 'local'));
    },
    async select() {
      for (const fn of mouseupListeners) {
        fn({ composedPath() { return []; } });
      }
      await sleep(context.LCT.constants.DEBOUNCE_DELAY + 30);
    }
  };
}

const profiles = [
  { domain: 'youtube.com', overrides: { ttsEnabled: true, ttsPlayMode: 'once', triggerMode: 'instant' } },
  { domain: 'google.com', overrides: { wordsOnly: false } },
  { domain: 'x.com', overrides: { pageEnabled: false } }
];

async function run() {
  // 子域名套用站点配置，没改的项跟随默认
  {
    const h = loadOnHost('www.youtube.com', { ttsEnabled: false, wordsOnly: true, siteProfiles: profiles });
    assert.equal(h.LCT.state.ttsEnabled, true);
    assert.equal(h.LCT.state.triggerMode, 'instant');
    assert.equal(h.LCT.settings.get().wordsOnly, true);
    const settings = await h.LCT.storage.getSiteSettings();
    assert.equal(settings.ttsPlayMode, 'once');
  }

  // 没有命中的网站走默认配置
  {
    const h = loadOnHost('en.wikipedia.org', { ttsEnabled: false, siteProfiles: profiles });
    assert.equal(h.LCT.state.ttsEnabled, false);
    assert.equal(h.LCT.state.triggerMode, 'icon');
  }

  // 站点配置改动后即时生效；删掉覆盖后回到默认
  {
    const h = loadOnHost('m.youtube.com', { ttsEnabled: false, siteProfiles: profiles });
    assert.equal(h.LCT.state.ttsEnabled, true);
    h.change({ siteProfiles: { newValue: [{ domain: 'youtube.com', overrides: {} }] } });
    assert.equal(h.LCT.state.ttsEnabled, false);
    assert.equal(h.LCT.state.triggerMode, 'icon');

    // 默认配置变了，没被覆盖的项跟着变
    h.change({ ttsEnabled: { newValue: true } });
    assert.equal(h.LCT.state.ttsEnabled, true);
  }

  // 站点配置能把「翻译句子」打开，默认的仅单词门禁不再拦整句
  {
    const h = loadOnHost(
      'docs.google.com',
      { enabled: true, triggerMode: 'instant', wordsOnly: true, siteProfiles: profiles },
      'This is a full sentence.'
    );
    const settings = await h.LCT.storage.getSettings();
    assert.equal(settings.wordsOnly, false);
    await h.select();
    assert.equal(h.calls.startStreaming, 1);
  }

  // 停用划词的网站：选中不发请求
  {
    const h = loadOnHost(
      'x.com',
      { enabled: true, triggerMode: 'instant', siteProfiles: profiles },
      'serendipity'
    );
    assert.equal(h.LCT.state.pageEnabled, false);
    await h.select();
    assert.equal(h.calls.startStreaming, 0);
  }

  // 默认停用、个别网站开启 = 白名单
  {
    const whitelist = [{ domain: 'nhk.or.jp', overrides: { pageEnabled: true } }];
    const off = loadOnHost('example.com', { enabled: true, triggerMode: 'instant', pageEnabled: false, siteProfiles: whitelist }, 'word');
    await off.select();
    assert.equal(off.calls.startStreaming, 0);

    const on = loadOnHost('www3.nhk.or.jp', { enabled: true, triggerMode: 'instant', pageEnabled: false, siteProfiles: whitelist }, 'word');
    await on.select();
    assert.equal(on.calls.startStreaming, 1);
  }

  // 正在打开的面板所在网站被停用：收起未固定的面板
  {
    const h = loadOnHost('news.example.com', { enabled: true, siteProfiles: [] });
    h.LCT.state.isVisible = true;
    h.LCT.state.isPinned = false;
    h.change({ siteProfiles: { newValue: [{ domain: 'example.com', overrides: { pageEnabled: false } }] } });
    assert.equal(h.LCT.state.pageEnabled, false);
    assert.equal(h.calls.hidePanel, 1);
  }

  console.log('site-settings-content.test.js: all passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
