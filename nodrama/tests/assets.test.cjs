const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../internal/web/static');

function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? scripts(file) : file.endsWith('.js') ? [file] : [];
  });
}

test('every embedded browser script has valid JavaScript syntax', () => {
  for (const file of scripts(root)) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
});

test('index script and stylesheet references resolve to embedded assets', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="\/static\/([^"?#]+)"/g)].map(match => match[1]);
  assert.ok(references.length > 0);
  assert.equal(new Set(references).size, references.length, 'duplicate asset references');
  for (const reference of references) assert.ok(fs.statSync(path.join(root, reference)).isFile(), reference);
  const context = vm.createContext({
    window: { location: new URL('http://localhost') },
    document: { addEventListener() {} },
    navigator: { language: 'en' },
    setInterval() {},
    URL, URLSearchParams, console,
  });
  // Define functions in actual index order, omitting the final boot invocation.
  // This catches top-level dependency/order errors as well as syntax errors.
  for (const reference of references.filter(file => file.endsWith('.js') && !file.endsWith('/99-start.js'))) {
    vm.runInContext(fs.readFileSync(path.join(root, reference), 'utf8'), context, { filename: reference });
  }
});

test('all supported languages contain the same translation keys', () => {
  const context = vm.createContext({});
  for (const file of ['00-core.js', 'en.js', 'ko.js', 'ja.js', 'zh-CN.js', 'es.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'i18n', file), 'utf8'), context);
  }
  const languages = vm.runInContext('I18N', context);
  const expected = Object.keys(languages.en).sort();
  for (const [language, strings] of Object.entries(languages)) {
    assert.deepEqual(Object.keys(strings).sort(), expected, language);
  }
});
