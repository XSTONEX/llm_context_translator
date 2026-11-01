// ========================================================================
// options.js — 全屏设置页：默认配置 / 站点配置 / 生词本 / 连接与快捷键
// ========================================================================

'use strict';

const STATUS_CHECK_TIMEOUT = 3000;
const HISTORY_LIMIT = 50;
const VOCAB_PAGE_SIZE = 20;
const PAGES = ['defaults', 'sites', 'vocab', 'connection'];
const GROUP_NUMS = ['一', '二', '三', '四'];

// 默认配置和站点配置共用一份表：站点配置每项多一个「默认」档
const SETTING_GROUPS = [
  {
    title: '划词',
    items: [
      {
        key: 'pageEnabled',
        label: '启用划词',
        type: 'seg',
        options: [[true, '开'], [false, '关']],
        hint: '关掉后，只有在站点配置里单独开启的网站才会划词，相当于白名单。'
      },
      {
        key: 'triggerMode',
        label: '触发方式',
        type: 'seg',
        options: [['icon', '碰图标'], ['instant', '选中即译']]
      },
      {
        key: 'wordsOnly',
        label: '翻译句子',
        type: 'seg',
        options: [[false, '开'], [true, '关']],
        hint: '关闭时只翻译单词和两个词以内的词组，选中整句不弹面板。'
      },
      {
        key: 'sourceLangMode',
        label: '源语言',
        type: 'seg',
        options: [['auto', '自动'], ['en', 'English'], ['ja', '日本語']]
      },
      { key: 'selectedModel', label: '翻译模型', type: 'model' }
    ]
  },
  {
    title: '发音',
    items: [
      {
        key: 'ttsEnabled',
        label: '发音',
        type: 'seg',
        options: [[true, '开'], [false, '关']],
        hint: '关闭后不请求发音，面板里也不显示喇叭。'
      },
      {
        key: 'ttsPlayMode',
        label: '自动发音',
        type: 'seg',
        options: [['off', '不播'], ['once', '一遍'], ['thrice', '三遍']],
        hint: '只在发音开启的网站上起作用。默认关了发音也可以先设好，开了发音的网站会继承它。'
      }
    ]
  },
  {
    title: '面板',
    items: [
      {
        key: 'themeMode',
        label: '外观',
        siteLabel: '面板外观',
        type: 'seg',
        options: [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']],
        hint: '也用于弹出窗口、设置页和复习页；站点配置里改的只影响那个网站上的面板。'
      },
      {
        key: 'copyWordFields',
        label: '复制内容',
        type: 'copy',
        hint: '拖动调整顺序，勾选要复制的项；句子只复制译文。'
      }
    ]
  }
];

const SETTING_ITEMS = {};
SETTING_GROUPS.forEach((group) => {
  group.items.forEach((item) => {
    SETTING_ITEMS[item.key] = item;
  });
});

const state = {
  raw: {},
  defaults: readDefaultSettings({}),
  profiles: [],
  models: [],
  page: 'defaults',
  site: null,
  favorites: [],
  history: [],
  vocabQuery: '',
  vocabPage: 0,
  confirmDelete: null
};

let els = {};

document.addEventListener('DOMContentLoaded', init);

// ---------- 小工具 ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  Object.entries(props || {}).forEach(([key, value]) => {
    if (value == null || value === false) return;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  });
  children.flat().forEach((child) => {
    if (child == null || child === false) return;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return el;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function itemLabel(item, forSite) {
  return forSite && item.siteLabel ? item.siteLabel : item.label;
}

function modelName(id) {
  const model = state.models.find((m) => m.id === id);
  if (model) return model.name;
  return id || '后端默认模型';
}

function copySummary(fields) {
  const labels = typeof COPY_WORD_FIELD_LABELS !== 'undefined' ? COPY_WORD_FIELD_LABELS : {};
  const on = normalizeCopyWordFields(fields).filter((f) => f.enabled).map((f) => labels[f.key] || f.key);
  return on.length ? on.join(' · ') : '释义';
}

// 某一项某个值的文字说明（列表摘要、「默认：xx」都用它）
function valueLabel(item, value) {
  if (item.type === 'model') return modelName(value);
  if (item.type === 'copy') return copySummary(value);
  const option = item.options.find((opt) => sameValue(opt[0], value));
  return option ? option[1] : String(value);
}

function domainSortKey(domain) {
  return domain.split('.').reverse().join('.');
}

function sortedProfiles() {
  return state.profiles.slice().sort((a, b) => (domainSortKey(a.domain) < domainSortKey(b.domain) ? -1 : 1));
}

function parentProfiles(domain) {
  return state.profiles.filter((p) => p.domain !== domain && hostMatchesDomain(domain, p.domain));
}

// ---------- 存储 ----------

function applyRaw(raw) {
  state.raw = raw;
  state.defaults = readDefaultSettings(raw);
  state.profiles = normalizeSiteProfiles(raw[SITE_PROFILES_KEY]);
}

function setDefault(key, value) {
  const patch = { [key]: value };
  // 旧版本读 targetLang，一起写上保持兼容
  if (key === 'sourceLangMode') patch.targetLang = value === 'auto' ? 'en' : value;
  Object.assign(state.raw, patch);
  applyRaw(state.raw);
  renderSettings();
  chrome.storage.local.set(patch);
}

function saveProfiles(profiles) {
  state.raw[SITE_PROFILES_KEY] = profiles;
  applyRaw(state.raw);
  renderSettings();
  chrome.storage.local.set({ [SITE_PROFILES_KEY]: profiles });
}

// value 为 undefined 表示改回跟随默认
function setOverride(domain, key, value) {
  saveProfiles(state.profiles.map((profile) => {
    if (profile.domain !== domain) return profile;
    const overrides = Object.assign({}, profile.overrides);
    if (value === undefined) delete overrides[key];
    else overrides[key] = value;
    return { domain: profile.domain, overrides };
  }));
}

// ---------- 初始化 ----------

function init() {
  els = {
    navLinks: Array.from(document.querySelectorAll('.contents a[data-page]')),
    pages: Array.from(document.querySelectorAll('main .page')),
    siteCount: document.getElementById('siteCount'),
    siteCountInline: document.getElementById('siteCountInline'),
    vocabCount: document.getElementById('vocabCount'),
    version: document.getElementById('version'),
    defaultsForm: document.getElementById('defaultsForm'),
    addSiteButton: document.getElementById('addSiteButton'),
    addSitePop: document.getElementById('addSitePop'),
    addSiteInput: document.getElementById('addSiteInput'),
    addSiteError: document.getElementById('addSiteError'),
    addSiteCancel: document.getElementById('addSiteCancel'),
    addSiteConfirm: document.getElementById('addSiteConfirm'),
    siteList: document.getElementById('siteList'),
    siteEditor: document.getElementById('siteEditor'),
    vocabLead: document.getElementById('vocabLead'),
    reviewButton: document.getElementById('reviewButton'),
    exportButton: document.getElementById('exportButton'),
    vocabSearch: document.getElementById('vocabSearch'),
    favoritesList: document.getElementById('favoritesList'),
    favoritesPager: document.getElementById('favoritesPager'),
    historyList: document.getElementById('historyList'),
    apiBaseInput: document.getElementById('apiBaseInput'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    tokenInput: document.getElementById('tokenInput'),
    tokenToggle: document.getElementById('tokenToggle'),
    shortcutKey: document.getElementById('shortcutKey'),
    shortcutCustomizeButton: document.getElementById('shortcutCustomizeButton')
  };

  try {
    els.version.textContent = chrome.runtime.getManifest().version;
  } catch (e) {
    els.version.textContent = '';
  }

  bindAddSite();
  bindVocab();
  bindConnection();

  chrome.storage.local.get(
    SITE_STORAGE_KEYS.concat(['apiBase', 'modelList', 'favoriteLookups', 'lookupHistory']),
    (result) => {
      applyRaw(Object.assign({}, result));
      state.models = Array.isArray(result.modelList) ? result.modelList : [];
      state.favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
      state.history = Array.isArray(result.lookupHistory) ? result.lookupHistory : [];
      applyDocumentTheme();
      route();

      const apiBase = result.apiBase || DEFAULT_API_BASE;
      els.apiBaseInput.value = apiBase;
      checkStatus(apiBase);
      loadModels(apiBase);
    }
  );

  chrome.storage.sync.get(['accessToken'], (result) => {
    els.tokenInput.value = (result && result.accessToken) || '';
  });
  if (typeof LCTFavorites !== 'undefined') LCTFavorites.sync({ force: true });
  loadShortcut();

  chrome.storage.onChanged.addListener(onStorageChanged);
  window.addEventListener('hashchange', route);

  try {
    const mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (state.defaults.themeMode === 'system') applyDocumentTheme();
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onSystemThemeChange);
    else if (mediaQuery.addListener) mediaQuery.addListener(onSystemThemeChange);
  } catch (e) {
    // matchMedia 不可用时忽略
  }
}

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  let settingsChanged = false;
  SITE_STORAGE_KEYS.forEach((key) => {
    if (!changes[key]) return;
    state.raw[key] = changes[key].newValue;
    settingsChanged = true;
  });
  if (settingsChanged) {
    applyRaw(state.raw);
    applyDocumentTheme();
    renderSettings();
  }
  if (changes.modelList) {
    state.models = Array.isArray(changes.modelList.newValue) ? changes.modelList.newValue : [];
    renderSettings();
  }
  if (changes.favoriteLookups) {
    state.favorites = Array.isArray(changes.favoriteLookups.newValue) ? changes.favoriteLookups.newValue : [];
    renderVocab();
  }
  if (changes.lookupHistory) {
    state.history = Array.isArray(changes.lookupHistory.newValue) ? changes.lookupHistory.newValue : [];
    renderVocab();
  }
}

function applyDocumentTheme() {
  document.documentElement.dataset.theme = resolveEffectiveTheme(state.defaults.themeMode);
}

// #defaults / #sites / #sites/<域名> / #vocab / #connection
function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  const slash = hash.indexOf('/');
  const page = slash >= 0 ? hash.slice(0, slash) : hash;
  const arg = slash >= 0 ? hash.slice(slash + 1) : '';
  state.page = PAGES.indexOf(page) >= 0 ? page : 'defaults';

  if (state.page === 'sites' && arg) {
    const domain = normalizeDomain(arg);
    if (domain && state.profiles.some((p) => p.domain === domain)) {
      state.site = domain;
    } else if (domain) {
      openAddSite(domain);
    }
  }

  els.pages.forEach((section) => {
    section.hidden = section.dataset.page !== state.page;
  });
  els.navLinks.forEach((link) => {
    if (link.dataset.page === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  renderSettings();
  renderVocab();
}

function renderSettings() {
  renderCounts();
  renderDefaults();
  renderSites();
}

function renderCounts() {
  const sites = state.profiles.length;
  els.siteCount.textContent = sites ? String(sites) : '';
  els.siteCountInline.textContent = sites ? sites + ' 个' : '';
  els.vocabCount.textContent = state.favorites.length ? String(state.favorites.length) : '';
}

// ---------- 控件 ----------

function buildSeg(label, buttons) {
  return h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': label },
    buttons.map((btn) => h('button', {
      type: 'button',
      class: btn.className || '',
      'aria-pressed': btn.pressed ? 'true' : 'false',
      onClick: btn.onClick,
      text: btn.text
    }))
  );
}

function buildModelSelect(label, value, onChange, followLabel) {
  const select = h('select', { 'aria-label': label });
  if (followLabel) select.appendChild(h('option', { value: '', text: followLabel }));

  const groups = {};
  state.models.forEach((model) => {
    const provider = model.provider || '其他';
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(model);
  });
  Object.keys(groups).forEach((provider) => {
    select.appendChild(h(
      'optgroup',
      { label: provider },
      groups[provider].map((model) => h('option', { value: model.id, text: model.name }))
    ));
  });
  // 存着的模型不在列表里（还没拉到列表或已下架）时也要能显示出来
  if (value && !state.models.some((m) => m.id === value)) {
    select.appendChild(h('option', { value, text: value }));
  }
  if (!followLabel && state.models.length === 0 && !value) {
    select.appendChild(h('option', { value: '', text: '正在获取模型列表' }));
    select.disabled = true;
  }
  select.value = value || '';
  select.addEventListener('change', () => onChange(select.value));

  return h('span', { class: 'select-wrap' }, select, chevron());
}

function chevron() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', '6 9 12 15 18 9');
  svg.appendChild(line);
  return svg;
}

function buildCopyList(fields, onChange, accent) {
  const labels = typeof COPY_WORD_FIELD_LABELS !== 'undefined' ? COPY_WORD_FIELD_LABELS : {};
  const list = h('div', { class: 'copy-list' + (accent ? ' is-accent' : '') });
  const current = normalizeCopyWordFields(fields);
  let dragFrom = -1;

  current.forEach((field, index) => {
    const checkbox = h('input', {
      type: 'checkbox',
      class: 'copy-check',
      'aria-label': '复制' + (labels[field.key] || field.key)
    });
    checkbox.checked = Boolean(field.enabled);
    checkbox.addEventListener('change', () => {
      onChange(current.map((f, i) => (i === index ? { key: f.key, enabled: checkbox.checked } : f)));
    });

    const grip = h('span', { class: 'copy-grip', 'aria-hidden': 'true' });
    for (let i = 0; i < 6; i++) grip.appendChild(h('i'));

    const row = h(
      'div',
      { class: 'copy-row', draggable: 'true' },
      grip,
      h('span', { class: 'copy-label', text: labels[field.key] || field.key }),
      checkbox
    );

    row.addEventListener('dragstart', (e) => {
      if (e.target === checkbox) {
        e.preventDefault();
        return;
      }
      dragFrom = index;
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    });
    row.addEventListener('dragend', () => {
      dragFrom = -1;
      row.classList.remove('is-dragging');
      list.querySelectorAll('.is-drag-over').forEach((el) => el.classList.remove('is-drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.is-drag-over').forEach((el) => el.classList.remove('is-drag-over'));
      if (index !== dragFrom) row.classList.add('is-drag-over');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom < 0 || dragFrom === index) return;
      const next = current.slice();
      const [moved] = next.splice(dragFrom, 1);
      next.splice(index, 0, moved);
      onChange(next);
    });

    list.appendChild(row);
  });
  return list;
}

// ---------- 壹 默认配置 ----------

function renderDefaults() {
  const form = els.defaultsForm;
  form.textContent = '';

  SETTING_GROUPS.forEach((group, gi) => {
    form.appendChild(h('h2', { class: 'sec' }, h('span', { class: 'num', text: GROUP_NUMS[gi] }), group.title));
    group.items.forEach((item) => {
      const value = state.defaults[item.key];
      let control;
      let top = false;

      if (item.type === 'seg') {
        control = buildSeg(item.label, item.options.map(([optValue, text]) => ({
          text,
          pressed: sameValue(optValue, value),
          className: sameValue(optValue, value) ? 'is-on' : '',
          onClick: () => setDefault(item.key, optValue)
        })));
      } else if (item.type === 'model') {
        control = buildModelSelect(item.label, value, (id) => setDefault('selectedModel', id || null));
      } else if (item.type === 'copy') {
        top = true;
        control = buildCopyList(value, (fields) => setDefault('copyWordFields', fields), false);
      }

      form.appendChild(h(
        'div',
        { class: 'row' + (top ? ' is-top' : '') },
        h('span', { class: 'row-label', text: item.label, style: top ? 'padding-top: 8px;' : null }),
        h('span', { class: 'leader' }),
        control
      ));
      if (item.hint) form.appendChild(h('p', { class: 'row-hint', text: item.hint }));
    });
  });
}

// ---------- 贰 站点配置 ----------

function bindAddSite() {
  els.addSiteButton.addEventListener('click', () => {
    if (els.addSitePop.hidden) openAddSite('');
    else closeAddSite();
  });
  els.addSiteCancel.addEventListener('click', closeAddSite);
  els.addSiteConfirm.addEventListener('click', submitAddSite);
  els.addSiteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAddSite();
    if (e.key === 'Escape') closeAddSite();
  });
  els.addSiteInput.addEventListener('input', () => {
    els.addSiteError.hidden = true;
  });
}

function openAddSite(prefill) {
  els.addSitePop.hidden = false;
  els.addSiteButton.setAttribute('aria-expanded', 'true');
  els.addSiteError.hidden = true;
  els.addSiteInput.value = prefill || '';
  setTimeout(() => els.addSiteInput.focus(), 0);
}

function closeAddSite() {
  els.addSitePop.hidden = true;
  els.addSiteButton.setAttribute('aria-expanded', 'false');
  els.addSiteInput.value = '';
}

function submitAddSite() {
  const domain = normalizeDomain(els.addSiteInput.value);
  if (!domain) {
    els.addSiteError.textContent = '这不像一个域名，换个写法试试，例如 youtube.com';
    els.addSiteError.hidden = false;
    return;
  }
  closeAddSite();
  if (!state.profiles.some((p) => p.domain === domain)) {
    saveProfiles(state.profiles.concat([{ domain, overrides: {} }]));
  }
  selectSite(domain);
}

function selectSite(domain) {
  state.site = domain;
  state.confirmDelete = null;
  const hash = '#sites/' + encodeURIComponent(domain);
  if (location.hash !== hash) history.replaceState(null, '', hash);
  renderSites();
}

function overrideSummary(profile) {
  const parts = Object.keys(profile.overrides).map((key) => {
    const item = SETTING_ITEMS[key];
    return item ? itemLabel(item, true) + ' ' + valueLabel(item, profile.overrides[key]) : '';
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : '还没有改动';
}

function renderSites() {
  const profiles = sortedProfiles();
  if (!profiles.some((p) => p.domain === state.site)) {
    state.site = profiles.length ? profiles[0].domain : null;
  }

  els.siteList.textContent = '';
  profiles.forEach((profile) => {
    const isChild = parentProfiles(profile.domain).length > 0;
    const count = Object.keys(profile.overrides).length;
    els.siteList.appendChild(h(
      'button',
      {
        type: 'button',
        class: 'site-item' + (isChild ? ' is-child' : ''),
        'aria-current': profile.domain === state.site ? 'true' : 'false',
        onClick: () => selectSite(profile.domain)
      },
      h(
        'span',
        { class: 'site-domain-line' },
        isChild ? h('span', { class: 'site-arrow', 'aria-hidden': 'true', text: '↳' }) : null,
        h('span', { class: 'site-domain', text: profile.domain }),
        h('span', { class: 'site-count', text: count + ' 项' })
      ),
      h('span', { class: 'site-summary', text: overrideSummary(profile) })
    ));
  });

  renderSiteEditor();
}

function renderSiteEditor() {
  const editor = els.siteEditor;
  editor.textContent = '';
  const profile = state.profiles.find((p) => p.domain === state.site);
  if (!profile) {
    editor.appendChild(h('p', { class: 'empty', text: '还没有站点配置。点右上角「添加站点」开始。' }));
    return;
  }

  const domain = profile.domain;
  const parents = parentProfiles(domain);
  // 不算自己时这个网站会得到什么：默认配置 + 更宽的站点配置
  const base = resolveSiteSettings(state.defaults, parents, domain);
  const effective = resolveSiteSettings(state.defaults, state.profiles, domain).settings;
  const changed = Object.keys(profile.overrides).length;

  const deleting = state.confirmDelete === domain;
  editor.appendChild(h(
    'div',
    { class: 'editor-head' },
    h('div', { class: 'editor-domain', text: domain }),
    h(
      'div',
      { class: 'editor-actions' },
      h('button', {
        type: 'button',
        class: 'text-btn',
        disabled: changed === 0,
        text: '全部恢复默认',
        onClick: () => saveProfiles(state.profiles.map((p) => (p.domain === domain ? { domain, overrides: {} } : p)))
      }),
      h('button', {
        type: 'button',
        class: 'text-btn is-muted',
        text: deleting ? '再点一次确认删除' : '删除此站点',
        onClick: () => {
          if (!deleting) {
            state.confirmDelete = domain;
            renderSiteEditor();
            setTimeout(() => {
              if (state.confirmDelete === domain) {
                state.confirmDelete = null;
                renderSiteEditor();
              }
            }, 3000);
            return;
          }
          state.confirmDelete = null;
          saveProfiles(state.profiles.filter((p) => p.domain !== domain));
        }
      })
    )
  ));

  let scope = '作用于 ' + domain + ' 及其所有子域名 · 已改 ' + changed + ' 项';
  if (parents.length) {
    scope += ' · 没改的项先继承 ' + parents.map((p) => p.domain).join('、');
  }
  editor.appendChild(h('p', { class: 'editor-scope', text: scope }));
  if (!effective.pageEnabled) {
    editor.appendChild(h('p', { class: 'editor-note', text: '这个网站已停用划词，下面的其他设定暂不起作用。' }));
  }

  SETTING_GROUPS.forEach((group, gi) => {
    const groupEl = h(
      'div',
      { class: 'editor-group' },
      h(
        'div',
        { class: 'editor-group-title' },
        h('span', { class: 'num', text: GROUP_NUMS[gi] }),
        group.title
      )
    );
    group.items.forEach((item) => {
      groupEl.appendChild(buildSiteRow(domain, item, profile.overrides, base, effective));
    });
    editor.appendChild(groupEl);
  });
}

function buildSiteRow(domain, item, overrides, base, effective) {
  const key = item.key;
  const label = itemLabel(item, true);
  const isOver = Object.prototype.hasOwnProperty.call(overrides, key);
  const override = overrides[key];
  const baseValue = base.settings[key];
  const baseSource = base.sources[key] || '默认';
  const cap = baseSource + '：' + valueLabel(item, baseValue);

  let control;
  let extra = null;

  if (item.type === 'seg') {
    const buttons = [{
      text: '默认',
      pressed: !isOver,
      className: isOver ? 'is-muted' : 'is-on',
      onClick: () => setOverride(domain, key, undefined)
    }].concat(item.options.map(([optValue, text]) => {
      let className = '';
      if (isOver && sameValue(optValue, override)) className = 'is-over';
      else if (!isOver && sameValue(optValue, baseValue)) className = 'is-ghost';
      return {
        text,
        pressed: isOver && sameValue(optValue, override),
        className,
        onClick: () => setOverride(domain, key, optValue)
      };
    }));
    control = buildSeg(label, buttons);
  } else if (item.type === 'model') {
    control = buildModelSelect(
      label,
      isOver ? override : '',
      (id) => setOverride(domain, key, id || undefined),
      '默认（' + modelName(baseValue) + '）'
    );
  } else if (item.type === 'copy') {
    control = buildSeg(label, [
      {
        text: '默认',
        pressed: !isOver,
        className: isOver ? 'is-muted' : 'is-on',
        onClick: () => setOverride(domain, key, undefined)
      },
      {
        text: '单独设定',
        pressed: isOver,
        className: isOver ? 'is-over' : '',
        onClick: () => {
          if (!isOver) setOverride(domain, key, normalizeCopyWordFields(baseValue));
        }
      }
    ]);
    if (isOver) {
      extra = buildCopyList(override, (fields) => setOverride(domain, key, fields), true);
      extra.classList.add('editor-copy');
    }
  }

  const dim =
    (!effective.pageEnabled && key !== 'pageEnabled') ||
    (key === 'ttsPlayMode' && !effective.ttsEnabled);

  return h(
    'div',
    { class: 'row-group' + (dim ? ' is-dim' : '') },
    h(
      'div',
      { class: 'row', style: 'padding-top: 14px;' },
      h(
        'div',
        { class: 'row-label-block' },
        h('span', { class: 'row-label' + (isOver ? ' is-over' : ''), text: label }),
        h('span', { class: 'row-cap', text: cap })
      ),
      h('span', { class: 'leader' }),
      control
    ),
    extra
  );
}

// ---------- 叁 生词本 ----------

function bindVocab() {
  els.reviewButton.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  });

  els.exportButton.addEventListener('click', () => {
    if (state.favorites.length === 0) {
      flashButton(els.exportButton, '暂无收藏');
      return;
    }
    const csv = buildFavoritesCsv(state.favorites);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    downloadText(csv, `生词本_${stamp}.csv`, 'text/csv;charset=utf-8');
  });

  els.vocabSearch.addEventListener('input', () => {
    state.vocabQuery = els.vocabSearch.value.trim().toLowerCase();
    state.vocabPage = 0;
    renderVocab();
  });
}

function langCode(lang) {
  return lang === 'ja' ? 'ja' : 'en';
}

function wordRow(item, actions) {
  return h(
    'div',
    { class: 'word-row' },
    h('span', { class: 'word', text: item.query || '--' }),
    item.phonetic ? h('span', { class: 'reading', text: item.phonetic }) : null,
    h('span', { class: 'leader' }),
    h('span', { class: 'meaning', text: item.coreTranslation || item.translation || '' }),
    h('span', { class: 'lang', text: langCode(item.lang) }),
    h('span', { class: 'row-actions' }, actions)
  );
}

function copyButton(text) {
  return h('button', {
    type: 'button',
    class: 'text-btn',
    text: '复制',
    onClick: (e) => {
      navigator.clipboard.writeText(text || '');
      flashButton(e.currentTarget, '已复制');
    }
  });
}

function renderVocab() {
  renderCounts();
  const total = state.favorites.length;
  els.vocabLead.textContent = total
    ? '收藏 ' + total + ' 条，会和后端同步，换设备也在。'
    : '还没有收藏。在划词面板里点星标，就会收进这里。';

  const query = state.vocabQuery;
  const filtered = query
    ? state.favorites.filter((item) =>
        [item.query, item.coreTranslation, item.translation, item.phonetic]
          .some((v) => String(v || '').toLowerCase().indexOf(query) >= 0))
    : state.favorites;
  const pages = Math.max(1, Math.ceil(filtered.length / VOCAB_PAGE_SIZE));
  state.vocabPage = Math.min(state.vocabPage, pages - 1);
  const start = state.vocabPage * VOCAB_PAGE_SIZE;

  els.favoritesList.textContent = '';
  if (filtered.length === 0) {
    els.favoritesList.appendChild(h('p', { class: 'empty', text: total ? '没有找到匹配的收藏。' : '暂无收藏。' }));
  }
  filtered.slice(start, start + VOCAB_PAGE_SIZE).forEach((item) => {
    els.favoritesList.appendChild(wordRow(item, [
      copyButton(item.query),
      h('button', { type: 'button', class: 'text-btn', text: '删除', onClick: () => removeFavorite(item) })
    ]));
  });

  els.favoritesPager.textContent = '';
  els.favoritesPager.hidden = pages <= 1;
  if (pages > 1) {
    els.favoritesPager.appendChild(h('button', {
      type: 'button',
      class: 'text-btn',
      disabled: state.vocabPage === 0,
      text: '‹ 上一页',
      onClick: () => {
        state.vocabPage -= 1;
        renderVocab();
      }
    }));
    els.favoritesPager.appendChild(h('span', { text: '第 ' + (state.vocabPage + 1) + ' 页，共 ' + pages + ' 页' }));
    els.favoritesPager.appendChild(h('button', {
      type: 'button',
      class: 'text-btn',
      disabled: state.vocabPage >= pages - 1,
      text: '下一页 ›',
      onClick: () => {
        state.vocabPage += 1;
        renderVocab();
      }
    }));
  }

  els.historyList.textContent = '';
  const history = state.history.slice(0, HISTORY_LIMIT);
  if (history.length === 0) {
    els.historyList.appendChild(h('p', { class: 'empty', text: '暂无记录。' }));
  }
  history.forEach((item) => {
    els.historyList.appendChild(wordRow(item, [copyButton(item.query)]));
  });
}

function lookupKey(item) {
  return [item.lang || 'en', (item.query || '').trim().toLowerCase()].join('::');
}

function removeFavorite(item) {
  chrome.storage.local.get(['favoriteLookups'], (result) => {
    const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
    const target = lookupKey(item);
    chrome.storage.local.set({
      favoriteLookups: favorites.filter((entry) => lookupKey(entry) !== target)
    });
    // 同步删除后端，否则下次同步时该词条会从后端拉回来（失败不阻塞本地删除）
    if (typeof LCTFavorites !== 'undefined') {
      LCTFavorites.remove(item.lang, item.query).catch(() => {});
    }
  });
}

function langLabel(lang) {
  return lang === 'ja' ? '日本語' : 'English';
}

// 把收藏导出为 CSV：正面=词条，背面=读音+释义，可直接导入 Anki / Excel
function buildFavoritesCsv(items) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['正面', '背面', '语言']];
  items.forEach((item) => {
    const front = item.query || '';
    const reading = item.phonetic ? '[' + item.phonetic + '] ' : '';
    const defs = (item.definitions || [])
      .map((d) => (d.partOfSpeech ? d.partOfSpeech + ' ' : '') + (d.meaning || ''))
      .filter(Boolean)
      .join('；');
    const core = item.coreTranslation || item.translation || '';
    const back = (reading + core).trim() + (defs ? '\n' + defs : '');
    rows.push([front, back, langLabel(item.lang)]);
  });
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

function downloadText(text, filename, mime) {
  // 加 UTF-8 BOM，保证 Excel 正确识别中文
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flashButton(btn, message) {
  const original = btn.textContent;
  btn.textContent = message;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

// ---------- 肆 连接与快捷键 ----------

function bindConnection() {
  els.apiBaseInput.addEventListener('blur', () => {
    let value = els.apiBaseInput.value.trim();
    if (!value) value = DEFAULT_API_BASE;
    value = value.replace(/\/+$/, '');
    els.apiBaseInput.value = value;
    chrome.storage.local.get(['apiBase'], (result) => {
      if ((result.apiBase || DEFAULT_API_BASE) === value) return;
      chrome.storage.local.set({ apiBase: value });
      checkStatus(value);
      loadModels(value);
    });
  });
  els.apiBaseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.apiBaseInput.blur();
  });

  els.tokenInput.addEventListener('blur', saveToken);
  els.tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.tokenInput.blur();
  });
  els.tokenToggle.addEventListener('click', () => {
    const show = els.tokenInput.type === 'password';
    els.tokenInput.type = show ? 'text' : 'password';
    els.tokenToggle.textContent = show ? '隐藏' : '显示';
  });

  els.shortcutCustomizeButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

// 访问令牌存在 chrome.storage.sync（随 Chrome 账号跨设备同步）
function saveToken() {
  const value = els.tokenInput.value.trim();
  chrome.storage.sync.get(['accessToken'], (result) => {
    if ((result.accessToken || '') === value) return;
    chrome.storage.sync.set({ accessToken: value }, () => {
      // 令牌变化后立即用新令牌重新同步生词本
      if (typeof LCTFavorites !== 'undefined') LCTFavorites.sync({ force: true });
    });
  });
}

function loadShortcut() {
  if (!chrome.commands || !chrome.commands.getAll) {
    els.shortcutKey.textContent = '未设置';
    return;
  }
  chrome.commands.getAll((commands) => {
    const command = commands.find((item) => item.name === 'toggle-enabled');
    els.shortcutKey.textContent = command && command.shortcut ? command.shortcut : '未设置';
  });
}

function setStatus(status) {
  els.statusDot.className = 'status-dot is-' + status;
  els.statusText.textContent = { checking: '检查中', online: '已连接', offline: '连接失败' }[status];
}

async function checkStatus(apiBase) {
  setStatus('checking');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);
  try {
    const response = await fetch(`${apiBase}/api/status`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatus('online');
  } catch {
    setStatus('offline');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadModels(apiBase) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT);
  try {
    const response = await fetch(`${apiBase}/api/models`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    state.models = models;
    chrome.storage.local.set({ modelList: models });

    // 默认模型已下架或从没选过：写回实际生效的那个，避免请求带着失效的 ID
    const saved = state.defaults.selectedModel;
    if (models.length && !models.some((m) => m.id === saved)) {
      const fallback = models.some((m) => m.id === data.default) ? data.default : models[0].id;
      setDefault('selectedModel', fallback);
    } else {
      renderSettings();
    }
  } catch {
    // 拉不到就用缓存的 modelList（init 时已读入）
    renderSettings();
  } finally {
    clearTimeout(timeoutId);
  }
}
