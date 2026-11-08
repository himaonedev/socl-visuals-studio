// ─── [CTX-MODEL] Host side: run the worker, pick moments ───────────────────
// The only entry point the pipeline uses. Everything here degrades to "no
// context picks" (the caller then uses the TF-IDF/topic picker as before) —
// a missing bundle, a worker crash or a timeout must never fail a run.

const path = require('path');
const { PROTOTYPES, buildSentences, pickMoments } = require('./picker');

const WORKER = path.join(__dirname, 'worker.js');
const WORKER_TIMEOUT_MS = 240_000;

function decode(b64, dim) {
  const buf = Buffer.from(b64, 'base64');
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const rows = [];
  for (let k = 0; k + dim <= all.length; k += dim) rows.push(all.subarray(k, k + dim));
  return rows;
}

// Electron (packaged: RunAsNode fuse is off) → utilityProcess; plain Node → fork.
function startWorker() {
  let electron = null;
  try { electron = require('electron'); } catch {}
  if (electron && typeof electron === 'object' && electron.utilityProcess) {
    const child = electron.utilityProcess.fork(WORKER, [], { serviceName: 'SOCL context model', stdio: 'ignore' });
    return {
      send: (m) => child.postMessage(m),
      onMessage: (fn) => child.on('message', fn),
      onExit: (fn) => child.on('exit', fn),
      kill: () => { try { child.kill(); } catch {} },
    };
  }
  const child = require('child_process').fork(WORKER, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let err = '';
  child.stderr?.on('data', (d) => { err = (err + d).slice(-800); });
  return {
    send: (m) => child.send(m),
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code) => fn(code, err)),
    kill: () => { try { child.kill(); } catch {} },
  };
}

function embedGroups(bundleDir, groups, { timeoutMs = WORKER_TIMEOUT_MS, threads = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const w = startWorker();
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); w.kill(); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error(`model konteks tidak selesai dalam ${Math.round(timeoutMs / 1000)} detik`)), timeoutMs);
    w.onMessage((msg) => {
      if (!msg || !msg.ok) return finish(reject, new Error((msg && msg.error) || 'worker gagal'));
      const out = {};
      for (const [k, v] of Object.entries(msg.vectors)) out[k] = decode(v, msg.dim);
      finish(resolve, { vectors: out, stats: msg.stats });
    });
    w.onExit((code, err) => finish(reject, new Error(`worker keluar (${code})${err ? ': ' + String(err).trim().split('\n').pop() : ''}`)));
    w.send({ bundleDir, groups, threads });
  });
}

// → { picks: [{start,end,score,text,features}], stats } ; throws on any failure.
async function pickContextMoments({ bundleDir, words, cues, numClips, dur, promo = [], seen = [], heatmap = null, timeoutMs }) {
  const t0 = Date.now();
  const S = buildSentences({ words, cues });
  if (S.length < 6) return { picks: [], stats: { sentences: S.length, totalMs: Date.now() - t0 } };
  const groups = { sentences: S.map((s) => s.text), ...PROTOTYPES };
  const { vectors, stats } = await embedGroups(bundleDir, groups, { timeoutMs });
  const P = {};
  for (const k of Object.keys(PROTOTYPES)) P[k] = vectors[k];
  const r = pickMoments({ S, V: vectors.sentences, P, numClips, dur, promo, seen, heatmap });
  return { picks: r.picks, stats: { ...stats, sentences: S.length, candidates: r.candidates, totalMs: Date.now() - t0 } };
}

module.exports = { pickContextMoments, embedGroups, WORKER };
