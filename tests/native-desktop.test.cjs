const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

test('desktop engine delegates settings and media transport to Rust', { timeout: 30000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'socl-native-desktop-'));
  const child = spawn(process.execPath, ['engine/server.cjs'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SOCL_APP_DATA: profile, SOCL_NATIVE_SETTINGS: '1', SOCL_NATIVE_MEDIA: '1', SOCL_NATIVE_REPORTS: '1', SOCL_NATIVE_WHISPER: '1' },
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill(); await exited; fs.rmSync(profile, { recursive: true, force: true }); });
  let diagnostics = '';
  let nativeWrite, responseResolve, responseReject;
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Engine startup timed out: ' + diagnostics.slice(-1500))), 20000);
    const lines = readline.createInterface({ input: child.stdout });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Engine exited: ' + code)); });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.kind === 'ready') { clearTimeout(timer); resolve(message.data); }
      if (message.kind === 'fatal') { clearTimeout(timer); reject(new Error(message.error)); }
      if (message.kind === 'native' && message.op === 'store-settings') {
        nativeWrite = message.payload;
        child.stdin.write(JSON.stringify({ kind: 'native-result', id: message.id, result: message.payload }) + '\n');
      }
      if (message.kind === 'response' && message.id === 9001) {
        if (message.error) responseReject(new Error(message.error)); else responseResolve(message.result);
      }
    });
  });
  assert.equal(ready.mediaBase, null);
  assert.ok(Array.isArray(ready.mediaRoots));
  for (const channel of ['get-settings', 'set-settings', 'secrets:available', 'secrets:diagnose']) assert.ok(!ready.channels.includes(channel), channel);
  assert.ok(ready.channels.includes('run-pipeline'));
  for (const channel of ['whisper:status', 'whisper:ensure', 'whisper:remove']) assert.ok(!ready.channels.includes(channel), channel);
  const response = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
  child.stdin.write(JSON.stringify({ id: 9001, channel: 'set-cookies', args: [{ clear: true }] }) + '\n');
  assert.equal((await response).ok, true);
  assert.deepEqual(nativeWrite, { cookiesPath: '' });
});
