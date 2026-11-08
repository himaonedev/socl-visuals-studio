// ─── [CTX-MODEL] Optional download: "Pembaca konteks lokal" ────────────────
// ~92-100 MB per platform (model + ONNX Runtime), installed into
// userData/context-model/<version>/ only when the user asks for it in
// Settings → AI. Same safeguards as the tracker runtime: sha256 check, an
// .installing marker for the whole extraction (an interrupted install never
// counts as installed), stale versions pruned only after the new one verifies.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const MANIFEST = require('./manifest.json');

const INSTALLING = '.installing';

function platformKey() { return `${process.platform}-${process.arch}`; }
function asset() { return MANIFEST.assets[platformKey()] || null; }
function isSupported() { return !!asset(); }
function parentDir() { return path.join(app.getPath('userData'), 'context-model'); }
function bundleDir() { return path.join(parentDir(), MANIFEST.version); }

function isInstalled() {
  const d = bundleDir();
  try {
    if (fs.existsSync(path.join(d, INSTALLING))) return false;
    const model = path.join(d, 'model', 'model_quantized.onnx');
    const binding = path.join(d, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', process.platform, process.arch, 'onnxruntime_binding.node');
    return fs.statSync(model).size > 50e6 && fs.existsSync(path.join(d, 'model', 'tokenizer.json')) && fs.existsSync(binding);
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha256File(f) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

let _inflight = null;
function ensureInstalled(onProgress) {
  if (isInstalled()) return Promise.resolve(bundleDir());
  if (_inflight) return _inflight;
  _inflight = _install(onProgress).finally(() => { _inflight = null; });
  return _inflight;
}

async function _install(onProgress) {
  const a = asset();
  if (!a) throw new Error(`Pembaca konteks lokal belum tersedia untuk ${platformKey()}`);
  const tb = require('../tracker-bundle');   // proven downloader (Electron net, ranges, stall timeouts) + tar extract
  const dir = bundleDir();
  fs.mkdirSync(parentDir(), { recursive: true });
  const tmp = path.join(parentDir(), `dl-${MANIFEST.version}.tar.gz`);
  // a verified download from an earlier attempt is reused (extract may have been what failed)
  let have = false;
  if (fs.existsSync(tmp)) {
    try { have = (await sha256File(tmp)) === a.sha256; } catch {}
    if (!have) { try { fs.unlinkSync(tmp); } catch {} }
  }
  for (let attempt = 1; !have; attempt++) {
    try {
      onProgress?.({ phase: 'download', percent: 0 });
      const { sha256 } = await tb.downloadFast(a.url, tmp, (p) => onProgress?.({ phase: 'download', percent: p.percent, got: p.got, total: p.total }));
      if (sha256.toLowerCase() !== a.sha256) throw Object.assign(new Error(`sha256 mismatch: ${sha256}`), { fatal: attempt >= 2 });
      have = true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      if (attempt >= 3 || e.fatal) throw e;
      await sleep(attempt * 3000);
    }
  }
  onProgress?.({ phase: 'extract' });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, INSTALLING), String(Date.now()));
  try {
    await tb.extractTarGz(tmp, dir, { onFile: () => {} });
    fs.rmSync(path.join(dir, INSTALLING), { force: true, maxRetries: 8, retryDelay: 250 });
    if (!isInstalled()) throw new Error('model konteks terekstrak tetapi file utamanya tidak ada');
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw e;                     // the verified tarball stays for the next attempt
  }
  try { fs.unlinkSync(tmp); } catch {}
  try { require('../bundle-cleanup').pruneOldVersions(parentDir(), MANIFEST.version, { label: 'context-model' }); } catch {}
  onProgress?.({ phase: 'done' });
  return dir;
}

function remove() {
  try { fs.rmSync(parentDir(), { recursive: true, force: true }); } catch {}
}

module.exports = { MANIFEST, platformKey, isSupported, isInstalled, bundleDir, ensureInstalled, remove,
  downloadBytes: () => (asset() ? asset().bytes : 0) };
