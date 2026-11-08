const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('transitional render report patches are awaited through the Rust-owned store', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'socl-report-owner-'));
  const oldProfile = process.env.SOCL_APP_DATA, oldReports = process.env.SOCL_NATIVE_REPORTS;
  process.env.SOCL_APP_DATA = profile;
  process.env.SOCL_NATIVE_REPORTS = '1';
  t.after(() => {
    if (oldProfile === undefined) delete process.env.SOCL_APP_DATA; else process.env.SOCL_APP_DATA = oldProfile;
    if (oldReports === undefined) delete process.env.SOCL_NATIVE_REPORTS; else process.env.SOCL_NATIVE_REPORTS = oldReports;
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const platform = require('../engine/platform.cjs');
  const requests = [];
  platform.connect(() => {}, async (op, payload) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    requests.push({ op, payload });
    return { updated: true, reportPath: 'synthetic/report.json' };
  });
  const { persistClipPatch } = require('../src/clip-report');
  const payload = { outputFile: path.join(profile, 'hasil', 'clip.mp4'), clipIndex: 0, patch: { file: 'rendered.mp4', titlesBurned: true } };
  assert.deepEqual(await persistClipPatch(payload), { updated: true, reportPath: 'synthetic/report.json' });
  assert.deepEqual(requests, [{ op: 'store-report', payload }]);
  assert.deepEqual(fs.readdirSync(profile), []);
});
