const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { prepareNodeRuntime } = require('../scripts/node-runtime.cjs');

test('installs a missing Node sidecar and verifies it', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'socl-runtime-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const target = path.join(folder, 'runtime', path.basename(process.execPath));
  assert.equal(prepareNodeRuntime(target), process.version);
  assert.ok(fs.existsSync(target));
});

test('reuses a running sidecar without attempting to copy the caller runtime', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'socl-runtime-'));
  const target = path.join(folder, path.basename(process.execPath));
  fs.copyFileSync(process.execPath, target);
  const child = spawn(target, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    fs.rmSync(folder, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  const before = fs.statSync(target).mtimeMs;
  // An unavailable source proves this path never attempts a replacement copy.
  assert.equal(prepareNodeRuntime(target, path.join(folder, 'missing-source.exe')), process.version);
  assert.equal(fs.statSync(target).mtimeMs, before);
});
