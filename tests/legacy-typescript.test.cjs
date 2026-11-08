const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const modules = require('../frontend/legacy-modules.json');

test('every active browser script has exactly one TypeScript source, with shared ownership preserved', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const names = ['preload.js', ...[...html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map(m => m[1])];
  const owners = new Map(require('../backend/modules.json').map(m => [m.output, m.source]));
  assert.equal(new Set(modules.map(m => m.output)).size, modules.length);
  assert.deepEqual(modules.map(m => m.output), names.map(name => 'src/' + name));
  for (const item of modules) {
    assert.ok(item.source.endsWith('.ts'));
    assert.ok(fs.existsSync(path.join(root, item.source)), item.source);
    if (owners.has(item.output)) assert.equal(item.source, owners.get(item.output));
    const text = fs.readFileSync(path.join(root, item.output), 'utf8');
    assert.ok(text.startsWith('// Generated from ' + item.source), item.output);
    assert.ok(!text.includes('Object.defineProperty(exports, "__esModule"'), 'browser script must not require a CommonJS module loader: ' + item.output);
  }
});

test('typed preload works as a browser script and preserves IPC payloads and listener cleanup', async () => {
  const calls = [], listeners = new Map();
  const window = {
    __soclPlatform: 'win32',
    __soclDroppedPaths: new Map([['test.mp4', 'D:\\clips\\test.mp4']]),
    __soclIpc: {
      invoke: async (channel, ...args) => { calls.push({ channel, args }); return { ok: true }; },
      on: (channel, callback) => listeners.set(channel, callback),
      removeListener: (channel, callback) => { assert.equal(listeners.get(channel), callback); listeners.delete(channel); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8'), { window });
  assert.equal(window.socl.platform, 'win32');
  const payload = { outputFile: 'clip.mp4', style: { subtitleBoxRotation: -12 } };
  await window.socl.renderEdit(payload);
  assert.equal(calls[0].channel, 'render-edit');
  assert.equal(calls[0].args[0], payload);
  assert.equal(window.socl.pathForFile({ name: 'test.mp4' }), 'D:\\clips\\test.mp4');
  assert.equal(window.socl.pathForFile({ name: 'test.mp4', __nativePath: 'E:\\test.mp4' }), 'E:\\test.mp4');
  await window.socl.whisper.status();
  assert.equal(calls[1].channel, 'whisper:status');
  let progress;
  const unsubscribe = window.socl.onRenderProgress(value => { progress = value; });
  listeners.get('render-progress')(null, { clipIndex: 0, pct: 50 });
  assert.deepEqual(progress, { clipIndex: 0, pct: 50 });
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('typed undo/redo still works through its browser global without a CommonJS loader', () => {
  const browser = {};
  browser.self = browser;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/edit-history.js'), 'utf8'), browser);
  const history = browser.EditHistory.createHistory({ limit: 2 });
  history.push('first'); history.push('second'); history.push('third');
  assert.equal(history.size(), 2);
  assert.equal(history.undo('current'), 'third');
  assert.equal(history.redo('third'), 'current');
  history.push('next');
  assert.equal(history.canRedo(), false);
});
