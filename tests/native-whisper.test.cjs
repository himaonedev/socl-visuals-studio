const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('pipeline Whisper installation delegates to Rust without invoking the JS downloader', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Module = require('node:module');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'socl-whisper-delegate-'));
    process.env.SOCL_APP_DATA = profile;
    process.env.SOCL_NATIVE_WHISPER = '1';
    const platform = require('./engine/platform.cjs');
    const original = Module._load;
    Module._load = function(name, ...args) { return name === 'electron' ? platform : original.call(this, name, ...args); };
    let calls = 0;
    let progress;
    platform.connect(() => {}, async (op, model, report) => {
      assert.equal(op, 'whisper-install');
      assert.equal(model, 'small');
      calls++;
      report({ phase: 'model', percent: 0.5 });
      return { bin: 'native-cli', model: 'native-model', vad: null };
    });
    const bundle = require('./src/whisper-bundle.js');
    bundle.ensureInstalled('small', value => { progress = value; }).then(paths => {
      assert.deepEqual(paths, { bin: 'native-cli', model: 'native-model', vad: null });
      assert.equal(calls, 1);
      assert.deepEqual(progress, { phase: 'model', percent: 0.5 });
      assert.equal(fs.existsSync(path.join(profile, 'whisper')), false);
    }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(profile, { recursive: true, force: true }));
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
});
