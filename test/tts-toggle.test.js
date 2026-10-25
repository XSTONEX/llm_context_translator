const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSpeakerButton() {
  const classes = new Set();
  return {
    title: '',
    removed: false,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      }
    },
    remove() {
      this.removed = true;
    }
  };
}

// 加载 config + core + 真实 content-tts（可选再加 content-selection），fetch 只计数不出网
function loadContent(storageData, options = {}) {
  const calls = {
    ttsFetch: [],
    storageGets: [],
    startStreaming: 0
  };
  const mouseupListeners = [];
  const storageChangeListeners = [];
  const speakerButton = createSpeakerButton();
  const panel = {
    querySelector(selector) {
      if (selector === '[data-action="speaker"]' && !speakerButton.removed) return speakerButton;
      return null;
    }
  };

  const context = {
    console,
    Date,
    AbortController,
    Node: { TEXT_NODE: 3 },
    MutationObserver: class {
      observe() {}
    },
    URL: {
      createObjectURL() {
        return 'blob:test';
      },
      revokeObjectURL() {}
    },
    fetch: async (url) => {
      calls.ttsFetch.push(url);
      return { ok: true, blob: async () => ({}) };
    },
    window: {
      getSelection() {
        return {
          toString() {
            return options.selectedText || '';
          },
          rangeCount: options.selectedText ? 1 : 0,
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
            calls.storageGets.push(keys);
            // 端到端用例走「选中即翻译」，选中后直接发请求
            callback({ triggerMode: 'instant', ...storageData });
          },
          set() {}
        },
        sync: {
          get(keys, callback) {
            callback({});
          }
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
    setInterval,
    clearInterval,
    matchMedia() {
      return { matches: false };
    }
  };
  context.globalThis = context;

  const root = path.join(__dirname, '..');
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content-core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content-tts.js'), 'utf8'), context);

  context.LCT.panel = {
    hidePanel() {},
    getPanel() {
      return panel;
    },
    getHost() {
      return null;
    },
    showProgressivePanel() {},
    forceCleanup() {},
    showToast() {}
  };
  context.LCT.trigger = {
    show() {},
    hide() {},
    containsEvent() {
      return false;
    }
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

  if (options.withSelection) {
    vm.runInContext(fs.readFileSync(path.join(root, 'content-selection.js'), 'utf8'), context);
    context.LCT.selection.init();
  }

  return {
    context,
    LCT: context.LCT,
    calls,
    speakerButton,
    storageChangeListeners,
    async select() {
      for (const fn of mouseupListeners) {
        fn({ composedPath() { return []; } });
      }
      await sleep(context.LCT.constants.DEBOUNCE_DELAY + 30);
    }
  };
}

function ttsCalls(harness) {
  return harness.calls.ttsFetch.filter((url) => String(url).endsWith('/api/tts'));
}

async function run() {
  // 默认值：未存储视为开启，只有显式 false 才关闭
  {
    const { context } = loadContent({});
    assert.equal(context.resolveTtsEnabled(undefined), true);
    assert.equal(context.resolveTtsEnabled(true), true);
    assert.equal(context.resolveTtsEnabled(false), false);
    assert.equal(context.LCT.state.ttsEnabled, true);
  }

  // 开启：fetchTTS 正常请求 /api/tts
  {
    const harness = loadContent({});
    await harness.LCT.tts.fetchTTS('hello');
    assert.equal(ttsCalls(harness).length, 1);
    assert.equal(harness.LCT.state.ttsReady, true);
  }

  // 关闭：fetchTTS 不请求、不进入加载态；autoPlay 不读播放设置
  {
    const harness = loadContent({});
    harness.LCT.tts.setEnabled(false);
    await harness.LCT.tts.fetchTTS('hello');
    assert.equal(ttsCalls(harness).length, 0);
    assert.equal(harness.LCT.state.ttsLoading, false);
    assert.equal(harness.LCT.state.ttsReady, false);

    const getsBefore = harness.calls.storageGets.length;
    await harness.LCT.tts.autoPlay();
    assert.equal(harness.calls.storageGets.length, getsBefore);
  }

  // 加载中途关闭：中止请求、清掉状态、移除面板上的喇叭按钮
  {
    const harness = loadContent({});
    const controller = new AbortController();
    harness.LCT.state.ttsAbortController = controller;
    harness.LCT.state.ttsLoading = true;
    harness.LCT.state.ttsText = 'hello';
    harness.LCT.tts.setEnabled(false);
    assert.equal(controller.signal.aborted, true);
    assert.equal(harness.LCT.state.ttsLoading, false);
    assert.equal(harness.LCT.state.ttsText, '');
    assert.equal(harness.speakerButton.removed, true);
  }

  // 重新开启：不动当前面板，之后的请求恢复
  {
    const harness = loadContent({});
    harness.LCT.tts.setEnabled(false);
    harness.LCT.tts.setEnabled(true);
    await harness.LCT.tts.fetchTTS('hello');
    assert.equal(ttsCalls(harness).length, 1);
  }

  // content-selection 初始化读取存储里的开关，并跟随 local 区的变更
  {
    const harness = loadContent({ enabled: true, ttsEnabled: false }, { withSelection: true });
    assert.equal(harness.LCT.state.ttsEnabled, false);

    harness.storageChangeListeners.forEach((fn) => fn({ ttsEnabled: { newValue: true } }, 'local'));
    assert.equal(harness.LCT.state.ttsEnabled, true);

    harness.storageChangeListeners.forEach((fn) => fn({ ttsEnabled: { newValue: false } }, 'sync'));
    assert.equal(harness.LCT.state.ttsEnabled, true);

    harness.storageChangeListeners.forEach((fn) => fn({ ttsEnabled: { newValue: false } }, 'local'));
    assert.equal(harness.LCT.state.ttsEnabled, false);
  }

  // 端到端：关闭时划词照常翻译，但不请求 /api/tts
  {
    const harness = loadContent(
      { enabled: true, ttsEnabled: false },
      { withSelection: true, selectedText: 'serendipity' }
    );
    await harness.select();
    assert.equal(harness.calls.startStreaming, 1);
    assert.equal(ttsCalls(harness).length, 0);
  }

  // 端到端：未设置开关时保持原行为，划词即预加载发音
  {
    const harness = loadContent({ enabled: true }, { withSelection: true, selectedText: 'serendipity' });
    await harness.select();
    assert.equal(harness.calls.startStreaming, 1);
    assert.equal(ttsCalls(harness).length, 1);
  }

  console.log('tts-toggle.test.js: all passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
