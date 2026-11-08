const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/legacy-src/renderer.ts', 'utf8');
const live = require('../src/live-preview-state');

test('renderer restores clips at bootstrap and checkpoints before pagehide', () => {
  const saved = live.snapshot({ clips: [{ file: 'rendered.mp4' }], activeClip: 0, currentPreviewIdx: 0 });
  const storage = new Map([['socl-clipping-session-v1', saved]]);
  const handlers = {};
  const context = vm.createContext({
    window: { ClipSelect: { createSelection: () => ({}) }, LivePreviewState: live,
      addEventListener: (name, handler) => { handlers[name] = handler; } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(source.slice(0, source.indexOf('// [WM-V1]')), context);
  assert.equal(vm.runInContext('state.clips[0].file', context), 'rendered.mp4');
  assert.equal(vm.runInContext('restoredClippingSession', context), true);
  vm.runInContext("state.clips[0].file = 'edited.mp4'; persistClippingSession()", context);
  assert.equal(live.restoreSnapshot(storage.get('socl-clipping-session-v1')).clips[0].file, 'edited.mp4');
  assert.equal(typeof handlers.pagehide, 'function');
});
