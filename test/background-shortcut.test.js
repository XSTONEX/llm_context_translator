const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createChrome(initialStorage = {}) {
  const storage = { ...initialStorage };
  const sentMessages = [];
  const listeners = {
    commands: [],
    connections: [],
    messages: []
  };

  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(storage, key)) {
              result[key] = storage[key];
            }
          }
          callback(result);
        },
        set(values, callback) {
          Object.assign(storage, values);
          if (callback) callback();
        }
      }
    },
    runtime: {
      onConnect: {
        addListener(listener) {
          listeners.connections.push(listener);
        }
      },
      onMessage: {
        addListener(listener) {
          listeners.messages.push(listener);
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 101 }];
      },
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
      }
    },
    commands: {
      onCommand: {
        addListener(listener) {
          listeners.commands.push(listener);
        }
      }
    }
  };

  return { chrome, listeners, sentMessages, storage };
}

function loadBackground(initialStorage) {
  const harness = createChrome(initialStorage);
  const context = {
    console,
    chrome: harness.chrome,
    DEFAULT_API_BASE: 'https://hover.sqw.org.cn',
    LCT_ACCESS_TOKEN: '',
    importScripts() {},
    fetch,
    TextDecoder,
    AbortController
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'),
    context,
    { filename: 'background.js' }
  );

  return harness;
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function triggerCommand(initialStorage, command = 'toggle-enabled') {
  const harness = loadBackground(initialStorage);
  assert.equal(harness.listeners.commands.length, 1);
  harness.listeners.commands[0](command);
  await flushAsyncWork();
  return harness;
}

(async () => {
  {
    const harness = await triggerCommand({ enabled: true });

    assert.equal(harness.storage.enabled, false);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].tabId, 101);
    assert.equal(harness.sentMessages[0].message.type, 'TOGGLE_ENABLED');
    assert.equal(harness.sentMessages[0].message.enabled, false);
  }

  {
    const harness = await triggerCommand({});

    assert.equal(harness.storage.enabled, false);
    assert.equal(harness.sentMessages[0].message.type, 'TOGGLE_ENABLED');
    assert.equal(harness.sentMessages[0].message.enabled, false);
  }

  {
    const harness = await triggerCommand({ enabled: true }, 'open-popup');

    assert.equal(harness.storage.enabled, true);
    assert.equal(harness.sentMessages.length, 0);
  }
})();
