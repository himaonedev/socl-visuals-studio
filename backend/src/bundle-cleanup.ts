// ─── Version-scoped bundle cleanup ─────────────────────────
// Every on-demand asset bundle installs into `userData/<kind>/<version>/`
// (tracker-runtime, whisper) and every isInstalled() check only
// ever looks at the CURRENT manifest version's path. That combination leaks:
// bumping a manifest version makes the app download a fresh copy into a NEW
// directory and leave the previous one on disk forever. Measured on a real
// install: tracker-runtime/<v> is 1.1GB EXTRACTED (the ~333MB figure is the
// compressed download) and whisper/<v> is 184MB with one model pulled. Nothing ever
// deleted them, so the
// only way a user reclaimed the space was the all-or-nothing Settings
// "remove" button (which wipes the working version too).
//
// This prunes the stale siblings. Three properties the callers depend on:
//
//   1. It only ever runs AFTER the current version is installed and verified.
//      Pruning before/around a download would delete the fallback while the
//      replacement may still fail its sha256 check.
//   2. It never touches a directory something is running from. Long-lived
//      children (the Smart Track Python sidecar) register their bundle path
//      via markInUse() for as long as the process is alive. This is the whole
//      story rather than a best-effort heuristic because main.js takes
//      Electron's single-instance lock, so no second copy of the app can be
//      running against the same userData directory. (An fs-level "is this
//      binary busy" probe is NOT a usable substitute: macOS happily opens a
//      currently-executing Mach-O for writing — measured — so the probe would
//      report "free" on the platform most users are on.)
//   3. It never throws. Windows refuses to delete files another process or an
//      antivirus scanner holds open; a stale directory surviving one more
//      release is a non-event, an exception escaping into the install path
//      that just succeeded is not. Failures are logged and skipped, and the
//      next sweep retries them.
//
// Removal is rename-then-delete rather than a straight recursive delete: a
// delete that dies halfway (Windows lock on one file deep in the tree) would
// otherwise leave a half-gutted directory still sitting under its version
// name — exactly the shape isInstalled() mistakes for a working bundle if
// that version ever becomes current again. Renaming to `.trash-*` first makes
// the directory unfindable by every version-keyed lookup the instant the
// removal starts, and leaves any remains under a name this same sweep
// collects on its next run.

const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');

const TRASH_PREFIX = '.trash-';

// fs.rm's own retry loop, which covers exactly the Windows failure mode this
// has to survive: an antivirus scanner or indexer holding a just-extracted
// file open for a moment (EBUSY/EPERM). Node does not retry by default.
const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 200 };

// Absolute paths inside bundle directories that a live process is using.
// Keys are files (the spawned executable) or directories; a candidate is
// protected when any registered path is the candidate itself or lives under it.
//
// Refcounted, not a set: the clip worker pool runs CLIP_CONCURRENCY sidecars
// at once and every one of them spawns the SAME python binary, so a plain set
// would unprotect the directory as soon as the first of them exited.
const _inUse = new Map();   // absolute path -> number of live users

function markInUse(p) {
  if (!p) return;
  const abs = path.resolve(p);
  _inUse.set(abs, (_inUse.get(abs) || 0) + 1);
}

function releaseInUse(p) {
  if (!p) return;
  const abs = path.resolve(p);
  const n = _inUse.get(abs) || 0;
  // Release is called from `finally`/'close' paths that can plausibly fire
  // twice; clamping at zero keeps a double-release from making the count
  // negative and permanently pinning the directory.
  if (n <= 1) _inUse.delete(abs);
  else _inUse.set(abs, n - 1);
}

function isInUse(dir) {
  const abs = path.resolve(dir);
  const prefix = abs + path.sep;
  for (const p of _inUse.keys()) {
    if (p === abs || p.startsWith(prefix)) return true;
  }
  return false;
}

// Best-effort recursive size, for a log line that says what was reclaimed.
// Symlinks are counted as nothing and never followed — portable Python builds
// are full of them and following would both over-count and risk walking out of
// the bundle entirely.
async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    let entries;
    const d = stack.pop();
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += (await fsp.stat(full)).size; } catch {} }
    }
  }
  return total;
}

function defaultLog(msg) {
  console.log(msg);
}

/**
 * Delete every version directory under `parentDir` except `keep`.
 *
 * `parentDir` must hold nothing but version directories — every subdirectory
 * that isn't `keep` is treated as a superseded install. (Loose files are left
 * alone, so a marker/lock file beside the versions is safe.)
 *
 * @param {string} parentDir  e.g. `<userData>/tracker-runtime`
 * @param {string} keep       the current MANIFEST.version — never removed
 * @param {{label?: string, log?: (msg: string) => void}} [opts]
 * @returns {Promise<{removed: string[], skipped: {name: string, reason: string}[], freedBytes: number}>}
 */
async function pruneOldVersions(parentDir, keep, opts = {}) {
  const label = opts.label || 'bundle';
  const log = opts.log || defaultLog;
  const result = { removed: [], skipped: [], freedBytes: 0 };
  // A missing `keep` would make every installed version look stale.
  if (!parentDir || !keep) return result;

  let entries;
  try {
    entries = await fsp.readdir(parentDir, { withFileTypes: true });
  } catch {
    return result;   // nothing installed yet — not an error
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;          // stray files are none of our business
    const name = ent.name;
    const full = path.join(parentDir, name);

    // Remains of an interrupted sweep: already renamed out of the way, so
    // nothing can be using them. Retry the delete, stay quiet if it fails again.
    if (name.startsWith(TRASH_PREFIX)) {
      try { await fsp.rm(full, RM_OPTS); }
      catch (e) { log(`[${label}] leftover ${name} still not removable (${e.code || e.message})`); }
      continue;
    }

    if (name === keep) continue;

    if (isInUse(full)) {
      result.skipped.push({ name, reason: 'in use by a running process' });
      log(`[${label}] keeping ${name}: still in use by a running process`);
      continue;
    }

    const size = await dirSize(full);
    const trash = path.join(parentDir, `${TRASH_PREFIX}${name}-${Date.now()}`);
    try {
      await fsp.rename(full, trash);
    } catch (e) {
      // Windows: a held-open file below can make even the rename fail.
      const reason = `rename failed (${e.code || e.message})`;
      result.skipped.push({ name, reason });
      log(`[${label}] could not clean up ${name}: ${reason}`);
      continue;
    }
    try {
      await fsp.rm(trash, RM_OPTS);
    } catch (e) {
      const reason = `remove failed (${e.code || e.message})`;
      result.skipped.push({ name, reason });
      log(`[${label}] partially cleaned ${name}: ${reason} — retrying next time`);
      continue;
    }
    result.removed.push(name);
    result.freedBytes += size;
  }

  if (result.removed.length) {
    const mb = Math.round(result.freedBytes / 1048576);
    log(`[${label}] removed stale version${result.removed.length > 1 ? 's' : ''} ` +
        `${result.removed.join(', ')} (~${mb} MB reclaimed)`);
  }
  return result;
}

module.exports = { pruneOldVersions, markInUse, releaseInUse, isInUse };
