const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
);

const command = manifest.commands && manifest.commands['toggle-enabled'];

assert.ok(command, 'manifest declares the toggle-enabled command');
assert.equal(command.suggested_key.default, 'Ctrl+Shift+Y');
assert.equal(command.suggested_key.mac, 'Command+Shift+Y');
assert.equal(command.description, '开启/关闭划词翻译');
assert.equal(
  Object.prototype.hasOwnProperty.call(command, 'global'),
  false,
  'toggle command stays scoped to Chrome instead of system-global'
);
