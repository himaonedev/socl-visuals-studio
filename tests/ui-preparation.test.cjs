const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('concurrent UI preparation never publishes an empty or partially transformed renderer', async () => {
  const root = path.resolve(__dirname, '..');
  const renderer = path.join(root, 'public/legacy/renderer.js');
  const failures = [];
  const check = () => {
    try {
      const text = fs.readFileSync(renderer, 'utf8');
      if (!text.includes('window.__soclCurrentClip =') || !text.includes('window.__soclApplyEffects =')) failures.push('incomplete renderer');
    } catch (e) { failures.push(e.message); }
  };
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/prepare-ui.cjs')], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let diagnostics = '';
    child.stderr.on('data', bytes => { diagnostics += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`UI preparation exited ${code}: ${diagnostics}`)));
  });
  const timer = setInterval(check, 10);
  try { await Promise.all([run(), run()]); check(); }
  finally { clearInterval(timer); }
  assert.deepEqual(failures, []);
});
