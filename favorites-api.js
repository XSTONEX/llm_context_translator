// ========================================================================
// favorites-api.js — 生词本后端同步客户端（内容脚本 / popup / 复习页共用）
// 依赖 config.js 暴露的 DEFAULT_API_BASE、LCT_ACCESS_TOKEN 全局变量。
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

  function authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (global.LCT_ACCESS_TOKEN) headers['X-LCT-Token'] = global.LCT_ACCESS_TOKEN;
    return headers;
  }

  async function call(method, path, body) {
    const apiBase = await getApiBase();
    const res = await fetch(apiBase + path, {
      method,
      headers: authHeaders(),
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

  const api = {
    list: () => call('GET', '/api/favorites'),
    add: (item) => call('POST', '/api/favorites', item),
    remove: (lang, query) => call('POST', '/api/favorites/delete', { lang, query }),
    bulkImport: (items) => call('POST', '/api/favorites/bulk', { favorites: items }),
    getMirror,
    setMirror,

    // 从后端拉取覆盖本地镜像；首次发现「后端空 + 本地有」则把本地迁移上去。
    async sync({ force = false } = {}) {
      try {
        if (!force) {
          const r = await new Promise((res) =>
            chrome.storage.local.get(['favoritesSyncedAt'], res)
          );
          if (r.favoritesSyncedAt && Date.now() - r.favoritesSyncedAt < SYNC_TTL_MS) {
            return;
          }
        }
        const data = await api.list();
        const remote = (data && data.favorites) || [];
        const local = await getMirror();
        if (remote.length === 0 && local.length > 0) {
          await api.bulkImport(local); // 迁移：保留本地镜像，同时写入后端
        } else {
          await setMirror(remote); // 后端权威：覆盖本地镜像
        }
        await markSynced();
      } catch (err) {
        // 离线/后端不可达：保留本地镜像，下次再同步
        console.warn('[LCT] favorites sync failed:', err && err.message);
      }
    }
  };

  global.LCTFavorites = api;
})(globalThis);
