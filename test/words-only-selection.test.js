const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSelection(storageData, selectedText) {
  const calls = {
    hidePanel: 0,
    getApiBase: 0,
    getCachedLookup: 0,
    startStreaming: 0,
    fetchTTS: 0,
    showProgressivePanel: 0
  };
  const mouseupListeners = [];

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
          addListener() {}
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
    showProgressivePanel() {
      calls.showProgressivePanel += 1;
    },
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
    fetchTTS() {
      calls.fetchTTS += 1;
    },
    autoPlay() {},
    cleanup() {}
  };

  vm.runInContext(fs.readFileSync(path.join(root, 'content-selection.js'), 'utf8'), context);
  context.LCT.selection.init();

  return {
    LCT: context.LCT,
    calls,
    async select() {
      for (const fn of mouseupListeners) {
        fn({ composedPath() { return []; } });
      }
      await sleep(context.LCT.constants.DEBOUNCE_DELAY + 30);
    }
  };
}

async function run() {
  {
    const harness = loadSelection({ enabled: true, wordsOnly: true }, 'This is a sentence.');
    await harness.select();
    assert.equal(harness.calls.getApiBase, 0);
    assert.equal(harness.calls.getCachedLookup, 0);
    assert.equal(harness.calls.startStreaming, 0);
    assert.equal(harness.calls.fetchTTS, 0);
    assert.equal(harness.calls.showProgressivePanel, 0);
    assert.equal(harness.LCT.state.currentText, '');
    assert.equal(harness.LCT.state.activeRequestId, 0);
  }

  {
    const harness = loadSelection({ enabled: true, wordsOnly: true }, 'This is a sentence.');
    harness.LCT.state.isVisible = true;
    harness.LCT.state.isPinned = false;
    await harness.select();
    assert.equal(harness.calls.hidePanel, 1);
    assert.equal(harness.calls.startStreaming, 0);
  }

  {
    const harness = loadSelection({ enabled: true, wordsOnly: true }, 'This is a sentence.');
    harness.LCT.state.isVisible = true;
    harness.LCT.state.isPinned = true;
    await harness.select();
    assert.equal(harness.calls.hidePanel, 0);
    assert.equal(harness.calls.startStreaming, 0);
  }

  {
    const harness = loadSelection({ enabled: true, wordsOnly: true }, 'serendipity');
    await harness.select();
    assert.equal(harness.calls.getApiBase, 1);
    assert.equal(harness.calls.getCachedLookup, 1);
    assert.equal(harness.calls.startStreaming, 1);
    assert.equal(harness.LCT.state.currentText, 'serendipity');
  }

  {
    const harness = loadSelection({ enabled: true, wordsOnly: false }, 'This is a sentence.');
    await harness.select();
    assert.equal(harness.calls.startStreaming, 1);
    assert.equal(harness.LCT.state.currentText, 'This is a sentence.');
  }

  {
    const settings = await loadSelection({ enabled: true }, 'x').LCT.storage.getSettings();
    assert.equal(settings.wordsOnly, false);
  }

  {
    const settings = await loadSelection({ enabled: true, wordsOnly: true }, 'x').LCT.storage.getSettings();
    assert.equal(settings.wordsOnly, true);
  }

  console.log('words-only-selection.test.js: all passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
