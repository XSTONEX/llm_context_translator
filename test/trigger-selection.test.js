const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 真实 config + core + content-selection；面板 / 请求 / TTS / 触发图标都用桩记录调用
function loadSelection(storageData, selectedText) {
  const calls = {
    hidePanel: 0,
    getApiBase: 0,
    getCachedLookup: 0,
    startStreaming: 0,
    fetchTTS: 0,
    triggerShow: [],
    triggerHide: []
  };
  const mouseupListeners = [];
  const storageChangeListeners = [];
  let insideTrigger = false;

  const context = {
    console,
    Date,
    Node: { TEXT_NODE: 3 },
    MutationObserver: class {
      observe() {}
    },
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
            callback(storageData);
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

  const originalGetApiBase = context.LCT.storage.getApiBase.bind(context.LCT.storage);
  const originalGetCached = context.LCT.storage.getCachedLookup.bind(context.LCT.storage);
  context.LCT.storage.getApiBase = async () => {
    calls.getApiBase += 1;
    return originalGetApiBase();
  };
  context.LCT.storage.getCachedLookup = async (...args) => {
    calls.getCachedLookup += 1;
    return originalGetCached(...args);
  };

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
  context.LCT.tts = {
    setEnabled() {},
    fetchTTS() {
      calls.fetchTTS += 1;
    },
    autoPlay() {},
    cleanup() {}
  };
  context.LCT.trigger = {
    show(pointer, onTrigger) {
      calls.triggerShow.push({ pointer, onTrigger });
    },
    hide(options) {
      calls.triggerHide.push(options || {});
    },
    containsEvent() {
      return insideTrigger;
    }
  };

  vm.runInContext(fs.readFileSync(path.join(root, 'content-selection.js'), 'utf8'), context);
  context.LCT.selection.init();

  return {
    LCT: context.LCT,
    calls,
    storageChangeListeners,
    setInsideTrigger(value) {
      insideTrigger = value;
    },
    // 图标模式松手后下一轮任务就处理；选中即翻译要等防抖
    async select(waitMs = 30) {
      for (const fn of mouseupListeners) {
        fn({ clientX: 120, clientY: 80, composedPath() { return []; } });
      }
      await sleep(waitMs);
    }
  };
}

function assertNoRequest(calls) {
  assert.equal(calls.getApiBase, 0);
  assert.equal(calls.getCachedLookup, 0);
  assert.equal(calls.startStreaming, 0);
  assert.equal(calls.fetchTTS, 0);
}

async function run() {
  // 未设置时默认图标模式：选中只出图标，不发任何请求；碰到图标后才走翻译
  {
    const harness = loadSelection({ enabled: true }, 'serendipity');
    assert.equal(harness.LCT.state.triggerMode, 'icon');
    await harness.select();
    assert.equal(harness.calls.triggerShow.length, 1);
    assert.deepEqual({ ...harness.calls.triggerShow[0].pointer }, { x: 120, y: 80 });
    assertNoRequest(harness.calls);
    assert.equal(harness.LCT.state.currentText, '');

    await harness.calls.triggerShow[0].onTrigger();
    assert.equal(harness.calls.getCachedLookup, 1);
    assert.equal(harness.calls.startStreaming, 1);
    assert.equal(harness.LCT.state.currentText, 'serendipity');
    assert.equal(harness.LCT.state.currentRequest.text, 'serendipity');
  }

  // 选中即翻译：保持旧行为，不出图标
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'instant' }, 'serendipity');
    await harness.select(harness.LCT.constants.DEBOUNCE_DELAY + 30);
    assert.equal(harness.calls.triggerShow.length, 0);
    assert.equal(harness.calls.startStreaming, 1);
  }

  // 仅单词/词组打开时，句子连图标都不出
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon', wordsOnly: true }, 'This is a sentence.');
    await harness.select();
    assert.equal(harness.calls.triggerShow.length, 0);
    assert.ok(harness.calls.triggerHide.length >= 1);
    assertNoRequest(harness.calls);
  }

  // 未固定的旧面板：选新词时先收起，再出图标
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon' }, 'serendipity');
    harness.LCT.state.isVisible = true;
    harness.LCT.state.isPinned = false;
    harness.LCT.state.currentText = 'other';
    await harness.select();
    assert.equal(harness.calls.hidePanel, 1);
    assert.equal(harness.calls.triggerShow.length, 1);
  }

  // 固定面板：保持原样，误选不会冲掉正在看的内容
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon' }, 'serendipity');
    harness.LCT.state.isVisible = true;
    harness.LCT.state.isPinned = true;
    harness.LCT.state.currentText = 'other';
    await harness.select();
    assert.equal(harness.calls.hidePanel, 0);
    assert.equal(harness.calls.triggerShow.length, 1);
    assert.equal(harness.LCT.state.currentText, 'other');
  }

  // 面板正显示同一个词：不出图标
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon' }, 'serendipity');
    harness.LCT.state.isVisible = true;
    harness.LCT.state.currentText = 'serendipity';
    await harness.select();
    assert.equal(harness.calls.triggerShow.length, 0);
  }

  // 选区被清空：收起图标
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon' }, '');
    await harness.select();
    assert.equal(harness.calls.triggerShow.length, 0);
    assert.ok(harness.calls.triggerHide.length >= 1);
  }

  // 在图标上松开鼠标（点击图标）不重新走选区流程
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon' }, 'serendipity');
    harness.setInsideTrigger(true);
    await harness.select();
    assert.equal(harness.calls.triggerShow.length, 0);
    assert.equal(harness.calls.triggerHide.length, 0);
  }

  // 划词总开关关闭：图标也不出
  {
    const harness = loadSelection({ enabled: false, triggerMode: 'icon' }, 'serendipity');
    await harness.select();
    assert.equal(harness.calls.triggerShow.length, 0);
  }

  // popup 切到选中即翻译：立即生效并收起已显示的图标
  {
    const harness = loadSelection({ enabled: true, triggerMode: 'icon' }, 'serendipity');
    harness.storageChangeListeners.forEach((fn) => fn({ triggerMode: { newValue: 'instant' } }, 'local'));
    assert.equal(harness.LCT.state.triggerMode, 'instant');
    assert.deepEqual({ ...harness.calls.triggerHide[0] }, { immediate: true });

    harness.storageChangeListeners.forEach((fn) => fn({ triggerMode: { newValue: 'bogus' } }, 'local'));
    assert.equal(harness.LCT.state.triggerMode, 'icon');
  }

  console.log('trigger-selection.test.js: all passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
