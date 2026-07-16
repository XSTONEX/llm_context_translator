// ========================================================================
// favorites-api.js — 生词本后端同步客户端（内容脚本 / popup / 复习页共用）
// 依赖 config.js 暴露的 DEFAULT_API_BASE 与 getAccessToken()。
// 策略：后端为权威源，chrome.storage.local 的 favoriteLookups 作为本地镜像，
//      保证离线可读、面板响应快；增删走「乐观更新本地 + 异步推后端」。
// ========================================================================

(function (global) {
  'use strict';

  const SYNC_TTL_MS = 5 * 60 * 1000;

  function getApiBase() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['apiBase'], (r) => {
          resolve((r && r.apiBase) || global.DEFAULT_API_BASE);
        });
      } catch {
        resolve(global.DEFAULT_API_BASE);
      }
    });
  }

  async function authHeaders({ json = false } = {}) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const token = (typeof getAccessToken === 'function') ? await getAccessToken() : '';
    if (token) headers['X-LCT-Token'] = token;
    return headers;
  }

  async function call(method, path, body) {
    const apiBase = await getApiBase();
    const res = await fetch(apiBase + path, {
      method,
      headers: await authHeaders({ json: body !== undefined }),
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (res.status === 204) return null;
    return res.json();
  }

  function getMirror() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['favoriteLookups'], (r) => {
        resolve(Array.isArray(r.favoriteLookups) ? r.favoriteLookups : []);
      });
    });
  }

  function setMirror(list) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ favoriteLookups: list }, () => resolve());
    });
  }

  function markSynced() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ favoritesSyncedAt: Date.now() }, () => resolve());
    });
  }

  function getSyncedAt() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['favoritesSyncedAt'], (r) => {
        resolve((r && r.favoritesSyncedAt) || 0);
      });
    });
  }

  function lookupKey(item) {
    return [item.lang || 'en', (item.query || '').trim().toLowerCase()].join('::');
  }

  function needsAudio(item) {
    return !(item && item.audioKey && String(item.audioKey).trim());
  }

  const api = {
    list: () => call('GET', '/api/favorites'),
    add: (item) => call('POST', '/api/favorites', item),
    remove: (lang, query) => call('POST', '/api/favorites/delete', { lang, query }),
    bulkImport: (items) => call('POST', '/api/favorites/bulk', { favorites: items }),

    /** 拉取收藏词音频 blob（带鉴权；用于复习页播放）。 */
    async fetchAudioBlob(lang, query, voice = 'alloy') {
      const apiBase = await getApiBase();
      const qs = new URLSearchParams({
        lang: lang || 'en',
        query: query || '',
        voice: voice || 'alloy'
      });
      const res = await fetch(apiBase + '/api/favorites/audio?' + qs.toString(), {
        method: 'GET',
        headers: await authHeaders()
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    },

    /**
     * 为缺 audioKey 的生词现场补 TTS→COS→写回。
     * 后端单次有上限，这里会连调直到 remaining=0 或本轮无进展。
     */
    async ensureMissingAudio() {
      const maxRounds = 10;
      let last = null;
      for (let round = 0; round < maxRounds; round++) {
        last = await call('POST', '/api/favorites/ensure-audio', {});
        if (last && Array.isArray(last.favorites)) {
          await setMirror(last.favorites);
        }
        const remaining = (last && last.remaining) || 0;
        const filled = (last && last.filled) || 0;
        if (remaining === 0) break;
        if (filled === 0) break; // 无进展（COS/TTS 不可用），避免死循环
      }
      return last;
    },

    getMirror,
    setMirror,

    // 从后端拉取并与本地镜像合并；首次发现「后端空 + 本地有」则把本地迁移上去。
    // 同步完成后若有缺音频的词，现场走完整补生成链路。
    async sync({ force = false } = {}) {
      try {
        const syncedAt = await getSyncedAt();
        if (!force && syncedAt && Date.now() - syncedAt < SYNC_TTL_MS) {
          // TTL 内也尽量给本地镜像里缺音频的词补一次（打开生词本场景）
          const localQuick = await getMirror();
          if (localQuick.some(needsAudio)) {
            await api.ensureMissingAudio().catch((err) => {
              console.warn('[LCT] ensure audio failed:', err && err.message);
            });
          }
          return;
        }
        const data = await api.list();
        const remote = (data && data.favorites) || [];
        const local = await getMirror();
        if (remote.length === 0 && local.length > 0) {
          await api.bulkImport(local); // 迁移：保留本地镜像，同时写入后端
          // 迁移后尽量用服务端列表；若仍为空（延迟/失败）绝不能用 [] 覆盖本地
          // （JS 里 [] 为 truthy，不能写 favorites || local）
          let next = local;
          try {
            const after = await api.list();
            if (after && Array.isArray(after.favorites) && after.favorites.length > 0) {
              next = after.favorites;
            }
          } catch (_) {
            /* 保留 local */
          }
          await setMirror(next);
          await markSynced();
          if (next.some(needsAudio)) {
            await api.ensureMissingAudio().catch((err) => {
              console.warn('[LCT] ensure audio failed:', err && err.message);
            });
          }
          return;
        }
        // 本地独有条目：上次同步之后才收藏的视为「离线新增」，补推后端并保留；
        // 上次同步之前就存在而远端没有的，视为已在其他设备删除，本地丢弃。
        const remoteKeys = new Set(remote.map(lookupKey));
        const pendingAdds = local.filter(
          (item) =>
            !remoteKeys.has(lookupKey(item)) &&
            (!syncedAt || (item.timestamp || 0) > syncedAt)
        );
        if (pendingAdds.length > 0) await api.bulkImport(pendingAdds);

        // 以远端为准，但 bulk 后若 list 尚未含离线新增，仍保留 pendingAdds
        let merged = [...pendingAdds, ...remote];
        if (pendingAdds.length > 0) {
          try {
            const refreshed = await api.list();
            if (refreshed && Array.isArray(refreshed.favorites) && refreshed.favorites.length > 0) {
              const refreshedKeys = new Set(refreshed.favorites.map(lookupKey));
              const stillPending = pendingAdds.filter(
                (item) => !refreshedKeys.has(lookupKey(item))
              );
              merged = [...stillPending, ...refreshed.favorites];
            }
          } catch (_) {
            /* 用合并结果兜底 */
          }
        }
        await setMirror(merged);
        await markSynced();

        if (merged.some(needsAudio)) {
          await api.ensureMissingAudio().catch((err) => {
            console.warn('[LCT] ensure audio failed:', err && err.message);
          });
        }
      } catch (err) {
        // 离线/后端不可达：保留本地镜像，下次再同步
        console.warn('[LCT] favorites sync failed:', err && err.message);
      }
    }
  };

  global.LCTFavorites = api;
})(globalThis);
