const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');

test('headless engine persists settings and renders a local manual clip without Electron or a license', { timeout: 180000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const scratchRoot = path.join(root, '.dev-tools/tests');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'engine-'));
  const child = spawn(process.execPath, ['engine/server.cjs'], { cwd: root, env: { ...process.env, SOCL_APP_DATA: path.join(scratch, 'profile') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  const pending = new Map();
  const events = [];
  let id = 0, log = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startupTimer = setTimeout(() => readyReject(new Error('Engine did not start: ' + log.slice(-4000))), 20000);
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.on('data', bytes => { log += bytes; });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.kind === 'ready') { clearTimeout(startupTimer); readyResolve(message.data); }
    else if (message.kind === 'fatal') { clearTimeout(startupTimer); readyReject(new Error(message.error)); }
    else if (message.kind === 'event') events.push(message);
    else if (message.kind === 'native') child.stdin.write(JSON.stringify({ kind: 'native-result', id: message.id, error: 'Unexpected native dialog in test' }) + '\n');
    else if (message.kind === 'response') {
      const p = pending.get(message.id);
      if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }
    }
  });
  function invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject });
      child.stdin.write(JSON.stringify({ id: key, channel, args }) + '\n');
    });
  }
  t.after(async () => {
    clearTimeout(startupTimer);
    if (!child.killed && child.exitCode == null) {
      child.stdin.write(JSON.stringify({ kind: 'shutdown' }) + '\n');
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 3000);
      await closed; clearTimeout(killTimer);
    }
    fs.writeFileSync(path.join(scratch, 'engine.log'), log);
  });
  const info = await ready;
  assert.ok(info.channels.includes('run-pipeline'));
  assert.ok(!info.channels.some(channel => channel.startsWith('license:')));
  await assert.rejects(invoke('license:getCurrent'), /Unsupported/);
  const initial = await invoke('get-settings');
  await invoke('set-settings', { clipCount: 3 });
  assert.equal((await invoke('get-settings')).clipCount, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, 'profile/settings.json'), 'utf8')).clipCount, 3);
  const bin = await invoke('get-bin-paths');
  assert.ok(fs.existsSync(bin.ffmpeg));
  assert.ok(fs.existsSync(bin.ffprobe));
  const source = path.join(scratch, 'source #test.mp4');
  const generate = spawnSync(bin.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(generate.status, 0, generate.stderr);
  const output = path.join(scratch, 'exports');
  fs.mkdirSync(output);
  const result = await invoke('run-pipeline', { source, noTranscript: true, overrides: {
    ...initial, exportPath: output, clipCount: 1, clipMode: 'manual', manualSegments: [{ start: '00:00', end: '00:04' }],
    format: 'landscape', resolution: '720p', burnSubtitles: false, deadAirCut: false, smartTrack: false,
    localAsr: false, hookProvider: '', aiProvider: '', videoFx: 'none', watermark: { enabled: false },
  } });
  assert.ok(result);
  assert.ok(events.some(event => event.channel === 'pipeline-progress'));
  assert.ok(events.some(event => event.channel === 'pipeline-done'));
  const rendered = [];
  function walk(folder) { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) walk(file); else if (file.endsWith('.mp4')) rendered.push(file); } }
  walk(output);
  assert.ok(rendered.length > 0, 'Expected a rendered MP4');
  const probe = spawnSync(bin.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', rendered[0]], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Number(JSON.parse(probe.stdout).format.duration) > 3);
  const videoUrl = info.mediaBase + '?path=' + encodeURIComponent(rendered[0]);
  assert.equal((await fetch(videoUrl, { method: 'HEAD' })).status, 200);
});
