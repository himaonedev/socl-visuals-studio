// ─── Local speech-to-text bundle (whisper.cpp) ─────────────
// Downloads a whisper.cpp CLI binary + a GGML model into
// `userData/whisper/<version>/` on demand, so the app can transcribe with no
// API key and no network at run time.
//
// Why this exists: transcription had exactly two tiers — Groq Whisper (needs a
// key) and a local whisper.cpp that was never shipped and could only be
// enabled through an env var no user sets. On a machine without a readable
// Groq key there was therefore NO transcript source at all, and without a
// transcript TF-IDF has nothing to score, so clip selection silently collapsed
// to fixed-interval cuts. This is the missing third tier.
//
// Download/verify/progress use the shared timeout-protected downloader; the
// additions here are per-platform binary selection, an unzip step for Windows,
// and the executable bit on Unix.

const fs      = require('fs');
const path    = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const { download } = require('./bundle-download');
const { pruneOldVersions } = require('./bundle-cleanup');
const MANIFEST = require('./whisper-manifest.json');

function platformKey() {
  return `${process.platform}-${process.arch}`;
}
function binarySpec(key = platformKey()) {
  return MANIFEST.binaries[key] || null;
}
function isSupportedPlatform(key = platformKey()) {
  return !!binarySpec(key);
}
function modelSpec(name) {
  return MANIFEST.models[name] || MANIFEST.models[MANIFEST.defaultModel];
}
function modelNames() {
  return Object.keys(MANIFEST.models);
}

function bundleParent() {
  return path.join(app.getPath('userData'), 'whisper');
}
function bundleRoot() {
  return path.join(bundleParent(), MANIFEST.version);
}
// [DISK-LEAK] Same version-scoped leak as tracker-bundle.js — a whisper
// version bump strands the old CLI plus whichever models the user had pulled
// (up to ~1.5GB for the large model). Only prunes SIBLING versions: the
// several `model-*.bin` files inside the current version are all live, since
// the user can switch model size at any time.
function cleanupOldVersions() {
  return pruneOldVersions(bundleParent(), MANIFEST.version, { label: 'whisper' });
}
function binPath(key = platformKey()) {
  const spec = binarySpec(key);
  return spec ? path.join(bundleRoot(), spec.exe) : null;
}
function modelPath(name) {
  return path.join(bundleRoot(), `model-${name || MANIFEST.defaultModel}.bin`);
}

// [VAD] whisper.cpp runs its encoder over every 30s window of the file,
// including the silent ones, and the encoder is ~90% of the wall clock on a
// low-power CPU (8.9s per window measured on a Ryzen 3 7320U). Silero VAD skips
// the windows with no speech. Measured on 122.2s of audio, 83% of it speech:
// 58s -> 52s; on real video, which carries far more silence and music than that
// test did, the share it can skip is larger.
//
// This is a SEPARATE concern from the model download and is deliberately not
// part of isInstalled(): see the note in the manifest.
function vadPath() {
  return path.join(bundleRoot(), MANIFEST.vad?.file || 'vad-silero.bin');
}
function vadInstalled() {
  const spec = MANIFEST.vad;
  if (!spec) return false;
  const p = vadPath();
  if (!fs.existsSync(p)) return false;
  try { return fs.statSync(p).size >= (spec.minBytes || 1); } catch { return false; }
}

// A half-written download must never count as installed: a truncated model
// makes whisper fail deep inside a run, which reads to the user as "the app is
// broken" rather than "the download did not finish". Size is the cheap proxy
// the other bundles use too.
function binaryInstalled(key = platformKey()) {
  const p = binPath(key);
  if (!p || !fs.existsSync(p)) return false;
  try { return fs.statSync(p).size > 100_000; } catch { return false; }
}
function modelInstalled(name) {
  const spec = modelSpec(name);
  const p = modelPath(name);
  if (!fs.existsSync(p)) return false;
  try { return fs.statSync(p).size >= (spec.minBytes || 1); } catch { return false; }
}
function isInstalled(name) {
  return binaryInstalled() && modelInstalled(name);
}

// Windows ships the CLI plus its runtime DLLs in a zip; the DLLs must land
// beside the exe or the spawn fails with a bare "spawn UNKNOWN" that looks
// exactly like the antivirus problem we already chase on that platform.
function unzip(zipPath, destDir) {
  if (process.platform === 'win32') {
    // [WIN-POWERSHELL-ENOENT] Same fix as extractZip() in bootstrap.js — a
    // bare 'powershell' resolves through PATH, which fails with
    // "spawnSync powershell ENOENT" on machines whose PATH lacks
    // System32\WindowsPowerShell\v1.0 (trimmed/locked-down PATH, minimal
    // Windows image). The absolute path sidesteps PATH resolution entirely.
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const ps = fs.existsSync(psPath) ? psPath : 'powershell';
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`],
      { stdio: 'ignore' });
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'ignore' });
  }
}

async function ensureInstalled(modelName, onProgress) {
  if (process.env.SOCL_NATIVE_WHISPER === '1') {
    const paths = await require('../engine/platform.cjs').ensureWhisper(modelName || MANIFEST.defaultModel, onProgress);
    return paths;
  }
  const name = MANIFEST.models[modelName] ? modelName : MANIFEST.defaultModel;
  const key = platformKey();
  const spec = binarySpec(key);
  if (!spec) throw new Error(`Whisper lokal belum tersedia untuk ${key}`);
  const root = bundleRoot();
  fs.mkdirSync(root, { recursive: true });

  if (!binaryInstalled(key)) {
    if (!spec.url) throw new Error('whisper manifest: binary url kosong');
    onProgress?.({ phase: 'binary', percent: 0 });
    const tmp = path.join(root, spec.zip ? 'bin.zip.part' : `${spec.exe}.part`);
    const { sha256 } = await download(spec.url, tmp,
      (p) => onProgress?.({ phase: 'binary', percent: p.percent, got: p.got, total: p.total }));
    if (spec.sha256 && !/^(SKIP_VERIFY|PENDING)$/i.test(spec.sha256)
        && sha256.toLowerCase() !== spec.sha256.toLowerCase()) {
      fs.unlinkSync(tmp);
      throw new Error(`sha256 binary tidak cocok: ${sha256}`);
    }
    if (spec.zip) {
      const zipFinal = path.join(root, 'bin.zip');
      fs.renameSync(tmp, zipFinal);
      unzip(zipFinal, root);
      try { fs.unlinkSync(zipFinal); } catch {}
      if (!fs.existsSync(path.join(root, spec.exe))) {
        throw new Error('zip whisper tidak berisi ' + spec.exe);
      }
    } else {
      fs.renameSync(tmp, path.join(root, spec.exe));
    }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(path.join(root, spec.exe), 0o755); } catch {}
    }
  }

  if (!modelInstalled(name)) {
    const m = modelSpec(name);
    onProgress?.({ phase: 'model', percent: 0 });
    const tmp = modelPath(name) + '.part';
    const { sha256 } = await download(m.url, tmp,
      (p) => onProgress?.({ phase: 'model', percent: p.percent, got: p.got, total: p.total }));
    if (m.sha256 && !/^(SKIP_VERIFY|PENDING)$/i.test(m.sha256)
        && sha256.toLowerCase() !== m.sha256.toLowerCase()) {
      fs.unlinkSync(tmp);
      throw new Error(`sha256 model tidak cocok: ${sha256}`);
    }
    fs.renameSync(tmp, modelPath(name));
  }

  // [VAD] Opportunistic and deliberately NON-FATAL. VAD only makes an existing
  // capability faster; a machine that cannot fetch this 0.9MB file must still
  // get its transcript, just at the old speed. Throwing here would turn a
  // performance feature into a new way for transcription to fail — and this
  // tier exists precisely for the users with the worst connections.
  //
  // It also runs for installs that predate VAD: those already have the binary
  // and the model, so ensureInstalled() skips both blocks above and this is the
  // only thing that downloads.
  if (MANIFEST.vad?.url && !vadInstalled()) {
    try {
      onProgress?.({ phase: 'vad', percent: 0 });
      const tmp = vadPath() + '.part';
      const { sha256 } = await download(MANIFEST.vad.url, tmp,
        (p) => onProgress?.({ phase: 'vad', percent: p.percent, got: p.got, total: p.total }));
      const want = MANIFEST.vad.sha256;
      if (want && !/^(SKIP_VERIFY|PENDING)$/i.test(want) && sha256.toLowerCase() !== want.toLowerCase()) {
        throw new Error(`sha256 VAD tidak cocok: ${sha256}`);
      }
      fs.renameSync(tmp, vadPath());
    } catch (e) {
      // Leave no half-written file behind: vadInstalled() gates on size, and a
      // truncated model would make whisper fail at the moment of use instead.
      try { fs.unlinkSync(vadPath() + '.part'); } catch {}
      try { fs.unlinkSync(vadPath()); } catch {}
      console.warn('[whisper] VAD tidak terpasang, transkrip tetap jalan tanpa VAD:', e?.message || e);
    }
  }

  // Both halves are on disk and past their checksum gates by here — every
  // failure above throws out of this function before reaching the sweep.
  await cleanupOldVersions();
  onProgress?.({ phase: 'done' });
  // `vad` is null when it could not be fetched; the caller must treat it as
  // optional and never pass -vm with a path that does not exist.
  return { bin: binPath(key), model: modelPath(name), vad: vadInstalled() ? vadPath() : null };
}

function remove() {
  const root = bundleParent();
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

// Rough on-disk cost, so the UI can tell the user what a download will cost
// BEFORE it starts rather than after.
function downloadSize(modelName) {
  const m = modelSpec(modelName);
  const b = binarySpec();
  return (m?.size || 0) + (b ? 15_000_000 : 0);
}

module.exports = {
  MANIFEST, bundleRoot, binPath, modelPath, modelNames, modelSpec,
  isInstalled, binaryInstalled, modelInstalled, isSupportedPlatform,
  platformKey, ensureInstalled, cleanupOldVersions, remove, downloadSize,
  vadPath, vadInstalled,
};
