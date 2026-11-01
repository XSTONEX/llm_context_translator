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

assert.equal(ctx.WORDS_ONLY_KEY, 'wordsOnly');
assert.equal(ctx.DEFAULT_WORDS_ONLY, false);
assert.equal(ctx.WORDS_ONLY_MAX_TOKENS, 2);
assert.equal(ctx.JA_WORD_CHAR_THRESHOLD, 10);

function allow(text, lang) {
  assert.equal(ctx.isWordOrPhrase(text, lang), true, JSON.stringify([text, lang]));
}
function deny(text, lang) {
  assert.equal(ctx.isWordOrPhrase(text, lang), false, JSON.stringify([text, lang]));
}

allow('serendipity', 'en');
allow('look up', 'en');
allow('well-known', 'en');
allow("don't", 'en');
allow('Hello, world', 'en');
allow('  pick   up  ', 'en');
deny('look it up', 'en');
deny('This is a test.', 'en');
deny('', 'en');
deny('   ', 'en');
deny(null, 'en');

allow('食べる', 'ja');
allow('申し込み', 'ja');
deny('これはペンです。', 'ja');
deny('今日はとてもいい天気ですね', 'ja');
deny('短い。', 'ja');

// 设置页里叫「翻译句子」，开 = wordsOnly 为 false
const optionsJs = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
assert.match(optionsJs, /key: 'wordsOnly'/);
assert.match(optionsJs, /label: '翻译句子'/);
assert.match(optionsJs, /options: \[\[false, '开'\], \[true, '关'\]\]/);

console.log('words-only-filter.test.js: all passed');
