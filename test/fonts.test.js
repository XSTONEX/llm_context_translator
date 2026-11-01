const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// paper.css 里引用的字体文件都在
{
  const css = read('paper.css');
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3, 'paper.css declares the bundled fonts');
  urls.forEach((url) => assert.ok(fs.existsSync(path.join(root, url)), url + ' exists'));
}

// 划词面板用 FontFace 加载的字体都在，并且网页能取到
{
  const panel = read('content-panel.js');
  const files = [...panel.matchAll(/file: '(fonts\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length >= 3, 'content-panel lists the panel fonts');
  files.forEach((file) => assert.ok(fs.existsSync(path.join(root, file)), file + ' exists'));

  const manifest = JSON.parse(read('manifest.json'));
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(resources.includes('fonts/*.woff2'), 'fonts are web accessible');
}

// 用标题字体显示的字都在裁剪字表里，否则会落到系统宋体
{
  const readme = read('fonts/README.md');
  const zhText = readme.match(/ZH_TEXT='([^']+)'/)[1];
  const shown = [];
  const options = read('options.html');
  shown.push(...[...options.matchAll(/<h1>([^<]+)<\/h1>/g)].map((m) => m[1]));
  shown.push(...[...options.matchAll(/class="(?:brand|chapter|num)">([^<]+)</g)].map((m) => m[1]));
  shown.push(...[...read('popup.html').matchAll(/class="popup-title">([^<]+)</g)].map((m) => m[1]));
  shown.push(...[...read('options.js').matchAll(/GROUP_NUMS = \[([^\]]+)\]/g)].map((m) => m[1].replace(/[',\s]/g, '')));
  shown.push(read('content-panel.js').match(/textContent = '(翻译[^']*失败)'/)[1]);

  const missing = [...new Set(shown.join('').split(''))].filter((ch) => !zhText.includes(ch));
  assert.deepEqual(missing, [], 'subset is missing: ' + missing.join(''));
}

console.log('fonts.test.js: all passed');
