const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadConfig() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const context = {
    matchMedia: () => ({ matches: false }),
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

const ctx = loadConfig();

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

{
  const fields = snapshot(ctx.getDefaultCopyWordFields());
  assert.deepEqual(
    fields.map((f) => [f.key, f.enabled]),
    [
      ['word', false],
      ['phonetic', false],
      ['definition', true],
    ]
  );
  assert.equal(ctx.COPY_WORD_FIELDS_KEY, 'copyWordFields');
  assert.equal(ctx.COPY_WORD_FIELD_LABELS.definition, '释义');
}

{
  const normalized = snapshot(ctx.normalizeCopyWordFields([
    { key: 'definition', enabled: true },
    { key: 'word', enabled: true },
    { key: 'unknown', enabled: true },
    { key: 'word', enabled: false },
  ]));
  assert.deepEqual(
    normalized.map((f) => [f.key, f.enabled]),
    [
      ['definition', true],
      ['word', true],
      ['phonetic', false],
    ]
  );
}

{
  const normalized = snapshot(ctx.normalizeCopyWordFields(null));
  assert.deepEqual(
    normalized.map((f) => f.key),
    ['word', 'phonetic', 'definition']
  );
}

const wordData = {
  isWord: true,
  query: 'serendipity',
  phonetic: '/ˌserənˈdɪpəti/',
  definitions: [
    { partOfSpeech: 'n.', meaning: '意外发现珍奇事物的能力' },
    { partOfSpeech: 'n.', meaning: '机缘巧合' },
  ],
};

{
  const text = ctx.formatCopyableText(wordData, ctx.getDefaultCopyWordFields());
  assert.equal(text, 'n. 意外发现珍奇事物的能力\nn. 机缘巧合');
}

{
  const text = ctx.formatCopyableText(wordData, [
    { key: 'word', enabled: true },
    { key: 'phonetic', enabled: true },
    { key: 'definition', enabled: true },
  ]);
  assert.equal(text, 'serendipity\n/ˌserənˈdɪpəti/\nn. 意外发现珍奇事物的能力\nn. 机缘巧合');
}

{
  const text = ctx.formatCopyableText(wordData, [
    { key: 'definition', enabled: true },
    { key: 'word', enabled: true },
    { key: 'phonetic', enabled: false },
  ]);
  assert.equal(text, 'n. 意外发现珍奇事物的能力\nn. 机缘巧合\nserendipity');
}

{
  const text = ctx.formatCopyableText(wordData, [
    { key: 'word', enabled: false },
    { key: 'phonetic', enabled: false },
    { key: 'definition', enabled: false },
  ]);
  assert.equal(text, 'n. 意外发现珍奇事物的能力\nn. 机缘巧合');
}

{
  const ja = {
    isWord: true,
    query: '食べる',
    kana: 'たべる',
    romaji: 'taberu',
    definitions: [{ partOfSpeech: '动', meaning: '吃' }],
  };
  const text = ctx.formatCopyableText(ja, [
    { key: 'word', enabled: true },
    { key: 'phonetic', enabled: true },
    { key: 'definition', enabled: false },
  ]);
  assert.equal(text, '食べる\nたべる taberu');
}

{
  const sentence = {
    isWord: false,
    query: 'Hello world',
    translation: '你好，世界',
  };
  const text = ctx.formatCopyableText(sentence, [
    { key: 'word', enabled: true },
    { key: 'phonetic', enabled: true },
    { key: 'definition', enabled: true },
  ]);
  assert.equal(text, '你好，世界');
}

{
  const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.match(popupHtml, /id="copyFieldList"/);
  assert.match(popupHtml, /复制内容/);
}

console.log('copy-word-fields.test.js: all passed');
