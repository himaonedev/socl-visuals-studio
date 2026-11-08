// Generated from backend/src/hw-accel.ts by scripts/backend.cjs. Edit the TypeScript source.
'use strict';
// ─── Hardware decode calibration ──────────────────────────────
// Every ffmpeg call in this app decoded on the CPU: there was no `-hwaccel`
// anywhere. The obvious fix — pass `-hwaccel auto` — is NOT safe to ship blind,
// and measuring proved why. On a Mac with VideoToolbox confirmed active
// (ffmpeg reports `pix_fmt: videotoolbox_vld`), adding `-hwaccel` made a real
// 1080p crop+subtitle render 2-4x SLOWER, on both synthetic and real footage.
//
// The mechanism generalises to Windows: every filter this pipeline uses (crop,
// scale, subtitles, blend, watermark) is a CPU filter, so a GPU decode has to
// copy each decoded frame back from VRAM to system memory before the filter
// graph can touch it. At 4K that readback is ~12MB per frame, and it can cost
// more than the CPU decode it replaced. Whether GPU decode wins therefore
// depends on the specific GPU, driver, PCIe bandwidth and source codec — i.e.
// on hardware we cannot enumerate, let alone test. GitHub's windows-latest
// runners have no GPU at all, so CI cannot answer it either.
//
// So the app measures it on the machine it is actually running on: race a real
// decode+filter+encode of a few seconds of the user's OWN source video with and
// without GPU decode, keep the faster one, and cache the verdict. This is the
// same "probe the real thing, don't trust the capability string" approach
// detectHwEncoder() already uses for encoders — extended from *can it* to
// *is it actually faster*.
//
// The pure decision helpers below are exported for unit tests; only
// calibrateDecode() spawns ffmpeg.
const fs = require('fs');
const path = require('path');
const CACHE_FILE = 'hw-calibration.json';
// A GPU decode must be a clear win, not a coin flip. Sampling noise on a loaded
// machine was measured at well over 10% for identical commands, so a hardware
// path that is merely "about the same" keeps the CPU path: equal speed with
// fewer moving parts and no driver surface is strictly better.
const MIN_WIN_RATIO = 1.15;
// Re-calibrate occasionally so a GPU driver update (or a machine whose first
// calibration ran while something else pegged the CPU) is not honoured forever.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Candidate GPU decoders per platform. `d3d11va` is the deliberate Windows
// choice: it is the one API that covers NVIDIA, AMD and Intel alike, where
// cuda is NVIDIA-only and qsv is Intel-only — one probe instead of three, on a
// path where every extra probe is startup latency the user waits through.
const HWACCEL_BY_PLATFORM = {
    win32: 'd3d11va',
    darwin: 'videotoolbox',
    linux: 'vaapi',
};
function hwaccelFor(platform) {
    return HWACCEL_BY_PLATFORM[platform] || null;
}
// ─── pure decision logic (unit-tested without ffmpeg) ───────────
// Pick the winner from timed probe results. `sw` is the incumbent and wins any
// tie, any failure, and anything short of MIN_WIN_RATIO.
function chooseFastest(sw, hw, minWinRatio = MIN_WIN_RATIO) {
    if (!hw || !hw.ok || !(hw.ms > 0))
        return { winner: 'sw', ratio: null };
    if (!sw || !sw.ok || !(sw.ms > 0)) {
        // Software failing is not a reason to adopt hardware — it means the probe
        // itself is untrustworthy (bad source, disk full). Stay on the incumbent.
        return { winner: 'sw', ratio: null };
    }
    const ratio = sw.ms / hw.ms;
    return { winner: ratio >= minWinRatio ? 'hw' : 'sw', ratio };
}
// Calibration is only transferable between runs when the machine, the ffmpeg
// build and the encoder in use are all unchanged — an encoder swap changes
// where the bottleneck sits and can flip the verdict.
function cacheKeyFor({ platform, arch, ffmpegVersion, encoder, hwaccel }) {
    return [platform, arch, ffmpegVersion || 'unknown', encoder || 'unknown',
        hwaccel || 'none'].join('|');
}
function isCacheEntryValid(entry, key, now = Date.now(), ttlMs = CACHE_TTL_MS) {
    if (!entry || typeof entry !== 'object')
        return false;
    if (entry.key !== key)
        return false;
    if (typeof entry.at !== 'number' || !isFinite(entry.at))
        return false;
    if (entry.at > now)
        return false; // clock skew / tampered file
    if (now - entry.at > ttlMs)
        return false;
    return entry.decision === 'hw' || entry.decision === 'sw';
}
// Decode flags for a decision. Software decode is the empty list, i.e. exactly
// the arguments this pipeline used before calibration existed.
function decodeArgsFor(decision, hwaccel) {
    return decision === 'hw' && hwaccel ? ['-hwaccel', hwaccel] : [];
}
// ─── cache persistence ──────────────────────────────────────────
function cachePath(dir) { return path.join(dir, CACHE_FILE); }
function readCache(dir) {
    try {
        return JSON.parse(fs.readFileSync(cachePath(dir), 'utf8'));
    }
    catch {
        return null;
    } // absent or corrupt → recalibrate, never throw
}
function writeCache(dir, entry) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cachePath(dir), JSON.stringify(entry, null, 2));
        return true;
    }
    catch {
        return false;
    } // read-only install dir → recalibrate next run
}
// ─── the measured probe ─────────────────────────────────────────
// Seconds of the real source to push through each probe. Long enough that
// per-process startup (~100-200ms) does not dominate the comparison, short
// enough that the whole calibration stays a few seconds.
const PROBE_SECONDS = 3;
const PROBE_TIMEOUT_MS = 60000;
// One probe: decode + the REAL filter chain + the REAL encoder, discarding the
// muxed output. Using the actual vf/encoder matters — the readback cost that
// decides this only appears because the filters are CPU-side, so a probe
// without them would measure the wrong thing and always favour hardware.
function probeArgs({ src, hwaccel, vf, encArgs, seconds = PROBE_SECONDS }) {
    return [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...(hwaccel ? ['-hwaccel', hwaccel] : []),
        '-i', src,
        '-t', String(seconds),
        ...(vf ? ['-vf', vf] : []),
        ...encArgs,
        '-an', // audio is identical either way — exclude it
        '-f', 'null', '-',
    ];
}
// Default runner: async on purpose. This code runs in Electron's MAIN process,
// so a synchronous execFileSync would freeze the whole UI for the duration of
// the calibration — several seconds of an unresponsive app on first run, which
// is a worse bug than the one being fixed.
function defaultRunner(ffmpeg, args, timeoutMs) {
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
        execFile(ffmpeg, args, { timeout: timeoutMs }, (err) => resolve(!err));
    });
}
// Monotonic wall-clock in milliseconds, injectable for the same reason `runner`
// is. A test that fakes probe durations by sleeping is not measuring this
// module, it is measuring the OS timer: Windows rounds every sleep up to the
// next ~15.6ms tick, so a nominal 30ms-vs-10ms probe pair is really measured as
// 31.2 vs 15.6, and one extra tick on a loaded CI runner collapses that to
// 31.2 vs 31.2 — a 3x win recorded as a tie, flipping the verdict below.
// Injecting the clock lets tests state durations exactly instead of hoping the
// scheduler cooperates.
function defaultClock() { return Number(process.hrtime.bigint()) / 1e6; }
// Run one probe twice and keep the FASTER run. A loaded machine produces
// occasional large outliers (identical commands were measured at 8.3s and
// 14.2s on the dev box); the minimum of two samples is far more stable than
// the mean and biases both candidates identically.
async function timeProbe(ffmpeg, args, runner = defaultRunner, clock = defaultClock) {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
        const t0 = clock();
        const ok = await runner(ffmpeg, args, PROBE_TIMEOUT_MS);
        if (!ok)
            return { ok: false, ms: Infinity };
        const ms = clock() - t0;
        if (ms < best)
            best = ms;
    }
    return { ok: true, ms: best };
}
// Decide whether GPU decode helps on THIS machine for THIS source, caching the
// verdict. Never throws: any failure resolves to software decode, which is the
// exact behaviour that shipped before this existed.
async function calibrateDecode({ ffmpeg, ffmpegVersion, src, vf, encArgs, encoderName, cacheDir, platform = process.platform, arch = process.arch, log = () => { }, runner = defaultRunner, clock = defaultClock, now = Date.now(), } = {}) {
    const hwaccel = hwaccelFor(platform);
    const fallback = { decision: 'sw', hwaccel, args: [], source: 'unavailable' };
    if (!hwaccel || !ffmpeg || !src)
        return fallback;
    const key = cacheKeyFor({ platform, arch, ffmpegVersion, encoder: encoderName, hwaccel });
    if (cacheDir) {
        const cached = readCache(cacheDir);
        if (isCacheEntryValid(cached, key, now)) {
            return { decision: cached.decision, hwaccel,
                args: decodeArgsFor(cached.decision, hwaccel), source: 'cache' };
        }
    }
    let sw, hw;
    try {
        sw = await timeProbe(ffmpeg, probeArgs({ src, hwaccel: null, vf, encArgs }), runner, clock);
        hw = await timeProbe(ffmpeg, probeArgs({ src, hwaccel, vf, encArgs }), runner, clock);
    }
    catch {
        return fallback; // probe infrastructure itself broke — stay on CPU
    }
    const { winner, ratio } = chooseFastest(sw, hw);
    log(`hw decode calibration (${hwaccel}): cpu=${sw.ok ? sw.ms.toFixed(0) + 'ms' : 'failed'} ` +
        `gpu=${hw.ok ? hw.ms.toFixed(0) + 'ms' : 'failed'} → ${winner === 'hw' ? hwaccel : 'cpu'}` +
        (ratio ? ` (${ratio.toFixed(2)}x)` : ''));
    if (cacheDir) {
        writeCache(cacheDir, {
            key, decision: winner, at: now,
            swMs: sw.ok ? Math.round(sw.ms) : null,
            hwMs: hw.ok ? Math.round(hw.ms) : null,
            hwaccel,
        });
    }
    return { decision: winner, hwaccel, args: decodeArgsFor(winner, hwaccel),
        source: 'measured', swMs: sw.ms, hwMs: hw.ms, ratio };
}
// Record that GPU decode failed during a REAL render, so the next app launch
// does not trust a stale "hw" verdict. Without this, a machine whose 3-second
// calibration slice passes but whose real renders fail pays a doomed GPU
// attempt plus a full CPU re-render on the first clip of every run — for the
// whole 30-day cache lifetime. Worse when the GPU failure is a hang rather
// than an error, because the first attempt burns the entire render timeout.
function demoteCache(cacheDir, key, now = Date.now()) {
    if (!cacheDir || !key)
        return false;
    const existing = readCache(cacheDir);
    return writeCache(cacheDir, {
        ...(existing && typeof existing === 'object' ? existing : {}),
        key, decision: 'sw', at: now, demotedByRenderFailure: true,
    });
}
// Strip GPU decode flags from an argument list, for the retry-on-failure path.
// A probe that passed on a 3s slice can still fail later on a different source
// (an unsupported codec profile, a driver that dies under load), and a render
// must never fail because of an optimisation. Callers retry once with this.
function withoutHwaccel(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-hwaccel' || args[i] === '-hwaccel_output_format') {
            i++;
            continue;
        }
        out.push(args[i]);
    }
    return out;
}
function hasHwaccel(args) { return args.includes('-hwaccel'); }
// Should a failed render be retried on CPU? Only when the failure plausibly
// came from the decoder. Retrying indiscriminately doubles the wall clock of
// every genuinely broken render (bad filter graph, missing font, disk full),
// and a TIMEOUT would re-pay the entire render budget a second time — turning
// a slow failure into a twice-as-slow one. Cancellation must never retry.
const DECODER_ERROR_RE = /hwaccel|hw_?device|d3d11|dxva|videotoolbox|vaapi|qsv|cuda|cuvid|nvdec|impossible to convert|device creation failed|failed setup for format|no decoder surfaces|decoder not found|error while decoding/i;
function isDecoderError(message) {
    const m = String(message || '');
    if (/cancelled/i.test(m))
        return false;
    if (/timed out after|ETIMEDOUT/i.test(m))
        return false;
    // [RENDER-STALL] A STALL is different from a wall-clock timeout, and is the
    // signature of exactly the failure this retry exists for: a GPU decode that
    // wedges mid-render stops producing output entirely while the process stays
    // alive. The retry is bounded (callers only reach here when the args actually
    // carried -hwaccel, and the CPU attempt then runs without it), so unlike a
    // timeout it does not re-pay a full render budget on an unrelated failure.
    if (/\bstalled\b/i.test(m))
        return true;
    return DECODER_ERROR_RE.test(m);
}
module.exports = {
    hwaccelFor, chooseFastest, cacheKeyFor, isCacheEntryValid, decodeArgsFor,
    readCache, writeCache, cachePath,
    probeArgs, timeProbe, calibrateDecode, withoutHwaccel, hasHwaccel,
    isDecoderError, demoteCache,
    MIN_WIN_RATIO, CACHE_TTL_MS, CACHE_FILE, HWACCEL_BY_PLATFORM, PROBE_SECONDS,
};
