const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadConfig() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const context = { matchMedia: () => ({ matches: false }) };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

const ctx = loadConfig();
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.equal(ctx.SITE_PROFILES_KEY, 'siteProfiles');
assert.equal(ctx.PAGE_ENABLED_KEY, 'pageEnabled');
assert.deepEqual(plain(ctx.SITE_SETTING_KEYS), [
  'pageEnabled', 'triggerMode', 'wordsOnly', 'sourceLangMode', 'selectedModel',
  'ttsEnabled', 'ttsPlayMode', 'themeMode', 'copyWordFields'
]);

// 域名：网址、端口、www.、大小写都收成同一个域名
{
  assert.equal(ctx.normalizeDomain('YouTube.com'), 'youtube.com');
  assert.equal(ctx.normalizeDomain('https://www.youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(ctx.normalizeDomain('docs.google.com/document/d/x'), 'docs.google.com');
  assert.equal(ctx.normalizeDomain('http://localhost:8000/'), 'localhost');
  assert.equal(ctx.normalizeDomain('  nhk.or.jp.  '), 'nhk.or.jp');
  assert.equal(ctx.normalizeDomain(''), '');
  assert.equal(ctx.normalizeDomain('not a domain'), '');
  assert.equal(ctx.normalizeDomain(null), '');
}

// 默认配置：未存储走默认值，targetLang 旧键仍然认
{
  const d = ctx.readDefaultSettings({});
  assert.equal(d.pageEnabled, true);
  assert.equal(d.triggerMode, 'icon');
  assert.equal(d.wordsOnly, false);
  assert.equal(d.sourceLangMode, 'auto');
  assert.equal(d.selectedModel, null);
  assert.equal(d.ttsEnabled, true);
  assert.equal(d.ttsPlayMode, 'off');
  assert.equal(d.themeMode, 'system');
  assert.deepEqual(plain(d.copyWordFields), plain(ctx.getDefaultCopyWordFields()));

  assert.equal(ctx.readDefaultSettings({ targetLang: 'ja' }).sourceLangMode, 'ja');
  assert.equal(ctx.readDefaultSettings({ sourceLangMode: 'en', targetLang: 'ja' }).sourceLangMode, 'en');
  assert.equal(ctx.readDefaultSettings({ pageEnabled: false, ttsEnabled: false }).pageEnabled, false);
}

// 站点配置规范化：丢非法/重复域名和未知项，值按默认配置的规则收紧
{
  const profiles = ctx.normalizeSiteProfiles([
    { domain: 'https://www.YouTube.com/', overrides: { ttsEnabled: true, ttsPlayMode: 'twice', bogus: 1 } },
    { domain: 'youtube.com', overrides: { ttsEnabled: false } },
    { domain: '', overrides: {} },
    { domain: 'x.com' },
    null
  ]);
  assert.deepEqual(plain(profiles), [
    { domain: 'youtube.com', overrides: { ttsEnabled: true, ttsPlayMode: 'off' } },
    { domain: 'x.com', overrides: {} }
  ]);
  assert.deepEqual(plain(ctx.normalizeSiteProfiles('nope')), []);
}

// 生效规则：由宽到窄逐项覆盖，sources 记来源
{
  const defaults = ctx.readDefaultSettings({ wordsOnly: true, ttsEnabled: false });
  const profiles = [
    { domain: 'docs.google.com', overrides: { triggerMode: 'instant', ttsEnabled: true } },
    { domain: 'google.com', overrides: { wordsOnly: false, triggerMode: 'icon' } },
    { domain: 'youtube.com', overrides: { ttsPlayMode: 'once' } }
  ];

  const docs = ctx.resolveSiteSettings(defaults, profiles, 'docs.google.com');
  assert.deepEqual(plain(docs.matched), ['google.com', 'docs.google.com']);
  assert.equal(docs.settings.triggerMode, 'instant');
  assert.equal(docs.settings.wordsOnly, false);
  assert.equal(docs.settings.ttsEnabled, true);
  assert.equal(docs.settings.ttsPlayMode, 'off');
  assert.equal(docs.sources.triggerMode, 'docs.google.com');
  assert.equal(docs.sources.wordsOnly, 'google.com');
  assert.equal(docs.sources.ttsPlayMode, null);

  const mail = ctx.resolveSiteSettings(defaults, profiles, 'mail.google.com');
  assert.deepEqual(plain(mail.matched), ['google.com']);
  assert.equal(mail.settings.triggerMode, 'icon');
  assert.equal(mail.settings.ttsEnabled, false);

  // 只按整段域名匹配：notgoogle.com 不算 google.com 的子域名
  const other = ctx.resolveSiteSettings(defaults, profiles, 'notgoogle.com');
  assert.deepEqual(plain(other.matched), []);
  assert.equal(other.settings.wordsOnly, true);

  const yt = ctx.resolveSiteSettings(defaults, profiles, 'WWW.YOUTUBE.COM');
  assert.equal(yt.settings.ttsPlayMode, 'once');

  const none = ctx.resolveSiteSettings(defaults, profiles, '');
  assert.deepEqual(plain(none.matched), []);
}

console.log('site-profiles.test.js: all passed');
