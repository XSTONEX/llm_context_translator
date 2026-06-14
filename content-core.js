// ========================================================================
// content-core.js — shared state, icons, language, and storage helpers
// ========================================================================

(function () {
  'use strict';

  const root = globalThis.LCT = globalThis.LCT || {};

  root.constants = {
    PANEL_WIDTH: 360,
    PANEL_MIN_WIDTH: 280,
    PANEL_MIN_HEIGHT: 200,
    PANEL_GAP: 10,
    DEBOUNCE_DELAY: 300,
    HISTORY_LIMIT: 50,
    TTS_CACHE_LIMIT: 20,
    LOOKUP_CACHE_LIMIT: 200
  };

  root.state = {
    enabled: true,
    isPinned: false,
    isDragging: false,
    isResizing: false,
    isVisible: false,
    dragOffset: { x: 0, y: 0 },
    currentText: '',
    currentResponseData: null,
    currentRequest: null,
    activeRequestId: 0,
    activePort: null,
    panelEventsBound: false,
    dragEventsBound: false,
    ttsAbortController: null,
    ttsBlobUrl: null,
    ttsReady: false,
    ttsLoading: false,
    ttsError: false,
    ttsAudio: null,
    ttsText: '',
    ttsCache: new Map()
  };

  root.ICONS = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>',
    close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    speaker: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    retry: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    star: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
  };

  root.lang = {
    metaConfig: {
      en: {
        headerFields: [
          { key: 'phonetic', cls: 'lct-phonetic', format: (v) => v }
        ],
        extraSections: []
      },
      ja: {
        headerFields: [
          { key: 'kana', cls: 'lct-kana', format: (v) => '【' + v + '】' },
          { key: 'romaji', cls: 'lct-romaji', format: (v) => v }
        ],
        extraSections: [
          {
            key: 'dictionaryForm',
            cls: 'lct-dictionary-form',
            format: (v) => '原型（辞書形）：' + v,
            condition: (v) => v != null && v !== ''
          }
        ]
      }
    },

    detect(text) {
      return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text) ? 'ja' : 'en';
    },

    resolve(mode, text) {
      if (mode === 'en' || mode === 'ja') return mode;
      return this.detect(text);
    },

    label(lang) {
      return lang === 'ja' ? '日本語' : 'English';
    }
  };

  function getStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function setStorage(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, () => resolve());
    });
  }

  function getLookupKey(item) {
    return [item.lang || 'en', (item.query || '').trim().toLowerCase()].join('::');
  }

  // djb2 字符串哈希，用于把上下文压成短键
  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  // 缓存键：语言 + 模型 + 选中文本 + 上下文哈希（上下文影响语境解析，必须纳入键）
  function getCacheKey(request) {
    return [
      request.lang || 'en',
      request.model || 'default',
      (request.text || '').trim().toLowerCase(),
      hashString(request.context || '')
    ].join('::');
  }

  root.storage = {
    get: getStorage,
    set: setStorage,

    async getApiBase() {
      const result = await getStorage(['apiBase']);
      return result.apiBase || DEFAULT_API_BASE;
    },

    async getSettings() {
      const result = await getStorage(['selectedModel', 'sourceLangMode', 'targetLang']);
      return {
        model: result.selectedModel || null,
        sourceLangMode: result.sourceLangMode || result.targetLang || 'auto'
      };
    },

    async addHistory(data, request) {
      if (!data || !data.query) return;
      const result = await getStorage(['lookupHistory']);
      const history = Array.isArray(result.lookupHistory) ? result.lookupHistory : [];
      const item = {
        id: String(Date.now()),
        query: data.query,
        lang: request.lang,
        model: request.model || null,
        isWord: Boolean(data.isWord),
        coreTranslation:
          (data.contextAnalysis && data.contextAnalysis.coreTranslation) ||
          data.translation ||
          (data.definitions && data.definitions[0] && data.definitions[0].meaning) ||
          '',
        timestamp: Date.now()
      };
      const key = getLookupKey(item);
      const next = [item, ...history.filter((entry) => getLookupKey(entry) !== key)]
        .slice(0, root.constants.HISTORY_LIMIT);
      await setStorage({ lookupHistory: next });
    },

    async getCachedLookup(request) {
      const result = await getStorage(['lookupCache']);
      const cache = (result.lookupCache && typeof result.lookupCache === 'object')
        ? result.lookupCache : {};
      const entry = cache[getCacheKey(request)];
      return entry && entry.data ? entry.data : null;
    },

    async setCachedLookup(request, data) {
      if (!data || !data.query) return;
      const result = await getStorage(['lookupCache']);
      const cache = (result.lookupCache && typeof result.lookupCache === 'object')
        ? result.lookupCache : {};
      cache[getCacheKey(request)] = { data, ts: Date.now() };

      // 超出上限时按时间戳淘汰最旧的条目（LRU）
      const keys = Object.keys(cache);
      const overflow = keys.length - root.constants.LOOKUP_CACHE_LIMIT;
      if (overflow > 0) {
        keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
        for (let i = 0; i < overflow; i++) delete cache[keys[i]];
      }
      await setStorage({ lookupCache: cache });
    },

    async isFavorite(query, lang) {
      const result = await getStorage(['favoriteLookups']);
      const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
      return favorites.some((entry) => getLookupKey(entry) === getLookupKey({ query, lang }));
    },

    async toggleFavorite(data, request) {
      if (!data || !data.query) return false;
      const result = await getStorage(['favoriteLookups']);
      const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
      const item = {
        id: String(Date.now()),
        query: data.query,
        lang: request.lang,
        isWord: Boolean(data.isWord),
        phonetic: data.phonetic || data.kana || data.romaji || '',
        coreTranslation:
          (data.contextAnalysis && data.contextAnalysis.coreTranslation) ||
          data.translation ||
          (data.definitions && data.definitions[0] && data.definitions[0].meaning) ||
          '',
        translation: data.translation || '',
        definitions: data.definitions || [],
        timestamp: Date.now()
      };
      const key = getLookupKey(item);
      const exists = favorites.some((entry) => getLookupKey(entry) === key);
      const next = exists
        ? favorites.filter((entry) => getLookupKey(entry) !== key)
        : [item, ...favorites];
      // 先乐观更新本地镜像（面板即时响应、离线可用）
      await setStorage({ favoriteLookups: next });
      // 再尽力推送到后端（失败不影响本地，下次同步以后端为准）
      if (globalThis.LCTFavorites) {
        try {
          if (exists) await globalThis.LCTFavorites.remove(request.lang, data.query);
          else await globalThis.LCTFavorites.add(item);
        } catch (err) {
          console.warn('[LCT] favorite backend sync failed:', err && err.message);
        }
      }
      return !exists;
    }
  };
})();
