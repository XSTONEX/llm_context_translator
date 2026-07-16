const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadConfig(matchMediaImpl) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const context = {
    matchMedia: matchMediaImpl || (() => ({ matches: false })),
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

// --- normalizeThemeMode ---
{
  const ctx = loadConfig();
  assert.equal(ctx.normalizeThemeMode('light'), 'light');
  assert.equal(ctx.normalizeThemeMode('dark'), 'dark');
  assert.equal(ctx.normalizeThemeMode('system'), 'system');
  assert.equal(ctx.normalizeThemeMode(undefined), 'system');
  assert.equal(ctx.normalizeThemeMode(null), 'system');
  assert.equal(ctx.normalizeThemeMode('auto'), 'system');
  assert.equal(ctx.normalizeThemeMode(''), 'system');
  assert.equal(ctx.DEFAULT_THEME_MODE, 'system');
  assert.equal(ctx.THEME_MODE_KEY, 'themeMode');
}

// --- resolveEffectiveTheme: light/dark pass-through ---
{
  const ctx = loadConfig(() => ({ matches: true }));
  assert.equal(ctx.resolveEffectiveTheme('light'), 'light');
  assert.equal(ctx.resolveEffectiveTheme('dark'), 'dark');
}

// --- resolveEffectiveTheme: system follows prefers-color-scheme ---
{
  const darkCtx = loadConfig(() => ({ matches: true }));
  assert.equal(darkCtx.resolveEffectiveTheme('system'), 'dark');
  assert.equal(darkCtx.resolveEffectiveTheme(undefined), 'dark');

  const lightCtx = loadConfig(() => ({ matches: false }));
  assert.equal(lightCtx.resolveEffectiveTheme('system'), 'light');
}

// --- resolveEffectiveTheme: matchMedia throw falls back to light for system ---
{
  const ctx = loadConfig(() => {
    throw new Error('no matchMedia');
  });
  assert.equal(ctx.resolveEffectiveTheme('system'), 'light');
  assert.equal(ctx.resolveEffectiveTheme('dark'), 'dark');
}

// --- static surface checks ---
{
  const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.match(popupHtml, /id="themeSelect"/);
  assert.match(popupHtml, /value="system"/);
  assert.match(popupHtml, /value="light"/);
  assert.match(popupHtml, /value="dark"/);
  assert.match(popupHtml, /跟随系统/);
  assert.match(popupHtml, /data-theme="dark"/);

  const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(styles, /:host\(\[data-theme="dark"\]\)/);
  assert.match(styles, /--lct-bg:\s*#1C1C1E/i);

  const reviewHtml = fs.readFileSync(path.join(__dirname, '..', 'review.html'), 'utf8');
  assert.match(reviewHtml, /data-theme="dark"/);
}

console.log('theme-resolve.test.js: all passed');
