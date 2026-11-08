const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { parseRequest } = require('../engine/contracts.js');
const root = path.resolve(__dirname, '..');
const modules = require('../backend/modules.json');

test('compiled backend includes every relative code dependency and the context worker', () => {
  const outputs = new Set(modules.map(item => item.output));
  assert.ok(outputs.has('src/context-model/worker.js'));
  for (const item of modules) {
    const text = fs.readFileSync(path.join(root, item.output), 'utf8');
    assert.ok(text.startsWith('// Generated from ' + item.source), item.output);
    for (const match of text.matchAll(/["'](\.{1,2}\/[^"'\r\n]+)["']/g)) {
      const stem = path.resolve(root, path.dirname(item.output), match[1]);
      const resolved = [stem, stem + '.js', stem + '.cjs', path.join(stem, 'index.js')].find(file => /\.(js|cjs)$/.test(file) && fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved && resolved.startsWith(root + path.sep)) assert.ok(outputs.has(path.relative(root, resolved).replaceAll('\\', '/')), item.output + ' -> ' + match[1]);
    }
    const result = ts.transpileModule(fs.readFileSync(path.join(root, item.source), 'utf8'), {
      fileName: item.source,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, alwaysStrict: false, ignoreDeprecations: '6.0', removeComments: false },
    });
    assert.equal(text, '// Generated from ' + item.source + ' by scripts/backend.cjs. Edit the TypeScript source.\n' + result.outputText, 'stale compiled output: ' + item.output);
  }
});

test('typed engine boundary preserves both RPC formats and validates malformed requests', () => {
  assert.deepEqual(parseRequest({ id: 1, channel: 'run-pipeline' }), { kind: 'invoke', id: 1, channel: 'run-pipeline', args: [] });
  assert.deepEqual(parseRequest({ kind: 'invoke', id: 2, channel: 'render-edit', args: [{ file: 'clip.mp4' }] }).args, [{ file: 'clip.mp4' }]);
  assert.deepEqual(parseRequest({ kind: 'shutdown' }), { kind: 'shutdown' });
  assert.deepEqual(parseRequest({ kind: 'native-progress', id: 3, data: { phase: 'model', percent: 0.5 } }), { kind: 'native-progress', id: 3, data: { phase: 'model', percent: 0.5 } });
  assert.equal(parseRequest({ kind: 'native-result', id: 3, result: { ok: true }, error: null }).error, undefined);
  for (const bad of [null, [], { id: -1, channel: 'test' }, { id: 1, channel: '' }, { id: 1, channel: 'test', args: {} }, { kind: 'native-result', id: 1, error: {} }]) assert.throws(() => parseRequest(bad));
});
