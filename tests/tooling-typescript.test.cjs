const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

test('package and Tauri launchers use real TypeScript sources that Node can parse', () => {
  const pkg = require('../package.json');
  const config = require('../src-tauri/tauri.conf.json');
  assert.equal(pkg.scripts.tauri, 'node scripts/tauri.ts');
  assert.equal(config.build.beforeDevCommand, 'node scripts/dev-frontend.ts');
  assert.equal(config.build.beforeBuildCommand, 'node scripts/build-frontend.ts');
  for (const name of ['tauri', 'dev-frontend', 'build-frontend']) {
    const file = path.join(root, 'scripts', name + '.ts');
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(path.join(root, 'scripts', name + '.cjs')));
    // Node --check does not apply TS stripping in this runtime. Use the same
    // native type stripper as execution, then check JS without starting dev.
    const script = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
    assert.doesNotThrow(() => new vm.Script(script, { filename: file }));
  }
});
