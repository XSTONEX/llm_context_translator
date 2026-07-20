// toggleFavorite 乐观更新回归：
// 1) 本地写完即返回，不 await 后端 add/remove
// 2) resolve 时本地 mirror 已含/已删该项
// 3) 后端最终被调用；add 返回 audioKey 后写回本地
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness({ storage = {}, addDelayMs = 500, addResponse = null } = {}) {
  const store = { ...storage };
  const calls = [];
  let resolveAdd;
  let addCalled = false;

  const addPromise = new Promise((resolve) => {
    resolveAdd = resolve;
  });

  const context = {
    console,
    setTimeout,
    clearTimeout,
    DEFAULT_API_BASE: 'http://backend',
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of keys) {
              if (Object.prototype.hasOwnProperty.call(store, key)) {
                result[key] = store[key];
              }
            }
            callback(result);
          },
          set(values, callback) {
            Object.assign(store, values);
            if (callback) callback();
          }
        }
      }
    },
    LCTFavorites: {
      async add(item) {
        addCalled = true;
        calls.push({ op: 'add', item });
        await new Promise((r) => setTimeout(r, addDelayMs));
        const res =
          addResponse ||
          ({ ok: true, favorite: { ...item, audioKey: 'tts/test/en/hello.mp3' } });
        resolveAdd(res);
        return res;
      },
      async remove(lang, query) {
        calls.push({ op: 'remove', lang, query });
        await new Promise((r) => setTimeout(r, addDelayMs));
        return { ok: true };
      }
    }
  };
  context.globalThis = context;

  const source = fs.readFileSync(path.join(__dirname, '..', 'content-core.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'content-core.js' });

  return {
    storage: context.LCT.storage,
    store,
    calls,
    waitForAdd: () => addPromise,
    isAddCalled: () => addCalled
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  // 场景 1：新增收藏 — toggle 在后端完成前就返回，本地已写入
  {
    const harness = createHarness({ storage: { favoriteLookups: [] }, addDelayMs: 400 });
    const started = Date.now();
    const isFavorite = await harness.storage.toggleFavorite(
      { query: 'hello', isWord: true, translation: '你好' },
      { lang: 'en' }
    );
    const elapsed = Date.now() - started;

    assert.equal(isFavorite, true);
    assert.ok(elapsed < 100, `toggleFavorite should resolve quickly, took ${elapsed}ms`);
    assert.equal(harness.store.favoriteLookups.length, 1);
    assert.equal(harness.store.favoriteLookups[0].query, 'hello');
    // 后台 add 可能尚未完成
    assert.equal(harness.store.favoriteLookups[0].audioKey, undefined);

    await harness.waitForAdd();
    await sleep(20); // 给写回 audioKey 的微任务一点时间
    assert.equal(harness.calls.some((c) => c.op === 'add'), true);
    assert.equal(harness.store.favoriteLookups[0].audioKey, 'tts/test/en/hello.mp3');
  }

  // 场景 2：取消收藏 — 本地立刻删除，remove 后台调用
  {
    const harness = createHarness({
      storage: {
        favoriteLookups: [
          { query: 'hello', lang: 'en', timestamp: 1 }
        ]
      },
      addDelayMs: 400
    });
    const started = Date.now();
    const isFavorite = await harness.storage.toggleFavorite(
      { query: 'hello' },
      { lang: 'en' }
    );
    const elapsed = Date.now() - started;

    assert.equal(isFavorite, false);
    assert.ok(elapsed < 100, `unfavorite should resolve quickly, took ${elapsed}ms`);
    assert.equal(harness.store.favoriteLookups.length, 0);

    await sleep(450);
    assert.equal(harness.calls.some((c) => c.op === 'remove'), true);
  }

  // 场景 3：add 返回前用户已取消 — 不写回 audioKey 到已删除项
  {
    const harness = createHarness({ storage: { favoriteLookups: [] }, addDelayMs: 200 });
    await harness.storage.toggleFavorite({ query: 'race' }, { lang: 'en' });
    assert.equal(harness.store.favoriteLookups.length, 1);

    // 立即再 toggle 取消
    await harness.storage.toggleFavorite({ query: 'race' }, { lang: 'en' });
    assert.equal(harness.store.favoriteLookups.length, 0);

    await harness.waitForAdd();
    await sleep(30);
    // 取消后不应被 audioKey 写回重新插入
    assert.equal(harness.store.favoriteLookups.length, 0);
  }

  console.log('toggle-favorite-optimistic.test.js: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
