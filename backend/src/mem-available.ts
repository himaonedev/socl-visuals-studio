'use strict';
// [MAC-FREEMEM] Memory the OS can hand to a new process right now.
//
// os.freemem() means different things per platform. On Windows it is
// ullAvailPhys (standby/cache counted as available) and on Linux libuv reads
// MemAvailable — both are "what a new process can get". On macOS libuv returns
// only vm_stat's "Pages free", which the kernel keeps near zero on purpose:
// cached file pages sit in "inactive" and are reclaimed on demand. Measured on
// a 16 GB M-series Mac with plenty of headroom (memory_pressure: 45% free):
// os.freemem() = 0.14 GB. The offline-Whisper gate [ASR-LOW-MEMORY] compares
// against ~1.4 GB, so on a Mac it skipped local transcription on nearly every
// run — "ASR lokal dilewati: RAM bebas 0.2 GB" — and imported videos came out
// with no transcript. Same number throttled the render pool to one clip.
//
// macOS: free + inactive + speculative + purgeable pages (the pages the kernel
// gives back without swapping). Every other platform keeps os.freemem().
const os = require('os');
const { execFileSync } = require('child_process');

function parseVmStat(text) {
  const s = String(text || '');
  const pageSize = Number((/page size of (\d+) bytes/.exec(s) || [])[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?`, 'm').exec(s);
    return m ? Number(m[1]) : 0;
  };
  const free = pages('free');
  if (!free && !pages('inactive')) return null;   // not vm_stat output
  return (free + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
}

function availableMemBytes({ platform = process.platform, freemem = os.freemem, vmStat } = {}) {
  const base = Number(freemem()) || 0;
  if (platform !== 'darwin') return base;
  let text = vmStat;
  if (text === undefined) {
    try { text = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }); }
    catch { return base; }
  }
  const avail = parseVmStat(text);
  // Never report LESS than libuv did — this only corrects an undercount.
  return avail ? Math.max(base, avail) : base;
}

module.exports = { availableMemBytes, parseVmStat };
