// 插件全局配置（提交进仓库，不含任何密钥）
// 访问令牌请在设置页「连接与快捷键」的「访问令牌」里填写：它会保存到 chrome.storage.sync，
// 并随你的 Chrome 账号自动同步到所有设备，无需在每台电脑手动配置。
// eslint-disable-next-line no-var
var DEFAULT_API_BASE = 'https://hover.sqw.org.cn';
// 本地后端调试时可改为 http://localhost:8000

// ---------- 外观主题（popup / 设置页 / content / review 共用；可按站点覆盖面板外观） ----------
// eslint-disable-next-line no-var
var THEME_MODE_KEY = 'themeMode';
// eslint-disable-next-line no-var
var THEME_MODES = ['system', 'light', 'dark'];
// eslint-disable-next-line no-var
var DEFAULT_THEME_MODE = 'system';

// eslint-disable-next-line no-unused-vars
function normalizeThemeMode(mode) {
  return THEME_MODES.indexOf(mode) !== -1 ? mode : DEFAULT_THEME_MODE;
}

// 将用户偏好解析为实际生效的 light/dark（system 读 prefers-color-scheme）
// eslint-disable-next-line no-unused-vars
function resolveEffectiveTheme(themeMode) {
  var mode = normalizeThemeMode(themeMode);
  if (mode === 'light' || mode === 'dark') return mode;
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

// ---------- 单词复制字段（设置页配置，可按站点覆盖；content 面板工具栏复制读取） ----------
// eslint-disable-next-line no-var
var COPY_WORD_FIELDS_KEY = 'copyWordFields';
// eslint-disable-next-line no-var
var COPY_WORD_FIELD_LABELS = {
  word: '单词',
  phonetic: '音标',
  definition: '释义'
};

// eslint-disable-next-line no-unused-vars
function getDefaultCopyWordFields() {
  return [
    { key: 'word', enabled: false },
    { key: 'phonetic', enabled: false },
    { key: 'definition', enabled: true }
  ];
}

// 保留用户顺序;未知 key 丢掉;缺的项按默认补上
// eslint-disable-next-line no-unused-vars
function normalizeCopyWordFields(value) {
  var allowed = { word: true, phonetic: true, definition: true };
  var seen = {};
  var out = [];
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      if (!item || !allowed[item.key] || seen[item.key]) continue;
      seen[item.key] = true;
      out.push({ key: item.key, enabled: Boolean(item.enabled) });
    }
  }
  var defaults = getDefaultCopyWordFields();
  for (var j = 0; j < defaults.length; j++) {
    if (!seen[defaults[j].key]) {
      out.push({ key: defaults[j].key, enabled: defaults[j].enabled });
    }
  }
  return out;
}

function extractWordCopyField(data, key) {
  if (!data) return '';
  if (key === 'word') return String(data.query || '').trim();
  if (key === 'phonetic') {
    var reading = [];
    if (data.kana) reading.push(data.kana);
    if (data.romaji) reading.push(data.romaji);
    if (reading.length) return reading.join(' ');
    return String(data.phonetic || '').trim();
  }
  if (key === 'definition') {
    var defs = data.definitions;
    if (!defs || !defs.length) return '';
    return defs
      .map(function (def) {
        if (!def) return '';
        var pos = def.partOfSpeech ? def.partOfSpeech + ' ' : '';
        return (pos + (def.meaning || '')).trim();
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// 单词按配置拼行;句子仍只出译文;勾选项都空时回退到释义,避免复制按钮变成空操作
// eslint-disable-next-line no-unused-vars
function formatCopyableText(data, fields) {
  if (!data) return '';
  if (data.isWord) {
    var normalized = normalizeCopyWordFields(fields);
    var lines = [];
    for (var i = 0; i < normalized.length; i++) {
      if (!normalized[i].enabled) continue;
      var text = extractWordCopyField(data, normalized[i].key);
      if (text) lines.push(text);
    }
    if (lines.length) return lines.join('\n');
    return extractWordCopyField(data, 'definition');
  }
  if (data.translation) return data.translation;
  if (data.contextAnalysis && data.contextAnalysis.coreTranslation) {
    return data.contextAnalysis.coreTranslation;
  }
  return '';
}

// ---------- 仅单词/词组门禁（设置页里叫「翻译句子」, content 选区拦截） ----------
// eslint-disable-next-line no-var
var WORDS_ONLY_KEY = 'wordsOnly';
// eslint-disable-next-line no-var
var DEFAULT_WORDS_ONLY = false;
// 单词或两个词的词组;比后端 WORD_COUNT_THRESHOLD (默认 3) 更严
// eslint-disable-next-line no-var
var WORDS_ONLY_MAX_TOKENS = 2;
// 与 service/language_strategy.py 的 JA_WORD_CHAR_THRESHOLD 对齐
// eslint-disable-next-line no-var
var JA_WORD_CHAR_THRESHOLD = 10;

// eslint-disable-next-line no-unused-vars
function isWordOrPhrase(text, lang) {
  var trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return false;
  if (lang === 'ja') {
    if (/[。？！]/.test(trimmed)) return false;
    return trimmed.length <= JA_WORD_CHAR_THRESHOLD;
  }
  var tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= WORDS_ONLY_MAX_TOKENS;
}

// ---------- 发音总开关（设置页开关, 只管划词面板; 复习页不受影响） ----------
// 关闭后不请求 /api/tts、不显示喇叭按钮; 与「自动发音」播放次数相互独立
// eslint-disable-next-line no-var
var TTS_ENABLED_KEY = 'ttsEnabled';
// eslint-disable-next-line no-var
var DEFAULT_TTS_ENABLED = true;

// 未设置时按默认开启处理, 只有显式 false 才算关闭
// eslint-disable-next-line no-unused-vars
function resolveTtsEnabled(value) {
  return value === undefined ? DEFAULT_TTS_ENABLED : value !== false;
}

// ---------- 触发方式（设置页选择, content 划词流程分流） ----------
// icon: 选中后在松手点旁显示小图标, 鼠标碰到/点击才翻译; instant: 选中即翻译（旧行为）
// eslint-disable-next-line no-var
var TRIGGER_MODE_KEY = 'triggerMode';
// eslint-disable-next-line no-var
var DEFAULT_TRIGGER_MODE = 'icon';

// eslint-disable-next-line no-unused-vars
function normalizeTriggerMode(value) {
  return value === 'instant' || value === 'icon' ? value : DEFAULT_TRIGGER_MODE;
}

// ---------- 网页内启用（默认配置 / 站点配置里的「启用划词」） ----------
// 与总开关 enabled 不同: enabled 是快捷键暂停所有网站, pageEnabled 决定在哪些网站工作。
// 默认关、个别网站开 = 白名单
// eslint-disable-next-line no-var
var PAGE_ENABLED_KEY = 'pageEnabled';

// ---------- 站点配置（按域名覆盖默认配置） ----------
// 默认配置仍是各自原来的 storage 键; 站点配置存成 [{ domain, overrides }], 只记改过的项
// eslint-disable-next-line no-var
var SITE_PROFILES_KEY = 'siteProfiles';
// 可按站点覆盖的项 -> 默认值; copyWordFields 的默认值走 getDefaultCopyWordFields()
// eslint-disable-next-line no-var
var SITE_SETTING_DEFAULTS = {
  pageEnabled: true,
  triggerMode: DEFAULT_TRIGGER_MODE,
  wordsOnly: DEFAULT_WORDS_ONLY,
  sourceLangMode: 'auto',
  selectedModel: null,
  ttsEnabled: DEFAULT_TTS_ENABLED,
  ttsPlayMode: 'off',
  themeMode: DEFAULT_THEME_MODE,
  copyWordFields: null
};
// eslint-disable-next-line no-var
var SITE_SETTING_KEYS = Object.keys(SITE_SETTING_DEFAULTS);
// 读默认配置时要一起取的键（targetLang 是 sourceLangMode 的旧名）
// eslint-disable-next-line no-var
var SITE_STORAGE_KEYS = SITE_SETTING_KEYS.concat(['targetLang', SITE_PROFILES_KEY]);

function normalizeSiteSetting(key, value) {
  switch (key) {
    case 'pageEnabled':
      return value !== false;
    case 'triggerMode':
      return normalizeTriggerMode(value);
    case 'wordsOnly':
      return Boolean(value);
    case 'sourceLangMode':
      return value === 'en' || value === 'ja' ? value : 'auto';
    case 'selectedModel':
      return typeof value === 'string' && value ? value : null;
    case 'ttsEnabled':
      return resolveTtsEnabled(value);
    case 'ttsPlayMode':
      return value === 'once' || value === 'thrice' ? value : 'off';
    case 'themeMode':
      return normalizeThemeMode(value);
    case 'copyWordFields':
      return normalizeCopyWordFields(value);
    default:
      return value;
  }
}

// 从 storage 原始值读出完整的默认配置
// eslint-disable-next-line no-unused-vars
function readDefaultSettings(raw) {
  var source = raw || {};
  var out = {};
  for (var i = 0; i < SITE_SETTING_KEYS.length; i++) {
    var key = SITE_SETTING_KEYS[i];
    var value = source[key];
    if (key === 'sourceLangMode' && !value) value = source.targetLang;
    out[key] = normalizeSiteSetting(key, value);
  }
  return out;
}

// 用户填的域名或整段网址 -> 规范域名; 去掉协议、路径、端口和 www.; 不合法返回 ''
// eslint-disable-next-line no-unused-vars
function normalizeDomain(input) {
  var text = String(input == null ? '' : input).trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.split(/[/?#]/)[0];
  text = text.replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  text = text.replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(text)) return '';
  return text;
}

// 保留顺序; 丢掉不合法域名、重复域名和未知项; 每项都按默认配置的规则规范化
// eslint-disable-next-line no-unused-vars
function normalizeSiteProfiles(value) {
  var out = [];
  var seen = {};
  if (!Array.isArray(value)) return out;
  for (var i = 0; i < value.length; i++) {
    var item = value[i];
    var domain = item && normalizeDomain(item.domain);
    if (!domain || seen[domain]) continue;
    seen[domain] = true;
    var overrides = {};
    var raw = (item.overrides && typeof item.overrides === 'object') ? item.overrides : {};
    for (var j = 0; j < SITE_SETTING_KEYS.length; j++) {
      var key = SITE_SETTING_KEYS[j];
      if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
        overrides[key] = normalizeSiteSetting(key, raw[key]);
      }
    }
    out.push({ domain: domain, overrides: overrides });
  }
  return out;
}

function hostMatchesDomain(hostname, domain) {
  var host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host || !domain) return false;
  return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
}

// 命中当前网址的站点配置, 由宽到窄排列（越具体越靠后、越优先）
// eslint-disable-next-line no-unused-vars
function matchSiteProfiles(hostname, profiles) {
  return normalizeSiteProfiles(profiles)
    .filter(function (p) { return hostMatchesDomain(hostname, p.domain); })
    .sort(function (a, b) { return a.domain.split('.').length - b.domain.split('.').length; });
}

// 默认配置 -> 由宽到窄逐项覆盖; sources 记每项最后来自哪个域名（null = 默认配置）
// eslint-disable-next-line no-unused-vars
function resolveSiteSettings(defaults, profiles, hostname) {
  var settings = {};
  var sources = {};
  for (var i = 0; i < SITE_SETTING_KEYS.length; i++) {
    var key = SITE_SETTING_KEYS[i];
    settings[key] = defaults[key];
    sources[key] = null;
  }
  var matched = matchSiteProfiles(hostname, profiles);
  for (var j = 0; j < matched.length; j++) {
    var overrides = matched[j].overrides;
    for (var k in overrides) {
      if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
      settings[k] = overrides[k];
      sources[k] = matched[j].domain;
    }
  }
  return {
    settings: settings,
    sources: sources,
    matched: matched.map(function (p) { return p.domain; })
  };
}

// 从 chrome.storage.sync 读取访问令牌；content / background / popup / 设置页 / review 各上下文通用。
// eslint-disable-next-line no-unused-vars
function getAccessToken() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(['accessToken'], (r) => resolve((r && r.accessToken) || ''));
    } catch (e) {
      resolve('');
    }
  });
}
