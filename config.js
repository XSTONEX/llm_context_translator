// 插件全局配置（提交进仓库，不含任何密钥）
// 访问令牌请在扩展 popup 的「访问令牌」里填写：它会保存到 chrome.storage.sync，
// 并随你的 Chrome 账号自动同步到所有设备，无需在每台电脑手动配置。
// eslint-disable-next-line no-var
var DEFAULT_API_BASE = 'https://hover.sqw.org.cn';
// 本地后端调试时可改为 http://localhost:8000

// ---------- 外观主题（popup / content / review 共用） ----------
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

// ---------- 单词复制字段（popup 配置，content 面板工具栏复制读取） ----------
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

// 从 chrome.storage.sync 读取访问令牌；content / background / popup / review 各上下文通用。
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
