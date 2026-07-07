// favorites-api.js sync() 合并逻辑回归测试：
// 1) 远端空 + 本地有 → 全量迁移（保留本地）
// 2) 本地独有且上次同步后新增（离线收藏）→ 推后端并保留
// 3) 本地独有但上次同步前就有（其他设备已删）→ 本地丢弃
// 4) 未到 TTL 的非强制同步 → 不打后端
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// vm 沙箱里创建的数组原型与本 realm 不同，deepStrictEqual 会因此失败；
// 用 Array.from 把结果拷贝回本 realm 再断言
function queries(list) {
  return Array.from(list, (item) => item.query);
}

function createHarness({ storage = {}, remoteFavorites = [] } = {}) {
  const calls = [];
  const store = { ...storage };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    DEFAULT_API_BASE: 'http://backend',
    getAccessToken: async () => 'token',
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
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      calls.push({
        url,
        method,
        body: options.body ? JSON.parse(options.body) : null
      });
      if (url.endsWith('/api/favorites') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ favorites: remoteFavorites })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  context.globalThis = context;

  const source = fs.readFileSync(path.join(__dirname, '..', 'favorites-api.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'favorites-api.js' });

  return { api: context.LCTFavorites, calls, store };
}

async function run() {
  // 场景 1：远端空 + 本地有 → 全量迁移到后端，本地镜像原样保留
  {
    const harness = createHarness({
      storage: {
        favoriteLookups: [{ query: 'watch', lang: 'en', timestamp: 100 }],
        favoritesSyncedAt: 500
      },
      remoteFavorites: []
    });
    await harness.api.sync({ force: true });

    const bulk = harness.calls.find((c) => c.url.endsWith('/api/favorites/bulk'));
    assert.ok(bulk, 'remote empty: migrates local favorites to backend');
    assert.deepEqual(queries(bulk.body.favorites), ['watch']);
    assert.deepEqual(queries(harness.store.favoriteLookups), ['watch']);
  }

  // 场景 2：本地独有 + 上次同步之后收藏（离线新增）→ 推后端并保留在镜像
  {
    const harness = createHarness({
      storage: {
        favoriteLookups: [
          { query: 'offline', lang: 'en', timestamp: 1000 },
          { query: 'shared', lang: 'en', timestamp: 100 }
        ],
        favoritesSyncedAt: 500
      },
      remoteFavorites: [{ query: 'shared', lang: 'en', timestamp: 100 }]
    });
    await harness.api.sync({ force: true });

    const bulk = harness.calls.find((c) => c.url.endsWith('/api/favorites/bulk'));
    assert.ok(bulk, 'offline add: pushed to backend');
    assert.deepEqual(queries(bulk.body.favorites), ['offline']);
    assert.deepEqual(
      queries(harness.store.favoriteLookups).sort(),
      ['offline', 'shared'],
      'offline add survives sync'
    );
  }

  // 场景 3：本地独有但上次同步之前就存在（远端已被删）→ 本地丢弃，不回灌后端
  {
    const harness = createHarness({
      storage: {
        favoriteLookups: [
          { query: 'deleted-elsewhere', lang: 'en', timestamp: 100 },
          { query: 'shared', lang: 'en', timestamp: 100 }
        ],
        favoritesSyncedAt: 500
      },
      remoteFavorites: [{ query: 'shared', lang: 'en', timestamp: 100 }]
    });
    await harness.api.sync({ force: true });

    const bulk = harness.calls.find((c) => c.url.endsWith('/api/favorites/bulk'));
    assert.equal(bulk, undefined, 'deleted favorite is not re-imported');
    assert.deepEqual(queries(harness.store.favoriteLookups), ['shared']);
  }

  // 场景 4：非强制同步且未过 TTL → 不发任何请求
  {
    const harness = createHarness({
      storage: { favoriteLookups: [], favoritesSyncedAt: Date.now() },
      remoteFavorites: []
    });
    await harness.api.sync();

    assert.equal(harness.calls.length, 0, 'TTL throttles sync');
  }
}

run().then(
  () => {
    console.log('favorites-sync tests passed');
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  }
);
