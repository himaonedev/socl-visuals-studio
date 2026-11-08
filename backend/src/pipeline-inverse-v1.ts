// ============================================================================
// [INVERSE-V1] EXPERIMENTAL PIPELINE — DO NOT EDIT THE STABLE pipeline.js
// ----------------------------------------------------------------------------
// This is a DUPLICATE of pipeline.js with ONE additional caption style:
//   `inverse_auto` — Open Sauce Two Bold, tight letter-spacing, colour AUTO-
//   INVERTED against the underlying video via ffmpeg `blend=all_mode=difference`.
//
// All other styles (neon_*, bw, bw_neon_*, cinematic_white) behave EXACTLY the
// same as in the stable pipeline.js — the branched code path only fires when
// `subtitleStyle === 'inverse_auto'`.
//
// To activate this experimental pipeline, swap the require() in main.js:5.
// To rollback: swap the require back, or delete this whole file — no other
// file will break because renderer.js / styles.css additions are guarded by
// [INVERSE-V1] sentinel comments.
// ============================================================================
// SOCL Visuals Studio v03 — pipeline worker
// Migrated from the Python core (clipper_core.py + Pipeline in app.py):
//   1) yt-dlp download (URL) OR use local file
//   2) ffprobe metadata + duration
//   3) transcript: youtube subtitle (preferred) OR placeholder note
//   4) AI highlight detection (Gemini / OpenAI-compatible)
//   5) per-clip hook title rewrite (2-pass focused prompt)
//   6) ffmpeg cut → 9:16 / 1:1 / 16:9
//   7) optional caption burn-in (ASS overlay)
//   8) report.json saved
//
// Cancellation: cancelPipeline() kills the active child process.

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const { validateBinaryPath, validateArgs } = require('./sanitize');
// Shared recut-vs-legacy input decision for renderClipEdit (also used by
// pipeline.js) — see src/edit-input.js.
const { resolveEditInput } = require('./edit-input');
// [FS-EM-SCALE] libass sizes a font by ascender−descender, CSS sizes it by the
// em square — see font-metrics.js for the measurements. Needed to convert the
// preview's CSS pixels into an ASS Fontsize that renders at the same size.
// [WM-TEXT-ASS] __parseFace reads a TTF/OTF `name` table — the watermark needs
// it to turn a FILENAME from watermark.js's TEXT_FONTS into the family name
// libass actually matches on.
const { fontEmScale, cssLineHeightEm, fontInkCenterEm, fontInkExtentEm, __parseFace } = require('./font-metrics');
const KT = require('./kinetic-title');
const { contrastInk, boxRectEm, deriveWordTiming, boxEligible, bridgeCueGaps, RADIUS_EM, PAD_EM } = require('./caption-box');
// [TITLE-LAYOUT] Pure word-break math for the auto pyramid/rhombus multi-line
// title shape — shared with the renderer so preview and burn agree byte-for-
// byte. See title-layout.js for the shape rules.
const { autoTitleBreaks, autoFitScale, hookWordIndices, inkLeadOffsets, eventWindow } = require('./title-layout');
// [BOX-HIGHLIGHT] `boxDrawing` dan `boxCueLines` didefinisikan DI FILE INI
// sendiri — jangan di-require. Hanya geometri kotak (caption-box.js) dan offset
// horizontal (caption-box-layout.js) yang datang dari luar.
// Lets the stale-bundle sweep (bundle-cleanup.js) see which runtime directory
// a sidecar is currently executing from.
const { markInUse: markBundleInUse, releaseInUse: releaseBundleInUse } = require('./bundle-cleanup');
// Direct YouTube Innertube caption fetch — tried BEFORE the yt-dlp subtitle
// pass below. See innertube-transcript.js for why: yt-dlp's subtitle fetch
// is a subprocess + webpage scrape (13.9s measured, and 429-prone); a
// direct HTTPS call to the same public player API a competitor app uses
// does the identical job in under a second.
const { fetchTranscriptViaInnertube, json3ToWords, json3ToSrt } = require('./innertube-transcript');
const { selectSubtitleTrack } = require('./subtitle-track-selector');
const {
  remotePoster,
  youtubePosterFromSource,
  extractCandidatePosters,
  extractRenderedPoster,
  renderedPosterPath,
} = require('./pipeline-preview');
const SF = require('./session-files');
const { availableMemBytes } = require('./mem-available');   // [MAC-FREEMEM]
const { localAsrPlanFor, LOW_SPEC_WINDOWS_TOTAL_BYTES } = require('./asr-resource-plan');
const {
  isolatedYtdlpArgs,
  sourceInventory,
  resolveDownloadedVideo,
  probeHasVideoStream,
  acquisitionFailureMessage,
  sourceHeightCap,
  ytdlpNetworkArgs,
  youtubePrimaryExtractorArgs,
  youtubeDefaultClientArgs,
  ytdlpFormatSort,
  findBestAudioStream,
  YTDLP_STALL_MS,
  YTDLP_MERGE_STALL_MS,
  looksLikeVideoData400,
  rewriteToBackupNode,
  cacheNodeRejectedMessage,
} = require('./source-acquisition');

// Bundled fonts (EB Garamond, Hanken, Anton…) live in assets/fonts. In dev this
// resolves to the source tree; in a packaged app electron-builder unpacks the
// folder via asarUnpack so libass can read the TTFs directly. Forward-slash the
// path for the subtitles filter, which treats colons/backslashes as separators.
function assFontsDir() {
  const p = path.join(__dirname, '..', 'assets', 'fonts').replace(/\\/g, '/');
  // Subtitles filter splits options on ':' (quotes do NOT protect it), so a
  // Windows drive-letter colon must be backslash-escaped (C\:/…). Exactly ONE
  // escape level — verified empirically against the bundled ffmpeg 6.1.1:
  // unescaped 'C:/…' splits the option and the trailing /…/fonts fragment is
  // re-consumed as positional `filename`, clobbering the .ass path ("Unable
  // to open /Users/…/fonts"); a double backslash fails the same way.
  return assFontsDirFs().replace(/:/g, '\\:');
}
// [FS-EM-SCALE-WIN] The SAME directory, but as a path the FILESYSTEM can open.
// assFontsDir() is for the subtitles *filter* only: it backslash-escapes the
// drive-letter colon so ffmpeg's option parser leaves it alone. Handing that
// escaped form to fs.readdirSync() is fine on macOS (an absolute POSIX path has
// no colon, so the escape is a no-op) and fatal on Windows: 'C\:/…/fonts' is not
// a path Windows resolves, readdirSync throws, font-metrics silently caches an
// EMPTY map, and fontEmScale() then returns 1 for every face. Result: the Style
// line burns the raw CSS px as a libass Fontsize, so every caption renders
// (asc−desc)/upem smaller than the preview — 19% for Open Sauce Two Bold, 15%
// for Times New Roman MT Cond — while Spacing stays computed off the FULL size,
// which is why the letters also crowd together. Mac was always correct, so the
// bug read as "Windows-only preview/apply mismatch".
function assFontsDirFs() {
  const p = path.join(__dirname, '..', 'assets', 'fonts').replace(/\\/g, '/');
  return p.replace('app.asar', 'app.asar.unpacked');
}

// ─── State ────────────────────────────────────────────────
// A Set, not a single child, because clip rendering now runs several ffmpeg /
// tracker child processes concurrently (see CLIP_CONCURRENCY below) — a lone
// `activeChild` var would get clobbered by whichever process spawned/closed
// last, leaving the others un-cancellable.
let activeChildren = new Set();
// [RUN-LOG-ASYNC] Pending pipeline.log writes of the current run, in order.
let runLogQueue = Promise.resolve();
// Wait (bounded) for queued log lines, so a caller appending after the run
// keeps the file in order without hanging on a dead drive.
function flushRunLog(ms = 5000) {
  let t;
  return Promise.race([runLogQueue, new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t));
}
let cancelled   = false;

// [WIN-KILL-TREE] Killing a child does NOT kill its grandchildren on Windows:
// child.kill() maps to TerminateProcess on that one PID. yt-dlp is spawned with
// `--merge-output-format mp4`, so during Fetch it has its own ffmpeg child doing
// the video+audio merge. Cancelling used to terminate yt-dlp.exe and leave that
// ffmpeg.exe running — still burning CPU and, because Windows keeps a lock on
// open files, still holding the partial download so it could not be deleted and
// a retry hit EBUSY/EPERM. On POSIX the same orphan is harmless: the child exits
// on its own and an open file can still be unlinked, which is why this only ever
// showed up on Windows. `taskkill /T` walks the tree; /F is required because a
// mid-write ffmpeg will not quit politely.
// NOTE: deliberately no `child.killed` early-out. That flag means "a signal was
// SENT", not "the process died", so guarding on it would swallow the watchdog's
// SIGKILL escalation after a cancel already sent SIGTERM — exactly the wedged
// -encoder case the watchdog exists for.
function killTree(child, signal = 'SIGTERM') {
  if (!child) return;
  const plain = () => { try { child.kill(signal); } catch {} };
  if (process.platform === 'win32' && child.pid) {
    let handed = false;
    try {
      // execFile does NOT throw when the binary is missing — it reports ENOENT
      // through the CALLBACK. Swallowing that callback (the first cut of this
      // fix did) meant a machine without a usable taskkill killed NOTHING at
      // all: strictly worse than the plain kill it replaced. Fall back here.
      require('child_process').execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'],
        (err) => { if (err) plain(); });
      handed = true;
    } catch { /* synchronous failure — fall through */ }
    if (handed) return;
  }
  plain();
}

function cancelPipeline() {
  cancelled = true;
  for (const child of activeChildren) killTree(child);
  return true;
}

// ─── Binary resolution ────────────────────────────────────
function which(cmd) {
  const PATH = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of PATH) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try { if (fs.existsSync(full)) return full; } catch {}
    }
  }
  return null;
}
let FFMPEG  = process.env.FFMPEG_BIN  || which('ffmpeg')  || 'ffmpeg';
let FFPROBE = process.env.FFPROBE_BIN || which('ffprobe') || 'ffprobe';
let YTDLP   = process.env.YTDLP_BIN   || which('yt-dlp')  || 'yt-dlp';
let DENO    = null;  // populated by bootstrap; injected into yt-dlp's PATH
// [FFMPEG-FILTERS] Every ffmpeg filter the render paths below actually put
// into a -vf / -filter_complex string.
//
// v2.4.1 shipped a `drawtext` watermark with no check like this, and
// ffmpeg-static sources its two macOS binaries from two DIFFERENT upstreams:
// darwin-arm64 is osxexperts' ffmpeg 6.0 (477 filters, drawtext present),
// darwin-x64 is evermeet's 6.1.1-tessus (490 filters, drawtext ABSENT). Every
// watermarked render on an Intel Mac died with `Error parsing global options:
// Filter not found` + exit 8, and the first anyone heard of it was a user
// report — the two bundles were never compared, by anything, ever. A binary is
// one `ffmpeg -filters` call away from telling us exactly this, so ask it once
// and put any gap in front of the user instead of letting ffmpeg's own
// message arrive mid-render.
//
// Keep this list in step with the filtergraph builders (vfFor, captionBurnVf,
// buildWatermarkFilter, segmentFilterArgs, stickerJobs, the split-screen
// graph). `drawtext` is deliberately NOT in it: the text watermark renders
// through libass now, precisely because one of the binaries we ship lacks it.
const REQUIRED_FILTERS = [
  'scale', 'crop', 'pad', 'setsar', 'split', 'gblur', 'overlay', 'format',
  'subtitles', 'drawbox', 'blend', 'colorchannelmixer', 'movie', 'loop',
  'fps', 'fade', 'null', 'hstack', 'amix', 'volume', 'setpts', 'asetpts',
  'trim', 'atrim', 'concat',
];

// Same allowance as bootstrap's own -filters probe: the bundled Windows
// ffmpeg.exe is ~82MB and unsigned, so Defender's first-run scan is
// synchronous and routinely well past a few seconds on a laptop HDD.
const FFMPEG_FILTER_PROBE_MS = 30000;

// `ffmpeg -filters` prints an 8-line legend first, and two of those rows
// ("  T.. = Timeline support", "  A = Audio input/output") are close enough to
// a filter row to fool a looser pattern. Anchor on the real shape instead:
// three flag chars, the name, then the `in->out` signature — `|->N` for source
// filters like movie, which is how the image watermark gets into the graph.
function parseFilterNames(out) {
  const names = new Set();
  for (const line of String(out || '').split('\n')) {
    const m = /^\s*[A-Z.]{3}\s+([A-Za-z0-9_]+)\s+[AVN|]+->[AVN|]+/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

// Unparseable output yields the whole list — "the probe told us nothing" must
// read as loud, not as a clean bill of health.
function missingFilters(out, required = REQUIRED_FILTERS) {
  const have = parseFilterNames(out);
  return required.filter((n) => !have.has(n));
}

function probeFfmpegFilters(ffmpegPath) {
  // [EPIPE] Explicit stdio — an inherited pipe whose reader is gone turns an
  // EPIPE into an 'error' event no try/catch here could ever see.
  const { execFileSync } = require('child_process');
  return execFileSync(validateBinaryPath(ffmpegPath), ['-hide_banner', '-filters'],
    { encoding: 'utf8', timeout: FFMPEG_FILTER_PROBE_MS, stdio: ['ignore', 'pipe', 'ignore'] });
}
function probeFfmpegVersion(ffmpegPath) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(validateBinaryPath(ffmpegPath), ['-hide_banner', '-version'],
    { encoding: 'utf8', timeout: FFMPEG_FILTER_PROBE_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  return String(out).split('\n')[0].trim();
}

// One ffmpeg spawn per binary path, not per render: renderClipEdit runs on
// every Caption Editor Preview AND Apply, and a batch render calls it once per
// clip. The cache saves the SPAWN, never the message — each caller still gets
// the line in its own log pane, because runPipeline and renderClipEdit are
// separate runs with separate panes.
const __filterCheckCache = new Map();
function __resetFilterCheck() { __filterCheckCache.clear(); }

function checkFfmpegFilters(ffmpegPath, log, opts = {}) {
  const { probe = probeFfmpegFilters, version = probeFfmpegVersion } = opts;
  const key = String(ffmpegPath || '');
  // Markers are load-bearing: shouldShowLog() in renderer.js drops any line
  // that does not start with one, and console.warn is invisible from a
  // Finder-launched app — which is the normal way this app is started.
  const say = (line, kind) => { try { log?.(line, kind); } catch {} };

  let verdict = __filterCheckCache.get(key);
  if (!verdict) {
    try {
      const out = probe(ffmpegPath);
      const missing = missingFilters(out);
      // Only worth a second spawn when there is something to report — and then
      // it is worth a lot: "6.0" vs "6.1.1-tessus" is the whole diagnosis.
      let build = '';
      if (missing.length) { try { build = version(ffmpegPath) || ''; } catch {} }
      verdict = { missing, total: parseFilterNames(out).size, build };
    } catch (e) {
      // A probe that will not run is not evidence of a broken binary. Say so
      // and carry on — ffmpeg's own error is still ahead of us if it matters.
      verdict = { missing: [], error: String((e && e.message) || e) };
    }
    __filterCheckCache.set(key, verdict);
  }

  if (verdict.error) {
    say(`⚠ ffmpeg tidak bisa diperiksa (${verdict.error}) — render tetap dilanjutkan`, 'yellow');
  } else if (verdict.missing.length) {
    say(`✗ ffmpeg ${verdict.build ? `[${verdict.build}] ` : ''}tidak punya filter yang dipakai render: `
      + `${verdict.missing.join(', ')} — render bisa gagal dengan "Filter not found". `
      + `Kirim baris ini ke support.`, 'err');
  } else {
    say(`✓ ffmpeg siap — ${verdict.total} filter, semua yang dipakai render tersedia`, 'lime');
  }
  return verdict.missing;
}


// One static JPEG from the actual deliverable keeps gallery cards accurate
// without allocating a video decoder per clip. Extraction is deliberately
// best-effort: a poster can never turn a successful video render into a failed
// render, and the caller may keep its pre-render candidate as the fallback.
async function createRenderedPoster(input, duration, format, fallback = null) {
  return extractRenderedPoster({
    input,
    output: renderedPosterPath(input),
    duration,
    format,
    fallback,
    onError: (error) => {
      console.warn('[rendered-poster]', error?.message || error);
    },
    extract: async ({ input: file, output, time, posterSpec }) => {
      await spawnLines(FFMPEG, [
        '-y', '-ss', String(time), '-i', file,
        '-frames:v', '1', '-vf', posterSpec.filter, '-q:v', '3', output,
      ], { onLine: () => {}, timeoutMs: 30000 });
      return output;
    },
  });
}

// [AI-PARALLEL] Bounded-concurrency map. Result array is ordered by INPUT
// index (not completion order) so every downstream step — dedup, numbering,
// logging — stays deterministic and byte-identical to the old serial loop.
// `fn` is expected to handle its own failures; a throw rejects the whole map.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// [STAGE-TIMING] Per-stage stopwatch. Until this existed there was no way to
// answer "which stage is slow on this machine?" — report.json carried only
// createdAt, and the visible log has no timestamps. Stages are exclusive: a
// begin() closes the previous one, so the numbers sum to (roughly) total.
// Cheap enough to leave on permanently; the totals land in report.timings.
function makeStageTimer(log) {
  const totals = Object.create(null);
  const t0 = Date.now();
  let cur = null, curStart = 0;
  const close = () => {
    if (!cur) return;
    const ms = Date.now() - curStart;
    totals[cur] = (totals[cur] || 0) + ms;
    log?.(`⏱ ${cur}: ${(ms / 1000).toFixed(1)}s`, 'lime');
    cur = null;
  };
  return {
    begin(name) { close(); cur = name; curStart = Date.now(); },
    end: close,
    finish() {
      close();
      totals.total = Date.now() - t0;
      const parts = Object.entries(totals)
        .filter(([k]) => k !== 'total')
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`);
      log?.(`⏱ Total ${(totals.total / 1000).toFixed(1)}s — ${parts.join(' · ')}`, 'lime');
      return totals;
    },
  };
}

// Env for yt-dlp spawns: prepend the directory holding our `deno` binary so
// yt-dlp's EJS plugin can find it and solve YouTube's `n`/signature challenge.
function ytEnv() {
  if (!DENO) return process.env;
  const denoDir = path.dirname(DENO);
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: denoDir + sep + (process.env.PATH || '') };
}

// [WIN-SPAWN-UNKNOWN] Turn an opaque spawn failure into something the user
// can actually act on.
//
// Windows reports `spawn UNKNOWN` whenever CreateProcessW fails with a code
// libuv has no errno mapping for. In this app the overwhelmingly common one
// is ERROR_VIRUS_INFECTED (225) — Defender (or another AV) blocking the
// bundled ffmpeg.exe. Our Windows build is UNSIGNED, and the bundled
// ffmpeg.exe is a ~82MB unsigned binary that lands in a user-writable folder,
// which is close to a worst case for AV heuristics. Defender's cloud verdict
// arrives ASYNCHRONOUSLY, so the binary can start fine during bootstrap's
// probe and then be blocked minutes later mid-pipeline — exactly the reported
// failure (bootstrap resolved the bundled path, then Fetch died on it).
//
// Real user report (v2.3.25, Windows): "Failed to spawn
// C:\Users\…\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe:
// spawn UNKNOWN" — the file was present and a valid PE32+ x86-64 image.
// Without this hint the message is a dead end: nothing about it suggests AV.
// `platform` is injectable so the Windows branch is testable from any host
// (same approach as resolveEditInput's injectable `exists`).
// [FILTER-SCRIPT] `cmdLen` = the whole command line. Past Windows' 32,767-char
// cap CreateProcess fails with the same bare UNKNOWN, and blaming antivirus
// sent a user (SOCL folder already excluded) to fix the wrong thing.
const WIN_CMDLINE_MAX = 32767;
function cmdLineLength(cmd, args) {
  return String(cmd || '').length + 3 + (Array.isArray(args) ? args.reduce((a, x) => a + String(x).length + 3, 0) : 0);
}
function spawnFailureHint(e, cmd, platform = process.platform, cmdLen = 0) {
  if (e && e.errno === -86) {
    return ' (binary architecture mismatch — wrong CPU type. Re-install app deps to pull arch-correct binaries.)';
  }
  if (platform !== 'win32') return '';
  const code = String(e && e.code || '');
  if (cmdLen > WIN_CMDLINE_MAX && /^(UNKNOWN|ENAMETOOLONG|E2BIG)$/.test(code)) {
    return ` — perintah untuk "${path.basename(cmd)}" terlalu panjang (${cmdLen} karakter, batas Windows ${WIN_CMDLINE_MAX}). `
      + `Ini BUKAN antivirus. Laporkan ke kami beserta pipeline.log.`;
  }
  if (!/^(UNKNOWN|EPERM|EACCES|ENOEXEC)$/.test(code)) return '';
  return ` — Windows menolak menjalankan file ini padahal filenya ADA. `
    + `Penyebab paling umum: antivirus/Windows Defender memblokir "${path.basename(cmd)}" `
    + `(installer kami belum ditandatangani secara digital, jadi sering kena false positive). `
    + `Solusi: buka Windows Security → Virus & threat protection → Manage settings → `
    + `Add or remove exclusions, lalu tambahkan folder aplikasi ini sebagai exclusion, `
    + `dan pulihkan file dari Protection history kalau sudah terlanjur dikarantina. `
    + `Path yang diblokir: ${cmd}`;
}

// Pick the line(s) that actually explain a non-zero exit.
//
// Real user report (Windows, v2.3.27): the Fetch step showed
// `yt-dlp.exe exited 1 WARNING: [youtube] No title found in player responses;
// falling back to title from initial data` — which is a NON-FATAL warning that
// yt-dlp itself says it recovered from. The genuine `ERROR:` line was further
// down the same stderr blob and got clipped off-screen, because the UI renders
// the error message as a single line. Diagnosing the failure required a photo
// of the screen, and even then the cause stayed invisible.
//
// So: prefer explicit ERROR lines (last one — yt-dlp's final verdict), and only
// if there are none fall back to the tail of stderr with warning/deprecation
// noise stripped. The FULL stderr is still attached to the Error (`.stderr`) so
// nothing is lost for logging or for looksLikeStaleYtdlp's pattern match.
function pickErrorLines(stderr = '', stdout = '') {
  const lines = String(stderr || stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const errs = lines.filter(l => /^ERROR\b/i.test(l));
  if (errs.length) return errs.slice(-2).join('\n');
  // [RENDER-STALL] ffmpeg's `frame=… time=…` progress now arrives as real lines
  // (it used to be buffered into one blob), so it would otherwise crowd the
  // actual explanation out of the last-3-lines window.
  const signal = lines.filter(l => !/^(WARNING|DeprecationWarning|Deprecated)\b/i.test(l)
                                && !/^(frame|size)=\s*\S/.test(l));
  const tail = (signal.length ? signal : lines).slice(-3);
  // [DISK-FULL-MSG] ffmpeg names the real cause once, well before the encoder
  // summary that fills the tail — keep it, or "drive penuh" reads as a crash.
  const full = lines.find(l => /No space left on device|not enough space on the disk|ENOSPC|Disk quota exceeded/i.test(l));
  if (full && !tail.includes(full)) return [full, ...tail.slice(-2)].join('\n');
  return tail.join('\n');
}

// [FILTER-SCRIPT] Windows caps a whole command line at 32,767 chars, and a
// smart-tracked clip's crop expression (one if(lt(t,…)) per keyframe, x and y)
// plus captions/hook/B-roll filters grows with clip length. Past the cap
// CreateProcess fails and Node reports a bare "spawn UNKNOWN" — which read as
// antivirus to a user whose SOCL folder was already excluded in Defender (clip
// 8 of 10 failed, the first 7 rendered). A long filter now travels in a file:
// ffmpeg 6 reads -filter_complex_script / -filter_script:<v|a> exactly as it
// reads the inline option.
const FILTER_SCRIPT_MIN = 8000;   // only the long ones; short filters stay inline
const FILTER_SCRIPT_OPT = { '-filter_complex': '-filter_complex_script', '-lavfi': '-filter_complex_script',
  '-vf': '-filter_script:v', '-filter:v': '-filter_script:v', '-af': '-filter_script:a', '-filter:a': '-filter_script:a' };
function moveLongFiltersToFiles(cmd, args) {
  if (!/ffmpeg(\.exe)?$/i.test(path.basename(String(cmd || ''))) || !Array.isArray(args)) return { args, files: [] };
  const files = [];
  const out = args.slice();
  for (let i = 0; i < out.length - 1; i++) {
    const to = FILTER_SCRIPT_OPT[out[i]];
    if (!to || String(out[i + 1]).length < FILTER_SCRIPT_MIN) continue;
    const f = path.join(os.tmpdir(), `socl-filter-${process.pid}-${Date.now()}-${files.length}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(f, String(out[i + 1]), 'utf8');
    files.push(f);
    out[i] = to; out[i + 1] = f;
    i++;
  }
  return { args: out, files };
}

// ─── Child runner with line streaming ─────────────────────
// [SPAWN-RETRY] A bare "spawn UNKNOWN" mid-run (7 of 10 clips already done,
// SOCL folder excluded in Defender) is a CreateProcess failure libuv cannot
// name: an AV scan holding the exe, or the system briefly out of commit
// memory while other encoders run. The process never started, so trying
// again is safe; a real, permanent block fails all three attempts and still
// shows the hint.
const SPAWN_RETRY_MS = [2000, 5000];
async function spawnLines(cmd, args, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await spawnLinesOnce(cmd, args, opts);
    } catch (e) {
      if (e?.spawnCode !== 'UNKNOWN' || attempt >= SPAWN_RETRY_MS.length || cancelled) throw e;
      opts.onLine?.('err', `[spawn-retry] ${path.basename(String(cmd))}: spawn UNKNOWN, coba lagi dalam ${SPAWN_RETRY_MS[attempt] / 1000}s`);
      console.warn(`[spawn-retry] ${cmd}: spawn UNKNOWN (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, SPAWN_RETRY_MS[attempt]));
    }
  }
}
function spawnLinesOnce(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error('cancelled'));
    if (!cmd || typeof cmd !== 'string') {
      return reject(new Error(`spawnLines: invalid command (${cmd}). Binary not resolved — bootstrap may have failed.`));
    }
    if (!fs.existsSync(cmd) && !/^[a-zA-Z0-9_\-.]+$/.test(cmd)) {
      // Absolute path that doesn't exist — better message than ENOENT
      return reject(new Error(`Binary not found: ${cmd}`));
    }
    try { cmd = validateBinaryPath(cmd); args = validateArgs(args); }
    catch (e) { return reject(e); }
    let filterFiles = [];
    try { ({ args, files: filterFiles } = moveLongFiltersToFiles(cmd, args)); }
    catch (e) { return reject(new Error(`Filter ffmpeg tidak bisa ditulis ke file sementara: ${e.message}`)); }
    const dropFilterFiles = () => { for (const f of filterFiles) { try { fs.unlinkSync(f); } catch {} } filterFiles = []; };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    } catch (e) {
      dropFilterFiles();
      const err = new Error(`Failed to spawn ${cmd}: ${e.message}${spawnFailureHint(e, cmd, process.platform, cmdLineLength(cmd, args))}`);
      err.spawnCode = e && e.code;
      return reject(err);
    }
    activeChildren.add(child);
    let stdout = '', stderr = '';
    // Optional watchdog: some yt-dlp setup steps (metadata probe that fetches
    // remote challenge-solver scripts from GitHub) can hang indefinitely on a
    // slow/blocked network. Without this the UI sits on "Menyiapkan sumber…"
    // forever. Generous by default; only set where a hang is plausible.
    let timedOut = false, watchdog = null;
    if (opts.timeoutMs) {
      watchdog = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGKILL');   // [WIN-KILL-TREE] watchdog must not orphan a merge child either
      }, opts.timeoutMs);
    }
    // [RENDER-STALL] `stallMs` is the watchdog a long render actually needs: it
    // measures SILENCE, not elapsed time, and re-arms on every byte the child
    // emits. A wall-clock budget cannot tell a wedged encoder from a slow one,
    // so on a low-end machine it eventually kills real work — the reported
    // "ffmpeg.exe timed out after 1200s" was exactly that, a 60s clip hitting
    // its 20s-per-clip-second ceiling mid-encode. ffmpeg writes a progress line
    // roughly twice a second, so a multi-minute silence is unambiguous.
    let stalled = false, stallTimer = null;
    const armStall = () => {
      if (!opts.stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        killTree(child, 'SIGKILL');
      }, opts.stallMs);
    };
    const clearWatchdog = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    const onLine = (kind, line) => { if (opts.onLine) opts.onLine(kind, line); };

    const piper = (stream, kind, acc) => {
      let buf = '';
      stream.on('data', d => {
        // Liveness is the ARRIVAL of bytes, independent of whether they form a
        // complete line — a progress-only child must never look silent.
        armStall();
        buf += d.toString();
        // [RENDER-STALL] Split on \r AS WELL AS \n. ffmpeg terminates its
        // `frame= … time=…` progress with a carriage return and emits no
        // newline until the process ends, so a \n-only splitter buffered every
        // progress line to the very end: the export percentage in the UI never
        // moved, and the one signal that proves the encoder is alive was
        // invisible. Measured against the bundled ffmpeg 6.0: 9 \r-terminated
        // progress writes, 0 newlines, arriving ~2×/second during the encode.
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) {
          const line = buf.slice(0, i);
          // Consume CRLF as one terminator so a Windows child does not produce
          // a phantom empty line between every real one.
          const skip = buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1;
          buf = buf.slice(i + skip);
          if (line) { onLine(kind, line); acc.s += line + '\n'; }
        }
        // onLine may have just changed opts.stallMs (yt-dlp entering its silent
        // merge); re-arm so the new window applies from now, not from the next byte.
        armStall();
      });
      stream.on('end', () => { if (buf) { onLine(kind, buf); acc.s += buf; } });
    };
    const so = { s: '' }, se = { s: '' };
    piper(child.stdout, 'out', so);
    piper(child.stderr, 'err', se);
    // Arm before the first byte, so a child that wedges before saying anything
    // at all is caught too.
    armStall();

    // Node throws synchronously for most spawn failures (handled above) but
    // defers ENOENT/EAGAIN/EMFILE/ENFILE to this event — carry the same
    // actionable hint here so neither path is a dead end.
    child.on('error', e => {
      activeChildren.delete(child); clearWatchdog(); dropFilterFiles();
      const hint = spawnFailureHint(e, cmd, process.platform, cmdLineLength(cmd, args));
      reject(hint ? new Error(`Failed to spawn ${cmd}: ${e.message}${hint}`) : e);
    });
    child.on('close', code => {
      activeChildren.delete(child);
      clearWatchdog();
      dropFilterFiles();
      stdout = so.s; stderr = se.s;
      // Stall is reported distinctly from a wall-clock timeout: the two have
      // different recoveries (a stall is retry-eligible on CPU decode, a
      // timeout deliberately is not — see hw-accel.isDecoderError).
      if (stalled) {
        // [YTDLP-STALL] "encoder wedged" is an ffmpeg diagnosis; yt-dlp has no
        // encoder, and that text sent buyers chasing antivirus/GPU settings
        // when the real cause was a connection that stopped answering. Name
        // the program honestly, and carry whatever it DID print — a stall used
        // to drop it, so the log showed nothing about where it hung.
        const isFfmpeg = /ffmpeg/i.test(path.basename(String(cmd)));
        const err = new Error(`${cmd} stalled — no output for ${Math.round(opts.stallMs / 1000)}s (${isFfmpeg ? 'encoder wedged; ' : ''}killed)`);
        err.stalled = true; err.stderr = stderr; err.stdout = stdout;
        return reject(err);
      }
      if (timedOut) return reject(new Error(`${cmd} timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
      if (cancelled) return reject(new Error('cancelled'));
      if (code === 0) resolve({ stdout, stderr });
      else {
        // Message = the lines that actually explain the failure; full streams
        // ride along on the Error so callers can log/inspect everything.
        const err = new Error(`${cmd} exited ${code}\n${pickErrorLines(stderr, stdout) || '(no error output)'}`);
        err.stderr = stderr; err.stdout = stdout; err.exitCode = code;
        reject(err);
      }
    });
  });
}

// ─── HTTP helpers (Node 18 has fetch; we keep a small fallback) ─
// AI_HTTP_TIMEOUT_MS: every other network/subprocess call in this file has an
// explicit timeout (yt-dlp 90s, ffmpeg render, encoder probe, …) — this one
// didn't, so a stalled TCP connection to Groq/Gemini/OpenRouter (connects but
// never responds — common behind Windows Defender / corporate proxies that
// silently black-hole instead of sending a TCP RST) hung the `await fetch()`
// forever. tryFreeChain() can't fail over to the next provider while still
// awaiting a promise that never settles, so the whole hook-title step (and
// any other aiComplete() call) stalls indefinitely with no way to recover.
// A hard timeout turns that into a normal error so the existing fallback
// chain / local model actually gets a turn.
//
// [AI-TIMEOUT-TOO-TIGHT] Was 25000. Live-reported 2026-08-27: a real, working,
// previously-successful Gemini key hit "request timed out after 25s" on the
// Settings "Test" button (screenshot confirmed the exact 25s message) — not a
// misdiagnosis like the yt-dlp/quota classifier bugs above (the message was
// accurate), just genuinely not enough time for a real round-trip on some
// connections/regions. 25000 was never measured against real API latency —
// picked only as "not literally forever". Raised to a value with real margin;
// still bounded (never hangs forever), still short enough that the fallback
// chain gets a turn well within a user's patience for one AI call.
const AI_HTTP_TIMEOUT_MS = 45000;
// [PIPELINE-NET] The raw http/https fallback this function used to have for
// "no global fetch" is dead code in this app's actual runtime — Electron 33
// bundles Node 20+, which always has `fetch`. Worse, that fallback used
// Node's http/https directly, which only trust Node's own bundled CA list,
// not certs an antivirus/proxy injects into the OS trust store — the same
// class of bug fixed in licenseManager.js/bootstrap.js/tracker-bundle.js. It
// could never have been hit in practice, but kept it one unpatched network
// call site away from the same failure if `fetch` were ever undefined for
// any reason. Removed rather than converted: this is EVERY AI provider call
// in the app (Groq/OpenRouter/Gemini/Sumopod/OpenAI, every hook-title
// render) — main.js patches global.fetch to Electron's net.fetch (OS trust
// store) before any other module loads, so the single `fetch()` path below
// already gets that fix for free.
async function postJSON(url, body, headers = {}) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), AI_HTTP_TIMEOUT_MS) : null;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: ac?.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`request timed out after ${Math.round(AI_HTTP_TIMEOUT_MS / 1000)}s`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 400)}`);
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

// ─── Duration presets (mirrors v2 DURATION_PRESETS) ───────
const DURATION_PRESETS = {
  '15':   { min: 10, max: 20,  ideal: 15, label: 'SHORT 15s',
            rule: 'Durasi target 13–17 detik (range valid 10–20). Pilih MOMEN PUNCAK saja — 1 punchline atau 1 statement keras. Tanpa setup panjang.' },
  '30':   { min: 22, max: 38,  ideal: 30, label: 'MID 30s',
            rule: 'Durasi target 27–33 detik (range valid 22–38). Setup singkat + payoff yang keras. Buang filler.' },
  '60':   { min: 50, max: 75,  ideal: 60, label: 'STANDARD 60s',
            rule: 'Durasi target 55–65 detik (range valid 50–75). Setup → buildup → payoff lengkap, padat tanpa basa-basi.' },
  '90':   { min: 75, max: 105, ideal: 90, label: 'STORY 90s',
            rule: 'Durasi target 85–95 detik (range valid 75–105). Pakai untuk momen viral yang butuh konteks: setup jelas, eskalasi, lalu payoff. Tetap buang sponsor, intro, dan filler.' },
  '120':  { min: 100, max: 135, ideal: 120, label: 'DEEP 120s',
            rule: 'Durasi target 110–125 detik (range valid 100–135). Pakai hanya jika konteksnya kuat dan satu cerita/argumen masih menyatu sampai payoff. Jangan menyambung topik berbeda demi durasi.' },
  // [LONG-PRESET] Explicit 2–3 minute mode for storytelling / podcast / long
  // explainer cuts. flex:true so the end lands on a real sentence boundary
  // inside the 120–185s window instead of a hard 150s cut.
  '180':  { min: 120, max: 185, ideal: 150, flex: true, label: 'LONG 2–3 menit',
            rule: 'Durasi target 120–180 detik (range valid 120–185). Pilih HANYA momen yang benar-benar butuh napas panjang: cerita utuh, argumen bertingkat, atau breakdown step-by-step. Wajib ada setup → buildup → payoff yang tuntas — jangan menyambung dua topik berbeda hanya untuk mengejar durasi.' },
  'auto': { min: 30, max: 180, ideal: 90, flex: true, label: 'AUTO',
            rule: 'Durasi fleksibel 30–180 detik — sesuaikan dengan panjang momennya, JANGAN paksa semua clip sama panjang. Punchline/quote/confession singkat: 30–60 detik. Cerita, argumen, atau insight bertahap yang butuh setup→buildup→payoff penuh: 90–180 detik. Potong dari awal kalimat pemicu sampai tuntas setelah payoff.' },
};
// [MANUAL-DURATION] Hard ceiling for a user-typed clip length. Matches
// AUTO_COVER_MAX_SEC so "5 minutes" means the same number everywhere.
const MANUAL_DURATION_MAX_SEC = 300;
const MANUAL_DURATION_MIN_SEC = 10;

// [MANUAL-DURATION] A duration the user typed by hand, not one of the presets.
// Deliberately flex:false — "300" must mean 300, the same exact-length contract
// the fixed presets already honour. flex:true would route it through
// flexClipEnd() and hand back a 255s clip for a 300s request (minKeep drops to
// dur.min), and would also make it eligible for the AUTO-COVER branch, which
// splits a short source into equal parts — neither is what typing a number asks
// for. The +/-15% window is what lets filterByWindow clamp a near-miss instead
// of dropping the candidate outright.
function buildManualPreset(key) {
  const n = /^[0-9]+$/.test(key) ? Number(key) : NaN;
  if (!Number.isFinite(n) || n < MANUAL_DURATION_MIN_SEC || n > MANUAL_DURATION_MAX_SEC) return null;
  // Upper tolerance is capped at the hard ceiling: without this a 300s request
  // carried a 345s window, so filterByWindow could hand back a 5m45s clip from
  // a control the UI promises tops out at 5 minutes.
  const lo = Math.max(3, Math.round(n * 0.85));
  const hi = Math.min(MANUAL_DURATION_MAX_SEC, Math.round(n * 1.15));
  return {
    min: lo,
    max: hi,
    ideal: n,
    manual: true,
    label: `MANUAL ${n}s`,
    rule: `Durasi target ${n} detik (range valid ${lo}–${hi}). `
      + 'Panjang ini DIMINTA EKSPLISIT oleh user — pilih momen yang benar-benar sanggup mengisi durasi itu dengan satu cerita/argumen utuh. '
      + 'Jangan menyambung dua topik berbeda hanya untuk mengejar durasi, dan jangan memotong sebelum payoff-nya tuntas.',
  };
}

// Lookup order matters: the named presets are matched FIRST and by exact key,
// so '15'/'30'/'60'/'90'/'120'/'180'/'auto' never reach the manual branch and
// their behaviour is bit-for-bit unchanged. Only a numeric key with no preset
// of its own — i.e. something the user typed — builds one on the fly.
// Before this, such a value silently resolved to AUTO (30–180s), so a
// request for 300s came back as a ~90s clip with no warning anywhere.
function resolveDuration(mode) {
  const k = String(mode || 'auto').toLowerCase().replace('s','').trim();
  return DURATION_PRESETS[k] || buildManualPreset(k) || DURATION_PRESETS.auto;
}

// [AUTO-FLEX] For the 'auto' preset, clip length adapts to the MOMENT instead
// of a fixed `ideal`. Walk the transcript cues forward from `start`, extending
// to the end of the sentence/thought that completes the payoff, bounded to
// [minLen, maxLen] and the real video length. This is what lets 'auto' emit a
// 40s punchline and a 150s story from the same video instead of clamping every
// clip to one length. Falls back to start+minLen when no cues cover the range.
// [AUTO-LENGTH] `targetLen` asks for a clip of about that length, ending on a
// sentence boundary. Without it the loop stops at the FIRST sentence end past
// the minimum, which is why every "auto" clip came out at exactly the preset
// minimum — 30.0s from a 62.6s source, no matter how much material was left.
// With word-level ASR cues that is almost immediate: whisper emits one word
// per cue, so "sejati," or "hari." closes a cue barely past the floor.
function flexClipEnd(cues, start, minLen, maxLen, vidDur, targetLen) {
  const cap = Math.min(Number(vidDur) > 0 ? Number(vidDur) : Infinity, start + maxLen);
  const floor = Math.min(cap, start + minLen);
  const want = Number(targetLen) > 0 ? Math.min(cap, Math.max(floor, start + Number(targetLen))) : null;
  if (!Array.isArray(cues) || !cues.length) return want || floor;
  const isSentenceEnd = (c) => /[.!?…]["'”’)\]]?$/.test(String(c.text || '').trim());

  if (want) {
    // Aim AT the target and take the sentence boundary closest to it, so the
    // cut lands on a complete thought without abandoning the requested length.
    let best = null, bestDist = Infinity, last = floor;
    for (const c of cues) {
      const ce = Number(c.end);
      if (!Number.isFinite(ce) || ce <= start) continue;
      if (ce > cap) break;
      last = ce;
      if (ce < floor || !isSentenceEnd(c)) continue;
      const d = Math.abs(ce - want);
      if (d < bestDist) { bestDist = d; best = ce; }
      if (ce > want && best !== null) break;   // boundaries only move away now
    }
    return Math.max(floor, Math.min(cap, best !== null ? best : (last > floor ? Math.min(last, want) : want)));
  }

  let end = floor;
  for (const c of cues) {
    const cs = Number(c.start), ce = Number(c.end);
    if (!Number.isFinite(ce) || ce <= start) continue;   // cue ends before our clip starts
    if (Number.isFinite(cs) && cs >= cap) break;          // cue starts past the ceiling
    end = Math.min(cap, ce);                              // extend to cover this cue
    if (end >= cap) break;                                // hit the hard max / video end
    // Stop only once we're PAST the minimum AND this cue closes a complete
    // thought (sentence-final punctuation) — so we never cut mid-sentence and
    // never return a sub-minimum clip when a boundary lands early.
    if (end >= floor && isSentenceEnd(c)) break;
  }
  return Math.max(floor, Math.min(cap, end));
}

// [AUTO-COVER] "Auto" on a SHORT source means: use the whole thing, split into
// exactly the number of clips asked for, cutting at sentence boundaries. Asking
// for 1 clip from a 1m30s video should return 1m30s, and asking for 2 should
// return roughly 45s each — not two 30s clips with 30s of the video silently
// discarded, which is what the minimum-length behaviour produced.
//
// Only for short sources. Past AUTO_COVER_MAX_SEC the request stops meaning
// "use everything" and starts meaning "find the good parts", so highlight
// detection keeps its job — an hour-long podcast split in two is not a clip.
const AUTO_COVER_MAX_SEC = 300;
function buildCoverageClips(cues, duration, numClips) {
  const n = Math.max(1, Math.floor(numClips));
  const target = duration / n;
  const out = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    // The final clip always runs to the end: rounding must never leave a tail
    // of the source unused, which is the whole point of covering it.
    let end = last ? duration
      : flexClipEnd(cues, start, Math.min(target * 0.5, duration - start), duration - start, duration, target);
    end = Math.min(duration, Math.max(start + 0.5, end));
    out.push({
      start, end, title: `Bagian ${i + 1}`, hook: '', score: 6, why: '',
      origin: `auto-coverage ${i + 1}/${n}`, category: 'EDUCATIONAL', coverage: true,
    });
    start = end;
    if (start >= duration) break;
  }
  return out;
}

// ─── [MANUAL-SEGMENTS] User-specified clip ranges ─────────
// Manual mode hands the pipeline explicit start/end timecodes instead of
// running highlight detection. The parse is DELIBERATELY strict: toSeconds()
// falls back to 0 for anything it can't read, so feeding raw user text
// straight into it would silently turn a typo ("1;12") into "start at 0s"
// rather than telling the user their row is broken. Every rejection carries a
// human reason so the UI can say WHY a row is invalid instead of just "0 valid".
const TIMECODE_RE = /^\s*(?:\d+:)?(?:\d+:)?\d+(?:[.,]\d+)?\s*$/;
const MANUAL_MIN_LEN = 3;      // same floor the short-video fallback path uses
// Phone/IME keyboards and pasted text produce full-width digits and colons
// ("１０：００") that look identical on screen but fail the ASCII regex.
function normTimecode(v) {
  return String(v ?? '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[\uFF1A\u2236\uFE55]/g, ':')
    .replace(/[\uFF0E\u3002]/g, '.')
    .trim();
}
// "10.30" is read as 10.3 SECONDS by toSeconds() — a very common way for
// Indonesian users to write 10:30 (as in "10.30 WIB"). Only a row where BOTH
// ends are written that way is treated as that mistake; a single "12.50" is still
// valid fractional seconds, exactly as before.
const DOT_STYLE_RE = /^\d{1,3}\.\d{2}$/;
function parseManualSegments(list, vidDur) {
  const clips = [];
  const rejected = [];
  const dur = Number(vidDur) > 0 ? Number(vidDur) : Infinity;
  (Array.isArray(list) ? list : []).forEach((seg, i) => {
    const row = i + 1;
    const rawS = normTimecode(seg?.start);
    const rawE = normTimecode(seg?.end);
    if (!rawS && !rawE) return;                     // untouched blank row — not an error
    if (DOT_STYLE_RE.test(rawS) && DOT_STYLE_RE.test(rawE)) {
      rejected.push({ row, reason: `"${rawS}" / "${rawE}" pakai titik — tulis dengan titik dua (mis. 10:30), bukan 10.30` });
      return;
    }
    if (!TIMECODE_RE.test(rawS)) { rejected.push({ row, reason: 'waktu MULAI tidak terbaca (pakai MM:SS atau HH:MM:SS)' }); return; }
    if (!TIMECODE_RE.test(rawE)) { rejected.push({ row, reason: 'waktu SELESAI tidak terbaca (pakai MM:SS atau HH:MM:SS)' }); return; }
    const start = toSeconds(rawS);
    let end = toSeconds(rawE);
    if (start >= dur) { rejected.push({ row, reason: 'MULAI melewati akhir video' }); return; }
    if (end <= start) { rejected.push({ row, reason: 'SELESAI harus lebih besar dari MULAI' }); return; }
    // Past the end of the video is a clamp, not a rejection — the user asked
    // for "sampai habis" and meant it.
    let clamped = false;
    if (end > dur) { end = dur; clamped = true; }
    if (end - start < MANUAL_MIN_LEN) { rejected.push({ row, reason: `durasi < ${MANUAL_MIN_LEN} detik` }); return; }
    clips.push({
      start, end,
      title: '', hook: '', score: 5,
      why: '', origin: 'manual segment', category: 'EDUCATIONAL',
      manual: true, row, clamped,
    });
  });
  clips.sort((a, b) => a.start - b.start);
  return { clips, rejected };
}

// ─── Format → ffmpeg video filter ─────────────────────────
// Resolution = the SHORT side of the output in pixels. The long side is
// derived per aspect (16/9 for portrait/landscape, 1:1 for square). These
// drive ALL output dimensions so "HD sesuai pilihan" is honoured exactly:
//   720p → 720×1280 | 1080p → 1080×1920 | 2K → 1440×2560 | 4K → 2160×3840 (9:16)
const RES_MAP = { '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160 };
function resUnit(res) { return RES_MAP[res] || RES_MAP['1080p']; }

// ─── Video encoder selection ──────────────────────────────
// Every clip cut/segment/preview used software libx264 unconditionally,
// which pegs CPU cores that ML tracking + concurrent clip rendering also
// need. Hardware encoders (Apple VideoToolbox / NVIDIA NVENC / Intel
// QuickSync) run on a dedicated media chip instead, freeing CPU for the
// tracking sidecar and letting more clips render in parallel without
// thermal throttling. Detected once per process; falls back to the
// original libx264 behaviour verbatim if no hardware encoder is present.
// `ffmpeg -encoders` only reports which encoders this ffmpeg BINARY was
// compiled with — h264_nvenc/h264_qsv are compiled into every static build
// regardless of the machine's actual hardware, so the string always matches
// even with no NVIDIA/Intel GPU or driver present. That false-positive sent
// every clip through h264_nvenc on a plain Windows laptop with no NVIDIA
// card: ffmpeg failed to load nvcuda.dll and the whole render step crashed
// ("Conversion failed!") instead of falling back to CPU. Confirmed live via
// a user's `ffmpeg` log showing exactly that failure. Verify each candidate
// actually opens by running one real 1-frame encode — that's the only way
// to know the hardware/driver genuinely works, not just that the codec name
// exists in this ffmpeg build.
// [2026-07-26] Two defects found together on a real AMD Windows laptop
// (Ryzen 3 7320U / Radeon 610M iGPU, 4 cores, 7.8GB RAM); either one alone
// makes the other invisible, so they are fixed as a pair:
//   1. h264_amf was never a candidate at all. AMD is the whole non-Intel,
//      non-NVIDIA half of the Windows market, so every such machine fell to
//      `software` — not because the hardware could not encode, but because
//      it was never asked.
//   2. The probe frame was 64x64, which AMF rejects outright (init error 5).
//      Measured on that machine: 64x64 FAILS, 320x240 and 1280x720 both
//      WORK. So adding (1) without (2) would still have detected nothing.
// Measured payoff, real 436MB source, 60s clip, crop+scale to 9:16, run with
// nothing else competing:
//   libx264 veryfast : wall 24.6s, CPU 113.9s, 11.2MB
//   h264_amf @2Mbps  : wall 14.2s, CPU  28.1s, 13.6MB
// 1.7x wall, but the number that matters on a 4-core machine is CPU: 4x
// less. libx264 was eating ~4.6 core-seconds per second of render, starving
// the tracking sidecar and the Electron UI — that contention, not the encode
// itself, is what users feel as "slow".
// Probe frame size. NOT 64x64: AMF rejects frames that small with init error 5,
// which is indistinguishable from "no AMD hardware here" — so a too-small probe
// silently disqualifies every AMD machine. Measured on a Radeon 610M: 64x64
// FAILS, 320x240 and 1280x720 both WORK. Keep this at or above 320x240.
const PROBE_FRAME = '320x240';

function encoderProbeArgs(codecArgs, frame = PROBE_FRAME) {
  return ['-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', `color=c=black:s=${frame}:d=1`,
          ...codecArgs, '-f', 'null', '-'];
}

function tryEncode(codecArgs) {
  try {
    const { execFileSync } = require('child_process');
    // [EPIPE] stdio MUST be explicit. With the default, the probe's streams are
    // wired to pipes whose write completion is asynchronous — so when the peer
    // is already gone (parent stdout closed, e.g. the launching terminal died,
    // or ffmpeg exits before we finish writing) the EPIPE surfaces as an
    // 'error' event on a socket with no listener, i.e. an UNCAUGHT exception
    // that this try/catch cannot see. Nothing here reads the probe's output —
    // only its exit code matters — so discard all three streams.
    execFileSync(validateBinaryPath(FFMPEG), encoderProbeArgs(codecArgs),
      { timeout: 10000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Preference order. First entry wins, so this is the order of "use this if the
// hardware genuinely works", not a list of equals. `h264_amf` was missing from
// this list entirely, which sent every AMD Windows machine to software libx264.
const HW_ENCODER_CANDIDATES = [
  ['h264_videotoolbox', 'videotoolbox'],
  ['h264_nvenc',        'nvenc'],
  ['h264_qsv',          'qsv'],
  ['h264_amf',          'amf'],
];

// Pure selection, split out so the order and the fallback can be tested without
// AMD/NVIDIA/Intel hardware or a real ffmpeg. `encodersOut` is `ffmpeg -encoders`
// output; `probe` returns whether a codec actually opens on this machine.
function pickHwEncoder(encodersOut, probe) {
  const out = String(encodersOut || '');
  for (const [codec, name] of HW_ENCODER_CANDIDATES) {
    if (out.includes(codec) && probe(['-c:v', codec])) return name;
  }
  return 'software';
}

// ─── [HW-ENCODE] "it runs" is not "it is faster" ─────────────────
//
// pickHwEncoder() returns the first hardware encoder that successfully encodes
// one frame. That proves the encoder EXISTS; it says nothing about speed, and
// on a low-power integrated GPU the answer is routinely the opposite of the
// assumption. Measured on the reporting machine (Ryzen 3 7320U / Radeon 610M),
// 10s of 1080p cropped and scaled to 720x1280, mean of 3 runs:
//
//   h264_amf -quality quality  (what this shipped)  6295 ms   4458 KB
//   h264_amf -quality speed                         4967 ms   4340 KB
//   libx264  -preset veryfast                       4456 ms   4188 KB
//
// So the "hardware acceleration" was 41% SLOWER than plain software, and
// produced a slightly larger file at the same bitrate target. Smart Track
// renders a clip as N separate segment encodes, so that penalty is paid N
// times per clip and N x clips per run — which is the "render smart crop jadi
// lama sekali" report.
//
// This is the same lesson [HW-DECODE] already learned on this exact machine,
// where calibration measured d3d11va at 1388ms against 1107ms for software and
// correctly chose software. Decode measures; encode only asked "does it run?".
// So encode now measures too, reusing hw-accel's decision logic and cache
// shape rather than inventing a second set.
const ENC_CACHE_FILE = 'hw-encoder-calibration.json';
const ENC_PROBE_SECONDS = 4;
let _encCacheDir = null;
// Only drops the memoised verdict when the directory actually CHANGES.
// Resetting unconditionally meant a second call with the same dir threw away a
// correct answer and paid for the whole probe + race again — which is exactly
// what happened once a caller started reading detectHwEncoder() earlier than
// this was set. See the [ENC-CACHE-ORDER] note in runPipeline.
function __setEncoderCacheDir(dir) {
  if (dir === _encCacheDir) return;
  _encCacheDir = dir;
  _hwEncoderCache = null;
}

// Both candidates run the SAME crop+scale chain the real render uses. That
// matters: the filters are CPU-side and are a large share of the work, so a
// bare encode-only probe would flatter whichever encoder is faster in
// isolation and miss that the machine is already saturated doing the scaling.
function encoderRaceArgs(encArgs, seconds = ENC_PROBE_SECONDS) {
  return ['-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${seconds}`,
          '-vf', 'crop=iw*0.5625:ih:iw*0.22:0,scale=720:1280',
          ...encArgs, '-pix_fmt', 'yuv420p', '-an', '-f', 'null', '-'];
}

function timeEncode(encArgs) {
  const t0 = Date.now();
  try {
    const { execFileSync } = require('child_process');
    execFileSync(validateBinaryPath(FFMPEG), encoderRaceArgs(encArgs),
      { stdio: 'ignore', timeout: 90000 });
    return { ok: true, ms: Date.now() - t0 };
  } catch { return { ok: false, ms: 0 }; }
}

// Returns 'hw' | 'sw' | null. null means the race could not be run at all, and
// the caller must then keep today's behaviour — a machine whose probe fails is
// not evidence that its GPU encoder is slow, and demoting on no evidence would
// cost a real NVENC user their acceleration.
function raceEncoders(hwName, hwArgs) {
  const { chooseFastest } = require('./hw-accel');
  const sw = timeEncode(['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3500000']);
  const hw = timeEncode(hwArgs);
  if (!sw.ok || !hw.ok) return null;
  const { winner, ratio } = chooseFastest(sw, hw);
  console.log('[hw-encode] %s %dms vs software %dms — ratio %s, using %s',
    hwName, hw.ms, sw.ms, ratio ? ratio.toFixed(2) : '?', winner === 'hw' ? hwName : 'software');
  return winner;
}

function encCacheKey(hwName) {
  return [process.platform, process.arch, hwName].join('|');
}

let _hwEncoderCache = null;
function detectHwEncoder() {
  if (_hwEncoderCache !== null) return _hwEncoderCache;
  let detected = 'software';
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(validateBinaryPath(FFMPEG), ['-hide_banner', '-encoders'],
      // [EPIPE] explicit stdio — see the note in tryEncode().
      { encoding: 'utf8', timeout: 7000, stdio: ['ignore', 'pipe', 'ignore'] });
    detected = pickHwEncoder(out, tryEncode);
  } catch { _hwEncoderCache = 'software'; return _hwEncoderCache; }

  if (detected === 'software') { _hwEncoderCache = detected; return detected; }

  // Calibrate, once per machine. Racing two 4s encodes on every launch would
  // trade one slow path for another, so the verdict persists exactly like the
  // decode one.
  try {
    const hwAccel = require('./hw-accel');
    const key = encCacheKey(detected);
    const dir = _encCacheDir;
    const file = dir ? path.join(dir, ENC_CACHE_FILE) : null;
    let entry = null;
    if (file) { try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
    if (entry && entry.key === key && typeof entry.at === 'number'
        && entry.at <= Date.now() && Date.now() - entry.at <= hwAccel.CACHE_TTL_MS
        && (entry.decision === 'hw' || entry.decision === 'sw')) {
      _hwEncoderCache = entry.decision === 'hw' ? detected : 'software';
      return _hwEncoderCache;
    }
    const verdict = raceEncoders(detected, videoEncodeArgsFor(detected, 'final', '720p'));
    if (verdict === null) { _hwEncoderCache = detected; return detected; }   // no evidence → unchanged
    if (file) {
      try { fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ key, decision: verdict, at: Date.now() }, null, 2)); } catch {}
    }
    _hwEncoderCache = verdict === 'hw' ? detected : 'software';
  } catch {
    _hwEncoderCache = detected;          // anything unexpected → today's behaviour
  }
  return _hwEncoderCache;
}
// Test seam: videoEncodeArgs() branches on the detected encoder, and there is no
// other way to exercise the AMD/NVIDIA/Intel branches from a dev Mac or CI.
function __setHwEncoder(name) { _hwEncoderCache = name; }
// Target video bitrate per output resolution tier (short-side driven, same
// keys as RES_MAP), tuned to land near libx264 -crf 20 visual quality.
const TIER_MBPS = { '480p': 1.5, '720p': 3.5, '1080p': 5, '2K': 9, '4K': 20 };
function videoEncodeArgs(tier, resolution, threads) {
  return videoEncodeArgsFor(detectHwEncoder(), tier, resolution, threads);
}
// Split out so the calibration race can build the hardware encoder's REAL
// arguments without calling detectHwEncoder() — which is what invokes the race
// — and so each vendor branch stays unit-testable off its own hardware.
function videoEncodeArgsFor(hw, tier, resolution, threads) {
  const mbps = TIER_MBPS[resolution] || TIER_MBPS['1080p'];
  const bps = Math.round(mbps * (tier === 'preview' ? 0.4 : 1) * 1e6);
  if (hw === 'videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-profile:v', tier === 'preview' ? 'baseline' : 'high',
            '-b:v', String(bps), '-maxrate', String(Math.round(bps * 1.4)), '-bufsize', String(bps * 2)];
  }
  if (hw === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', tier === 'preview' ? 'p1' : 'p5',
            '-rc', 'vbr', '-cq', tier === 'preview' ? '30' : '20', '-b:v', '0',
            '-maxrate', String(Math.round(bps * 1.4)), '-bufsize', String(bps * 2)];
  }
  if (hw === 'qsv') {
    return ['-c:v', 'h264_qsv', '-preset', tier === 'preview' ? 'veryfast' : 'medium',
            '-global_quality', tier === 'preview' ? '30' : '20'];
  }
  // AMF has no CRF equivalent, so drive it by bitrate like videotoolbox.
  // vbr_latency is the mode measured above; vbr_peak stalls on some driver
  // versions. At the tier bitrate it lands within 20% of libx264 -crf 20 on
  // file size (13.6MB vs 11.2MB for the same 60s clip).
  if (hw === 'amf') {
    return ['-c:v', 'h264_amf', '-quality', tier === 'preview' ? 'speed' : 'quality',
            '-rc', 'vbr_latency', '-b:v', String(bps),
            '-maxrate', String(Math.round(bps * 1.4)), '-bufsize', String(bps * 2)];
  }
  // [SW-ENCODE-BUDGET] `threads` is only meaningful here. x264 sizes its own
  // pool from the core count, so N concurrent encodes each try to own the whole
  // machine; the hardware branches above are not CPU-bound and a cap there would
  // be noise. Absent (the default) emits exactly the args that shipped before,
  // so every single-shot call site is untouched.
  const cap = Number.isFinite(threads) && threads > 0 ? ['-threads', String(threads)] : [];
  return tier === 'preview'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', ...cap]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...cap];
}

// ─── [SW-ENCODE-BUDGET] What one software encode actually costs ──────
//
// Measured on a 10-core M-series Mac, one process, /usr/bin/time -l, on the real
// production job (1080x1920, 10s, caption burn):
//
//   h264_videotoolbox   2.32s user CPU   191 MB peak RSS   (~0.61 cores)
//   libx264 veryfast   10.32s user CPU   594 MB peak RSS   (~2.15 cores)
//
// The clip limit of 6 was chosen where the encode is free. On the software path
// it asks for ~13 cores and ~3.6 GB of encoder RSS. The reporting machine is a
// Ryzen 3 7320U — 4 cores / 8 threads — and os.cpus() reports the SMT count, so
// the old `min(6, cpus-1, clips)` picked 6 there. Note the encoder calibration
// deliberately PREFERS software on that exact laptop (h264_amf measured 41%
// slower), so this is the normal path there, not a fallback.
//
// Wall-clock is nearly flat across limits on a many-core box (best-of-3 over 8
// clips: 6=10.7s, 4=9.8s, 2=13.5s, 1=11.7s), so lowering the cap to a small
// constant would REGRESS those machines. Budget it instead, and never exceed the
// 6 that already ships.
const SW_ENCODE_RSS_BYTES = 600 * 1024 * 1024;   // measured 594 MB, rounded up
const SW_ENCODE_CORES     = 2;                   // measured ~2.15, rounded down
// [LOW-SPEC-2026-07-30] os.freemem(), not os.totalmem(). Installed RAM is a
// static property of the machine and says nothing about a laptop that is
// already down to 2-3 GB free at launch because of antivirus/bloatware — a
// real pattern on old corporate Windows laptops, exactly the population most
// likely to run this on weak hardware in the first place. freemem() is read
// AFTER Electron/Chromium have already started, so their footprint is already
// netted out of it; the margin below only has to cover background fluctuation
// and this render's own memory growth, not the whole app's baseline.
const SW_ENCODE_FREE_MARGIN_BYTES = 1 * 1024 ** 3;
const CLIP_CONCURRENCY_CEILING = 6;              // unchanged from what ships
// [LOW-SPEC-MAC-2026-07-30] A hardware encoder is cheap on CPU but NOT free on
// RAM, and the free-RAM budget above was gated behind `hw === 'software'` — so
// every Mac (videotoolbox always wins pickHwEncoder there) and every nvenc
// Windows box got no memory budget at all and ran the flat ceiling of 6 no
// matter how little RAM was left. That is the low-spec Mac failure: an 8 GB
// machine with a browser open has ~2 GB free, and 6 concurrent renders ask for
// more than half of it on top of Electron.
//
// Measured on this machine (M-series arm64, 10 cores / 16 GB, macOS 26.4.1)
// with the app's own bundled ffmpeg, rendering what a clip actually renders —
// scale to 1080x1920 plus an ASS subtitle burn — sampling all live children from
// one sampler (per-child sampling after the fact reports zeros, which is how
// this measurement first went wrong):
//   h264_videotoolbox  N=1 181 MB · N=2 182 · N=4 183 · N=6 178 MB/proc  (linear)
//   libx264            N=1 546 MB · N=6 466 MB/proc  → confirms the 600 above
// 256 MB rather than 181 leaves room for Intel VideoToolbox, a larger source and
// the crop/track filter graphs, all of which sit above this floor.
const HW_ENCODE_RSS_BYTES = 256 * 1024 * 1024;

// [RES-RSS-BUDGET] The two constants above were measured at 1080p only, so a
// 2K/4K render got the 1080p budget (memory: concurrency-ram-ignores-resolution).
// Measured 2026-10-10 with the bundled ffmpeg on the same 15 s clip, peak RSS of
// one process, worst format per tier (face sources follow FACE_SOURCE_HEIGHT_CAPS
// in source-acquisition.js — 2K/4K face read a 2160p source):
//                    libx264 veryfast      h264_videotoolbox
//   720p  (src 1080)      295 MB               122 MB
//   1080p (src 1440)      566 MB               202 MB      ← under 600 / 256
//   2K    (src 2160)     1004 MB  (blur 918)   374 MB
//   4K    (src 2160)     1917 MB               482 MB
// 720p/1080p keep the shipped constants exactly; only 2K/4K get their own,
// which can only LOWER concurrency on those tiers, never raise it.
const ENCODE_RSS_BYTES_BY_RES = {
  '2K': { software: 1024 * 1024 * 1024, hardware: 384 * 1024 * 1024 },
  '4K': { software: 2048 * 1024 * 1024, hardware: 512 * 1024 * 1024 },
};
function encodeRssBytesFor(hw, resolution) {
  const sw = hw === 'software';
  const byRes = ENCODE_RSS_BYTES_BY_RES[resolution];
  if (byRes) return sw ? byRes.software : byRes.hardware;
  return sw ? SW_ENCODE_RSS_BYTES : HW_ENCODE_RSS_BYTES;
}

// Threads per software encode, so concurrency x threads lands near the core
// count instead of every process sizing itself for the whole machine. Clamped
// at 8 because x264 gains little past that, and at 2 because 1 is a large loss.
function softwareEncodeThreads(cpuCount, concurrency) {
  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1));
  const conc = Math.max(1, Math.floor(Number(concurrency) || 1));
  return Math.max(2, Math.min(8, Math.floor(cpus / conc)));
}

// The clip-render pool size. Pure so the platform/RAM matrix is testable off the
// hardware it describes — same reason pickHwEncoder and trackingParallelSafeOn
// were extracted.
function clipConcurrencyFor({ smartTrack, trackerCap, hw, cpus, freeMemBytes, clips, resolution }) {
  const n = Math.max(1, Math.floor(Number(cpus) || 1));
  const nClips = Math.max(1, Math.floor(Number(clips) || 1));
  // Smart Track's cap comes from trackerAccelCapFor() — a NUMBER, not a
  // boolean, because there are three cases (darwin/nvenc = 4, a win32 iGPU
  // running DirectML = 2, no evidence of an accelerator = 1), not two. See
  // [TRACKER-ACCEL-CAP] at trackerAccelCapFor for the measurements.
  // [LOW-SPEC-MAC-2026-07-30] The free-RAM budget applies to EVERY encoder now,
  // not just software — see HW_ENCODE_RSS_BYTES for why and for the numbers.
  // Every clip pays one ffmpeg encode whichever branch we are in, so budgeting
  // on that measured cost is valid in both. On the Smart Track path each clip
  // ALSO carries a tracker worker whose footprint is not measured here, so the
  // budget below undercounts that path — it can only ever lower the cap, never
  // raise it, so undercounting stays on the safe side of a crash rather than
  // inventing a number for the part that was never measured.
  const byRam = () => {
    const free = Number(freeMemBytes) || 0;
    // freeMemBytes is optional: a caller that cannot report free memory must not
    // be silently squeezed to 1: 0/absent means "no information", not "no RAM".
    if (free <= 0) return Infinity;
    const perProc = encodeRssBytesFor(hw, resolution);   // [RES-RSS-BUDGET]
    return Math.floor(Math.max(0, free - SW_ENCODE_FREE_MARGIN_BYTES) / perProc);
  };
  if (smartTrack) {
    const cap = Math.max(1, Math.floor(Number(trackerCap) || 1));
    return Math.max(1, Math.min(cap, byRam(), n - 1, nClips));
  }
  let cap = CLIP_CONCURRENCY_CEILING;
  if (hw === 'software') cap = Math.min(cap, Math.floor(n / SW_ENCODE_CORES));
  cap = Math.min(cap, byRam());
  return Math.max(1, Math.min(cap, n - 1, nClips));
}

// Final renders are deliberately conservative. LokaClip's measured sweet spot
// is two hardware encodes at once; beyond that, short clips do not complete
// materially sooner but compete with tracking, Chromium and the OS. The RAM/
// tracker calculation above remains the safety authority: this helper only
// caps a healthy machine at two and never raises a low-memory decision.
function renderPlanFor(input) {
  const available = clipConcurrencyFor(input);
  const workers = Math.min(2, available);
  const encoder = input.hw || 'software';
  return {
    encoder,
    workers,
    reason: workers < 2 && Number(input.freeMemBytes) > 0 ? 'low-memory'
      : encoder === 'software' ? 'software-verified' : 'hardware-verified',
  };
}
// ─── [HW-DECODE] GPU decode, measured per machine ──────────────
// Populated by calibrateDecodeOnce(); [] means CPU decode, which is exactly
// what every ffmpeg call did before calibration existed. Module-level so all
// clips in a run share one verdict instead of re-probing per clip.
let _decodeArgs = [];
let _decodeCalibrated = false;
let _ffmpegVersionCache = null;
// Remembered so a GPU failure during a REAL render can demote the on-disk
// verdict, not just the in-memory one.
let _decodeCacheDir = null;
let _decodeCacheKey = null;

// Async on purpose. The synchronous version of this contradicted the very
// reason hw-accel.js probes asynchronously: it runs in Electron's main process,
// and the first spawn of ffmpeg.exe on Windows under Defender is documented in
// this project's own notes as taking seconds — a hard UI freeze.
async function ffmpegVersion() {
  if (_ffmpegVersionCache !== null) return _ffmpegVersionCache;
  _ffmpegVersionCache = await new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile(validateBinaryPath(FFMPEG), ['-hide_banner', '-version'],
        { encoding: 'utf8', timeout: 7000 }, (err, out) => {
          if (err) return resolve('unknown');
          resolve((/ffmpeg version (\S+)/.exec(out) || [, 'unknown'])[1]);
        });
    } catch { resolve('unknown'); }
  });
  return _ffmpegVersionCache;
}

async function calibrateDecodeOnce({ src, vf, resolution, cacheDir, log = () => {} } = {}) {
  if (_decodeCalibrated) return _decodeArgs;
  _decodeCalibrated = true;   // set BEFORE the first await so concurrent
                              // callers cannot both start a calibration
  try {
    const hwa = require('./hw-accel');
    const encoderName = detectHwEncoder();
    const ffVer = await ffmpegVersion();
    _decodeCacheDir = cacheDir || null;
    _decodeCacheKey = hwa.cacheKeyFor({
      platform: process.platform, arch: process.arch,
      ffmpegVersion: ffVer, encoder: encoderName, hwaccel: hwa.hwaccelFor(process.platform),
    });
    const res = await hwa.calibrateDecode({
      ffmpeg: FFMPEG,
      ffmpegVersion: ffVer,
      src, vf,
      encArgs: videoEncodeArgs('preview', resolution || '1080p'),
      encoderName,
      cacheDir,
      log,
    });
    _decodeArgs = res.args || [];
  } catch (e) {
    // Calibration must never be able to break a render. Any failure keeps the
    // pre-existing CPU-decode behaviour.
    console.warn('[hw-decode] calibration failed:', e?.message || e);
    _decodeArgs = [];
  }
  return _decodeArgs;
}

// Where the calibration verdict is cached. Only ever the app's own userData
// directory — never anywhere the user browses, and never derived from the output
// path. Returns null when unknown, which makes calibration re-measure each run
// rather than write the file somewhere unexpected.
function calibrationCacheDir(userDataDir) {
  return (typeof userDataDir === 'string' && userDataDir.trim()) ? userDataDir : null;
}

// Decode flags to place BEFORE `-i`. Empty unless calibration proved GPU
// decode faster on this machine.
function decodeArgs() { return _decodeArgs; }

// Test seams. The GPU-failure retry path cannot be reached from a normal test
// run on a machine where calibration (correctly) chooses CPU, so tests force
// the state that a GPU-winning machine would be in.
function __setDecodeArgs(a) { _decodeArgs = a; _decodeCalibrated = true; }
function __setFfmpeg(p) { FFMPEG = p; }

function replaceVideoEncodeArgs(args, from, to) {
  const at = args.findIndex((_, i) => from.every((v, j) => args[i + j] === v));
  if (at < 0) return args.slice();
  return [...args.slice(0, at), ...to, ...args.slice(at + from.length)];
}

function isEncoderError(message) {
  return /Error initializing output stream|Error while opening encoder|Unknown encoder|\b(nvEncodeAPI|VideoToolbox|QSV|AMF).*(fail|error|unavailable|not supported)/i.test(message);
}

// Run ffmpeg, retrying once on CPU if a GPU-decode attempt fails. A 3-second
// calibration slice cannot prove every source will decode on the GPU — an
// unusual codec profile or a driver that dies under sustained load would
// otherwise turn a speed optimisation into a failed render.
async function spawnFfmpegWithDecodeFallback(args, opts = {}) {
  const hwa = require('./hw-accel');
  try {
    return await spawnLines(FFMPEG, args, opts);
  } catch (e) {
    // Classify on message + FULL stderr: spawnLines condenses the message to
    // the explanatory lines, and ffmpeg's decoder giveaway ("Unrecognized
    // hwaccel", "Failed setup for format") sits above the final "Error opening
    // input files" line — matching the message alone would miss it and skip the
    // CPU retry entirely.
    const msg = `${e?.message || String(e)}\n${e?.stderr || ''}`;
    if (opts.encodeArgs && opts.fallbackEncodeArgs && isEncoderError(msg)) {
      const cpuArgs = replaceVideoEncodeArgs(args, opts.encodeArgs, opts.fallbackEncodeArgs);
      console.warn('[hw-encode] hardware encoder failed — retrying once with libx264');
      return await spawnLines(FFMPEG, cpuArgs, opts);
    }
    if (!hwa.hasHwaccel(args) || !hwa.isDecoderError(msg)) throw e;
    const cpuArgs = hwa.withoutHwaccel(args);
    console.warn('[hw-decode] GPU decode failed (%s) — retrying on CPU', msg);
    // Stop using GPU decode for the rest of this run: if it failed once it will
    // almost certainly fail again, and paying a doomed attempt per clip would
    // be slower than never having enabled it.
    _decodeArgs = [];
    // And remember it across launches, so a machine whose calibration slice
    // passes but whose real renders fail does not re-pay a doomed GPU attempt
    // on the first clip of every run until the 30-day cache expires.
    try { hwa.demoteCache(_decodeCacheDir, _decodeCacheKey); } catch { /* best effort */ }
    return await spawnLines(FFMPEG, cpuArgs, opts);
  }
}

// Build a STEP (hold) ffmpeg expression (fraction 0..1) over time `t` from
// keyframes [{t, x|y (0..100)}]. Each keyframe LOCKS its framing until the next
// keyframe's time — no drifting between them. Commas escaped for the filtergraph.
function piecewiseFrac(kf, key) {
  const v = i => Math.max(0, Math.min(1, (kf[i][key] || 0) / 100));
  if (kf.length === 1) return v(0).toFixed(4);
  let expr = v(kf.length - 1).toFixed(4);            // t >= last keyframe → hold last
  for (let i = kf.length - 2; i >= 0; i--) {
    // for t < next keyframe time, hold THIS keyframe's value
    expr = `if(lt(t,${kf[i + 1].t.toFixed(3)}),${v(i).toFixed(4)},${expr})`;
  }
  return expr;   // t before kf[1] (incl. before kf[0]) → v(0)
}

// ─── Watermark filter builder ─────────────────────────────
// Takes an already-built base video filter chain string (from vfFor and/or
// buildCaptionVf), the watermark descriptor (as returned by
// watermark.resolveWatermark), and the target OUTPUT width in pixels
// (computed via outputWidthPx below from clipFormat + clipResolution) —
// returns everything a ffmpeg command needs to burn the watermark on top:
//
//   { extraInputs, filterArgs }
//
// - extraInputs : additional `-i <path>` args appended after the main input
// - filterArgs  : either `['-vf', vf]` (bit-identical passthrough when the
//                 watermark is inactive) OR `['-filter_complex', graph,
//                 '-map', '[wmOut]', '-map', '0:a?']` when the overlay chain
//                 needs to run.
//
// The audio map uses `0:a?` so silent inputs don't fail the ffmpeg run — the
// existing `-vf` code path never had to worry because ffmpeg's implicit
// stream mapping already handled it, and we must preserve that behaviour.
//
// Scaling: the watermark is resized to sizePct% of the output canvas width,
// with height preserved from the source PNG/WebP/JPEG (aspect-locked).
// We do that scaling in a fixed-pixel `scale=W:-1` filter so we never have
// to touch libavfilter's fragile scale2ref (whose iw/rw semantics silently
// change meaning depending on filter version).
const wmModule = require('./watermark');
// [EMOJI-STICKER] Dictionary + caps + geometry. Shared with the renderer's
// preview so both draw the same PNG at the same rect — see emoji-map.js.
const EmojiMap = require('./emoji-map');
// [FMT-WIDE] The 16:9 format is called `landscape` everywhere that produces it
// — the Clip Options chip grid, formatForAspect(), assPlayRes(), vfFor(). The
// string 'wide' is produced by NOTHING, so this branch never fired and a 16:9
// clip reported width = the SHORT side (1080 at 1080p) instead of 1920. That
// fed watermark sizing (sizePct × width) and drawtext fontsize, so a watermark
// on a landscape clip burned at 56% of the size the user asked for. 'wide' is
// kept as an alias rather than deleted: it costs nothing and any caller still
// passing it gets the answer it always meant.
function outputWidthPx(format, resolution) {
  const short = resUnit(resolution);
  if (format === 'landscape' || format === 'wide') return Math.round(short * 16 / 9);
  return short;  // face (9:16) or square (1:1) → width = short side
}
// Companion to outputWidthPx — the sticker layer positions against frame
// HEIGHT (captions are placed on a top-origin Y axis), so it needs both.
function outputHeightPx(format, resolution) {
  const short = resUnit(resolution);
  if (format === 'landscape' || format === 'wide') return short;   // 16:9 → height is the short side
  if (format === 'square') return short;
  return Math.round(short * 16 / 9);   // face / blur → 9:16
}

// Probes the actual video width, useful when cropAspect === 'free' produces
// an output resolution not bound to the strict 16:9 or 9:16 aspect ratios.
// [WM-TEXT-ASS] Width AND height, in ONE probe. The watermark used to need only
// the width (drawtext addressed the frame with the `w`/`h` variables and let
// ffmpeg fill them in); the .ass sidecar has to state PlayResY and compute
// absolute pixel positions itself, so the height has to be known up front.
// Returns nulls rather than guesses — callers fall back to the format's own
// canvas size, which is what they already did for the width.
async function getStreamDims(videoPath) {
  try {
    const { stdout } = await spawnLines(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', videoPath
    ], { cwd: process.cwd() });
    const [w, h] = String(stdout).trim().split('x').map(n => parseInt(n, 10));
    return { w: isNaN(w) ? null : w, h: isNaN(h) ? null : h };
  } catch (e) {
    return { w: null, h: null };
  }
}

// [EMOJI-STICKER] Bundled Twemoji PNGs, named by codepoint. asarUnpack applies
// the same way it does to assets/fonts — libass and ffmpeg both need real files
// on disk, not entries inside the asar.
function emojiAssetsDir() {
  return path.join(__dirname, '..', 'assets', 'emoji').replace('app.asar', 'app.asar.unpacked');
}

// [EMOJI-STICKER] AI fallback for the nouns the dictionary misses. Cues are
// collected and answered in ONE aiComplete() call per render — never one
// call per cue — for the same reason topic-summary and highlight-detection
// already batch: [AI-CIRCUIT-BREAKER] above measured that pipeline AI latency
// is driven by the COUNT of serial calls, not by clip length or cue count.
//
// aiAvailable/aiComplete are the same functions fixCaptionTypos/
// regenerateClipMeta use — this is a fourth caller of that shared gate, not a
// parallel AI path. Never throws: skippable by design, so a clip with no key
// configured (or an AI call that fails) quietly stays dictionary-only rather
// than losing the render over a decorative feature.
//
// [AI-STICKER-CACHE] `cache` is an OPTIONAL, caller-supplied { cueText: emoji }
// map — the same shape this function RETURNS as `.cache`, meant to be
// persisted onto the clip (mirrors how trackPlan survives from runPipeline
// into every later re-cut) and handed back in on the next call. Keyed by the
// cue's own text rather than its index: an index is only stable within ONE
// render pass (see planStickers' aiHits note), but re-chunking the transcript
// into different cue groupings changes indices AND text together, so a
// cache miss there is simply "ask again for the new grouping" — never wrong,
// only less cached. A cache hit costs NOTHING — it is checked and returned
// before aiAvailable() is ever consulted, so a clip that already has an
// answer for every uncovered cue makes no network attempt at all, even with
// no AI key configured (a user who resolved stickers once and later cleared
// their key keeps the stickers they already paid to resolve).
async function resolveAiStickers(cfg, cues, { onLog, cache } = {}) {
  const priorCache = (cache && typeof cache === 'object') ? cache : {};
  const items = EmojiMap.uncoveredCues(cues);
  if (!items.length) return { hits: {}, cache: priorCache };

  // Same cache→hits mapping the live preview uses, so a cached cue produces
  // the identical sticker in both places (EmojiMap.hitsFromCache).
  const hits = EmojiMap.hitsFromCache(cues, priorCache);
  const toAsk = items.filter(it => !Object.prototype.hasOwnProperty.call(hits, it.index));
  if (!toAsk.length) return { hits, cache: priorCache };   // every uncovered cue was already cached

  // No cfg at all (a caller with none in scope) is deliberately treated as
  // "AI unavailable" WITHOUT ever calling aiAvailable()/effectiveAI() — their
  // {} default resolves to the always-on free tier, which would otherwise
  // silently attempt a real network call a caller that passed no cfg never
  // asked for.
  if (!cfg || !aiAvailable(cfg)) return { hits, cache: priorCache };

  const inventoryList = EmojiMap.inventory();
  const prompt = EmojiMap.buildAiPrompt(toAsk, inventoryList);
  try {
    const raw = await aiComplete(cfg, prompt, {
      system: 'You pick emoji stickers for short-form video captions. Output JSON only.',
      maxTokens: 800, temperature: 0.2, json: true,
    });
    const fresh = EmojiMap.parseAiResponse(raw, toAsk, inventoryList);
    const nextCache = { ...priorCache };
    for (const it of toAsk) {
      if (Object.prototype.hasOwnProperty.call(fresh, it.index)) {
        hits[it.index] = fresh[it.index];
        nextCache[it.text] = fresh[it.index];
      }
    }
    const n = Object.keys(fresh).length;
    if (n) onLog?.(`✦ Emoji sticker: AI melengkapi ${n} kata di luar kamus`, 'lime');
    return { hits, cache: nextCache };
  } catch (e) {
    onLog?.(`⚠ Emoji sticker: AI fallback gagal (${e?.message || e}) — lanjut dengan kamus saja`, 'yellow');
    return { hits, cache: priorCache };
  }
}

// Turn cues into ready-to-burn sticker jobs: dictionary lookup (+ the AI
// fallback above when a cue misses it) + caps from emoji-map, the shared
// rect, and an absolute PNG path.
//
// Called from BOTH burn paths. The audit that preceded this feature found
// subtitleCase and the watermark wired into renderClipEdit only, so neither
// ever reached the clip the pipeline hands over — a new layer must not repeat
// that, which is why this lives at module scope and not inside either caller.
//
// Returns { jobs, aiCache } rather than a bare array — aiCache is the (maybe
// updated) resolution cache the caller must persist onto the clip so the
// NEXT render of the same clip (Preview clicked again, then Apply, then a
// batch re-render) reuses it instead of re-querying the AI. `aiCache` in the
// options is the PRIOR persisted cache; omit it on a clip's first render.
//
// `cfg` is OPTIONAL and gates the NETWORK step specifically — omitting it
// still honours a prior cache (see resolveAiStickers), it just cannot
// resolve anything NEW. renderClipEdit runs in main.js outside runPipeline's
// closure, so its caller must pass its own readCfg().
//
// A dictionary entry whose PNG is missing is dropped rather than failing the
// render: an incomplete asset set degrades to fewer stickers, never to a
// broken clip.
async function stickerJobs({ enabled, cues, fontSize, captionY, subtitleX, format, resolution, cfg, onLog, aiCache }) {
  if (!enabled) return { jobs: [], aiCache: (aiCache && typeof aiCache === 'object') ? aiCache : {} };
  const fmt = format || 'face';
  const res = resolution || '1080p';
  const { hits: aiHits, cache: nextAiCache } = await resolveAiStickers(cfg, cues, { onLog, cache: aiCache });
  const geom = {
    fontSize: fontSize || 64,
    captionY: captionY || 540,
    // [EMOJI-SUBTITLEX] canonical (1080-wide) caption X; null/undefined = centre.
    subtitleX: (subtitleX == null) ? null : subtitleX,
    outputW: outputWidthPx(fmt, res),
    outputH: outputHeightPx(fmt, res),
  };
  const dir = emojiAssetsDir();
  const jobs = [];

  // [EMOJI-INLINE] A cue whose tokens carry a baked emoji anchor (only
  // possible once the Caption Editor has measured it via bakeCueWordOffsets —
  // see that function's [EMOJI-INLINE] comment) places its emoji directly
  // above the word that triggered it, instead of the block-row placement
  // below. Read straight off the tokens: no dictionary/AI lookup needed here,
  // the choice and position were already decided client-side.
  const inlineCueIndices = new Set();
  (cues || []).forEach((cue, index) => {
    const toks = Array.isArray(cue && cue.tokens) ? cue.tokens : [];
    const hasInline = toks.some(t => t && t.emoji &&
      Number.isFinite(+t.eax) && Number.isFinite(+t.eay) && Number.isFinite(+t.esize));
    if (hasInline) inlineCueIndices.add(index);
  });
  // [STICKER-HOLD-CLAMP] Same ceiling planStickers' own hold pass uses: never
  // past the very last cue's own end, so a hold near the tail doesn't linger
  // over silence like a stuck frame.
  let timelineEnd = -Infinity;
  for (const c of (cues || [])) {
    const e = Number(c && c.end);
    if (Number.isFinite(e) && e > timelineEnd) timelineEnd = e;
  }
  for (const index of inlineCueIndices) {
    const cue = cues[index];
    const start = Number(cue && cue.start), end = Number(cue && cue.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // [STICKER-HOLD-CLAMP] The hold below EXTENDS end toward start+
    // MIN_STICKER_SEC, but must never cross into the NEXT caption cue's own
    // window — measured on a real session, consecutive cues almost always
    // have a ZERO gap between them, so a naive extend routinely left an
    // emoji anchored to one word still on screen while the caption had
    // already moved on to unrelated text several words later. This is
    // usually the tighter of the two ceilings in practice; the timeline end
    // only matters for the clip's very last cue.
    const nextCue = cues[index + 1];
    const nextCueStart = nextCue && Number.isFinite(Number(nextCue.start)) ? Number(nextCue.start) : Infinity;
    const ceiling = Math.min(nextCueStart, Number.isFinite(timelineEnd) ? timelineEnd : Infinity);
    const heldEnd = Math.max(end, Math.min(start + EmojiMap.MIN_STICKER_SEC, Math.max(ceiling, end)));
    for (const t of cue.tokens) {
      if (!t || !t.emoji || !Number.isFinite(+t.eax) || !Number.isFinite(+t.eay) || !Number.isFinite(+t.esize)) continue;
      const file = path.join(dir, EmojiMap.assetFileFor(t.emoji));
      let ok = false;
      try { ok = fs.existsSync(file); } catch {}
      if (!ok) continue;
      const rect = EmojiMap.inlineJobRect({ eax: t.eax, eay: t.eay, esize: t.esize, captionY: geom.captionY, outputW: geom.outputW, outputH: geom.outputH, subtitleX: geom.subtitleX });
      jobs.push({ emoji: t.emoji, word: EmojiMap.caseFold(t.text), file, start, end: heldEnd, ...rect });
    }
  }

  // [STICKER-ROW] Block-row placement for every OTHER cue (no inline bake —
  // most History clips, or a fresh render before the Editor has ever opened).
  // planStickers tags each entry with groupIndex/groupSize — 2-3 emoji from
  // the SAME cue-moment must sit in a ROW (stickerRowRect), not all centred
  // on one point. stickerRect() alone (groupSize 1) is what ran here before
  // this feature, so a clip with no multi-emoji moments is unaffected.
  let rowCache = null, rowKey = null;
  for (const s of EmojiMap.planStickers(cues, { aiHits })) {
    if (inlineCueIndices.has(s.cueIndex)) continue;   // this cue already got inline jobs above
    const file = path.join(dir, s.file);
    let ok = false;
    try { ok = fs.existsSync(file); } catch {}
    if (!ok) continue;
    const key = `${s.start}|${s.end}`;
    if (key !== rowKey) { rowKey = key; rowCache = EmojiMap.stickerRowRect(s.groupSize, geom); }
    jobs.push({ ...s, ...rowCache[s.groupIndex], file });
  }
  return { jobs, aiCache: nextAiCache };
}
// [WM-V1] Layered composite: base crop → watermark → captions.
//
// Called with the crop-only base filter (from vfFor), the caption suffix
// string (from captionSuffixOnly — may be null when there are no captions),
// the resolved watermark descriptor, and the output canvas width in pixels.
//
// Returns { extraInputs, filterArgs } — extraInputs adds `-i wmPath` when
// active; filterArgs is either bit-identical `-vf` (inactive watermark) or
// a `-filter_complex … -map [final] -map 0:a?` triplet:
//
//   [0:v] baseVf                             → [wmBase]
//   [1:v] scale + opacity                    → [wmA]
//   [wmBase][wmA] overlay at anchor          → [wmDone]
//   [wmDone] captionSuffix                   → [final]      ← captions on top
//
// This means the watermark burns BELOW the caption layer — which is what
// users expect when a big logo would otherwise cover their subtitles.
// When there are no captions, the graph terminates at [wmDone] labelled
// as [final] so the mapping stays consistent.
// Retained for the emoji-sticker chain's `movie=` source, which is the only
// remaining filter option carrying a filesystem path. (The drawtext colour
// helper that used to sit here went with [WM-TEXT-ASS].)
// Filter-arg escaping is a nightmare to do inline (colons, single quotes,
// backslashes, %-expansion). textfile= reads the exact bytes from disk, so
// we sidestep escaping entirely — just write the text to a temp file. Path
// still needs the standard filter-arg escape for the colon on Windows drive
// letters + backslashes; assFontsDir() has the same rules and works here.
function drawtextPathArg(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}
// [WM-TEXT-ASS] The text watermark renders through libass, not drawtext.
//
// drawtext needs libfreetype compiled into ffmpeg, and the binary ffmpeg-static
// ships for macOS **x64** does not have it — measured against the 2.4.1 build:
// the arm64 bundle (ffmpeg 6.0) lists 477 filters, the x64 bundle (ffmpeg
// 6.1.1-tessus) lists 490, and `drawtext` is the ONLY name the two lists
// disagree on. Worse, 6.1.x parses `-filter_complex` while it is still reading
// GLOBAL options, so the run aborted before opening an input:
//
//   Error parsing global options: Filter not found        (exit code 8)
//
// Reported live on an Intel Mac as "Apply failed: …/ffmpeg exited 8" — and only
// from the paths that composite a watermark, which is why ordinary renders
// looked fine while Caption Editor Apply always failed. libass (`subtitles=`)
// cannot go missing the same way: the captions themselves ride on it.
//
// Resolve the family name out of the font file rather than keeping a second
// name table here — watermark.js's TEXT_FONTS stores FILENAMES, and libass
// matches on the `name` table's family. A wrong name does not error; it
// silently renders Helvetica (see the libass font-matching note on buildAss).
function wmTextFace(file) {
  try {
    const face = __parseFace(fs.readFileSync(path.join(assFontsDirFs(), String(file || ''))));
    const family = face && Array.isArray(face.names) && face.names[0];
    if (family) return { family, bold: !!face.bold, italic: !!face.italic };
  } catch { /* fall through to the default face */ }
  return { family: 'Arial', bold: false, italic: false };
}
// ASS colours are &HAABBGGRR: bytes reversed against CSS hex, and the alpha is
// INVERTED (00 = opaque, FF = invisible). Copying the opacity straight across
// would burn a solid bar for the 5%-opacity watermark that was reported.
function hexToAssColour(hex, alpha) {
  const h = /^#([0-9a-fA-F]{6})$/.exec(hex || '#ffffff');
  const rgb = h ? h[1] : 'ffffff';
  const a = Math.max(0, Math.min(255,
    Math.round((1 - (Number.isFinite(alpha) ? alpha : 1)) * 255)));
  const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
  return `&H${a.toString(16).padStart(2, '0')}${bgr}`.toUpperCase();
}
// The ASS twin of drawtextXY(): same anchor semantics (offset from the named
// edge, centre anchors ignore the offset), expressed as an \an alignment plus
// an absolute \pos. PlayRes is set to the real frame below, so these are plain
// output pixels — no PlayRes-to-frame scaling to get wrong.
function wmAssPos(wm, W, H) {
  const dx = Math.round(W * ((wm.xPct || 0) / 100));
  const dy = Math.round(H * ((wm.yPct || 0) / 100));
  const A = String(wm.anchor || 'tl');
  const v = 'tmb'.includes(A[0]) ? A[0] : 't';
  const hz = 'lcr'.includes(A[1]) ? A[1] : 'l';
  const an = { t: 7, m: 4, b: 1 }[v] + { l: 0, c: 1, r: 2 }[hz];
  const x = hz === 'l' ? dx : hz === 'c' ? Math.round(W / 2) : W - dx;
  const y = v === 't' ? dy : v === 'm' ? Math.round(H / 2) : H - dy;
  return { an, x, y };
}
// `{`/`}` delimit ASS override blocks and have no escape form, and a lone
// backslash starts an override tag — strip both so user text cannot rewrite the
// event it sits in. Real newlines become the hard break \N.
function wmAssText(s) {
  return String(s == null ? '' : s)
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/\r?\n/g, '\\N');
}
function buildWatermarkAss(wm, outputW, outputH) {
  const W = Math.max(2, Math.round(outputW) || 1080);
  // Height is needed for PlayResY and for every bottom/middle anchor. Callers
  // pass the probed frame height; the 9:16 fallback only covers a caller that
  // has not been taught to, and matches the app's default portrait canvas.
  const H = Math.max(2, Math.round(outputH) || Math.round(W * 16 / 9));
  const face = wmTextFace(wm.text.font);
  // sizePct is a percentage of the output WIDTH, exactly as drawtext sized it.
  const px = Math.max(10, Math.round(((wm.text.sizePct || 5) / 100) * W));
  // [FS-EM-SCALE] drawtext's fontsize is the em square (same as CSS px); libass
  // sizes by ascender−descender. Without this conversion the watermark burns
  // smaller than the WYSIWYG preview draws it — the same correction captions
  // already apply in buildAss.
  const fsz = Math.max(1, Math.round(px * fontEmScale(face.family, assFontsDirFs(), face.bold, face.italic)));
  const colour = hexToAssColour(wm.text.color, wm.text.opacity);
  const { an, x, y } = wmAssPos(wm, W, H);
  // [WM-LINES] Stacked lines ride in ONE event joined by \N, so \an aligns them
  // to each other the way the preview's text-align does, and the whole block
  // keeps a single anchor. A line not at 100% gets its own \fs, computed from
  // the em size like the style's, not by rescaling the rounded fsz. Without
  // `scales` every line is the style size, which is the pre-lines output.
  const lines = wmModule.textLines(wm.text);
  const body = Array.isArray(wm.text.scales)
    ? lines.map(l => {
        const lfs = Math.max(1, Math.round(px * (l.scale / 100) * fontEmScale(face.family, assFontsDirFs(), face.bold, face.italic)));
        return `{\\fs${lfs}}${wmAssText(l.text)}`;
      }).join('\\N')
    : wmAssText(wm.text.content);
  // Outline and Shadow are 0: drawtext drew bare glyphs and the preview overlay
  // is bare CSS text, so any border here would be a third, unmatched look.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: WM,${face.family},${fsz},${colour},${colour},&H00000000,&H00000000,${face.bold ? -1 : 0},${face.italic ? -1 : 0},0,0,100,100,0,0,1,0,0,${an},0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.99,WM,,0,0,0,,{\\an${an}\\pos(${x},${y})}${body}
`;
}
// [WM-CANVAS] Which frame the watermark is actually composited onto.
//
// It is the frame `baseVf` PRODUCES, not the one it reads. renderClipEdit used
// the probed dimensions of its INPUT, and on the common recut path that input
// is the original master — a 1920x1080 source being cropped down to a 1080x1920
// clip. That sized the watermark off 1920 (1.78x too big; drawtext had the same
// bug, it just positioned itself with ffmpeg's own w/h so only the size showed)
// and, once the text moved to libass, handed it a LANDSCAPE PlayRes to stretch
// onto a portrait frame — the watermark ran off both edges.
//
// Probing the input is correct in exactly one case: no base filter at all, so
// the input IS the final frame (a tracked intermediate, already rendered at
// output size, or the legacy burn-onto-this-file path).
function watermarkCanvas({ baseVf, probed, outW, outH }) {
  if (baseVf) return { w: outW, h: outH };
  return { w: (probed && probed.w) || outW, h: (probed && probed.h) || outH };
}
function buildWatermarkFilter(baseVf, captionSuffix, wm, outputW, ctx, stickers) {
  const flatVf = captionSuffix
    ? (baseVf ? `${baseVf},${captionSuffix}` : captionSuffix)
    : (baseVf || 'null');

  const imgActive = wmModule.isImageActive(wm);
  const txtActive = wmModule.isTextActive(wm);
  const stick = (Array.isArray(stickers) ? stickers : []).filter(s => s && s.file);

  if (!imgActive && !txtActive && !stick.length) {
    if (baseVf && baseVf.includes(';')) {
      const graph = captionSuffix ? `${baseVf};[out]${captionSuffix}[wmFinal]` : baseVf;
      return { extraInputs: [], filterArgs: ['-filter_complex', graph, '-map', captionSuffix ? '[wmFinal]' : '[out]', '-map', '0:a?'], writtenFiles: [] };
    }
    return { extraInputs: [], filterArgs: ['-vf', flatVf], writtenFiles: [] };
  }

  let chains = [];
  if (baseVf && baseVf.includes(';')) {
    chains.push(baseVf);
  } else {
    const b = baseVf && baseVf.trim() ? baseVf : 'null';
    chains.push(`[0:v]${b}[out]`);
  }
  let prevLabel = 'out';
  let extraInputs = [];
  let writtenFiles = [];

  if (imgActive) {
    // [WM-INPUT-GUARD] The watermark image is added as an extra `-i` and read
    // below as [1:v] — correct ONLY while 0:v is the graph's lone video input
    // (the blur base consumes 0:v implicitly; single-input chains never name a
    // higher video pad). If baseVf already consumes [1:v] or higher — e.g. a
    // 2-video split-screen panel — then [1:v] silently names that second video
    // panel instead of the watermark, producing a corrupt composite with no
    // error. This path can't safely reindex the watermark (the caller owns -i
    // ordering), so refuse loudly rather than emit a wrong-stream label.
    const usedVideoInput = /\[[1-9]\d*:v\]/.exec(baseVf || '');
    if (usedVideoInput) {
      throw new Error(
        `buildWatermarkFilter: base graph already consumes video input ` +
        `${usedVideoInput[0]}; the image watermark hardcodes [1:v] and would ` +
        `collide with that video panel. Wire multi-video composites (e.g. ` +
        `split-screen) through their own overlay path, not the watermark path.`);
    }
    const wmPath = wmModule.ffmpegInputPath(wm.image.path);
    let wmW = Math.round((wm.sizePct / 100) * outputW);
    if (wmW % 2) wmW += 1;
    if (wmW < 8) wmW = 8;
    const opacity = wm.opacity.toFixed(4);
    const { x, y } = wmModule.overlayXY(wm);
    extraInputs.push('-i', wmPath);
    let nextLabel = txtActive || stick.length || captionSuffix ? 'wmImg' : 'final';
    chains.push(`[1:v]scale=${wmW}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${opacity}[wmA];[${prevLabel}][wmA]overlay=${x}:${y}:format=auto[${nextLabel}]`);
    prevLabel = nextLabel;
  }

  if (txtActive) {
    // [WM-TEXT-ASS] libass, not drawtext — see buildWatermarkAss above for why.
    // The sidecar is referenced by BASENAME: ffmpeg runs with cwd = sessionDir
    // (both callers), libass resolves `filename` against cwd, and an absolute
    // path would drag a Windows drive-letter colon into an option the subtitles
    // filter splits on ':' — the same contract captionSuffixOnly() relies on.
    const assName = `watermark-${ctx.nameSuffix || Date.now()}.ass`;
    const assPath = path.join(ctx.sessionDir, assName);
    let wrote = false;
    try {
      fs.writeFileSync(assPath, buildWatermarkAss(wm, outputW, ctx.outputH), 'utf8');
      writtenFiles.push(assPath);
      wrote = true;
    } catch { /* handled below */ }
    // A watermark is decoration; it must never be the reason a render dies.
    // The old drawtext path swallowed this same write failure and then emitted
    // a filter pointing at the file it had just failed to write, which failed
    // the whole command anyway. Dropping the layer is the honest recovery.
    if (wrote) {
      let nextLabel = stick.length || captionSuffix ? 'wmTxt' : 'final';
      chains.push(`[${prevLabel}]subtitles=filename='${assName}':fontsdir='${assFontsDir()}'[${nextLabel}]`);
      prevLabel = nextLabel;
    }
  }

  if (captionSuffix) {
    let nextLabel = stick.length ? 'capDone' : 'final';
    chains.push(`[${prevLabel}]${captionSuffix}[${nextLabel}]`);
    prevLabel = nextLabel;
  }

  let graph = chains.join(';');

  if (stick.length) {
    let prev = prevLabel;
    stick.forEach((s, i) => {
      const next = i === stick.length - 1 ? 'final' : `stk${i}`;
      const dur = Math.max(0.01, s.end - s.start);
      const fd = Math.min(0.25, dur / 3);
      graph += `;movie='${drawtextPathArg(s.file)}',loop=loop=-1:size=1,fps=25,scale=${s.size}:-1,format=rgba,fade=t=in:st=${s.start.toFixed(3)}:d=${fd.toFixed(3)}:alpha=1,fade=t=out:st=${(s.end - fd).toFixed(3)}:d=${fd.toFixed(3)}:alpha=1[st${i}]`;
      graph += `;[${prev}][st${i}]overlay=${s.x}:${s.y}:enable='between(t,${s.start},${s.end})'[${next}]`;
      prev = next;
    });
    prevLabel = prev;
  }

  // Every branch above names its LAST pad [final] because it knows it is last.
  // A branch that drops out at runtime (the watermark .ass that could not be
  // written) leaves the chain ending on an earlier label, and `-map '[final]'`
  // would then fail with "Output with label 'final' does not exist" — turning a
  // skipped decoration back into a dead render. Terminate explicitly instead.
  if (prevLabel !== 'final') graph += `;[${prevLabel}]null[final]`;

  return {
    extraInputs,
    filterArgs: ['-filter_complex', graph, '-map', '[final]', '-map', '0:a?'],
    writtenFiles,
  };
}

function piecewiseLerp(kf, boxKey, axisKey) {
  const v = i => (kf[i][boxKey][axisKey] || 0) / 100;
  if (kf.length === 1) return v(0).toFixed(5);
  // t >= last kf -> hold last
  let expr = v(kf.length - 1).toFixed(5);
  for (let i = kf.length - 2; i >= 0; i--) {
    const t1 = kf[i].t, t2 = kf[i + 1].t;
    const v1 = v(i), v2 = v(i + 1);
    if (t1 === t2) {
      expr = `if(lt(t,${t1.toFixed(3)}),${v1.toFixed(5)},${expr})`;
    } else {
      // Lerp formula: v1 + (t - t1)/(t2 - t1) * (v2 - v1)
      const lerp = `${v1.toFixed(5)}+((t-${t1.toFixed(3)})/${(t2 - t1).toFixed(3)})*(${(v2 - v1).toFixed(5)})`;
      expr = `if(lt(t,${t1.toFixed(3)}),${v1.toFixed(5)},if(lt(t,${t2.toFixed(3)}),${lerp},${expr}))`;
    }
  }
  return expr.replace(/,/g, '\\,');
}

// [SPLIT-SANITISE] Nothing upstream validates splitCrop — it can arrive from a
// hand-edited or older report.json, and a bad value used to reach ffmpeg as raw
// text. `w:0` gave "Invalid too big or non positive size", a missing field gave
// the literal "(undefined / 100)", and an out-of-bounds x was silently clamped
// by crop itself (a 256px framing shift the studio never showed). Clamp here so
// a corrupt config degrades to a sane crop instead of opaque ffmpeg noise.
function sanitiseSplitRect(r) {
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const w = Math.min(100, Math.max(1, num(r && r.w, 100)));
  const h = Math.min(100, Math.max(1, num(r && r.h, 100)));
  return {
    w, h,
    x: Math.min(100 - w, Math.max(0, num(r && r.x, 0))),
    y: Math.min(100 - h, Math.max(0, num(r && r.y, 0))),
  };
}

function vfForSplitScreen(splitCrop, resolution, hasFile2) {
  const short = resUnit(resolution);
  const long = Math.round(short * 16 / 9);

  // scale=W:0 does NOT error — ffmpeg reads 0 as "keep the input size" — so an
  // out-of-range splitY used to render a silently wrong layout. Bound it to the
  // slider's own range and keep both panes at a real height.
  const rawSplitY = Number.isFinite(+splitCrop.splitY) ? +splitCrop.splitY : 50;
  const splitY = Math.min(95, Math.max(5, rawSplitY));
  const faceTop = splitCrop.faceTop ?? true;

  let topH = Math.round(long * (splitY / 100));
  if (topH % 2 !== 0) topH += 1;
  topH = Math.min(long - 2, Math.max(2, topH));
  const botH = long - topH;

  const faceH = faceTop ? topH : botH;
  const gameH = faceTop ? botH : topH;
  const faceY = faceTop ? 0 : topH;
  const gameY = faceTop ? topH : 0;

  const kf = splitCrop.kf && splitCrop.kf.length > 0 ? splitCrop.kf : null;
  const f = sanitiseSplitRect(splitCrop.faceRect);
  const g = sanitiseSplitRect(splitCrop.gameRect);

  let cxFace, cyFace, cwFace, chFace;
  let cxGame, cyGame, cwGame, chGame;

  if (kf) {
    // [SPLIT-KF-SIZE] crop evaluates w/h exactly ONCE, at config time, where t
    // is NAN — only x/y are re-evaluated per frame (crop has no `eval` option).
    // Feeding a t-dependent expression into w/h therefore did not animate the
    // zoom; every lt(NAN,·) is false, so piecewiseLerp fell through to its
    // hold-last branch and the whole clip rendered at the FINAL keyframe's
    // size. Take the size from the first keyframe and animate position only, so
    // the burn matches what the canvas preview draws. Animated zoom needs
    // zoompan, not crop — see [SPLIT-KF-SIZE] in the caption editor notes.
    const k0f = sanitiseSplitRect(kf[0].face);
    const k0g = sanitiseSplitRect(kf[0].game);
    cxFace = `(${piecewiseLerp(kf, 'face', 'x')}) * in_w`;
    cyFace = `(${piecewiseLerp(kf, 'face', 'y')}) * in_h`;
    cwFace = `(${k0f.w} / 100) * in_w`;
    chFace = `(${k0f.h} / 100) * in_h`;

    cxGame = `(${piecewiseLerp(kf, 'game', 'x')}) * in_w`;
    cyGame = `(${piecewiseLerp(kf, 'game', 'y')}) * in_h`;
    cwGame = `(${k0g.w} / 100) * in_w`;
    chGame = `(${k0g.h} / 100) * in_h`;
  } else {
    cxFace = `(${f.x} / 100) * in_w`;
    cyFace = `(${f.y} / 100) * in_h`;
    cwFace = `(${f.w} / 100) * in_w`;
    chFace = `(${f.h} / 100) * in_h`;

    cxGame = `(${g.x} / 100) * in_w`;
    cyGame = `(${g.y} / 100) * in_h`;
    cwGame = `(${g.w} / 100) * in_w`;
    chGame = `(${g.h} / 100) * in_h`;
  }

  const vFace = hasFile2 ? '[0:v]' : '[inFace]';
  const vGame = hasFile2 ? '[1:v]' : '[inGame]';
  const splitInput = hasFile2 ? '' : '[0:v]split=2[inFace][inGame];';

  // [SPLIT-BOUND] The canvas used to be `color=c=black` — an INFINITE source,
  // and it was overlay's main input, so it owned the output timeline. Two
  // consequences, both measured: in legacy mode (no output -t, no watchdog) the
  // render never terminated and filled the disk; and color's default rate of 25
  // pinned every output to 25fps, silently decimating 60fps gameplay capture.
  // Building the canvas with pad on the face pane instead lets the real video
  // drive both duration and frame rate. `shortest=1` bounds the graph when
  // source 2 is an infinitely looped input.
  return `${splitInput}` +
    `${vFace}crop=${cwFace}:${chFace}:${cxFace}:${cyFace},scale=${short}:${faceH}:flags=lanczos,setsar=1[face];` +
    `${vGame}crop=${cwGame}:${chGame}:${cxGame}:${cyGame},scale=${short}:${gameH}:flags=lanczos,setsar=1[game];` +
    `[face]pad=${short}:${long}:0:${faceY}:color=black[bgFace];` +
    `[bgFace][game]overlay=x=0:y=${gameY}:shortest=1[out]`;
}

// [SPLIT-MUTE] Which audio a split-screen render keeps, as a pure decision so
// it can be tested without spawning ffmpeg (applyClipCrop cannot be).
//
// Split Screen composes two DIFFERENT sources and both may carry sound. The
// original rule was only "mix whatever has audio", with source 2 ducked to
// 0.35 — no way to say "keep this voice, drop that one". Reported live on a
// facecam + gameplay split: both tracks played at once, so the burned captions
// no longer tracked a single speaker.
//
// `mute1`/`mute2` are the user's explicit choice and are absolute — a muted
// source is never revived because the other one turned out to be silent. Both
// muted is a legitimate request for a silent clip, not an error to correct.
// Missing flags mean "not muted", so splitCrop objects saved before this
// feature render exactly as they did.
function splitAudioArgs({ hasFile2, hasAudio1, hasAudio2, mute1 = false, mute2 = false }) {
  const maps = ['-map', '[out]'];
  if (!hasFile2) {
    // One source: `0:a?` (optional) because a clip with no audio track must
    // still render rather than fail the map.
    if (!mute1) maps.push('-map', '0:a?');
    return { graph: null, maps };
  }
  const use1 = !!hasAudio1 && !mute1;
  const use2 = !!hasAudio2 && !mute2;
  if (use1 && use2) {
    // amix defaults to normalize=1, which scales every input by 1/n — the
    // talking head lost exactly 6 dB the moment a background was added
    // (measured -21.1 dB -> -27.1 dB). Keep source 1 at full level and duck
    // the background instead. See [SPLIT-AUDIO] in split-screen-render.test.js.
    maps.push('-map', '[aout]');
    return {
      graph: ';[1:a]volume=0.35[bgA];[0:a][bgA]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]',
      maps,
    };
  }
  // One survivor: map it straight through. Running it through amix anyway
  // would still resample and re-time it for no benefit.
  if (use1) maps.push('-map', '0:a');
  else if (use2) maps.push('-map', '1:a');
  return { graph: null, maps };
}

// cropX / cropY: 0–100 percent of available slack. Default 50 (center).
// cropKF: optional [{t,x,y}] (x,y 0..100) for animated pan across the clip.
function vfFor(format, resolution, cropX, cropY, cropKF, cropScale, cropAspect, cropRect) {
  // Freeform manual crop: output dimensions follow the dragged rectangle's
  // aspect, scaled so the long edge matches the chosen resolution tier. H.264
  // requires even dimensions. The rect fractions are over the displayed (already
  // correct-aspect) source, so the visual aspect = rect.w : rect.h directly.
  if (cropAspect === 'free' && cropRect && cropRect.w > 0 && cropRect.h > 0) {
    // Long edge of the resolution tier acts as a CEILING — we never upscale a
    // small crop to it. ffmpeg's `force_original_aspect_ratio=decrease` shrinks
    // the output box to fit, and `min(iw/ih, long)` keeps native pixels when
    // the crop is already smaller than the ceiling (no blur from forced
    // upscaling). Final `crop=trunc/2*2` ensures even dims for H.264.
    const long = Math.round(resUnit(resolution) * 16 / 9);
    // [FREE-KF-WH] Detect per-keyframe rect size: if EVERY keyframe carries
    // finite w/h, animate the crop dimensions too. Otherwise fall back to a
    // static cropRect.w/h (legacy behavior).
    const kfHasWH = Array.isArray(cropKF) && cropKF.length >= 2
      && cropKF.every(k => Number.isFinite(k.w) && Number.isFinite(k.h));
    const w = cropRect.w.toFixed(5);
    const h = cropRect.h.toFixed(5);
    const esc = s => s.replace(/,/g, '\\,');
    // Fixed output canvas — the video encoder requires a constant output size
    // even when the crop is animated. Use the FIRST keyframe's rect (if any)
    // scaled to the resolution tier, otherwise fall back to cropRect. Later
    // keyframes with a different aspect get letterboxed via pad below.
    let refW, refH;
    if (kfHasWH) {
      const sorted = [...cropKF].sort((a, b) => a.t - b.t);
      refW = sorted[0].w / 100;   // kf w/h come in as 0..100 percent
      refH = sorted[0].h / 100;
    } else {
      refW = cropRect.w;
      refH = cropRect.h;
    }
    // Fit the target canvas so its long edge ≤ long; keep native aspect.
    let targetW, targetH;
    const arRef = refW / refH;
    if (arRef >= 1) { targetW = long; targetH = Math.round(long / arRef); }
    else            { targetH = long; targetW = Math.round(long * arRef); }
    if (targetW % 2) targetW += 1;
    if (targetH % 2) targetH += 1;

    let xExpr, yExpr, wExpr, hExpr;
    if (Array.isArray(cropKF) && cropKF.length >= 2) {
      const sorted = [...cropKF].sort((a, b) => a.t - b.t);
      // [FREE-KF] Position tracks kf x/y (slack fractions 0..1 via
      // piecewiseFrac which converts from the incoming 0..100 percent).
      // Slack range depends on the CURRENT crop dims — if we're also
      // animating w/h, the slack range animates too.
      if (kfHasWH) {
        const wFrac = piecewiseFrac(sorted, 'w');   // 0..1
        const hFrac = piecewiseFrac(sorted, 'h');
        wExpr = esc(`iw*(${wFrac})`);
        hExpr = esc(`ih*(${hFrac})`);
        xExpr = esc(`(iw-iw*(${wFrac}))*(${piecewiseFrac(sorted, 'x')})`);
        yExpr = esc(`(ih-ih*(${hFrac}))*(${piecewiseFrac(sorted, 'y')})`);
      } else {
        wExpr = `iw*${w}`;
        hExpr = `ih*${h}`;
        xExpr = esc(`(iw*(1-${w}))*(${piecewiseFrac(sorted, 'x')})`);
        yExpr = esc(`(ih*(1-${h}))*(${piecewiseFrac(sorted, 'y')})`);
      }
    } else {
      const x = Math.max(0, Math.min(1 - cropRect.w, cropRect.x)).toFixed(5);
      const y = Math.max(0, Math.min(1 - cropRect.h, cropRect.y)).toFixed(5);
      wExpr = `iw*${w}`;
      hExpr = `ih*${h}`;
      xExpr = `iw*${x}`;
      yExpr = `ih*${y}`;
    }
    // Chain:
    //   crop=W(t):H(t):X(t):Y(t)     ← time-varying, per current kf
    //   scale to fit target canvas    ← letterbox on aspect mismatch
    //   pad up to constant target dims ← encoder needs constant output size
    //   final crop trunc/2*2           ← even H.264 dims safety net
    //
    // Scale semantics differ per mode:
    //   - Animated w/h (zoom effect): force UPSCALE so small crops fill the
    //     canvas — that's the whole point of a zoom-in keyframe.
    //   - Static rect (no kf animation): DON'T upscale — small crops stay
    //     small, letterboxed. Preserves the legacy "no blur from forced
    //     upscaling" contract from before this change.
    const scaleExpr = kfHasWH
      ? `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`
      : `scale='min(iw\\,${targetW})':'min(ih\\,${targetH})':force_original_aspect_ratio=decrease`;
    return `crop=${wExpr}:${hExpr}:${xExpr}:${yExpr},`
      + `${scaleExpr},`
      + `pad=${targetW}:${targetH}:(${targetW}-iw)/2:(${targetH}-ih)/2:color=black,`
      + `crop='trunc(iw/2)*2':'trunc(ih/2)*2',setsar=1`;
  }
  // Dimensions scale with the chosen resolution. Long side = 16/9 of the short
  // side, rounded to an even number (yuv420p / libx264 require even W&H).
  const even = n => { n = Math.round(n); return n % 2 ? n + 1 : n; };
  const u = resUnit(resolution);
  const long = even(u * 16 / 9);
  const tallW = u,    tallH = long;   // 9:16 portrait
  const sqW   = u,    sqH   = u;      // 1:1 square
  const wideW = long, wideH = u;      // 16:9 landscape
  const cx = cropX != null ? Math.max(0, Math.min(100, cropX)) : 50;
  const cy = cropY != null ? Math.max(0, Math.min(100, cropY)) : 50;
  const esc = s => s.replace(/,/g, '\\,');
  // cropScale (0.3..1): manual zoom for the 9:16 face crop. 1 = full-height
  // window (default). <1 = a SMALLER window cropped from the frame then scaled
  // back up to the output size — lets the user zoom past watermarks / black
  // bars / stickers on the source edges. cw/ch are the cropped-window size.
  const sc = (cropScale != null && cropScale > 0) ? Math.max(0.3, Math.min(1, cropScale)) : 1;
  const cw = even(tallW * sc), ch = even(tallH * sc);
  let cropXexpr, cropYexpr;
  if (Array.isArray(cropKF) && cropKF.length >= 2) {
    const sorted = [...cropKF].sort((a, b) => a.t - b.t);
    cropXexpr = esc(`(in_w-${cw})*(${piecewiseFrac(sorted, 'x')})`);
    cropYexpr = esc(`(in_h-${ch})*(${piecewiseFrac(sorted, 'y')})`);
  } else {
    cropXexpr = `floor((in_w-${cw})*${(cx / 100).toFixed(4)})`;
    cropYexpr = `floor((in_h-${ch})*${(cy / 100).toFixed(4)})`;
  }
  // When zoomed (sc<1) the cropped window is upscaled back to tallW×tallH.
  const zoomTail = sc < 1 ? `,scale=${tallW}:${tallH}` : '';
  switch (format) {
    case 'square':    return `scale=${sqW}:${sqH}:force_original_aspect_ratio=increase,crop=${sqW}:${sqH},setsar=1`;
    // [FMT-WIDE] 'wide' is an alias for 'landscape' (see outputWidthPx). Fall
    // through so the 16:9 crop matches the 1920×1080 canvas + PlayRes those
    // functions report; without it 'wide' fell to the portrait face default.
    case 'wide':
    case 'landscape': return `scale=${wideW}:${wideH}:force_original_aspect_ratio=increase,crop=${wideW}:${wideH},setsar=1`;
    // [BLUR-OUT-LABEL] This is the only case here that emits a multi-branch
    // filter graph (split[bg][fg];…) instead of a single linear chain — every
    // caller that composites a watermark/caption layer on top
    // (buildWatermarkFilter above) checks baseVf.includes(';') to decide
    // whether it can just comma-append more filters (linear chains) or must
    // switch to -filter_complex and -map a named output pad. It always maps
    // '[out]' for that case, matching vfForSplitScreen's convention (ends in
    // …[out]) — but this graph ended in a bare `setsar=1` with NO terminal
    // label, so `-map '[out]'` failed with "Output with label 'out' does not
    // exist". Reported live: Blur Fit rendered fine as the initial cut (a
    // PLAIN `-vf` value — ffmpeg's simple filtergraph auto-connects a
    // nameless dangling output, so the missing label never mattered there),
    // then broke the moment Caption Editor tried to composite captions/
    // watermark/stickers on top of it via buildWatermarkFilter's
    // -filter_complex path. Verified: -vf still accepts this same string
    // with the added label (harmless no-op for the simple-filtergraph path),
    // and -filter_complex + -map '[out]' now resolves correctly.
    case 'blur':      return `split[bg][fg];[bg]scale=${tallW}:${tallH}:force_original_aspect_ratio=increase,crop=${tallW}:${tallH},gblur=sigma=40[bgb];[fg]scale=${tallW}:${tallH}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[out]`;
    case 'face':
    default:          return `scale=${tallW}:${tallH}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:${cropXexpr}:${cropYexpr}${zoomTail},setsar=1`;
  }
}

// ─── Subtitle ASS style ──────────────────────────────────
// IDs kept stable for backwards-compatible config; colors retuned to brand spectrum.
//   neon_green → brand lime    #f1ff00   (BGR &H0000FFF1)
//   neon_pink  → brand pink    #ff4d6a   (BGR &H006A4DFF)
//   yellow     → brand orange  #ff9540   (BGR &H004095FF)
//   bw         → brand ivory   #f6f6ef   (BGR &H00EFF6F6)
// Each style carries `primary` (text fill) and `glow` (the blurred halo colour
// rendered behind the text). Glow defaults to the text colour for a neon look.
// [WYSIWYG-FONT] Styles WITHOUT a `font` used to fall back to 'Arial Black',
// which is NOT bundled in assets/fonts — libass silently substituted Helvetica
// (different widths + loose tracking), breaking preview↔burn parity. Every
// style now names a BUNDLED face; neon styles use Open Sauce Two ExtraBold
// (heavy sans, closest bundled match) with bold:0 so libass renders the raw
// face exactly like the CSS preview (no synthetic emboldening on either side).
// [WYSIWYG-SPACING] `trackEm` = letter-spacing as a fraction of font size
// (mirrors the CSS em values in styles.css/applyCE). The old constant-px
// `spacing` field drifted as font size changed; em-based stays proportional.
// [TRACK-UNIFORM] Single tracking value shared by every caption style AND every
// burn font (see fontTrackEm below for the full rationale and the burn-proof
// measurements). Declared here because SUB_STYLES below references it — a
// `const` further down the file would be in the temporal dead zone at module
// load and throw before the app ever starts.
// -0.07, not the old -0.08: with [FS-EM-SCALE-WIN] restoring the real glyph size
// the letters no longer needed to be pulled that tight. MUST stay equal to
// TRACK_EM_CSS in renderer.js or the preview drifts from the burn again.
const TRACK_EM = -0.07;

// [BOX-HIGHLIGHT] Memecah satu cue menjadi satu baris Dialogue per kata.
//
// Baris ke-i menampilkan teks cue PENUH dengan kotak hanya di kata ke-i. Teks
// sengaja tidak dipotong: memotongnya akan mengubah lebar baris, dan libass
// memusatkan baris — jadi setiap kata akan melompat posisinya tiap kali kata
// aktif berganti.
//
// Fungsi ini MURNI (tidak menyentuh ASS string) supaya bisa diuji tanpa font,
// tanpa ffmpeg, dan tanpa Electron.
function boxCueLines({ words, boxColor }) {
  if (!Array.isArray(words) || !words.length) return [];
  const ink = contrastInk(boxColor);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // Kata tanpa timing tidak bisa jadi baris: durasinya nol atau NaN, dan
    // libass akan menampilkannya selamanya atau tidak sama sekali.
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    if (w.end <= w.start) continue;
    out.push({ start: w.start, end: w.end, activeIndex: i, words, ink, boxColor });
  }
  return out;
}

// [BOX-DRAW] Rectangle `\p1`, digambar dari (0,0) — pojok kiri-atas — bukan
// simetris di sekitar titik pusat.
//
// [BOX-ANCHOR-BUG] Live-tested 14 Agu 2026 dengan ffmpeg/libass bundled:
// rectangle simetris (`m -w/2 -h/2 l w/2 -h/2 ...`) dipasangkan dengan
// `\an5\pos(x,y)` TIDAK dipusatkan tepat di (x,y) seperti seharusnya —
// pusat kotak yang benar-benar terbakar meleset PERSIS setengah lebar dan
// setengah tinggi kotak itu sendiri ke arah kiri-atas (dibuktikan dengan
// probe terisolasi: kotak 200×100 di pos(540,960) terbakar berpusat di
// (439.5,909.5), bukan (540,960) — offset (-100,-50) = -halfW,-halfH persis).
// libass tidak memusatkan `\an5` untuk drawing `\p1` seperti untuk teks.
//
// Fix: gambar path dalam koordinat POSITIF saja (0,0 sampai w,h — pojok
// kiri-atas di origin, konvensi standar untuk `\p1`), pasangkan dengan
// `\an7` (top-left, bukan \an5), lalu pemanggil menggeser `\pos` sendiri
// sebesar (-w/2,-h/2) supaya kotak tetap TERLIHAT terpusat di titik target.
// Diverifikasi dengan probe yang sama: hasil (539.5,959.5) vs target
// (540,960) — meleset 0.5px (pembulatan antialiasing, bukan bug).
//
// Sudut membulat TIDAK digambar di sini: rectangle ini dipasangkan dengan
// `\bord` berwarna sama, dan libass menggambar border dengan sambungan
// membulat — radius sudut = tebal border. Menggambar bezier manual akan
// menambah matematika yang bisa salah tanpa menambah hasil visual.
//
// [BORDER-INFLATES-SIZE] `\bord` digambar MELEBAR KE LUAR dari tepi path,
// bukan menimpa tepinya — diukur langsung (15 Agu 2026): path 179×92 dengan
// bord=15 (RADIUS_EM=0.20 pada fontSize 75) terbakar jadi ±208×121, tumbuh
// persis 2×bord di tiap sumbu (bord menambah di kedua sisi). CSS
// border-radius di sisi preview TIDAK punya efek ini sama sekali — jadi
// tanpa kompensasi, menaikkan RADIUS_EM diam-diam membuat box burn lebih
// besar dari box preview, padahal keduanya sudah membaca PAD_EM/VPAD_EM
// yang sama. Path di sini di-KECILKAN sebesar 2×bordPx dulu supaya ukuran
// AKHIR yang benar-benar terlihat (path + border) tetap sama dengan
// wEm/hEm yang dimaksud pemanggil — bukan wEm/hEm + bord.
//
// [BORDER-SHIFTS-ORIGIN] Laporan langsung (15 Agu 2026, screenshot "dibeli":
// padding kiri 23px, kanan ~1px — pengukuran render 1080p nyata, BUKAN
// tebakan): versi SEBELUMNYA mengecilkan path dengan menarik HANYA tepi
// kanan-bawah ke dalam (`m 0 0 l w h ...` dengan w/h sudah dikurangi 2×bord,
// tapi titik AWAL tetap di (0,0)) — total lebar path memang benar, tapi
// \bord menumbuhkan path itu SIMETRIS ke SEMUA arah dari tepinya sendiri,
// jadi kotak yang benar-benar terlihat bergeser bordPx ke KIRI-ATAS relatif
// terhadap \pos yang dimaksud (bukti aljabar: tepi kiri akhir = 0−bordPx,
// tepi kanan akhir = (targetW−2bordPx)+bordPx = targetW−bordPx — total
// lebar tetap benar, tapi TITIK AWALNYA meleset −bordPx, bukan 0). Kata
// aktif yang dipasang di `\pos` yang SAMA (tidak lewat fungsi ini, jadi
// tidak ikut bergeser) jadi terlihat ketarik ke kanan relatif terhadap
// kotak — padding kiri "kelebihan", padding kanan nyaris nol/negatif
// (huruf terakhir sampai terpotong tepi kotak). Fix: path digambar mulai
// dari (bordPx, bordPx) — SIMETRIS pada KEDUA sisi — supaya sesudah \bord
// menumbuhkannya, tepi kiri-atas yang benar-benar terlihat kembali PERSIS
// di \pos, bukan bergeser.
//
// Koordinat dibulatkan: ASS drawing memakai bilangan bulat kecuali diberi
// skala, dan presisi sub-piksel di sini tidak terlihat.
function boxDrawing({ wEm, hEm, emPx, bordPx = 0 }) {
  const targetW = Math.round((Number(wEm) || 0) * (Number(emPx) || 0));
  const targetH = Math.round((Number(hEm) || 0) * (Number(emPx) || 0));
  const bord = Math.max(0, Number(bordPx) || 0);
  // Jangan sampai negatif untuk kata sangat pendek dengan radius besar —
  // path minimal 1×1 lebih baik daripada koordinat terbalik yang merusak
  // parser drawing ASS.
  const w = Math.max(1, targetW - bord * 2);
  const h = Math.max(1, targetH - bord * 2);
  const x0 = bord, y0 = bord, x1 = bord + w, y1 = bord + h;
  return `m ${x0} ${y0} l ${x1} ${y0} ${x1} ${y1} ${x0} ${y1}`;
}

// [BOX-DRAW-ANCHOR] Titik \pos untuk sebuah drawing \an5 dari boxDrawing.
// boxDrawing menggeser path-nya ke dalam sebesar `bord` supaya stroke mendarat
// DI DALAM rect target — tapi libass menempatkan drawing dari TITIK ASAL (0,0),
// bukan dari kotak-batas path-nya. Inset itu karena itu ikut menggeser seluruh
// bentuk sejauh +bord pada kedua sumbu.
//
// Diukur pada render sungguhan (Anton \fs116, bord 13): kotak mendarat 12,5px
// ke kanan dan ke bawah dari \pos-nya. Varian \bord0 pada .ass yang SAMA
// membuktikan stroke-nya simetris dan bukan penyebabnya — pusatnya tidak
// bergeser sama sekali, hanya ukurannya yang mengecil sebesar 2xbord. Menggeser
// \pos sebesar (-bord,-bord) memindahkan ketimpangan vertikal dari -20px ke
// -7px, yaitu tepat 13px.
// [HOOK-BACKDROP] Panel geometry for a title backdrop, in ASS pixels. Pure:
// takes the per-word rects titleBoxRects returned (every word "boxed") and
// the title's backdrop fields. Returns { color, parts:[{x,y,draw,alpha,bord}] }
// or null. Shared numbers live in BACKDROP so the preview can mirror them.
const BACKDROP = Object.freeze({
  cardPadXEm: 0.30, cardPadYEm: 0.22, cardRadiusEm: 0.24,
  gradLeadEm: 1.6,      // how far above the block the band starts fading in
  gradSteps: 24,
});
function backdropGeometry(T, rects, fs, PR) {
  if (!Array.isArray(rects) || !rects.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const q of rects) {
    l = Math.min(l, q.boxLeftPx); t = Math.min(t, q.boxTopPx);
    r = Math.max(r, q.boxLeftPx + q.wPx); b = Math.max(b, q.boxTopPx + q.hPx);
  }
  if (!Number.isFinite(l)) return null;
  const op = Math.max(0, Math.min(1, T.backdropOpacity != null ? +T.backdropOpacity : (T.backdrop === 'gradient' ? 0.78 : 1)));
  const alphaOf = (o) => '&H' + Math.round((1 - o) * 255).toString(16).toUpperCase().padStart(2, '0') + '&';
  const fallback = T.backdrop === 'gradient' ? '#000000' : '#FFFFFF';
  // Colour without alpha (&HBBGGRR&) — opacity rides on \1a/\3a per part.
  const hex = /^#[0-9a-fA-F]{6}$/.test(String(T.backdropColor || '')) ? T.backdropColor : fallback;
  const color = '&H' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3) + '&';
  if (T.backdrop === 'card') {
    const padX = Math.round(fs * BACKDROP.cardPadXEm), padY = Math.round(fs * BACKDROP.cardPadYEm);
    const left = Math.round(l - padX), top = Math.round(t - padY);
    const w = Math.round(r - l + 2 * padX), h = Math.round(b - t + 2 * padY);
    const rad = Math.max(0, Math.round(fs * BACKDROP.cardRadiusEm));
    // Rounded corners the same way the box highlight gets them: the path is
    // inset by the border width and a same-coloured \bord rounds it out.
    const draw = `m ${rad} ${rad} l ${w - rad} ${rad} ${w - rad} ${h - rad} ${rad} ${h - rad}`;
    return { color, rect: { left, top, w, h }, parts: [{ x: left, y: top, draw, alpha: alphaOf(op), bord: rad }] };
  }
  // gradient: transparent at (top - lead) → full opacity at the block top,
  // then solid to the bottom of the frame.
  const lead = Math.round(fs * BACKDROP.gradLeadEm);
  const top0 = Math.max(0, Math.round(t - lead));
  const solidTop = Math.max(top0, Math.round(t));
  const parts = [];
  const n = BACKDROP.gradSteps;
  const stepH = Math.max(1, (solidTop - top0) / n);
  for (let k = 0; k < n && solidTop > top0; k++) {
    const y0 = Math.round(top0 + k * stepH), y1 = Math.round(top0 + (k + 1) * stepH);
    if (y1 <= y0) continue;
    parts.push({ x: 0, y: y0, draw: `m 0 0 l ${PR.w} 0 ${PR.w} ${y1 - y0} 0 ${y1 - y0}`, alpha: alphaOf(op * (k + 0.5) / n), bord: 0 });
  }
  parts.push({ x: 0, y: solidTop, draw: `m 0 0 l ${PR.w} 0 ${PR.w} ${PR.h - solidTop} 0 ${PR.h - solidTop}`, alpha: alphaOf(op), bord: 0 });
  return { color, rect: { left: 0, top: top0, w: PR.w, h: PR.h - top0 }, parts };
}

function boxDrawAnchor({ leftPx, topPx, wPx, hPx, bordPx = 0 }) {
  const b = Math.max(0, Number(bordPx) || 0);
  return {
    x: Math.round(leftPx + wPx / 2) - b,
    y: Math.round(topPx + hPx / 2) - b,
  };
}

// [BOX-TRACKING] Layout horizontal per-kata DENGAN tracking (\fsp), dalam px.
//
// stampBaseFsp (lihat [FSP-NEGATIVE] di akhir buildAss) menyuntik \fsp ke
// SETIAP baris Dialogue — termasuk baris teks boxed — jadi teks yang
// benar-benar dirender libass lebih rapat daripada jumlah advance width
// mentah SELAMA masih di DALAM satu kata. Geometri box yang menjumlahkan
// advance saja (versi pertama) kelebaran |fsp| px per huruf dan posisinya
// melenceng makin jauh ke kanan pada cue panjang — terlihat sebagai box
// yang menimpa kata-kata tetangganya ("nyatanya? [tertawa] itu,").
//
// [BOX-GAP-TRACKED] libass menambahkan \fsp SETELAH SETIAP glyph — huruf
// terakhir kata DAN spasinya juga — persis seperti letter-spacing CSS di
// pratinjau. Jadi dari awal kata i ke awal kata i+1 jaraknya
//   advance_i + len_i×fsp + spasi + fsp
// dan celah ANTAR kata (tepi kanan visual → kata berikut) = spasi + 2×fsp.
//
// Versi sebelumnya ([BOX-GAP-NO-TRACKING], 5c80ffe, 15 Agu 2026) memakai
// celah = spasi polos, berdasar ukuran "bisa"→"dibeli" = 14px yang lebih
// dekat ke 15.5 (spasi polos) daripada 7.54 (spasi + 2×fsp). Tapi 14px itu
// celah TINTA, sedangkan kedua prediksi adalah celah ADVANCE: side bearing
// kanan "a" + kiri "d" (~6px) belum ditambahkan — 7.54 + ~6 ≈ 14 justru
// cocok dengan rumus 2×fsp. Diukur ulang 6 Okt 2026 (white_clean 70px,
// fsp −5, PAD 0.15em = 10.5px, "orang nilai kamu", box di "nilai"):
//
//   celah tinta        tanpa box   pratinjau box   burn box (rumus lama)
//   orang → nilai          18        29 (+11)          40 (+22)
//   nilai → kamu           17        29 (+12)          37 (+20)
//
// Pratinjau menambah tepat 1×PAD per sisi; burn lama menambah PAD + 2×|fsp|
// — setiap celah di sekitar box ~10px lebih lebar dari editor, dan dalam
// satu run beberapa kata (yang dialirkan libass sendiri) celahnya tetap
// sempit, jadi jarak antar kata tidak rata.
//
//   lefts[i]  = Σ_{j<i} (advance_j + len_j×fsp + spasi + fsp)
//   widths[i] = advance_i + (len_i − 1) × fsp   — tepi visual kata (box)
//   totalW    = lefts[n−1] + advance_{n−1} + len_{n−1}×fsp — lebar alir
//               baris, sama dengan yang dipakai libass/CSS untuk memusatkan
//               baris yang sama tanpa box
//
// Murni & terpisah supaya bisa diuji tanpa font/ffmpeg.
function boxWordLayoutPx({ advPx, lens, spacePx, fspPx = 0 }) {
  const lefts = [], widths = [];
  let cursor = 0;
  for (let i = 0; i < advPx.length; i++) {
    const len = Math.max(0, lens[i] || 0);
    lefts.push(cursor);
    widths.push(advPx[i] + Math.max(0, len - 1) * fspPx);
    cursor += advPx[i] + len * fspPx + spacePx + fspPx;
  }
  const n = advPx.length;
  const totalW = n ? lefts[n - 1] + advPx[n - 1] + Math.max(0, lens[n - 1] || 0) * fspPx : 0;
  return { lefts, widths, totalW };
}

const SUB_STYLES = {
  neon_green: { primary: '&H0000FFF1', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H0000FFF1', font: 'Open Sauce Two ExtraBold' },
  neon_pink:  { primary: '&H006A4DFF', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H006A4DFF', font: 'Open Sauce Two ExtraBold' },
  yellow:     { primary: '&H004095FF', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H004095FF', font: 'Open Sauce Two ExtraBold' },
  // Default white caption: Times New Roman Condensed, pure white for max
  // contrast against any background, bold weight + crisp black halo for punch.
  bw:         { primary: '&H00FFFFFF', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 1, glow: '&H00000000', font: 'Times New Roman MT Condensed', trackEm: TRACK_EM },
  bw_neon_green:  { primary: '&H00EFF6F6', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', highlight: '&H0000FFF1', font: 'Open Sauce Two ExtraBold' },
  bw_neon_yellow: { primary: '&H00EFF6F6', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', highlight: '&H004095FF', font: 'Open Sauce Two ExtraBold' },
  // [HL-PALETTE] More accents for the same "tint the last word of each cue"
  // engine. The two ids above are kept as-is even though they are misnamed
  // (bw_neon_green burns #F1FF00, bw_neon_yellow burns #FF9540) — those ids are
  // persisted in saved projects, so renaming them needs a migration and buys
  // this feature nothing.
  bw_hi_lime:     { primary: '&H00EFF6F6', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', highlight: '&H006FF9D2', font: 'Open Sauce Two ExtraBold' },
  bw_hi_red:      { primary: '&H00EFF6F6', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', highlight: '&H00303BFF', font: 'Open Sauce Two ExtraBold' },
  // The only accent that also changes the BASE text. Pure white on the
  // near-white #F6F6EF base above is invisible; dropping the base to mid-grey is
  // what makes "white pop" read at all.
  bw_hi_white:    { primary: '&H009A9A9A', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', highlight: '&H00FFFFFF', font: 'Open Sauce Two ExtraBold' },
  // Rotates per cue, by cue INDEX rather than at random: a random accent would
  // make every export of one clip differ from the last, and would make the
  // preview unable to predict what the burn is about to do.
  bw_hi_rainbow:  { primary: '&H00EFF6F6', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', font: 'Open Sauce Two ExtraBold',
                    highlightCycle: ['&H006FF9D2', '&H00303BFF', '&H0000FFF1', '&H004095FF'] },
  // Base text TRUE white (&HFFFFFF, not the near-white #F6F6EF the bw_hi_*
  // family uses) — every non-highlighted word is plain white, no halo. Last
  // word gets the "limegreen" accent (CSS `limegreen` #32CD32) via the same
  // hiC mechanism as the rest of this family: the highlighted word ALWAYS
  // carries its own glow (gcol = hiC in the emit path below) regardless of
  // this style's own `glow` field, so leaving `glow` at 0 keeps the base words
  // flat while the accent still blooms. Distinct id from bw_hi_lime, which is
  // a paler mint (#D2F96F, keyed 'lime') and dims its base — this one keeps
  // full white and a punchier, more saturated green (keyed 'limegreen').
  white_hi_lime:  { primary: '&H00FFFFFF', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 0, glow: '&H00000000', highlight: '&H0032CD32', font: 'Open Sauce Two ExtraBold' },
  // Cinematic serif: Times New Roman, pure white, soft white halo, slightly condensed.
  // Soft outer glow (medium-large radius, dreamy blur) + a very subtle dark
  // drop-shadow underneath for readability. No stroke, no background, no scale
  // animation — only a soft fade-in. High-contrast luxury cinematic look.
  // Pure cinematic: white serif (natural weight), condensed, tight spacing, soft
  // outer glow only. No drop shadow, no synthetic bold (was making letters look
  // chunky + amplified the halo). softFade forces single-halo per cue (no
  // typewriter per-word reveal that stacks glows brighter than expected).
  cinematic_white: { primary: '&H00FFFFFF', secondary: '&H00000000', outline: '&H00FFFFFF', back: '&H00000000', bold: 1, glow: '&H00FFFFFF', font: 'Times New Roman MT Condensed', scaleX: 100, trackEm: TRACK_EM, glowMul: 0.30, glowAlpha: '&HA0&', noEdge: true, softFade: true },
  // [INVERSE-V1] start — auto-inverting caption style.
  // Rendered as PURE WHITE onto a black canvas by libass; the difference blend
  // in renderClipEdit then XORs it against the underlying video, so wherever
  // the text sits the pixels get colour-inverted (white on dark, black on
  // bright — automatic). No outline, no glow, no shadow — those would tint
  // the mask and break the clean inversion. Font: Open Sauce Two Bold
  // (Open Sans-adjacent humanist sans already bundled in app/assets/fonts).
  // Spacing: -8 = very tight tracking, matches editorial reference.
  inverse_auto: { primary: '&H00FFFFFF', secondary: '&H00000000', outline: '&H00000000', back: '&H00000000', bold: 1, glow: '&H00000000', font: 'Open Sauce Two Bold', scaleX: 100, trackEm: TRACK_EM, noEdge: true, softFade: true },
  // [INVERSE-V1] end
  // [WHITE-CLEAN] Pure-white Open Sauce Two Bold, tight/narrow tracking, NO
  // outline/black stroke. Glow OFF → flat white; glow ON → a SOFT white halo the
  // same gentle size as cinematic (glowMul 0.30 + glowAlpha &HA0& so it never
  // over-brightens). Same soft-glow recipe as cinematic_white but a sans font.
  white_clean: { primary: '&H00FFFFFF', secondary: '&H00000000', outline: '&H00FFFFFF', back: '&H00000000', bold: 1, glow: '&H00FFFFFF', font: 'Open Sauce Two Bold', scaleX: 100, trackEm: TRACK_EM, glowMul: 0.30, glowAlpha: '&HA0&', noEdge: true, softFade: true },
};
// [TITLE-V1] `titles` is a NEW optional 8th argument. Each entry:
//   { id, text, start, end, x, y, fs, style, anim }
// Titles render as \pos-anchored Dialogue lines that appear INDEPENDENTLY of the
// subtitle cue timing — persistent overlays the user can place anywhere on the
// frame with their own time window, font size, style, and animation. Absent →
// legacy behavior (subtitle-only ASS). Compatible with the inverse_auto pipeline
// because titles get emitted onto the same black-canvas mask.
// [AR-BURN] Canonical caption authoring space is 1080×1920. For non-portrait output
// the ASS PlayRes must match the OUTPUT aspect, otherwise libass stretches glyphs
// (a 1080×1920 script scaled onto a 1920×1080 frame = 1.78× horizontal squash).
// Return the PlayRes for a given output format; portrait is the 1080×1920 identity.
// NOTE: these are ASPECT-ONLY canonical dims; libass scales them to the real
// output pixels (set by resolution/vfFor), so they need not equal actual frame px.
function assPlayRes(format) {
  switch (format) {
    // [FMT-WIDE] 'wide' is an alias for 'landscape' — same 16:9 PlayRes.
    case 'wide':
    case 'landscape': return { w: 1920, h: 1080 };
    case 'square':    return { w: 1080, h: 1080 };
    case 'face':
    case 'blur':
    default:          return { w: 1080, h: 1920 };
  }
}
// [SEG-DRIFT] Second half of the same defect. Track-plan boundaries land on
// speech/movement, not on the frame grid — a real plan starts 0, 0.125, 1.25,
// 2.5 … while a frame at 25fps is 0.04 s. ffmpeg cannot emit a fraction of a
// frame, so each segment rounds UP to a whole one, and the leftovers add up:
// summed straight off the user's own 29-segment plan that is 16.00 frames =
// 640 ms, and their finished file carried 15 extra frames = 600 ms.
//
// Snapping every boundary to the frame grid makes the round-up exactly zero
// and keeps consecutive segments tiling without gaps or overlaps, because both
// sides of a boundary snap to the SAME frame. Boundaries move by at most half
// a frame (20 ms), far below the ~150 ms where a viewer notices a cut landing
// early or late.
function snapSegmentJobs(jobs, fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return jobs;   // unknown fps → leave alone
  const snap = (t) => Math.round(t * f) / f;
  return jobs
    .map(j => ({ ...j, ss: snap(j.ss), to: snap(j.to) }))
    // A sub-frame segment collapses to zero once snapped; ffmpeg would emit an
    // empty file that breaks concat, so drop it — the neighbouring segments
    // already cover its span.
    .filter(j => j.to > j.ss);
}

// Frames-per-second of a probed stream, from ffprobe's "25/1" style ratio.
// BOTH fields are tried: ffprobe reports avg_frame_rate as the literal "0/0"
// when it cannot work one out, which is truthy and would otherwise shadow a
// perfectly good r_frame_rate and leave the segments unsnapped.
function fpsFromStream(stream) {
  for (const raw of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const str = String(raw || '');
    const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(str);
    if (m && +m[2] !== 0 && +m[1] > 0) return +m[1] / +m[2];
    const n = parseFloat(str);
    if (Number.isFinite(n) && n > 0 && !str.includes('/')) return n;
  }
  return null;
}

// [SEG-DRIFT] Smart Track renders a clip as N short segments and joins them
// with the concat demuxer. Each segment came out of ffmpeg with its VIDEO
// stream starting at 0.040 (one frame at 25fps) while its AUDIO started at
// 0.000 — an input-seek artefact. `-c copy` concat preserves those per-segment
// offsets, so the slip ACCUMULATES: measured at ~40 ms per segment, and a real
// 30 s clip is cut into 29 segments, which stretched the finished video to
// 31.18 s. Captions are timed against the SOURCE, so they ran progressively
// further ahead of the speaker's mouth — barely visible at the start, a full
// second off by the end. That is the "subtitle selalu meleset" report.
//
// Resetting both streams' timestamps to zero per segment removes the offset at
// the source: measured 5×2 s segments went from 10.221 s to 10.021 s total,
// with the VIDEO track landing exactly on 10.000. (The ~20 ms remainder is AAC
// frame granularity in the audio track — one frame, and it does not
// accumulate.) Re-encoding the audio at concat time was tried and does not
// improve on it.
const SEG_PTS_RESET = 'setpts=PTS-STARTPTS';
function segmentFilterArgs(j) {
  return j.kind === 'filter'
    ? ['-filter_complex', `${j.graph},${SEG_PTS_RESET}`]
    : ['-vf', `${j.vf},${SEG_PTS_RESET}`];
}
// [CONTINUOUS-AUDIO] Audio is no longer segmented — it is extracted once as a
// single continuous stream and muxed back after video-only concat.  This
// eliminates all segment-boundary PTS discontinuities and AAC priming gaps
// that caused audio to disappear in the middle of Smart Track clips.
const SEG_AUDIO_ARGS = [];

// [RENDER-STALL] How long a render ffmpeg may emit NOTHING before we call it
// wedged. ffmpeg prints a progress line about twice a second while encoding, so
// three minutes of total silence is not a slow machine — it is a stuck decoder
// or encoder. This replaces the wall-clock budget as the primary watchdog
// precisely because silence, unlike elapsed time, does not punish slow hardware:
// an 8 GB ThinkPad encoding at 0.2× realtime stays alive indefinitely, while a
// wedged iGPU is killed in 3 minutes instead of 20.
const RENDER_STALL_MS = 180000;

// [CAP-OFFSET] Manual caption timing calibration, in milliseconds. Positive
// pushes captions LATER (use when they run ahead of the voice), negative pulls
// them earlier.
//
// This exists because automatic alignment has a real floor. Whisper's word
// timings on continuous speech were measured against audio energy here and the
// answer was not resolvable: 88 words offered only 14 usable acoustic onsets,
// matches ran at 13-16%, and different methods disagreed between -200ms and
// +40ms. DTW alignment was tried too and moved nothing measurable. When the
// instrument cannot decide, the viewer can — so the offset is exposed rather
// than guessed at, and defaults to 0 so nobody inherits a correction they did
// not ask for.
//
// Applied to a COPY: cueWords are also written to the report and reused by the
// editor, and shifting them in place would compound the offset every re-render.
function shiftCues(cues, offsetMs, clipDur) {
  const off = Number(offsetMs) / 1000;
  if (!Number.isFinite(off) || off === 0) return cues;
  const cap = Number(clipDur) > 0 ? Number(clipDur) : Infinity;
  return (cues || []).map(c => {
    const start = Math.max(0, Math.min(cap, Number(c.start) + off));
    const end   = Math.max(start + 0.05, Math.min(cap, Number(c.end) + off));
    return { ...c, start, end };
  // A cue shifted entirely past the end of the clip would otherwise linger on
  // the final frame instead of disappearing.
  }).filter(c => c.start < cap);
}

// [CASE-V1] Apply the text-case transform (uppercase/lowercase) to cue text
// AND per-word tokens so the burn matches the CSS text-transform preview.
// Applied to the cues (not inside buildAss) so it flows into both dual-pass
// buckets and leaves the stored cue data untouched — toggling back to 'none'
// restores the original casing.
//
// Module scope for the same reason captionBurnVf is: this used to live inside
// renderClipEdit, so the pipeline's own post-render burn never applied it. A
// user who set captions to UPPERCASE got a delivered clip in normal case and
// only saw the setting take effect after re-rendering from the editor. Both
// burn paths call this now; a new text treatment must go here, not in one of
// the two callers.
function applyCueCase(cues, caseMode) {
  const mode = caseMode === 'upper' || caseMode === 'lower' ? caseMode : 'none';
  const tx = (str) => {
    const v = String(str == null ? '' : str);
    return mode === 'upper' ? v.toUpperCase() : mode === 'lower' ? v.toLowerCase() : v;
  };
  return (cues || []).map(c => ({
    start: c.start, end: c.end,
    text: tx(c.text),
    tokens: Array.isArray(c.tokens) ? c.tokens.map(tk => ({ ...tk, text: tx(tk.text) })) : c.tokens,
    ...(c.textMotion ? { textMotion: c.textMotion } : {}),
    // [BOX-HIGHLIGHT] No `.words` field to carry through anymore — buildAss
    // derives per-word timing fresh from `.tokens` + `.start`/`.end` via
    // deriveWordTiming() (src/caption-box.js). This function used to need to
    // remember to pass `.words` through by hand (and once silently didn't —
    // see git history), which is exactly the class of bug the derive-on-use
    // approach removes structurally: there is no second array left to forget.
  }));
}

// [INVERSE-BURN] The filter chain that makes `inverse_auto` actually invert.
// A plain `subtitles` overlay renders that style as flat white text — the
// knockout effect comes entirely from rendering the captions onto a black
// canvas and blending that mask over the video with difference. renderClipEdit
// has always done this; the pipeline's own first burn did not, so a clip cut
// with the Subtract look came out as ordinary white captions and only became
// correct after the user re-rendered from the caption editor. Extracted here
// so both paths are literally the same chain.
// [TITLE-VIDEO-FX] A title may restyle the VIDEO under it for its own window
// (the riot template's pink duotone). Only filters already in REQUIRED_FILTERS
// — colorchannelmixer and drawbox, both proven in the mac and Windows ffmpeg —
// so this cannot introduce a "Filter not found" on one platform. Every filter
// is timeline-gated, so outside the window the frame is untouched.
//   duotone: luma -> pink (#FF3FA4) multiply, lifted 1.45x for punch; black
//   stays black, like a two-colour print. Opens with a 0.1 s white flash.
// The catalog lives in video-fx.js (shared with the preview).
const VFX = require('./video-fx');
const VIDEO_FX = new Proxy({}, { get: (_, id) => VFX.get(String(id)) || undefined });
function titleVideoFxVf(titles) {
  const out = [];
  for (const T of (Array.isArray(titles) ? titles : [])) {
    const fx = T && VIDEO_FX[T.videoFx];
    if (!fx) continue;
    // [FX-FRONT] hook window only (the clip's first 3.5 s), same as the preview
    const s = Math.max(0, +T.start || 0), e = Math.min(3.5, Math.max(s + 0.05, +T.end || s + 3.5));
    if (s >= 3.5) continue;
    const L = [0.299, 0.587, 0.114].map((v) => v * fx.gain);
    const row = (c, k) => L.map((v, i) => `${c}${'rgb'[i]}=${(v * k).toFixed(4)}`).join(':');
    out.push(`colorchannelmixer=${row('r', fx.tint[0])}:${row('g', fx.tint[1])}:${row('b', fx.tint[2])}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'`);
    out.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@0.75:t=fill:enable='between(t,${s.toFixed(3)},${(s + fx.flashMs / 1000).toFixed(3)})'`);
  }
  return out.join(',');
}
function withVideoFx(fxVf, chain) {
  if (!fxVf) return chain;
  return chain ? `${fxVf},${chain}` : fxVf;
}

// [CUTOUT-FX] Person cut-out (person B&W, background pink duotone) for the
// title's window. Segmentation runs in the tracker bundle's python, which
// already ships mediapipe + opencv for face tracking; the script travels as
// `python -c` source so the installed bundle needs no update. Returns a new
// file with the window composited in, or null (caller falls back to the plain
// full-frame duotone) — an effect must never fail a render.
// [PY-SCRIPT-FILE] Bundled .py helpers run from a real file, never `python -c`:
// Windows caps a whole command line at 32,767 chars and collage-broll.py is
// 42 KB, so on Windows every B-roll spawn failed and was skipped silently.
// The source lives inside app.asar (python cannot open that), so copy it out
// to the temp dir once per content hash.
const _pyScriptCache = new Map();
function pyScriptFile(name) {
  const code = fs.readFileSync(path.join(__dirname, name), 'utf8');
  const h = crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
  const out = path.join(os.tmpdir(), 'socl-py', `${name.replace(/\.py$/, '')}-${h}.py`);
  if (_pyScriptCache.get(name) === out && fs.existsSync(out)) return out;
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, code, 'utf8');
    try { fs.renameSync(tmp, out); } catch { try { fs.unlinkSync(tmp); } catch {} }
  }
  _pyScriptCache.set(name, out);
  return out;
}
// [HOOK-FACE] Head boxes during the hook window, as vertical bands in
// canonical 1920-high units, for placeHook to keep the hook off faces. Runs the
// tracker bundle's python (mediapipe face detection). [] when it cannot run —
// placement then falls back to avoiding the captions only.
async function probeFaceBands(file, start, end, { cwd, log } = {}) {
  try {
    const { python } = trackerPaths();
    if (!fs.existsSync(python) || !fs.existsSync(file)) return [];
    const code = pyScriptFile('face-probe.py');
    let res = null;
    await spawnLines(python, [code, file, String(start), String(end)], {
      cwd: cwd || path.dirname(file), timeoutMs: 90000, stallMs: 60000,
      onLine: (k, line) => { if (k === 'out' && /^\{"ok"/.test(line)) { try { res = JSON.parse(line); } catch {} } },
    });
    if (!res || !res.ok || !Array.isArray(res.faces)) return [];
    // One band per detected head; overlapping ones merge in placeHook.
    return res.faces.map((f) => ({ top: f.y0 * 1920, bottom: f.y1 * 1920 }));
  } catch (err) {
    log && log(`hook: face probe skipped (${err && err.message || err})`);
    return [];
  }
}

async function applyCutoutFx(inFile, T, { cwd, log, encArgs } = {}) {
  let framesDir = null;
  try {
    const { python } = trackerPaths();
    if (!fs.existsSync(python)) { log && log('cutout: tracker bundle not installed, using full duotone'); return null; }
    const s = Math.max(0, +T.start || 0), e = Math.max(s + 0.05, +T.end || s + 3.5);
    const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    framesDir = path.join(cwd || path.dirname(inFile), `_cutout-${tag}`);
    const code = pyScriptFile('segment-fx.py');
    let res = null;
    await spawnLines(python, [code, inFile, framesDir, String(s), String(e), (VFX.get(T.videoFx) || VFX.get('cut_pink')).tint.join(',')], {
      cwd: cwd || path.dirname(inFile), timeoutMs: 180000, stallMs: 120000,
      onLine: (k, line) => { if (k === 'out' && /^\{"ok"/.test(line)) { try { res = JSON.parse(line); } catch {} } },
    });
    if (!res || !res.ok) { log && log(`cutout: segmentation failed (${res && res.error || 'no result'}), using full duotone`); return null; }
    const outFile = inFile.replace(/\.mp4$/, `.cutout-${tag}.mp4`);
    const fxV = VFX.get(T.videoFx) || VFX.get('cut_pink');
    await spawnLines(FFMPEG, ['-y', '-i', inFile, '-framerate', String(res.fps), '-start_number', '0', '-i', path.join(framesDir, 'f%05d.jpg'),
      '-filter_complex', `[1:v]setpts=PTS-STARTPTS+${s.toFixed(3)}/TB[cut];[0:v][cut]overlay=0:0:eof_action=pass,`
        + `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.75:t=fill:enable='between(t,${s.toFixed(3)},${(s + fxV.flashMs / 1000).toFixed(3)})'[v]`,
      '-map', '[v]', '-map', '0:a?', ...(encArgs || videoEncodeArgs('final', '1080p')), '-pix_fmt', 'yuv420p', '-c:a', 'copy', outFile,
    ], { cwd: cwd || path.dirname(inFile), timeoutMs: 1800000, stallMs: RENDER_STALL_MS });
    log && log(`cutout: ${res.frames} frames composited`);
    return outFile;
  } catch (err) {
    log && log(`cutout: ${err && err.message || err} — using full duotone`);
    return null;
  } finally {
    if (framesDir) { try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {} }
  }
}

// [COLLAGE-BROLL] Halftone paper-collage B-roll (Clip setting → "B-roll
// kolase"). One per clip, at the strongest spoken keyword AFTER the hook
// window: the speaker cut out in halftone, paper shapes and the keyword on
// torn labels assemble over a flat colour field (collage-broll.py), laid over
// the clip's video for ~4 s while the audio keeps running. Local and free:
// the tracker bundle's python, no model, no API.
const BROLL_PALETTES = [
  ['#E8572A', '#1F8A8A'],   // burnt orange / teal
  ['#5B2A86', '#F2C230'],   // deep purple / mustard
  ['#1F8A8A', '#E8572A'],   // teal / orange
  ['#D8352B', '#F3EAD6'],   // red / cream
  ['#2E4BCB', '#F2C230'],   // cobalt / mustard
];
const BROLL_SEC = 4.0;
const BROLL_OV_SEC = 2.6;   // [BROLL-OVERLAY] light cut-out inserts are shorter
// [INSERT-SEC] User-chosen length for B-roll and the hook teaser: 'auto' keeps
// the tuned defaults, a number is clamped to 2-5 s (long inserts drag).
const insertSec = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.max(2, Math.min(5, n)) : null; };
function applyBrollSec(list, sec, clipDur) {
  if (!sec) return list;
  for (const b of list || []) {
    if (!b) continue;
    const room = Number.isFinite(clipDur) ? clipDur - (+b.t || 0) - 0.2 : Infinity;
    b.dur = +Math.max(1, Math.min(sec, room)).toFixed(2);
  }
  return list;
}
// [BROLL-CARDS] Small paper cards only (user: the round stamp read as tacky).
const BROLL_OVERLAYS = ['polaroid', 'note', 'receipt', 'tape', 'highlight', 'scribble', 'cutout'];   // [BROLL-LIGHT] + no-box looks
const BROLL_MONEY = new Set(('uang duit gaji cuan modal utang hutang cicilan mahal murah rugi untung bangkrut harga bayar tabungan investasi saham kaya miskin jualan bisnis omzet pajak kredit pinjol thr bonus money broke').split(' '));
const BROLL_FEEL = new Set(('takut capek lelah stres stress bingung sedih kecewa marah benci nangis panik cemas trauma depresi kesepian sendirian insecure overthinking malas males susah sulit sakit gagal salah bohong kangen galau baper malu bangga senang bahagia').split(' '));
// The look that fits the word: money → receipt, feelings / pain → note,
// highlight or scribble, anything else → polaroid, tape, cut-out or highlight.
// `skip` = looks already used in this clip, so one clip never repeats a look.
function brollCardFor(word, seed = 0, skip = []) {
  const k = String(word || '').toLowerCase().replace(/(nya|lah|kah|pun)$/, '');
  const pool = BROLL_MONEY.has(k) ? ['receipt', 'highlight', 'tape']
    : BROLL_FEEL.has(k) ? ['note', 'scribble', 'highlight']
      : ['polaroid', 'tape', 'cutout', 'highlight', 'scribble'];
  const free = pool.filter((x) => !skip.includes(x));
  const list = free.length ? free : pool;
  return list[Math.abs(seed) % list.length];
}
// Long but empty words — they win on length, never on meaning.
const BROLL_FILLER = new Set(('menggunakan benar-benar sebenarnya sebenernya bagaimana gimana misalnya kemudian seperti makanya sehingga mungkin terutama tentunya pokoknya akhirnya ternyata langsung soalnya biasanya memang sendiri semuanya beberapa sesuatu something because actually basically really literally everything anything').split(' '));
// [BROLL-CONTEXT] Reduplications whose base is a function word ("masing-masing",
// "sendiri-sendiri", "gara-gara") read as filler on screen — real field picks.
const BROLL_REDUP_FILLER = new Set(('masing sendiri gara kadang pelan sama baik bener benar kira lama tiba paling apa siapa mana kapan jangan mudah cepat bentar sebentar diam besar kecil hati jauh dekat rame ramai lain').split(' '));
// Pain points / emotional stakes that make a viewer stop scrolling.
const BROLL_PAIN = new Set(('masalah susah sulit takut gagal sakit capek lelah stres stress bingung mahal rugi utang hutang miskin kaya uang duit gaji sukses karier karir kerja kerjaan bisnis jualan cuan modal cinta putus nikah cerai selingkuh keluarga anak orangtua kesehatan mental insecure overthinking malas males rahasia salah bahaya penting bohong jujur bangkrut viral nangis kecewa marah benci sendirian kesepian depresi cemas panik trauma diet gemuk kurus jerawat kulit tidur pensiun investasi tabungan cicilan kontrakan rumah mimpi target hidup mati pengalaman pertama terakhir pelajaran fail broke money fear pain secret mistake success').split(' '));
const brollClean = (w) => String(w || '').replace(/[^\p{L}\p{N}'-]/gu, '');
function brollWordScore(word, ctx) {
  const k = brollClean(word).toLowerCase();
  if (k.length < 4 || BROLL_FILLER.has(k) || CAP_STOPWORDS.has(k)) return -1;
  const m = /^([\p{L}]+)-\1(nya)?$/u.exec(k);
  if (m && BROLL_REDUP_FILLER.has(m[1])) return -1;
  const base = m ? m[1] : k.replace(/(nya|lah|kah|pun)$/, '');
  const pain = BROLL_PAIN.has(k) || BROLL_PAIN.has(base);
  const inCtx = !!(ctx && (ctx.has(k) || ctx.has(base)));
  let sc = Math.min(8, k.length);
  if (pain) sc += 9;
  if (inCtx) sc += 6;      // word from the clip's title / hook
  // spoken slang verbs (ngomongnya, nganterin, dibikin…) read as noise on screen
  if (!pain && !inCtx && (/^(ng|nge|di)\p{L}{3,}/u.test(k) || /\p{L}{3,}in(nya)?$/u.test(k))) sc -= 4;
  if (!pain && !inCtx && /nya$/.test(k)) sc -= 2;
  return sc;
}
const CAP_STOPWORDS = new Set(('yang dan di ke dari itu ini aku saya gua gue lu lo kamu dia kita kami mereka untuk dengan karena jadi ada juga tapi aja saja sih kok nya pun lagi udah sudah akan bisa kalau kalo atau terus nggak enggak gak tidak bukan banget gitu kayak kaya lihat liat kenapa berapa lebih hampir gimana masih pakai pake bikin buat punya mau ingin juga baru tahu tau sangat paling cuma emang memang sama abis habis terus lalu dulu nanti sekarang the a an to of and is are was in on it that this for you i we they be so but').split(' '));
// [BROLL-MULTI] Several inserts per clip: about one per 14 s (max 4), ≥ 7 s
// apart, all after the hook window. The strongest moment is full screen;
// the others are light cut-out overlays so it never feels like a takeover.
function pickBrollMoments(cueWords, clipDur, ctxText = '') {
  const cues = (Array.isArray(cueWords) ? cueWords : []).filter((c) => c && String(c.text || '').trim());
  const dur = +clipDur || 0;
  const lo = VFX.WINDOW_SEC + 0.5;
  const ctx = new Set(String(ctxText || '').toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 4));
  const cands = [];
  cues.forEach((c, ci) => {
    const t0 = +c.start;
    if (t0 < lo || t0 > dur - BROLL_OV_SEC - 0.4) return;
    const ws = String(c.text).split(/\s+/).filter(Boolean);
    let ki = -1, best = -1;
    ws.forEach((w, j) => { const sc = brollWordScore(w, ctx); if (sc > best) { best = sc; ki = j; } });
    if (ki < 0 || best < 8) return;
    // lead-in words: whole words only (ASR chunk edges cut "temen" to "tem")
    const okLead = (w) => w.length >= 4 || /^(aku|gue|gua|kok|mau|apa|gak|ini|itu|kita)$/i.test(w);
    let lead = ws.slice(Math.max(0, ki - 2), ki).map(brollClean).filter(okLead);
    if (!lead.length && ci > 0) lead = String(cues[ci - 1].text).split(/\s+/).slice(-2).map(brollClean).filter(okLead);
    if (lead.length && lead.join(' ').toLowerCase() === brollClean(ws[ki]).toLowerCase()) lead = [];
    cands.push({ t: Math.max(0, t0 - 0.2), score: best + (/[!?]/.test(c.text) ? 2 : 0), key: brollClean(ws[ki]), line1: lead.join(' ').toUpperCase() });
  });
  if (!cands.length) return [];
  // [BROLL-SPARSE] A complement, not wallpaper (user): at least 2 on a clip
  // long enough, at most 3, ~one per 22 s, ≥ 12 s apart — and only on the
  // lines that matter (pain point / title word / ! ?) before any filler pick.
  const want = dur < 20 ? 1 : Math.max(2, Math.min(3, Math.round(dur / 22)));
  const strong = (c) => c.score >= 14;
  const picked = [];
  const stem = (w) => w.toLowerCase().replace(/(nya|lah|kah|pun)$/, '');
  const tryPick = (pool, gap) => {
    for (const c of pool) {
      if (picked.length >= want) break;
      if (picked.some((p) => Math.abs(p.t - c.t) < gap)) continue;
      if (picked.some((p) => stem(p.key) === stem(c.key))) continue;
      picked.push(c);
    }
  };
  const ranked = cands.slice().sort((a, b) => b.score - a.score);
  tryPick(ranked.filter(strong), 12);
  if (picked.length < want) tryPick(ranked, 12);
  if (picked.length < Math.min(2, want)) tryPick(ranked, 8);   // short clips: still reach two
  const used = [];
  return picked.map((c, i) => {
    let h = 0; for (const ch of c.key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const card = brollCardFor(c.key, h, used);
    const [bg, acc] = BROLL_PALETTES[h % BROLL_PALETTES.length];
    const full = i === 0 && c.t + BROLL_SEC + 0.4 <= dur;
    return { t: +c.t.toFixed(2), dur: full ? BROLL_SEC : BROLL_OV_SEC, line1: c.line1, line2: c.key.toLowerCase(), bg, acc,
      kind: full ? 'full' : 'overlay', style: full ? BROLL_STYLES[h % BROLL_STYLES.length] : (used.push(card), card) };
  }).sort((a, b) => a.t - b.t);
}
// One full-screen moment — kept for callers/tests that want a single pick.
function pickBrollMoment(cueWords, clipDur, ctxText = '') {
  const all = pickBrollMoments(cueWords, clipDur, ctxText);
  return all.find((b) => b.kind === 'full') || null;
}
// [BROLL-STYLES] kolase (paper collage), poster (Swiss kinetic type), partikel
// (particles form the keyword), impact (manga lines + face circle), glitch
// (RGB split, REC cam), stiker (sticker bomb). 'auto' = per clip, chosen by the keyword hash.
const BROLL_STYLES = ['kolase', 'poster', 'partikel', 'impact', 'glitch', 'stiker'];   // [BROLL-GENZ] +impact/glitch/stiker
function brollStyleFor(B, cfgStyle) {
  if (B && B.kind === 'overlay') return BROLL_OVERLAYS.includes(B.style) ? B.style : brollCardFor(B.line2);
  return BROLL_STYLES.includes(cfgStyle) ? cfgStyle : (B && BROLL_STYLES.includes(B.style) ? B.style : 'kolase');
}
// [BROLL-OVERLAY] Where an overlay can sit without covering a face: face
// boxes come from face-probe.py (0..1) mapped to 1080×1920; candidates stay
// inside the safe zone. Too little room for the wide Pop sticker → the
// compact Stamp. Last resort: the spot with the least face overlap.
const OV_SIZE = { pop: [820, 300], polaroid: [400, 520], stamp: [420, 420], note: [410, 440], receipt: [360, 490] };
// lower third of the safe zone first (chest / desk), the top corners last
const OV_SPOTS = [[540, 1400], [790, 1360], [290, 1360], [540, 1260], [800, 520], [280, 520]];
async function probeFaceBoxes(file, start, end, { cwd, log } = {}) {
  try {
    const { python } = trackerPaths();
    if (!fs.existsSync(python) || !fs.existsSync(file)) return [];
    const code = pyScriptFile('face-probe.py');
    let res = null;
    await spawnLines(python, [code, file, String(start), String(end)], {
      cwd: cwd || path.dirname(file), timeoutMs: 90000, stallMs: 60000,
      onLine: (k, line) => { if (k === 'out' && /^\{"ok"/.test(line)) { try { res = JSON.parse(line); } catch {} } },
    });
    if (!res || !res.ok || !Array.isArray(res.faces)) return [];
    // margin: detections miss turned heads and the crop moves — keep well clear
    return res.faces.map((f) => ({ x0: f.x0 * 1080 - 70, x1: f.x1 * 1080 + 70, y0: f.y0 * 1920 - 60, y1: f.y1 * 1920 + 140 }));
  } catch (err) { log && log(`b-roll: face probe skipped (${err && err.message || err})`); return []; }
}
function brollOverlayPlace(style, faces, word = '') {
  const boxes = Array.isArray(faces) ? faces : [];
  const n = String(word).length;
  const sizeOf = (st) => ({ pop: [Math.min(820, 160 + 62 * n), 300], tape: [Math.min(820, 170 + 58 * n), 220],
    highlight: [Math.min(820, 130 + 56 * n), 240], scribble: [Math.min(860, 240 + 70 * n), 340], cutout: [380, 480] }[st] || OV_SIZE[st] || OV_SIZE.stamp);
  const overlap = (st, cx, cy) => {
    const [w, h] = sizeOf(st);
    const r = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
    return boxes.reduce((a, f) => a + Math.max(0, Math.min(r.x1, f.x1) - Math.max(r.x0, f.x0)) * Math.max(0, Math.min(r.y1, f.y1) - Math.max(r.y0, f.y0)), 0);
  };
  const fits = (st, cx) => { const [w] = sizeOf(st); return cx - w / 2 >= 30 && cx + w / 2 <= 1050; };
  // keep the card that fits the word's meaning; only the spot moves
  for (const [cx, cy] of OV_SPOTS) if (fits(style, cx) && overlap(style, cx, cy) === 0) return { style, x: cx, y: cy };
  let best = null;
  for (const [cx, cy] of OV_SPOTS) { if (!fits(style, cx)) continue; const o = overlap(style, cx, cy); if (!best || o < best.o) best = { style, x: cx, y: cy, o }; }
  return best ? { style: best.style, x: best.x, y: best.y } : { style, x: 790, y: 1360 };
}
const brollNorm = (b) => (Array.isArray(b) ? b : (b && b.line2 ? [b] : [])).filter((x) => x && x.line2);
// [BROLL-ONE-PASS] Every insert of a clip is drawn first, then laid over the
// clip in ONE encode (full-screen = jpg frames, overlays = transparent png).
// [BROLL-AVOID-CAPS] the burned caption band (caption top Y ~ 3.4 lines of
// its font size) is an obstacle too — a card on the subtitle reads as a clash.
function captionBand(y, fs) {
  const top = +y || 0, f = +fs || 64;
  return top ? { x0: 0, x1: 1080, y0: top - 50, y1: top + f * 3.4 } : null;
}
async function applyCollageBrolls(inFile, list, { portraitSrc, cwd, log, encArgs, avoid } = {}) {
  const items = brollNorm(list);
  const dirs = [];
  try {
    if (!items.length) return null;
    const { python } = trackerPaths();
    if (!fs.existsSync(python)) { log && log('b-roll: tracker bundle belum terpasang, dilewati'); return null; }
    const dims = await getStreamDims(inFile);
    if (!(dims.w && dims.h) || Math.abs(dims.w / dims.h - 9 / 16) > 0.02) { log && log('b-roll: hanya untuk format 9:16, dilewati'); return null; }
    const code = pyScriptFile('collage-broll.py');
    const ready = [];
    for (const B of items) {
      const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dir = path.join(cwd || path.dirname(inFile), `_broll-${tag}`); dirs.push(dir);
      let style = brollStyleFor(B, B.styleOverride);
      let oy = '', ox = '';
      if (B.kind === 'overlay') {
        const faces = await probeFaceBoxes(portraitSrc || inFile, B.t, B.t + (B.dur || BROLL_OV_SEC), { cwd, log });
        const pl = brollOverlayPlace(style, faces.concat((avoid || []).filter(Boolean)), B.line2);
        style = pl.style; oy = String(pl.y); ox = String(pl.x);
      }
      let res = null;
      await spawnLines(python, [code, portraitSrc || inFile, String(B.t + 0.4), dir, `${B.line1 || ''}|${B.line2}`, B.bg, B.acc, assFontsDirFs(),
        String(B.dur || (B.kind === 'overlay' ? BROLL_OV_SEC : BROLL_SEC)), style, oy, ox], {
        cwd: cwd || path.dirname(inFile), timeoutMs: 180000, stallMs: 120000,
        onLine: (k, line) => { if (k === 'out' && /^\{"ok"/.test(line)) { try { res = JSON.parse(line); } catch {} } },
      });
      if (!res || !res.ok) { log && log(`b-roll: "${B.line2}" dilewati (${res && res.error || 'no result'})`); continue; }
      ready.push({ B, dir, res, style });
    }
    if (!ready.length) return null;
    const outFile = inFile.replace(/\.mp4$/, `.broll-${process.pid}-${Date.now()}.mp4`);
    const args = ['-y', '-i', inFile];
    const fc = [];
    let last = '0:v';
    ready.forEach(({ B, dir, res }, i) => {
      args.push('-framerate', String(res.fps), '-start_number', '0', '-i', path.join(dir, res.alpha ? 'f%05d.png' : 'f%05d.jpg'));
      fc.push(`[${i + 1}:v]${res.alpha ? 'format=rgba,' : ''}scale=${dims.w}:${dims.h},setpts=PTS-STARTPTS+${B.t.toFixed(3)}/TB[b${i}]`);
      fc.push(`[${last}][b${i}]overlay=0:0:eof_action=pass[o${i}]`);
      last = `o${i}`;
    });
    await spawnLines(FFMPEG, [...args, '-filter_complex', fc.join(';'), '-map', `[${last}]`, '-map', '0:a?',
      ...(encArgs || videoEncodeArgs('final', '1080p')), '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', outFile,
    ], { cwd: cwd || path.dirname(inFile), timeoutMs: 1800000, stallMs: RENDER_STALL_MS });
    log && log(`b-roll: ${ready.map(({ B, style }) => `"${B.line2}" ${style} @ ${B.t.toFixed(1)}s`).join(' · ')}`);
    return outFile;
  } catch (err) {
    log && log(`b-roll: ${err && err.message || err} — dilewati`);
    return null;
  } finally {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}
// Single-insert wrapper (older callers / tests).
function applyCollageBroll(inFile, B, opts) { return applyCollageBrolls(inFile, [B], opts); }

function captionBurnVf(assName, fontsDir, style) {
  const sub = `subtitles=filename='${assName}':fontsdir='${fontsDir}'`;
  if (style !== 'inverse_auto') return sub;
  return `format=gbrp,split=2[__vBg][__vSub];`
    + `[__vSub]drawbox=x=0:y=0:w=iw:h=ih:c=black@1.0:t=fill,`
    + `${sub},format=gbrp[__mask];`
    + `[__vBg][__mask]blend=all_mode=difference,format=yuv420p`;
}

// [FONT-OVERRIDE] fontOverride replaces the style preset's own face for the
// WHOLE burn. Empty means "keep the style's font", so every existing project
// renders byte-identically. The value must be a name libass actually resolves
// from assets/fonts — see CAPTION_FONTS in renderer.js, where each entry was
// probed with ffmpeg fontselect; a plausible-but-wrong name does not error, it
// silently falls back to Helvetica.
// [WYSIWYG-SPACING] Per-font optical tightening, as a fraction of font size.
// Hoisted to module scope so the font OVERRIDE can consult it before buildAss
// builds anything — it used to live inside buildAss, below the line that
// applies the override, so the override could not reach it. Mirrored by
// titleFontTracking() in renderer.js; the two must agree or preview drifts
// from burn. null = no opinion, keep whatever the caller had.
// [TRACK-UNIFORM] One tracking value for every face instead of the old per-font
// ladder (-0.02 … -0.10). The ladder was tuned against burns that never applied
// it — see the [FSP-NEGATIVE] note in buildAss: negative Spacing was silently
// dropped by libass, so those numbers only ever shaped the CSS preview, and each
// font drifted a different amount away from its own burn. Chosen from a real
// burn proof rendered with this app's bundled ffmpeg/libass at fontSize 64
// ("CONTOH CAPTION", ink width): 483px untracked → 418px at -0.08 on Open Sauce,
// with Times Cond / Arial Nova / Garamond tracking the same 13% tightening.
function fontTrackEm(fn) {
  // Pinyon Script is a CONNECTED script — its letterforms join, and pulling them
  // together breaks the joins into overlapping strokes. Deliberately excluded.
  if (/Pinyon/i.test(fn)) return 0;
  return TRACK_EM;
}

// [TITLE-ANIM-PARITY] Entrance/exit fragments for a piece of text at a given
// pixel font size. Originally computed inline, once, for caption cues only —
// titles had their own SEPARATE switch with older, unsynced numbers (200ms
// \move for rise/drop vs this one's 550ms, no blur-in on pop, etc), so a title
// animated differently from a caption using the "same" name, AND differently
// from the CSS preview (which was tuned to match THIS function, not the title
// one). One function now backs captions, titles, and — via the CSS constants
// mirrored in renderer.js — the preview, so there is exactly one place that
// can drift.
//
// `slidePx` intentionally differs by caller: captions pass the CUE fontSize
// (moves relative to the caption's own size), titles pass their OWN fs2 (a
// 96px title and a 48px caption must not travel the same physical distance).
//
// The timing constants are exported on the function itself (ANIM_TIMING)
// rather than kept file-private: buildAnimTokenCue's per-WORD reveal path
// builds its own inline \fad/\move fragments (a line-level \fad can't vary per
// word) and has to use these exact same numbers, or a word with its own
// animation override would tick on a different clock than the cue around it.
const ANIM_TIMING = Object.freeze({
  inMs: 200, fadeIn: 70, fadeOut: 40,             // punchy timing (pop, blur)
  softInMs: 260, softIn: 130, softOut: 80,        // elegant timing (fade, zoom)
  slideMs: 550, slideFadeIn: 200, slideFadeOut: 100,
  slamMs: 160, slamScale: 1.7,                    // [HOOK-SLAM] impact entrance (titles)
});
// [TITLE-WORD-ANIM] Animasi yang bisa dipakai SATU KATA sendiri. Persis set
// yang dihormati preview lewat ANIM_CSS + 'none'. 'type' dan '' (inherit)
// sengaja di luar: preview pun mewariskannya ke animasi judul, karena 'type'
// punya mesin per-karakternya sendiri.
const PER_WORD_TITLE_ANIMS = new Set(['pop', 'fade', 'rise', 'drop', 'zoom', 'blur', 'slam', 'none']);

// [CUE-NO-FADEOUT] A caption cue that the next one follows directly must not
// fade out: every animation carries \fad(in,out), so the outgoing cue faded
// to nothing while the next started from transparent — measured on a real
// 2.4.22 render, the caption dropped to 0 % at EVERY cue change and took 3–4
// frames to recover, a blink about twice a second on short cues. The preview
// never fades out at all. Within one frame (0.05 s) counts as back to back; a
// cue before a real gap keeps its fade-out. Applied to the cue's finished
// Dialogue lines, so every caption path (plain, box segments, per-word, type)
// is covered by the one rule; titles are built elsewhere and keep theirs.
const CONTIGUOUS_CUE_GAP_SEC = 0.05;
function cuesJoin(a, b) {
  return !!(a && b) && Number(b.start) - Number(a.end) <= CONTIGUOUS_CUE_GAP_SEC;
}
function dropFadeOutIfContiguous(dialogue, cue, next) {
  if (!cuesJoin(cue, next)) return dialogue;
  return String(dialogue).replace(/\\fad\((\d+),\d+\)/g, '\\fad($1,0)');
}
// [CUE-SOLID-IN] ...and the cue that directly follows another starts fully
// visible: dropping only the fade-out left the incoming cue's first frame at
// 0 % (measured: 9 of 9 swaps still went blank). Its motion — pop's scale,
// rise/drop's \move, zoom, blur — is untouched; only the opacity ramp goes.
// A cue after a real gap, and the first cue, still fade in. The user picked
// this over "start at 50 %" after seeing both measured (2026-10-05).
function applyCueContinuity(dialogue, prev, cue, next) {
  let d = dropFadeOutIfContiguous(dialogue, cue, next);
  if (cuesJoin(prev, cue)) d = String(d).replace(/\\fad\(\d+,(\d+)\)/g, '\\fad(0,$1)');
  return d;
}

function animFragments(mode, fontSizePx, glowMul = 1, softMul = 1) {
  const blur = Math.max(2, Math.round((fontSizePx / 6) * glowMul * softMul));
  const textStartBlur = Math.round(blur * 1.8);
  const { inMs, fadeIn, fadeOut, softInMs, softIn, softOut, slideMs, slideFadeIn, slideFadeOut } = ANIM_TIMING;
  const slidePx = Math.round(fontSizePx * 0.65);           // matches CSS translateY(38px) at the reference size
  let glowAnim = '', textAnim = '\\blur0';
  // [BOX-ANIM-SCALE] Skala AWAL animasi dan berapa lama ia mencapai 100%,
  // dinyatakan terang-terangan. Kotak highlight butuh keduanya untuk
  // mengikuti teksnya (lihat [BOX-ANIM-SCALE] di buildAss); menguraikannya
  // kembali dari string \fscx di textAnim akan pecah begitu ada mode baru.
  let scale0 = 1, scaleMs = 0;
  switch (mode) {
    case 'pop':
      glowAnim = `\\fad(${fadeIn},${fadeOut})\\fscx64\\fscy64\\t(0,${inMs},\\fscx100\\fscy100)`;
      textAnim = `\\fad(${fadeIn},${fadeOut})\\fscx64\\fscy64\\blur${textStartBlur}\\t(0,${inMs},\\fscx100\\fscy100\\blur0)`;
      scale0 = 0.64; scaleMs = inMs;
      break;
    case 'blur':
      glowAnim = `\\fad(${fadeIn},${fadeOut})`;
      textAnim = `\\fad(${fadeIn},${fadeOut})\\blur${textStartBlur}\\t(0,${inMs},\\blur0)`;
      break;
    case 'slam': {
      // [HOOK-SLAM] Big-to-normal "impact": starts at SLAM_SCALE and lands at
      // 100% in slamMs, linear so the boxed-word / backdrop \move (also
      // linear) stays glued to the text on every frame — the [BOX-ANIM-SCALE]
      // rule. The preview's capSlam keyframes are linear for the same reason.
      const { slamMs, slamScale } = ANIM_TIMING;
      const pct = Math.round(slamScale * 100);
      glowAnim = `\\fad(${fadeIn},${fadeOut})\\fscx${pct}\\fscy${pct}\\t(0,${slamMs},\\fscx100\\fscy100)`;
      textAnim = `\\fad(${fadeIn},${fadeOut})\\fscx${pct}\\fscy${pct}\\blur${textStartBlur}\\t(0,${slamMs},\\fscx100\\fscy100\\blur0)`;
      scale0 = slamScale; scaleMs = slamMs;
      break;
    }
    case 'zoom':
      glowAnim = `\\fad(${softIn},${softOut})\\fscx90\\fscy90\\t(0,${softInMs},\\fscx100\\fscy100)`;
      textAnim = `\\fad(${softIn},${softOut})\\fscx90\\fscy90\\t(0,${softInMs},\\fscx100\\fscy100)\\blur0`;
      scale0 = 0.90; scaleMs = softInMs;
      break;
    case 'rise':
    case 'drop':
      glowAnim = `\\fad(${slideFadeIn},${slideFadeOut})\\blur2\\t(0,${slideMs},\\blur0)`;
      textAnim = `\\fad(${slideFadeIn},${slideFadeOut})\\blur2\\t(0,${slideMs},\\blur0)`;
      break;
    case 'fade':
      glowAnim = `\\fad(260,${softOut})`;
      textAnim = `\\fad(260,${softOut})\\blur0`;
      break;
    default: // 'none'
      glowAnim = '';
      textAnim = '\\blur0';
  }
  return { glowAnim, textAnim, slideMs, slidePx, scale0, scaleMs };
}

// [BOX-HIGHLIGHT] Pembungkus tipis: font tak dikenal tidak boleh menjatuhkan
// seluruh baris. Seharusnya tidak pernah kena karena `offsets` sudah dicek
// `!= null` lebih dulu, tapi defensif terhadap urutan pemanggilan yang berubah.
function textWidthEmSafe(text, fontName, fontsDir, bold = false, italic = false) {
  const { textWidthEm } = require('./font-metrics');
  const v = textWidthEm(text, fontName, fontsDir, bold, italic);
  return v == null ? 0 : v;
}

// [TITLE-BOX] Absolute-pixel rectangles for a title's manually-boxed words.
// Pure: no ASS strings, no Dialogue lines — that's buildAss's job (it turns
// each rect into one \p1 Dialogue via boxDrawing()). Deliberately does NOT
// reflow neighbouring words to make room for a box (unlike caption box
// highlighting's [BOX-PAD-INSERT]) — titles' boxed-word set is static for
// the whole time the title is on screen and hand-picked by the user, who
// sees the result immediately in the preview; the reflow machinery exists
// in the caption path specifically to handle box highlighting following
// WHICHEVER word is currently being spoken, a problem titles don't have.
// See docs/superpowers/specs/2026-09-04-title-word-box-highlight-design.md.
//
// `fitLines`: array of lines, each an array of token objects ({text, style?})
// IN TITLE ORDER — same shape TITLE-FIT-WIDTH already builds (see the
// `fitLines`/`fitCur` loop above the call site in buildAss). `boxedIdx`: a
// Set of FLAT word indices (counting across all lines in order) that should
// get a box. `fs2`: the title's own final font size in output pixels (AFTER
// any TITLE-FIT-WIDTH shrink has already been applied — this function must
// be called with the same fs2 the text itself burns at, or boxes drift from
// their words). `tx2`/`ty2`: the title's own \pos anchor (top-center, \an8 —
// same values the text Dialogue lines use). `lineHeightEm`: vertical spacing
// between lines as a multiple of fs2 — pass 1.2 to match titleCenterShift's
// existing assumption (buildAss, a few lines above the call site).
// `SY`: the canonical-1920-height-to-output-height scale factor (same `SY`
// `buildAss` already computes for itself) — REQUIRED so a per-word
// `style.fs` override (always authored in canonical space) resolves to the
// correct output-pixel size, matching how `TITLE-FIT-WIDTH` and `tokOpen`
// already scale it.
// [TITLE-BOX] Split a title's tokens into per-line arrays wherever
// titleLineBreaks says a new line starts. Extracted so the TITLE-FIT-WIDTH
// sizing pass and the box-rectangle pass (titleBoxRects, below) can never
// silently diverge on what a title's "lines" are — this codebase has a
// documented history of exactly that class of bug (two copies of near-
// identical splitting/measuring logic drifting apart over time).
function splitTitleLines(tToks, titleLineBreaks) {
  const lines = [];
  let cur = [];
  tToks.forEach((tk, i) => {
    if (titleLineBreaks.includes(i) && cur.length) { lines.push(cur); cur = []; }
    cur.push(tk);
  });
  if (cur.length) lines.push(cur);
  return lines;
}

// [HOOK-FONT] BOX_H_EM (1.20, caption-box.js) is expressed in units of the
// px font size, and was tuned against a face whose fontEmScale is 1.237 — so
// what it has always encoded is a fraction of the ASS \fs, not of fsw. Naming
// that ratio keeps the default face byte-identical and lets any other face
// derive its own box height correctly.
const BOX_H_OVER_ASSFS = 1.20 / 1.237;

// [TITLE-INK-LEADING] Saklar perapatan jarak baris judul. NYALA sejak sisi
// preview ikut dipasang (paintTitleLayer di renderer.js, pembungkus .ttl-line).
// Keduanya WAJIB bergerak bersama: menyalakan satu sisi saja membuat preview
// dan burn berselisih ~26px untuk judul campuran ukuran.
const TITLE_INK_LEADING_ON = true;

// [TITLE-WORD-POS] Where each word of a shaped title actually lands, in ASS
// pixels. titleBoxRects needs it to place highlight rectangles; the per-word
// drag needs it to redraw a dragged word at its natural spot plus the user's
// offset. ONE measurement for both — two copies of this loop is how a box and
// the word it sits behind drift apart.
// [TITLE-LINE-PITCH] Atas setiap baris, diukur dari jangkar \an8 judul.
//
// libass memajukan tiap baris sejauh \fs MILIK BARIS ITU, bukan sejauh satu
// pitch seragam. Diturunkan dari ASS tulisan tangan dan diukur pikselnya:
//
//   \fs seragam 72 : atas baris 314, 386, 457  -> jarak 72, 71
//   baris-2 \fs200 : atas baris 314, 410, 585  -> jarak 96, 175
//   baris-1 \fs200 : atas baris 338, 514, 585  -> jarak 176, 71
//
// Ketiganya terprediksi tepat oleh model itu (tinta duduk pada fraksi tetap di
// bawah atas kotak-baris, jadi selisih tinta bukan selisih barisnya).
//
// Satu pitch seragam membuat SETIAP baris sesudah baris yang lebih besar
// meleset — terlihat langsung sebagai kotak highlight yang terdampar di tengah
// kata besar, dan sebagai jarak antar baris yang terasa aneh.
function titleLinePitch(line, { fs2, fontsDir, baseFont, boldDefault, lineHeightEm, SY }) {
  let px = 0;
  for (const tk of (line || [])) {
    const st = (tk && tk.style) || {};
    const fn = st.fn || baseFont;
    const bold = st.b != null ? !!st.b : !!boldDefault;
    const fsw = st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fs2;
    // \fs yang benar-benar diemisikan untuk kata ini — sama dengan assFs().
    const em = (st.fn || st.b != null || st.i)
      ? (fontEmScale(fn, fontsDir, bold, !!st.i) || lineHeightEm)
      : lineHeightEm;
    const cand = fsw * em;
    if (cand > px) px = cand;
  }
  return px || (fs2 * lineHeightEm);
}
function titleLineTops(fitLines, ty2, opts) {
  const tops = [];
  let y = ty2;
  for (const line of (fitLines || [])) {
    tops.push(y);
    y += titleLinePitch(line, opts);
  }
  return tops;
}

// [TITLE-INK-LEADING] Ukuran px yang BENAR-BENAR diemisikan untuk satu token —
// satu definisi dipakai titleLinePitch, kedua pengukur lebar, tokOpen, dan
// model tinta di bawah. Kalau ada yang memakai rumus sendiri, kotak highlight
// dan teksnya akan berpisah lagi; itu sudah terjadi berkali-kali di file ini.
function tokenSizePx(tk, fs2, SY) {
  const st = (tk && tk.style) || {};
  return st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fs2;
}

// [TITLE-INK-LEADING] Metrik tinta satu baris, dalam piksel ASS. Baris dengan
// beberapa ukuran memakai angka TERBESAR di antara kata-katanya, karena kata
// terbesarlah yang menentukan baseline baris itu di libass.
//
// Mengembalikan null kalau ada satu saja face yang tak terselesaikan — lebih
// baik jatuh ke model kotak-em lama daripada memposisikan baris dari tebakan.
function titleLineInkPx(line, { fs2, fontsDir, baseFont, boldDefault, SY }) {
  let sizePx = 0, inkAscPx = 0, inkDescPx = 0, baselinePx = 0, seen = false;
  // Face PENENTU baris: kata terbesarnya. Di libass kata itulah yang menetapkan
  // baseline baris, jadi lead/gap-nya yang berlaku untuk baris itu. Judul bisa
  // mengganti font per kata, dan lead sangat berbeda antar face (Anton 0.545
  // lawan Open Sauce Two 0.237) — memakai lead font judul untuk semua baris
  // membuat baris ber-face lain meleset 61,5px dari sasaran model ini sendiri.
  let leadEm = null, gapEm = null;
  for (const tk of (line || [])) {
    const st = (tk && tk.style) || {};
    const fn = st.fn || baseFont;
    const bold = st.b != null ? !!st.b : !!boldDefault;
    const fsw = tokenSizePx(tk, fs2, SY);
    const ex = fontInkExtentEm(fn, fontsDir, bold, !!st.i);
    if (!ex || ex.baselineEm == null) return null;
    seen = true;
    if (fsw > sizePx) {
      sizePx = fsw;
      const opts = { fontsDir, baseFont: fn, boldDefault: bold };
      leadEm = titleInkLeadEm(opts);
      gapEm = titleInkGapEm(opts);
    }
    const a = ex.ascEm * fsw, d = ex.descEm * fsw, b = ex.baselineEm * fsw;
    if (a > inkAscPx) inkAscPx = a;
    if (d > inkDescPx) inkDescPx = d;
    if (b > baselinePx) baselinePx = b;
  }
  if (!seen || leadEm == null || gapEm == null) return null;
  return { sizePx, inkAscPx, inkDescPx, baselinePx, leadEm, gapEm };
}

// [TITLE-INK-LEADING] Celah antar baris, sebagai pecahan ukuran baris.
//
// BUKAN angka pilihan: diturunkan supaya baris BERUKURAN SAMA mempertahankan
// jarak yang dirender hari ini. Jarak libass untuk ukuran seragam adalah
// px x emScale; model tinta memberi px x inkH + celah x px. Menyamakan
// keduanya memaksa celah = emScale - inkH. Untuk Open Sauce Two Bold itu
// 1.2370 - 1.0000 = 0.2370.
//
// Hasilnya: judul berukuran seragam TIDAK berubah sedikit pun, dan satu-satunya
// yang hilang adalah ruang ekstra yang dibawa baris yang lebih besar.
function titleInkGapEm({ fontsDir, baseFont, boldDefault }) {
  const ex = fontInkExtentEm(baseFont, fontsDir, !!boldDefault, false);
  const em = fontEmScale(baseFont, fontsDir, !!boldDefault, false);
  if (!ex || !Number.isFinite(em)) return null;
  const g = em - (ex.ascEm + ex.descEm);
  // g <= 0 punya sebab yang SAMA dengan lead <= 0 di titleInkLeadEm: tanpa
  // sCapHeight, ascEm adalah ascender penuh, jadi tinggi "tinta" menelan
  // seluruh kotak em dan tidak ada celah yang tersisa. Ditolak di sini juga,
  // supaya penonaktifannya eksplisit dan bukan kebetulan dari satu cabang.
  return g > 0 ? g : null;
}

// [TITLE-INK-LEADING] Apakah baris-barisnya berbeda ukuran. Model tinta hanya
// dipasang kalau IYA — kalau semua baris seukuran, jalur lama sudah tepat dan
// dibiarkan byte-identik (nol risiko untuk judul biasa, yang adalah mayoritas).
// [TITLE-INK-LEADING] Jarak atas kotak-baris ke atas KAPITAL, pecahan ukuran.
// libass memenuhi Fontsize dengan usWinAscent+usWinDescent, jadi baseline duduk
// baselineEm di bawah atas baris; kapital naik capHeight dari baseline.
// Terverifikasi pada burn: 1.000 - 0.763 = 0.237, dan atas tinta baris pertama
// jatuh di 305 + 0.237 x 79 = 323,7 lawan 323 terukur.
function titleInkLeadEm({ fontsDir, baseFont, boldDefault }) {
  const ex = fontInkExtentEm(baseFont, fontsDir, !!boldDefault, false);
  if (!ex || ex.baselineEm == null) return null;
  const lead = ex.baselineEm - ex.ascEm;
  // lead <= 0 berarti KAPITALNYA menyentuh atas kotak-baris, yang tidak pernah
  // terjadi pada face sungguhan. Yang sebenarnya terjadi: OS/2 face itu lebih
  // tua dari v2 dan tidak punya sCapHeight, jadi fontInkExtentEm jatuh ke
  // hhea.ascender — ascender PENUH, bukan tinggi kapital. Terukur pada dua face
  // bundled: Apple Garamond dan Times NR Condensed Bold, keduanya
  // winAsc/upem = capH/upem = 0.9160 tepat sama.
  //
  // Dari tabel yang kita baca, tinggi kapital face seperti itu memang tidak
  // bisa diketahui. Menebaknya lebih buruk daripada tidak merapatkan: judul
  // dengan face itu tetap di model kotak-em lama, yang sudah terukur benar.
  return lead > 0 ? lead : null;
}

function titleSizesMixed(fitLines, { fs2, SY }) {
  const sizes = (fitLines || []).map(line =>
    (line || []).reduce((mx, tk) => Math.max(mx, tokenSizePx(tk, fs2, SY)), 0));
  return sizes.length > 1 && sizes.some(v => v !== sizes[0]);
}

// [TITLE-INK-LEADING] Atas KOTAK-BARIS tiap baris (yaitu nilai y untuk
// \an8\pos), diposisikan supaya ATAS TINTA-nya mengikuti inkLineTops().
//
// Terukur pada burn 1080x1920, \an8\pos(540,305), baris "Fbal Ini" px79 lalu
// "Ternyata":
//
//              atas tinta b.1   atas tinta b.2   celah tinta
//   px79/px79        323              422            37   <- acuan "normal"
//   px79/px200       323              450            65   <- 28px kelebihan
//   px79/px200 BARU  323             ~421           ~37   <- model ini
//
// Kelebihan 28px itu = (baselineEm - capHeight/upem) x (200 - 79), yaitu ruang
// kosong di atas kapital kata besar. Model ini membuangnya persis, sehingga
// kapital baris besar mendarat di tempat baris normal — bukan merapatkan
// semaunya.
//
// Baris pertama SELALU tetap di ty2, jadi jangkar judul tidak bergeser.
// Mengembalikan null kalau metriknya tak lengkap; pemanggil lalu memakai
// titleLineTops() seperti sebelumnya.
function titleInkLineTops(fitLines, ty2, opts) {
  const per = (fitLines || []).map(line => titleLineInkPx(line, opts));
  if (per.length < 2 || per.some(m => !m)) return null;
  const gapEm = titleInkGapEm(opts);
  const leadEm = titleInkLeadEm(opts);
  if (gapEm == null || leadEm == null) return null;
  // Dibangun DI ATAS titleLineTops() — model kotak-em yang sudah diukur benar
  // (lihat tabel di [TITLE-LINE-PITCH]) — bukan menggantinya. Jadi perubahannya
  // tepat sebesar kelebihan yang dibawa baris besar, dan tidak ada lagi yang
  // ikut bergeser diam-diam.
  const base = titleLineTops(fitLines, ty2, opts);
  // titleLinePitch mengembalikan NaN kalau lineHeightEm tak diberikan. Lebih
  // baik menolak di sini dan jatuh ke jalur lama daripada memancarkan
  // \pos(x,NaN), yang menerbangkan baris itu ke luar frame.
  if (base.some(y => !Number.isFinite(y))) return null;
  const offs = inkLeadOffsets(per, leadEm, gapEm);
  // Gerbangnya OFFSET, bukan "ukuran barisnya beda". Dua sebabnya, dua-duanya
  // terukur:
  //   - Arah MENGECIL pada face yang gap = lead memberi offset nol semuanya.
  //     Memecah judul jadi N Dialogue di situ membayar seluruh risiko
  //     strukturalnya untuk nol manfaat.
  //   - Baris yang ganti FONT tanpa ganti ukuran punya cacat yang sama persis
  //     (Anton menyumbang 24,3px ruang kosong ekstra pada px79) tapi ukurannya
  //     seragam, jadi gerbang lama melewatkannya sama sekali.
  if (!offs.some(o => Math.abs(o) >= 0.5)) return null;
  const out = base.map((y, i) => Math.round(y + offs[i]));
  return out.every(y => Number.isFinite(y)) ? out : null;
}

// [TITLE-BOX-TRACK] `trackPxFor(tk)` = the \fsp that token's override emits
// (tokOpen). libass adds it after every glyph, spaces included, so a word
// spans `wPx + trk*(nChar-1)` and moves the pen `wPx + trk*nChar`; the space
// after it is one more glyph. Same per-boundary model [TITLE-FIT-TRACK]
// measured for the fit. Without it the rects/anchors assumed an untracked
// line: a boxed Anton word (default \fsp-7) covered the next word's first
// letter. Defaults to 0, so a track:0 title is byte-identical.
function titleWordAnchors({ fitLines, fs2, fontsDir, baseFont, boldDefault, tx2, ty2, lineHeightEm, SY, lineTops: lineTopsIn, trackPxFor = null }) {
  const pitchOpts = { fs2, fontsDir, baseFont, boldDefault, lineHeightEm, SY };
  // [TITLE-INK-LEADING] Atas baris boleh datang dari luar, supaya kata yang
  // digeser, kotak highlight, dan teks barisnya memakai SATU set posisi.
  const lineTops = Array.isArray(lineTopsIn) && lineTopsIn.length
    ? lineTopsIn : titleLineTops(fitLines, ty2, pitchOpts);
  const out = [];
  let flatIdx = 0;
  fitLines.forEach((line, lineIdx) => {
    const lineHeightPx = titleLinePitch(line, pitchOpts);
    const widths = line.map((tk) => {
      const st = tk.style || {};
      const fn = st.fn || baseFont;
      const bold = st.b != null ? !!st.b : !!boldDefault;
      const italic = !!st.i;
      const fsw = st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fs2;
      const wEm = textWidthEmSafe(String(tk.text || ''), fn, fontsDir, bold, italic) || 0;
      // [TITLE-WORD-GAP-SIZE] Celah antar kata selalu seukuran JUDUL, mengikuti
      // preview: di sana spasi pemisah adalah text node milik KONTAINER, jadi
      // ia memakai font dan ukuran judul, bukan ukuran kata di sebelahnya.
      // Tanpa ini, kata yang diperbesar diikuti celah yang ikut membesar —
      // "spacing per wordnya gapnya gede banget" dari laporan.
      const spaceEm = textWidthEmSafe(' ', baseFont, fontsDir, !!boldDefault, false) || 0;
      const nChar = Array.from(String(tk.text || '')).length;
      const trk = trackPxFor ? (+trackPxFor(tk) || 0) : 0;
      return { wPx: wEm * fsw, spacePx: spaceEm * fs2, fsw, fn, nChar, trk, visW: wEm * fsw + trk * Math.max(0, nChar - 1) };
    });
    // [TITLE-CENTER-FLOW] The LAST word counts its trailing \fsp too: libass
    // centres an \an8 line on its pen advance, which includes the spacing
    // after the final glyph. Using the visual width here put the whole model
    // |trk|/2 left of what libass drew — invisible for anchored words (their
    // own \an8 centring had the opposite error) but every title box sat ~4px
    // left of its word (measured at 96px, \fsp-7: pad 24 left / 15 right,
    // vs 20/19 with track:0).
    const lineWidthPx = widths.reduce((sum, w, i) => sum + w.wPx + (i < widths.length - 1
      ? w.spacePx + w.trk * (w.nChar + 1)
      : w.trk * w.nChar), 0);
    const lineLeftPx = tx2 - lineWidthPx / 2;
    const lineTopPx = lineTops[lineIdx];
    let cursor = lineLeftPx;
    line.forEach((tk, wordInLine) => {
      const w = widths[wordInLine];
      out.push({
        flatIdx, lineIdx, wordInLine,
        fsw: w.fsw, fn: w.fn, wPx: w.wPx,
        // [TITLE-CENTER-FLOW] Drawn with \an8\pos, so libass centres the
        // word's pen advance (trailing \fsp included) on this x — centre that,
        // not the visual width, or the word lands |trk|/2 right of its slot.
        centerX: cursor + (w.wPx + w.trk * w.nChar) / 2,
        lineTopPx, lineHeightPx,
      });
      cursor += w.wPx + w.spacePx + w.trk * (w.nChar + 1);
      flatIdx++;
    });
  });
  return out;
}

function titleBoxRects({ fitLines, boxedIdx, fs2, fontsDir, baseFont, boldDefault, tx2, ty2, lineHeightEm, SY, lineTops: lineTopsIn, trackPxFor = null }) {
  if (!boxedIdx || !boxedIdx.size) return [];
  const pitchOpts = { fs2, fontsDir, baseFont, boldDefault, lineHeightEm, SY };
  // [TITLE-INK-LEADING] lihat catatan yang sama di titleWordAnchors.
  const lineTops = Array.isArray(lineTopsIn) && lineTopsIn.length
    ? lineTopsIn : titleLineTops(fitLines, ty2, pitchOpts);
  const rects = [];
  let flatIdx = 0;
  fitLines.forEach((line, lineIdx) => {
    const lineHeightPx = titleLinePitch(line, pitchOpts);
    // Per-word measured width (px) and cumulative left offset within this
    // line, mirroring the exact per-word measurement TITLE-FIT-WIDTH already
    // does (same textWidthEmSafe call, same bold/italic resolution) — kept
    // as a SEPARATE pass (not reused from that loop) because that loop runs
    // with the PRE-shrink font size and only tracks the line's TOTAL width,
    // not each word's own offset.
    const widths = line.map((tk) => {
      const st = tk.style || {};
      const fn = st.fn || baseFont;
      const bold = st.b != null ? !!st.b : !!boldDefault;
      const italic = !!st.i;
      const fsw = st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fs2;
      const wEm = textWidthEmSafe(String(tk.text || ''), fn, fontsDir, bold, italic) || 0;
      // [TITLE-WORD-GAP-SIZE] Celah antar kata selalu seukuran JUDUL, mengikuti
      // preview: di sana spasi pemisah adalah text node milik KONTAINER, jadi
      // ia memakai font dan ukuran judul, bukan ukuran kata di sebelahnya.
      // Tanpa ini, kata yang diperbesar diikuti celah yang ikut membesar —
      // "spacing per wordnya gapnya gede banget" dari laporan.
      const spaceEm = textWidthEmSafe(' ', baseFont, fontsDir, !!boldDefault, false) || 0;
      const nChar = Array.from(String(tk.text || '')).length;
      const trk = trackPxFor ? (+trackPxFor(tk) || 0) : 0;
      return { wPx: wEm * fsw, spacePx: spaceEm * fs2, fsw, fn, nChar, trk, visW: wEm * fsw + trk * Math.max(0, nChar - 1) };
    });
    // [TITLE-CENTER-FLOW] The LAST word counts its trailing \fsp too: libass
    // centres an \an8 line on its pen advance, which includes the spacing
    // after the final glyph. Using the visual width here put the whole model
    // |trk|/2 left of what libass drew — invisible for anchored words (their
    // own \an8 centring had the opposite error) but every title box sat ~4px
    // left of its word (measured at 96px, \fsp-7: pad 24 left / 15 right,
    // vs 20/19 with track:0).
    const lineWidthPx = widths.reduce((sum, w, i) => sum + w.wPx + (i < widths.length - 1
      ? w.spacePx + w.trk * (w.nChar + 1)
      : w.trk * w.nChar), 0);
    const lineLeftPx = tx2 - lineWidthPx / 2;
    const lineTopPx = lineTops[lineIdx];
    let cursor = lineLeftPx;
    line.forEach((tk, wordInLine) => {
      const w = widths[wordInLine];
      if (boxedIdx.has(flatIdx)) {
        // [HOOK-FONT] Height from the face that actually renders this word,
        // not the constant: a title carries its own font override, and a
        // tall-capped face overflowed a BOX_H_EM box (Anton, measured).
        // [HOOK-FONT] Height is a fraction of the size libass actually renders
        // at — assFs = fsw x fontEmScale — not of fsw itself. BOX_H_EM (1.20)
        // was tuned against a face whose emScale is 1.237, i.e. it has always
        // meant "0.97 of the ASS size"; spelling that out keeps the default
        // face byte-identical while a face with a different emScale (Anton,
        // 1.733) finally gets a box that matches its own glyphs.
        const emS = fontEmScale(w.fn || baseFont, fontsDir, !!boldDefault, false) || 0;
        const rect = boxRectEm({
          wordWidthEm: w.visW / w.fsw,
          hEm: emS > 0 ? BOX_H_OVER_ASSFS * emS : 0,
        });
        const wPx = Math.round(rect.wEm * w.fsw);
        const hPx = Math.round(rect.hEm * w.fsw);
        const wordCenterX = cursor + w.visW / 2;
        // [HOOK-FONT] Centre on the INK, not on the line box. Where a face
        // puts its capitals inside its line box varies — Anton sits 1.06 of
        // the px size below the top, the default face 0.68 — so centring on
        // the line box leaves a tall-capped face's text riding low in its own
        // highlight. Same fontInkCenterEm the caption box path already uses
        // for this ([BOX-VALIGN]); the line box is only the fallback.
        // [BOX-VALIGN-BOLD] Bold/italik PER-KATA, sama seperti dua pengukuran
        // lebar di atas dan sama seperti cyFor() di jalur caption. Memakai bold
        // tingkat-judul di sini berarti kotaknya ditinggikan dari angka face
        // yang berbeda dengan face yang benar-benar dirender, untuk keluarga
        // yang punya face bold sungguhan. Ditemukan saat kalibrasi lintas font.
        const stW = tk.style || {};
        const inkEm = fontInkCenterEm(
          stW.fn || baseFont, fontsDir,
          stW.b != null ? !!stW.b : !!boldDefault,
          !!stW.i,
        );
        const lineCenterY = (inkEm == null)
          ? lineTopPx + lineHeightPx / 2
          : lineTopPx + w.fsw * inkEm;
        // [TITLE-DRAG-BOX] The rect follows its word. Reported from a real
        // render: an EMPTY lime box left hanging mid-frame while the title sat
        // at the top, because both words had been dragged. In the PREVIEW the
        // box is a CSS background on the word's own span, so it moves with the
        // transform for free; in the burn it is a separate \p1 Dialogue that
        // was never given the offset. The [TITLE-WORD-DRAG] note claims "a
        // dragged word and its box move together" — the ANCHORS were shared,
        // the rect was not. Same SY-on-both-axes rule as the word's own redraw.
        const dxPx = Math.round((+(tk.style && tk.style.dx) || 0) * SY);
        const dyPx = Math.round((+(tk.style && tk.style.dy) || 0) * SY);
        const leftPx = Math.round(wordCenterX - wPx / 2) + dxPx;
        const topPx = Math.round(lineCenterY - hPx / 2) + dyPx;
        // [BOX-MERGE] Neighbouring boxed words become ONE rectangle. Drawn per
        // word, two rounded rects butt together and leave a dark notch where
        // they meet — reported from a real render of "Bilang Naik", where the
        // highlight read as two chips rather than one block. Extend the run
        // instead: same left edge, right edge moved out to cover this word and
        // the space before it.
        const prev = rects[rects.length - 1];
        // [TITLE-DRAG-BOX] Two boxed neighbours only form ONE block while they
        // are still side by side. Drag one away and merging them stretches a
        // single rectangle across the gap.
        const adjacent = prev && prev.lineIdx === lineIdx && prev.wordIdx === flatIdx - 1
          && prev.dxPx === dxPx && prev.dyPx === dyPx;
        if (adjacent) {
          prev.wPx = (leftPx + wPx) - prev.boxLeftPx;
          prev.hPx = Math.max(prev.hPx, hPx);
          prev.boxTopPx = Math.min(prev.boxTopPx, topPx);
          prev.wordIdx = flatIdx;
        } else {
          rects.push({
            // [BOX-ANIM-SCALE] lineTopPx = jangkar \an8 baris ini, yaitu titik
            // yang dipakai teksnya sebagai pusat penskalaan. Dibawa ikut, BUKAN
            // dihitung ulang di pemanggil: file ini punya riwayat panjang dua
            // salinan logika pembagian/pengukuran baris yang perlahan berselisih.
            lineIdx, wordIdx: flatIdx, fsw: w.fsw, lineTopPx,
            wPx, hPx, boxLeftPx: leftPx, boxTopPx: topPx, dxPx, dyPx,
          });
        }
      }
      cursor += w.wPx + w.spacePx + w.trk * (w.nChar + 1);
      flatIdx++;
    });
  });
  return rects;
}

// [HOOK-OVER-CAPTIONS] A hook that took the caption area hides the captions
// until it ends; a cue straddling the end starts when the hook goes.
function trimCuesUnderHook(cues, titles) {
  const hideUntil = Math.max(0, ...(Array.isArray(titles) ? titles : [])
    .filter((T) => T && T.hideCaptions).map((T) => +T.end || 0));
  if (!(hideUntil > 0)) return cues;
  return (cues || []).filter((c) => (+c.end || 0) > hideUntil + 0.05)
    .map((c) => ((+c.start || 0) < hideUntil ? Object.assign({}, c, { start: hideUntil }) : c));
}

function buildAss(cues, fontSize, style, yPos, xPos, anim = 'pop', glow = true, titles = [], format = 'face', fontOverride = '', box = null, layerCaptions = [], kineticCaption = '', extrasPass = false) {
  if (box?.boxColor) kineticCaption = '';
  // Segment transcripts have no editor-created tokens on their first render.
  if (box?.boxColor) cues = cues.map(c => Array.isArray(c.tokens) && c.tokens.length ? c : {
    ...c, tokens: String(c.text || '').trim().split(/\s+/).filter(Boolean).map(text => ({ text })),
  });
  const hasMotion = c => c.textMotion && ((c.textMotion.motion && c.textMotion.motion !== 'none') || (c.textMotion.flicker && c.textMotion.flicker !== 'none'));
  if (!extrasPass && cues.some(hasMotion)) {
    // Custom entrance/flicker replaces only entrance timing, never SOCL's
    // font, colours, per-word overrides or box geometry.
    const normal = buildAss(cues.filter(c => !hasMotion(c)), fontSize, style, yPos, xPos, anim, glow, titles, format, fontOverride, box, layerCaptions, kineticCaption, true);
    return normal + '\n' + cues.filter(hasMotion).map(c => {
      const custom = { ...c, tokens: Array.isArray(c.tokens) ? c.tokens.map(t => ({ ...t, style: { ...t.style, an:'none' } })) : c.tokens };
      return buildAss([custom], fontSize, style, yPos, xPos, 'none', glow, [], format, fontOverride, box, [], kineticCaption, true).split('\n').filter(line => line.startsWith('Dialogue:')).join('\n');
    }).join('\n');
  }
  // [CUE-BRIDGE] A small gap closes before anything else reads the timings —
  // the same shared rule both previews apply (caption-box.js).
  cues = bridgeCueGaps(cues);
  cues = trimCuesUnderHook(cues, titles);   // [HOOK-OVER-CAPTIONS]
  const s0 = SUB_STYLES[style] || SUB_STYLES.neon_green;
  // [BURN-FONT-TRACK] Swapping the face must swap its tracking too. This used
  // to replace `font` alone and keep the STYLE's trackEm, so picking "Open
  // Sauce Tight" over white_clean burned at the style's -0.05 while the font
  // wants -0.10 — the "burn font tidak tight" report, and a preview/burn
  // mismatch on top, since the specimen card advertises its own value again.
  // A face with no entry (Pinyon Script, Apple Garamond — a connected script
  // and an old-style serif, neither of which should be crushed) keeps the
  // style's value rather than being assigned a guess.
  const overrideEm = fontOverride ? fontTrackEm(fontOverride) : null;
  const s = fontOverride
    ? { ...s0, font: fontOverride, ...(overrideEm != null ? { trackEm: overrideEm } : {}) }
    : s0;
  // [AR-BURN] Scale the canonical 1080×1920 authoring space into the output PlayRes.
  const PR = assPlayRes(format);
  const SX = PR.w / 1080;   // frame-width scale (base X, margins)
  const SY = PR.h / 1920;   // font/height scale (Y, font size, blur, spacing)
  // Per-word offsets (tk.ax, st.dx/dy) are baked by the renderer with a
  // HEIGHT-based factor (overlayPx / (H/1920)), i.e. they are font-proportional,
  // not frame-width-relative — so BOTH axes must scale with SY like the font.
  // Scaling ax/dx by SX spread landscape words SX/SY = 3.16× too far apart.
  // Reassign the roots to output-space so the ~15 derived uses below (blur, gbord,
  // slidePx, per-token fs defaults) scale automatically. `xPos !== 540` keeps the
  // canonical-center sentinel test on the ORIGINAL value before scaling.
  const xCanonicalCenter = (xPos == null || xPos === 540);
  const x = xCanonicalCenter ? null : Math.round(xPos * SX);
  fontSize = Math.round(fontSize * SY);
  // yPos is top-origin (0 = top of the frame) to match the preview overlay.
  const y = Math.max(20, Math.min(PR.h - 20, Math.round((yPos || 540) * SY)));
  // [WYSIWYG-SPACING] Style Spacing derives from trackEm × the OUTPUT-scaled
  // font size so tracking stays proportional at any size (the old constant-px
  // Spacing drifted looser/tighter as the user resized the caption).
  // [TRACK-UNIFORM] `!= null` rather than `||`: a MISSING trackEm means the style
  // predates the uniform value and should get it (the neon/highlight styles never
  // declared one, so they burned completely untracked while every other style
  // tightened). An EXPLICIT 0 — which is what fontTrackEm returns for Pinyon
  // Script — must survive as 0, and `||` would have swallowed it back to the
  // default and crushed the one face that must not be crushed.
  let styleSpacing = Math.round((s.trackEm != null ? s.trackEm : TRACK_EM) * fontSize);
  const marginX = Math.round(40 * SX);
  // [FS-EM-SCALE] Everything above works in CSS-equivalent pixels, because that
  // is what the preview lays out in and what the renderer bakes per-word offsets
  // against. libass does NOT: its Fontsize is the ascender-to-descender height,
  // not the em square, so it renders `fontSize` at an em of fontSize/ratio —
  // between 1.00× and 1.51× smaller depending purely on the face. Convert here,
  // at the only two places a size actually reaches libass (this Style line and
  // the per-token \fs), and leave every other derived value (spacing, glow,
  // blur, slide distance, positions) on the canonical scale where it belongs.
  const styleFont = s.font || 'Open Sauce Two ExtraBold';
  // [CAPTION-FIT-WIDTH] chunkWordsToCues groups a fixed word COUNT per cue
  // with no idea how wide the actual glyphs render — reported live with a
  // real render: three elongated ALL-CAPS interjections chunked onto one
  // cue ("BOOOOOM!! booOOom booOOOMM") ran off BOTH the left and right
  // edges of a 1080-wide frame for the cue's entire display window, in
  // every animation mode (the animation only moves/fades text that was
  // already too wide before animating started). Mirrors [TITLE-FIT-WIDTH]
  // below's fix for the identical class of bug in titles: measure the
  // actual rendered width of the WIDEST cue with textWidthEmSafe (the same
  // glyph-metric measurer the box-highlight feature already trusts,
  // including per-character tracking since styleSpacing widens every gap),
  // and shrink the caption fontSize for THIS WHOLE CLIP if even one cue
  // would overflow. A per-cue shrink was rejected: several code paths below
  // (box width/position, per-word \fs, the [V4+ Styles] Fontsize baked once
  // into `head`) all trust ONE cue-independent size for this burn pass.
  {
    const fitFontsDir = assFontsDirFs();
    const capMaxWidthPx = Math.max(40, PR.w - 2 * marginX);
    let widestCuePx = 0;
    for (const c of cues) {
      const txt = String(c.text || '').trim();
      if (!txt) continue;
      // [FIT-WIDTH-BOLD] Measure the FACE libass will actually render — a bold
      // style (cinematic_white, bw) draws through a real bold sibling (or a
      // synthesized bold) that is wider than the regular face this guard used
      // to measure. Italic stays false: captions carry no style-level italic.
      const em = textWidthEmSafe(txt, styleFont, fitFontsDir, !!s.bold, false);
      if (!em) continue;
      const trackPx = styleSpacing * Math.max(0, Array.from(txt).length - 1);
      const w = em * fontSize + trackPx;
      if (w > widestCuePx) widestCuePx = w;
    }
    if (widestCuePx > capMaxWidthPx && widestCuePx > 0) {
      fontSize = Math.max(20, Math.round(fontSize * (capMaxWidthPx / widestCuePx)));
      // styleSpacing above was derived from the pre-shrink fontSize; the
      // [V4+ Styles] line below bakes styleSpacing in, so it must reflect
      // the SAME shrunk size or tracking would visibly widen the text back
      // toward the edge it was just pulled back from.
      styleSpacing = Math.round((s.trackEm != null ? s.trackEm : TRACK_EM) * fontSize);
    }
  }
  // [FS-EM-SCALE-WIN] assFontsDirFs(), NOT assFontsDir() — this reads the TTFs
  // off disk, so it needs the unescaped path. See the note on both functions.
  // [FS-EM-FACE] `bold`/`italic` are the state THIS text will be emitted with.
  // libass swaps to a real bold/italic sibling when the family has one, and
  // that sibling can carry a different (asc-desc)/upem — Apple Garamond's do.
  const assFs = (px, fontName, bold = false, italic = false) =>
    Math.max(1, Math.round(px * fontEmScale(fontName, assFontsDirFs(), bold, italic)));
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PR.w}
PlayResY: ${PR.h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${styleFont},${assFs(fontSize, styleFont, !!s.bold, false)},${s.primary},${s.secondary},${s.outline},${s.back},${s.bold},0,0,0,${s.scaleX || 100},100,${styleSpacing},0,1,4,0,8,${marginX},${marginX},${y},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  // Glow radius scales with font size so it stays proportional at any size.
  // Per-style multiplier lets cinematic-clean styles tone the halo down so the
  // text stays readable instead of dissolving into white blur.
  const glowMul = s.glowMul != null ? s.glowMul : 1;
  // White/near-white halos wash out the letters — keep their bloom gentle so the
  // glyph edge stays crisp. Detect by the glow colour being light (ASS BBGGRR).
  const isLightGlow = (() => {
    const m = /([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(s.glow).replace(/&H|&/gi, '').slice(-6));
    if (!m) return false;
    const avg = (parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16)) / 3;
    return avg > 200;
  })();
  // Light halos washing out letters is only a risk when the text ALSO has a
  // dark edge to keep crisp. For cleanEdge styles the white halo IS the effect
  // (no dark edge), so keep it full-strength — don't damp it.
  const softMul = (isLightGlow && !s.noEdge) ? 0.6 : 1;
  const blur = Math.max(2, Math.round((fontSize / 6) * glowMul * softMul));
  // Used by buildAnimTokenCue's per-word pop/blur reveal (wBlur) further down —
  // kept here rather than only inside animFragments() because that function's
  // copy is scoped to its own call and this one needs to outlive it.
  const textStartBlur = Math.round(blur * 1.8);
  // Per-style glow transparency. A solid white halo around white text washes the
  // letters out (no contrast). `glowAlpha` (ASS alpha &HXX&: 00=opaque, FF=clear)
  // makes the halo a faint aura so the crisp white text stays readable. Applied
  // ONLY to glow layers.
  const gAlpha = s.glowAlpha ? `\\1a${s.glowAlpha}\\3a${s.glowAlpha}` : '';
  // The "visible" alpha a glow character should reveal TO in typewriter mode.
  // Reveal to the thin glowAlpha (not full opaque) so the halo stays subtle as
  // each char types in. Use explicit \1a/\3a (never \alpha — \alpha shorthand
  // would clobber \3a and blow the halo back to full opacity).
  const gEnd = s.glowAlpha || '&H00&';
  // Override-tag colours need 6-digit &HBBGGRR& form (strip the style alpha byte).
  const c6 = h => '&H' + String(h).replace(/&H/i, '').replace(/&$/, '').slice(-6) + '&';
  const glowC = c6(s.glow);
  const textC = c6(s.primary);
  // ── Per-word styling (feature: manual per-word caption styling) ──
  // A cue may carry `tokens: [{ text, style? }]` where style overrides font,
  // bold, italic, colour and size for that single word. We always emit the
  // base value for any attribute a token does NOT override, so styling never
  // leaks from one word to the next. hex '#RRGGBB' → ASS '&HBBGGRR&'.
  const hexToAss = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    const r = m[1].slice(0,2), g = m[1].slice(2,4), b = m[1].slice(4,6);
    return `&H${b}${g}${r}&`.toUpperCase();
  };
  const baseFn   = s.font || 'Open Sauce Two ExtraBold';   // already carries fontOverride
  const baseBold = s.bold ? 1 : 0;
  // [WYSIWYG-SPACING] em-based letter-spacing, single source of truth shared
  // with the CSS preview (renderer baseStyle / styles.css class rules):
  //   • token WITH a per-word font override → that font's em (Anton -0.02,
  //     Open Sauce -0.10, Poppins -0.045, Times MT Condensed -0.05,
  //     Arial Nova Cond -0.03, Cooper BT -0.03) — mirrors
  //     the inline letter-spacing baseStyle() writes on the span.
  //   • token WITHOUT an override → the style's trackEm (what the span
  //     inherits from the .style-* class rule in preview).
  // \fsp is px; em × fs converts. Negative = tighter.
  // Single source of truth, hoisted above buildAss so the font override can
  // reach it. See fontTrackEm().
  const FONT_EM = fontTrackEm;
  // [FSP-NEGATIVE] An em of exactly 0 must emit `\fsp0`, NOT an empty string.
  // Emitting nothing used to mean "no tracking", which was true while nothing
  // set a line-level value. Now that every Dialogue line is stamped with the
  // style's \fsp (libass ignores a negative Style Spacing — see the note at the
  // end of buildAss), emitting nothing means "inherit the line", and the one
  // face that must never be tightened — Pinyon Script, whose letterforms join —
  // would silently inherit the tightening anyway. `em == null` still means
  // "genuinely no opinion, inherit"; 0 is now an assertion.
  const emFsp = (em, fs) => (em == null ? '' : `\\fsp${Math.round(em * fs)}`);
  // [MC-TRACK] `trackEm` is a per-token letter-spacing override — Manual
  // Caption stamps its entry's own spacing onto every token it splices in, so
  // a hand-authored caption can breathe without touching the global default.
  // Absent, the font/style chain decides exactly as before.
  const fontFsp = (fn, fs, fnOverridden, trackEm) => {
    if (trackEm != null && Number.isFinite(+trackEm)) return emFsp(+trackEm, fs);
    if (fnOverridden) {
      const em = FONT_EM(fn);
      return em != null ? emFsp(em, fs) : emFsp(s.trackEm, fs);
    }
    return emFsp(s.trackEm, fs);
  };
  const isPositioned = (tk) => {
    const st = tk && tk.style; return !!st && ((+st.dx) || (+st.dy));
  };
  // Legacy per-word font values → names libass actually resolves. Older clips
  // saved the Poppins PS names, which libass silently swaps for Helvetica
  // (PS-name matching only works for CFF OTFs, not these TTFs).
  const FN_ALIAS = { 'Poppins-Light': 'Poppins Light', 'Poppins-Bold': 'Poppins Bold' };
  const normFn = (fn) => FN_ALIAS[fn] || fn;
  // Build the inline ASS text for a cue from its tokens. `withColor` is false
  // for the glow layer (the layer tag already paints the halo colour). Tokens
  // with manual dx/dy are EXCLUDED — they're emitted as separate Dialogue lines
  // with their own \pos so they float independently.
  const tokenText = (tokens, withColor) => tokens.filter(tk => !isPositioned(tk)).map(tk => {
    const st = tk.style || {};
    const fn = normFn(st.fn) || baseFn;
    const b  = (st.b != null) ? (st.b ? 1 : 0) : baseBold;
    const it = st.i ? 1 : 0;
    const fs = st.fs ? Math.round(st.fs * SY) : fontSize;   // [AR-BURN] token size → output space
    // [FS-EM-SCALE] `fs` stays CANONICAL (CSS px): \fsp and every other
    // derived value must keep using it. Only the \fs tag libass reads is
    // converted, and with THIS token's own font — a per-word face swap
    // changes the ratio, which is why mixed-font cues drifted apart.
    const fsA = assFs(fs, fn, !!b, !!it);
    const colTag = withColor ? `\\1c${(st.color && hexToAss(st.color)) || textC}` : '';
    const txt = String(tk.text || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
    return `{\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fontFsp(fn, fs, !!st.fn, st.tr)}${colTag}}${txt} `;
  }).join('').trimEnd();
  // Shared per-word glow-colour resolver for every "structured" cue path
  // (tokenized, per-word-animated, typewriter). Mirrors the WYSIWYG preview
  // (renderer.js `paintCue` / `.cap-hi`): for highlight-family styles (`hiC`
  // set — bw_hi_*, bw_neon_*, white_hi_lime) only the one accented word gets
  // a coloured halo; every OTHER un-coloured word gets NONE (returns null =
  // "hide", never the style's raw glowC, which is opaque BLACK for all of
  // them). A word with its own st.color always glows in that colour, hi
  // slot or not. Styles with no highlight concept (hiC null) keep the
  // original flat glowC on every word.
  const glowColorFor = (st, isHiWord, hiC) => {
    if (st && st.color) return hexToAss(st.color);
    if (isHiWord) return hiC;
    if (hiC) return null;
    return glowC;
  };
  // Glow-layer variant of tokenText: a manually-styled word (st.color set,
  // e.g. via the Caption Editor) must glow in ITS OWN colour, not the cue's
  // base glowC. Without this, any per-word override routes the whole cue
  // through the hasTokens path below and every word — including ones with
  // no colour override — gets a black halo box painted behind it, because
  // glowC resolves to black for highlight styles (their real accent colour
  // lives in st.color/hiC, not the style's `glow` field). `hiC` (the cue's
  // resolved highlight accent, or null) lets the LAST inline word keep its
  // automatic highlight glow even inside a tokenized cue — previously the
  // whole accent concept was silently dropped the instant any word carried
  // a style override.
  const tokenGlowText = (tokens, hiC) => {
    let lastIdx = -1;
    tokens.forEach((tk, i) => { if (!isPositioned(tk)) lastIdx = i; });
    let out = '';
    tokens.forEach((tk, i) => {
      if (isPositioned(tk)) return;
      const st = tk.style || {};
      const fn = normFn(st.fn) || baseFn;
      const b  = (st.b != null) ? (st.b ? 1 : 0) : baseBold;
      const it = st.i ? 1 : 0;
      const fs = st.fs ? Math.round(st.fs * SY) : fontSize;
      const fsA = assFs(fs, fn, !!b, !!it);
      const txt = String(tk.text || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
      const isHiWord = !!hiC && i === lastIdx && !st.color;
      const gc = glowColorFor(st, isHiWord, hiC);
      const fontTag = `\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fontFsp(fn, fs, !!st.fn, st.tr)}`;
      // [BOX-SAFE] This path is static (no \t reveal) — a hidden word's
      // \1a\3a=FF otherwise persists forward onto the NEXT word's override
      // block (ASS state carries between runs), which would silently hide
      // the accent word's colour too instead of just removing its black
      // halo. Every visible run must explicitly reset alpha back to gEnd.
      out += gc == null
        ? `{${fontTag}\\1a&HFF&\\3a&HFF&}${txt} `
        : `{${fontTag}\\3c${gc}\\1c${gc}\\1a${gEnd}\\3a${gEnd}}${txt} `;
    });
    return out.trimEnd();
  };
  // Build text + glow Dialogue lines for a single positioned token. dx/dy are
  // offsets in 1080×1920 ASS pixel space from the cue's top-center origin.
  const baseX = x != null ? x : Math.round(PR.w / 2);   // [AR-BURN] center in output space
  const baseY = y;
  const positionedTokLines = (tk, start, end, hiC) => {
    const st = tk.style || {};
    const fn = normFn(st.fn) || baseFn;
    const b  = (st.b != null) ? (st.b ? 1 : 0) : baseBold;
    const it = st.i ? 1 : 0;
    const fs = st.fs ? Math.round(st.fs * SY) : fontSize;   // [AR-BURN]
    // [FS-EM-SCALE] `fs` stays CANONICAL (CSS px): \fsp and every other
    // derived value must keep using it. Only the \fs tag libass reads is
    // converted, and with THIS token's own font — a per-word face swap
    // changes the ratio, which is why mixed-font cues drifted apart.
    const fsA = assFs(fs, fn, !!b, !!it);
    const tc = (st.color && hexToAss(st.color)) || textC;
    const txt = String(tk.text || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
    const px = Math.round(baseX + (+st.dx || 0) * SY);      // [AR-BURN] font-proportional offsets
    const py = Math.round(baseY + (+st.dy || 0) * SY);
    const ovr = `\\an8\\pos(${px},${py})`;
    const fsp = fontFsp(fn, fs, !!st.fn, st.tr);
    const textTagP = cleanEdge
      ? `{${ovr}${textAnim}\\bord0${dropTag}\\1c${tc}\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fsp}}`
      : `{${ovr}${textAnim}\\bord3\\3c&H000000&\\shad2\\1c${tc}\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fsp}}`;
    const textLine = `Dialogue: 1,${start},${end},Default,,0,0,0,,${textTagP}${txt}`;
    // Glow halo renders whenever glow is ON — independent of cleanEdge. For
    // cleanEdge (no-dark-outline) styles the halo is a soft WHITE bloom; only
    // the black text border is dropped, NOT the glow.
    if (!glow) return textLine;
    // Glow colour mirrors the word's own resolved colour, not the cue's base
    // glowC — a manually-coloured/positioned word must glow in its own
    // accent. A dragged word is never the auto-highlighted "last word" (that
    // slot only ever applies to inline tokens), so isHiWord is always false
    // here — matching tokenGlowText's/buildTypeCue's convention.
    const gc = glowColorFor(st, false, hiC);
    if (gc == null) return textLine;   // highlight-family style, plain dragged word → no halo
    const glowTagP = `{${ovr}${glowAnim}\\bord${gbord}\\3c${gc}\\1c${gc}\\shad0\\blur${blur}${gAlpha}\\fn${fn}\\b${b}\\i${it}\\fs${fsA}}`;
    const glowLine = `Dialogue: 0,${start},${end},Default,,0,0,0,,${glowTagP}${txt}`;
    return `${glowLine}\n${textLine}`;
  };
  // A glow needs a thick coloured, blurred border behind the text. We render
  // each cue twice: Layer 0 = blurred halo (glow colour), Layer 1 = crisp text
  // with a thin black outline so it stays legible on bright backgrounds.
  const an   = '\\an8';
  const pos  = x != null ? `\\pos(${x},${y})` : '';
  const gbord = Math.max(3, Math.round((fontSize / 9) * glowMul * softMul));
  // ── Per-cue intro animation ──
  // Existing punchy modes:
  //   'pop'  → fade + scale-up (64→100) + blur-in (word "pops" in)
  //   'blur' → fade + blur-in only (no scale)
  // Elegant CapCut-style modes (softer, slower fade):
  //   'fade' → clean fade in/out, opacity only
  //   'rise' → slide up from below + fade (slide-then-fade)
  //   'drop' → slide down from above + fade
  //   'zoom' → gentle scale-in (90→100) + fade
  //   'none' → static
  // All styles (incl. cinematic_white) honour every anim mode, including the
  // character typewriter. The glow halo stays thin during typing because the
  // glow layer reveals via \1a/\3a → gEnd (not \alpha). No type→fade remap.
  // [TITLE-ANIM-PARITY] Fragments now come from the shared animFragments() —
  // see its own comment for why. `fontSize` here is the CUE's, so a rise/drop
  // travels a distance proportional to the caption's own size, same as before.
  const effAnim = anim;
  const { glowAnim, textAnim, slideMs, slidePx, scale0, scaleMs } = animFragments(effAnim, fontSize, glowMul, softMul);
  // buildAnimTokenCue's per-word reveal path (below) builds its own inline
  // fragments and needs these same constants in scope — see ANIM_TIMING's own
  // comment for why they can't just be re-derived from a different call.
  const { inMs, fadeIn, fadeOut, softIn, softInMs, softOut, slideFadeIn, slideFadeOut } = ANIM_TIMING;
  // Positioning: rise/drop animate position via \move (needs explicit coords);
  // every other mode keeps the static anchor.
  let posTag;
  if (effAnim === 'rise')      posTag = `\\move(${baseX},${baseY + slidePx},${baseX},${baseY},0,${slideMs})`;
  else if (effAnim === 'drop') posTag = `\\move(${baseX},${baseY - slidePx},${baseX},${baseY},0,${slideMs})`;
  else                         posTag = pos;
  const glowTag = `{${an}${posTag}${glowAnim}\\bord${gbord}\\3c${glowC}\\1c${glowC}\\shad0\\blur${blur}${gAlpha}}`;
  // ALL styles (incl. white/cinematic) render two-layer: a soft blurred halo
  // behind a CRISP text layer. The text keeps a firm black edge (\bord3 +
  // \shad2) and resolves to \blur0 — so glyphs stay sharp and high-contrast on
  // any background, while the separate halo provides the soft glow. White-glow
  // styles get a gentler halo (softMul) so the bloom never washes the letters.
  const cleanEdge = !!s.noEdge;
  // dropShadow: a very subtle dark offset shadow drawn UNDER the text for
  // readability on bright backgrounds (used by cinematic_white). Distance 2,
  // colour = style's `back` (e.g. soft near-black &H202020).
  // dropShadow: a hint of depth, not a real drop shadow. Heavily transparent
  // (\4a&HC0& = ~75% transparent) so it doesn't dirty the text on dark
  // backgrounds while still giving a touch of separation on bright ones.
  const dropTag = s.dropShadow ? `\\shad1\\4c&H404040&\\4a&HC0&` : '\\shad0';
  const textTag = cleanEdge
    ? `{${an}${posTag}${textAnim}\\bord0${dropTag}\\1c${textC}}`
    : `{${an}${posTag}${textAnim}\\bord3\\3c&H000000&\\shad2\\1c${textC}}`;
  // Highlight styles (e.g. bw_neon_green) render the last word of each cue in a
  // neon accent colour, with a coloured glow halo around only that word. The
  // rest of the cue stays in the base B&W styling.
  // [HL-PALETTE] Resolved per CUE, not once per track: bw_hi_rainbow rotates its
  // accent by cue index. Order is highlightCycle → highlight → no accent, and a
  // style may not set both (a test pins that, since setting both would silently
  // hide one). Cue index is the ONLY input, so the colour a given cue gets is
  // stable across re-renders and predictable from the preview.
  const hiColorFor = (ci) => {
    if (Array.isArray(s.highlightCycle) && s.highlightCycle.length) {
      return c6(s.highlightCycle[ci % s.highlightCycle.length]);
    }
    return s.highlight ? c6(s.highlight) : null;
  };
  // Split a cue text into [head, lastWord] so we can wrap the tail in ASS
  // colour-override tags. \N (forced line break) is treated as a word boundary.
  const splitLast = (txt) => {
    const m = /^(.*?)(\s|\\N\s?)([^\s\\]+)$/.exec(txt);
    return m ? [m[1] + m[2], m[3]] : ['', txt];
  };
  // ── Typewriter / word-by-word reveal ('type' anim) ──
  // Words fade in one after another (keyboard feel) while the WHOLE cue is laid
  // out from the start, so positions never shift (great for per-word manual
  // positioning). Inline words share one glow+text line pair and stagger via
  // per-word \alpha\t; positioned (dx/dy) words get their own \pos lines with a
  // staggered start time + fade.
  // Every style honours typewriter mode (incl. cinematic_white). The glow layer
  // reveals to the thin gEnd alpha so the halo never blows up during typing.
  const typeMode = anim === 'type';
  const TW_FADE = 90;   // per-word fade-in duration (ms) for positioned tokens
  // [HL-PALETTE] `ci` is the cue index, needed only to resolve a rotating
  // accent. [HL-TYPE-FIX] below records that this path once failed to highlight
  // at all while the normal path did, so the accent vanished on render while the
  // preview still showed it — a rotating accent doubles the chance of that
  // drift, hence the index is threaded here rather than recomputed.
  // (`cueIdx`, not `ci` — this function already uses `ci` for its running inline
  // CHARACTER index, and shadowing that would be a silent disaster.)
  // [TYPE-SOLID-FIRST] `joinPrev`: this cue directly follows another, so its
  // FIRST character is shown from the first frame — otherwise every sentence
  // change in Type mode blanked the caption for one frame (measured 0% on
  // 14/14 styles). The rest still types in.
  function buildTypeCue(c, start, end, cueIdx = 0, joinPrev = false) {
    const hiC = hiColorFor(cueIdx);
    const toks = (Array.isArray(c.tokens) && c.tokens.length)
      ? c.tokens
      : String(c.text || '').replace(/\r?\n/g, ' ').replace(/[{}]/g, '')
          .split(/\s+/).filter(Boolean).map(w => ({ text: w }));
    const n = Math.max(1, toks.length);
    const cueMs = Math.max(300, (c.end - c.start) * 1000);
    // True typewriter: reveal CHARACTER-by-character (not word-by-word). Stagger
    // each character across ~55% of the cue so the line finishes typing well
    // before the cue ends; cap the per-char step so long cues stay snappy.
    const inlineCharCount = toks.filter(t => !isPositioned(t))
      .reduce((sum, t) => sum + Array.from(String(t.text || '').replace(/[{}]/g, '')).length + 1, 0);
    const cstep = inlineCharCount > 1 ? Math.min(55, (cueMs * 0.55) / inlineCharCount) : 0;
    const TW_CHAR = 26;   // quick per-character fade-in (typewriter feel)
    // Positioned (dx/dy) words can't type per-char sensibly — keep a word stagger.
    const wstep = n > 1 ? Math.min(140, (cueMs * 0.6) / n) : 0;
    const lines = [];
    let inlineGlow = '', inlineText = '';
    let ci = 0;           // running inline character index for the typing stagger
    // [HL-TYPE-FIX] Highlight styles (bw_neon_*) colour the LAST word of a cue.
    // The non-type render path does this via splitLast()+hiC, but buildTypeCue
    // used to type EVERY char in the base colour — so the highlight vanished on
    // render while the CSS preview still showed it. Find the last inline (non-
    // positioned) token so its chars can be typed in the highlight colour.
    let lastInlineIdx = -1;
    toks.forEach((tk, i) => { if (!isPositioned(tk)) lastInlineIdx = i; });
    toks.forEach((tk, idx) => {
      const st = tk.style || {};
      const fn = normFn(st.fn) || baseFn;
      const b  = (st.b != null) ? (st.b ? 1 : 0) : baseBold;
      const it = st.i ? 1 : 0;
      const fs = st.fs ? Math.round(st.fs * SY) : fontSize;   // [AR-BURN]
      // [FS-EM-SCALE] `fs` stays CANONICAL (CSS px): \fsp and every other
      // derived value must keep using it. Only the \fs tag libass reads is
      // converted, and with THIS token's own font — a per-word face swap
      // changes the ratio, which is why mixed-font cues drifted apart.
      const fsA = assFs(fs, fn, !!b, !!it);
      // [HL-TYPE-FIX] Last word gets the neon highlight colour (fill + glow)
      // unless it carries its own explicit per-word colour override.
      const isHiWord = hiC && idx === lastInlineIdx && !st.color;
      const tcol = (st.color && hexToAss(st.color)) || (isHiWord ? hiC : textC);
      // [BOX-SAFE] gcol may be null: for highlight-family styles a word that
      // is neither the accented one nor manually coloured gets NO glow at
      // all, instead of the style's raw glowC (opaque black for every
      // bw_hi_*/bw_neon_*/white_hi_lime style) — that black used to render
      // as a solid box behind every other word the instant the style had
      // ANY highlight concept, e.g. mid-typing on bw_hi_rainbow.
      const gcol = glowColorFor(st, isHiWord, hiC);
      const txt = String(tk.text || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
      const fsp = fontFsp(fn, fs, false, (st && st.tr));
      if (isPositioned(tk)) {
        const px = Math.round(baseX + (+st.dx || 0) * SY);    // [AR-BURN] font-proportional
        const py = Math.round(baseY + (+st.dy || 0) * SY);
        const s2 = tcAss(c.start + (idx * wstep) / 1000);
        const ovrT = cleanEdge
          ? `\\an8\\pos(${px},${py})\\fad(${TW_FADE},${fadeOut})\\bord0${dropTag}\\1c${tcol}\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fsp}`
          : `\\an8\\pos(${px},${py})\\fad(${TW_FADE},${fadeOut})\\bord3\\3c&H000000&\\shad2\\1c${tcol}\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fsp}`;
        lines.push(`Dialogue: 1,${s2},${end},Default,,0,0,0,,{${ovrT}}${txt}`);
        if (glow && gcol != null) {
          const ovrG = `\\an8\\pos(${px},${py})\\fad(${TW_FADE},${fadeOut})\\bord${gbord}\\3c${gcol}\\1c${gcol}\\shad0\\blur${blur}${gAlpha}\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fsp}`;
          lines.push(`Dialogue: 0,${s2},${end},Default,,0,0,0,,{${ovrG}}${txt}`);
        }
      } else {
        // Emit each character with its own staggered alpha-reveal so letters
        // "type" in one after another. A trailing space is typed with the word.
        // [HL-PURE-GLOW] Highlight word types as a pure glow: no bold, thin
        // outline, no shadow — matches the non-type highlight path.
        const styleP = isHiWord
          ? `\\fn${fn}\\b0\\i${it}\\fs${fsA}${fsp}\\bord0\\shad0`
          : `\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fsp}`;
        const chars = Array.from(txt + (idx < toks.length - 1 ? ' ' : ''));
        for (const ch of chars) {
          const d = Math.round(ci * cstep);
          const solidFirst = joinPrev && ci === 0;   // [TYPE-SOLID-FIRST]
          // Text char: reveal the whole glyph (fill+outline+shadow) fully.
          inlineText += solidFirst
            ? `{${styleP}\\1c${tcol}\\alpha&H00&}${ch}`
            : `{${styleP}\\1c${tcol}\\alpha&HFF&\\t(${d},${d + TW_CHAR},\\alpha&H00&)}${ch}`;
          // Glow char: reveal ONLY to the style's thin glow alpha (gEnd) via
          // \1a/\3a so the halo never snaps to full opacity (would re-cover text).
          // [HL-TYPE-FIX] gcol = neon highlight colour on the last word, else base glow.
          // [HL-SOFT-GLOW] Highlight word reveals to a dimmer alpha (&H80&) so its
          // halo is a soft cinematic glow, not a hot neon bloom. (styleP already
          // makes its border thin via [HL-PURE-GLOW].)
          const gEndW = isHiWord ? '&H80&' : gEnd;
          // [BOX-SAFE] gcol null = this word gets no glow at all (highlight-
          // family style, not the accented/coloured word) — stay statically
          // hidden instead of revealing a black halo. \3c is set explicitly
          // whenever visible so it can never inherit the wrapper line's
          // (potentially black) border colour.
          inlineGlow += gcol == null
            ? `{${styleP}\\1a&HFF&\\3a&HFF&}${ch}`
            : solidFirst
              ? `{${styleP}\\3c${gcol}\\1c${gcol}\\1a${gEndW}\\3a${gEndW}}${ch}`
              : `{${styleP}\\3c${gcol}\\1c${gcol}\\1a&HFF&\\3a&HFF&\\t(${d},${d + TW_CHAR},\\1a${gEndW}\\3a${gEndW})}${ch}`;
          ci++;
        }
      }
    });
    if (inlineText.trim()) {
      if (glow) lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{${an}${pos}\\bord${gbord}\\3c${glowC}\\shad0\\blur${blur}${gAlpha}}${inlineGlow.trimEnd()}`);
      const textPrefix = cleanEdge
        ? `{${an}${pos}\\bord0${dropTag}}`
        : `{${an}${pos}\\bord3\\3c&H000000&\\shad2}`;
      lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,${textPrefix}${inlineText.trimEnd()}`);
    }
    return lines.join('\n');
  }

  // ── Per-word animation override (t.style.an) ──
  // The word-by-word panel can give each word its OWN entrance animation.
  // Line-level tags (\fad / \t at line start) can't vary per word, so a cue
  // containing ANY an-override is emitted with STATIC line tags and per-word
  // inline fragments instead: \alpha reveals for fades, \fscx/\fscy for
  // pop/zoom, \blur for blur-in, per-char staggers for 'type'. Inline words
  // can't \move, so rise/drop on an INLINE word burns as the soft fade with
  // the same timing; dragged (positioned) words own their Dialogue line and
  // get the real \move. Words with an:'' inherit the cue-level anim.
  const cueHasAnimOverride = (c) => Array.isArray(c.tokens)
    && c.tokens.some(tk => tk.style && tk.style.an);
  // [CUE-SOLID-PERWORD] `cont` = { joinPrev, joinNext } from cuesJoin — the
  // per-word path's own fade (alpha reveal/exit), which applyCueContinuity's
  // \fad rewrite cannot see. Same rule as the line path: a cue that follows
  // another back-to-back starts visible, one that is followed back-to-back
  // does not fade out. The motion (scale/blur) is kept.
  function buildAnimTokenCue(c, start, end, hiC, cont = {}) {
    const durMs = Math.max(120, Math.round(((c.end || 0) - (c.start || 0)) * 1000));
    // [BOX-SAFE] Same convention as buildTypeCue/tokenGlowText: the cue's
    // auto-highlight accent (hiC) belongs to the LAST inline (non-dragged)
    // word only. Every other word — whether it has its own an-override or
    // not — must get glowColorFor()'s resolved colour (or null = hidden),
    // never the style's raw glowC, which is opaque black for every
    // bw_hi_*/bw_neon_*/white_hi_lime style.
    let lastInlineIdx = -1;
    c.tokens.forEach((tk, i) => { if (!isPositioned(tk)) lastInlineIdx = i; });
    const wBlur = textStartBlur;
    // Every word block restates scale so a neighbour's pop/zoom \t never leaks
    // into it (override tags apply in parse order; a later static tag wins).
    const baseScale = `\\fscx${s.scaleX || 100}\\fscy100`;
    // Entrance fragment for one word. kind 'text' reveals to full opacity;
    // 'glow' reveals to the style's thin glow alpha via \1a/\3a (never \alpha
    // — the shorthand would clobber \3a and blow the halo opaque).
    const frag = (a, kind) => {
      const shown  = kind === 'text' ? '\\alpha&H00&' : `\\1a${gEnd}\\3a${gEnd}`;
      // [CUE-SOLID-PERWORD] Joined to the previous cue: start in the SHOWN
      // state (stated explicitly, never left out, so a neighbour's alpha cannot
      // bleed in) and skip the reveal. Joined to the next: no exit.
      const hidden = cont.joinPrev ? shown : (kind === 'text' ? '\\alpha&HFF&' : '\\1a&HFF&\\3a&HFF&');
      const reveal = (t1) => (cont.joinPrev ? '' : `\\t(0,${t1},${shown})`);
      const gone = kind === 'text' ? '\\alpha&HFF&' : '\\1a&HFF&\\3a&HFF&';
      const exit = cont.joinNext ? '' : `\\t(${Math.max(0, durMs - fadeOut)},${durMs},${gone})`;
      switch (a) {
        // Static words restate full visibility so an animated neighbour's
        // alpha state never bleeds into them.
        case 'none': return kind === 'text' ? '\\alpha&H00&' : `\\1a${gEnd}\\3a${gEnd}`;
        case 'pop':  return `${hidden}\\fscx64\\fscy64${kind === 'text' ? `\\blur${wBlur}` : ''}${reveal(fadeIn)}\\t(0,${inMs},\\fscx100\\fscy100${kind === 'text' ? '\\blur0' : ''})${exit}`;
        case 'zoom': return `${hidden}\\fscx90\\fscy90${reveal(softIn)}\\t(0,${softInMs},\\fscx100\\fscy100)${exit}`;
        case 'blur': return kind === 'text'
          ? `${hidden}\\blur${wBlur}${reveal(fadeIn)}\\t(0,${inMs},\\blur0)${exit}`
          : `${hidden}${reveal(fadeIn)}${exit}`;
        // rise/drop can't slide a text segment — soft fade, same timing family.
        case 'rise': case 'drop': return `${hidden}${reveal(slideFadeIn)}${exit}`;
        default:     return `${hidden}${reveal(softIn)}${exit}`;   // 'fade' / inherit
      }
    };
    // ── Exploded cue mode (feature: real per-word rise/drop on inline words) ──
    // An INLINE text segment can't \move, so historically inline rise/drop
    // burned as a soft fade. The renderer now bakes each token's natural layout
    // offset from the cue anchor (tk.ax = horizontal offset of the word's centre
    // from the cue centre, tk.ay = vertical offset of the word's top from the
    // cue top, both in canonical 1080×1920 ASS units). When present, we can lift
    // EVERY non-positioned word onto its own \pos/\move Dialogue line and give it
    // a real slide — "exploding" the cue. Only trigger when at least one inline
    // word actually wants rise/drop AND every inline word carries finite ax/ay
    // (legacy payloads without the offsets fall back to the soft-fade behaviour).
    const nonPos = c.tokens.filter(tk => !isPositioned(tk));
    const effAnimOf = (tk) => (tk.style && tk.style.an) || anim;
    const explode =
      nonPos.some(tk => { const a = effAnimOf(tk); return a === 'rise' || a === 'drop'; })
      && nonPos.every(tk => Number.isFinite(+tk.ax) && Number.isFinite(+tk.ay));
    const lines = [];
    let inlineText = '', inlineGlow = '';
    c.tokens.forEach((tk, tkIdx) => {
      const st = tk.style || {};
      const a  = st.an || anim;                     // effective per-word anim
      const fn = normFn(st.fn) || baseFn;
      const b  = (st.b != null) ? (st.b ? 1 : 0) : baseBold;
      const it = st.i ? 1 : 0;
      const fs = st.fs ? Math.round(st.fs * SY) : fontSize;   // [AR-BURN]
      // [FS-EM-SCALE] `fs` stays CANONICAL (CSS px): \fsp and every other
      // derived value must keep using it. Only the \fs tag libass reads is
      // converted, and with THIS token's own font — a per-word face swap
      // changes the ratio, which is why mixed-font cues drifted apart.
      const fsA = assFs(fs, fn, !!b, !!it);
      const tc = (st.color && hexToAss(st.color)) || textC;
      // isHiWord mirrors buildTypeCue: only the last INLINE token can be the
      // auto-highlight slot — a dragged/positioned word never is.
      const isHiWord = !!hiC && !isPositioned(tk) && tkIdx === lastInlineIdx && !st.color;
      const gc = glowColorFor(st, isHiWord, hiC);   // null = no halo for this word
      const txt = String(tk.text || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
      const styleP = `\\fn${fn}\\b${b}\\i${it}\\fs${fsA}${fontFsp(fn, fs, !!st.fn, st.tr)}${baseScale}`;
      if (isPositioned(tk)) {
        const px = Math.round(baseX + (+st.dx || 0) * SY);    // [AR-BURN] font-proportional
        const py = Math.round(baseY + (+st.dy || 0) * SY);
        // [POS-TYPE] A dragged (manually positioned) word set to typing must
        // still reveal CHARACTER-BY-CHARACTER — exactly like an inline type
        // word. This branch historically had no `type` case, so a dragged
        // type word fell through to frag() (which also has no `type` case) and
        // burned as a single soft fade instead of typing. The DOM preview
        // (paintCue's `else if (st.an === 'type')` path) already types dragged
        // words per-char, so this was a burn-only mismatch: reported live as a
        // repositioned word (e.g. "bangku") that typed in the editor but
        // fade-popped in the render. Mirrors the explode+type branch below,
        // but anchored at this word's own \pos(dx,dy).
        if (a === 'type') {
          const chars = Array.from(txt);
          const cstep = chars.length > 1 ? Math.min(45, (durMs * 0.4) / chars.length) : 0;
          let charsText = '', charsGlow = '';
          chars.forEach((ch, k) => {
            const d = Math.round(k * cstep);
            charsText += `{${styleP}\\1c${tc}\\alpha&HFF&\\t(${d},${d + 26},\\alpha&H00&)}${ch}`;
            if (gc != null) charsGlow += `{${styleP}\\1c${gc}\\1a&HFF&\\3a&HFF&\\t(${d},${d + 26},\\1a${gEnd}\\3a${gEnd})}${ch}`;
          });
          const ovrT = cleanEdge
            ? `\\an8\\pos(${px},${py})\\bord0${dropTag}`
            : `\\an8\\pos(${px},${py})\\bord3\\3c&H000000&\\shad2`;
          if (glow && gc != null) {
            const ovrG = `\\an8\\pos(${px},${py})\\bord${gbord}\\3c${gc}\\shad0\\blur${blur}${gAlpha}`;
            lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{${ovrG}}${charsGlow}`);
          }
          lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,{${ovrT}}${charsText}`);
          return;
        }
        const posT = a === 'rise' ? `\\move(${px},${py + slidePx},${px},${py},0,${slideMs})`
                   : a === 'drop' ? `\\move(${px},${py - slidePx},${px},${py},0,${slideMs})`
                   : `\\pos(${px},${py})`;
        const fadT  = (a === 'rise' || a === 'drop') ? `\\fad(${slideFadeIn},${slideFadeOut})` : '';
        const fragT = (a === 'rise' || a === 'drop') ? '' : frag(a, 'text');
        const fragG = (a === 'rise' || a === 'drop') ? '' : frag(a, 'glow');
        const ovrT = cleanEdge
          ? `\\an8${posT}${fadT}${fragT}\\bord0${dropTag}\\1c${tc}${styleP}`
          : `\\an8${posT}${fadT}${fragT}\\bord3\\3c&H000000&\\shad2\\1c${tc}${styleP}`;
        lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,{${ovrT}}${txt}`);
        if (glow && gc != null) {
          const ovrG = `\\an8${posT}${fadT}${fragG}\\bord${gbord}\\3c${gc}\\1c${gc}\\shad0\\blur${blur}${gAlpha}${styleP}`;
          lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{${ovrG}}${txt}`);
        }
        return;
      }
      if (explode) {
        // Non-positioned word gets its own \pos/\move line using its baked
        // natural layout offset (ax/ay). Mirrors the positioned emit above but
        // anchored at the word's own centre/top instead of a manual dx/dy.
        const px = Math.round(baseX + (+tk.ax) * SY);   // [AR-BURN] font-proportional offset
        const py = Math.round(baseY + (+tk.ay) * SY);
        if (a === 'type') {
          // Per-char typewriter stagger scoped to this word, on its own line.
          const chars = Array.from(txt);
          const cstep = chars.length > 1 ? Math.min(45, (durMs * 0.4) / chars.length) : 0;
          let charsText = '', charsGlow = '';
          chars.forEach((ch, k) => {
            const d = Math.round(k * cstep);
            charsText += `{${styleP}\\1c${tc}\\alpha&HFF&\\t(${d},${d + 26},\\alpha&H00&)}${ch}`;
            if (gc != null) charsGlow += `{${styleP}\\1c${gc}\\1a&HFF&\\3a&HFF&\\t(${d},${d + 26},\\1a${gEnd}\\3a${gEnd})}${ch}`;
          });
          const ovrT = cleanEdge
            ? `\\an8\\pos(${px},${py})\\bord0${dropTag}`
            : `\\an8\\pos(${px},${py})\\bord3\\3c&H000000&\\shad2`;
          if (glow && gc != null) {
            const ovrG = `\\an8\\pos(${px},${py})\\bord${gbord}\\3c${gc}\\shad0\\blur${blur}${gAlpha}`;
            lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{${ovrG}}${charsGlow}`);
          }
          lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,{${ovrT}}${charsText}`);
          return;
        }
        const isSlide = (a === 'rise' || a === 'drop');
        const posT = a === 'rise' ? `\\move(${px},${py + slidePx},${px},${py},0,${slideMs})`
                   : a === 'drop' ? `\\move(${px},${py - slidePx},${px},${py},0,${slideMs})`
                   : `\\pos(${px},${py})`;
        const fadT  = isSlide ? `\\fad(${slideFadeIn},${slideFadeOut})` : '';
        const fragT = isSlide ? '' : frag(a, 'text');
        const fragG = isSlide ? '' : frag(a, 'glow');
        const ovrT = cleanEdge
          ? `\\an8${posT}${fadT}${fragT}\\bord0${dropTag}\\1c${tc}${styleP}`
          : `\\an8${posT}${fadT}${fragT}\\bord3\\3c&H000000&\\shad2\\1c${tc}${styleP}`;
        if (glow && gc != null) {
          const ovrG = `\\an8${posT}${fadT}${fragG}\\bord${gbord}\\3c${gc}\\1c${gc}\\shad0\\blur${blur}${gAlpha}${styleP}`;
          lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{${ovrG}}${txt}`);
        }
        lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,{${ovrT}}${txt}`);
        return;
      }
      if (a === 'type') {
        // Per-char stagger scoped to this word only (typewriter feel).
        const chars = Array.from(txt);
        const cstep = chars.length > 1 ? Math.min(45, (durMs * 0.4) / chars.length) : 0;
        chars.forEach((ch, k) => {
          const d = Math.round(k * cstep);
          inlineText += `{${styleP}\\1c${tc}\\alpha&HFF&\\t(${d},${d + 26},\\alpha&H00&)}${ch}`;
          // [BOX-SAFE] gc null → stay statically hidden (no reveal, no colour)
          // instead of typing a black halo behind every non-accent character.
          inlineGlow += gc == null
            ? `{${styleP}\\1a&HFF&\\3a&HFF&}${ch}`
            : `{${styleP}\\3c${gc}\\1c${gc}\\1a&HFF&\\3a&HFF&\\t(${d},${d + 26},\\1a${gEnd}\\3a${gEnd})}${ch}`;
        });
        // Trailing space in a plain visible block so the next word's spacing
        // and alpha state are clean.
        inlineText += `{${styleP}\\1c${tc}\\alpha&H00&} `;
        inlineGlow += gc == null
          ? `{${styleP}\\1a&HFF&\\3a&HFF&} `
          : `{${styleP}\\3c${gc}\\1c${gc}\\1a${gEnd}\\3a${gEnd}} `;
        return;
      }
      inlineText += `{${styleP}\\1c${tc}${frag(a, 'text')}}${txt} `;
      // [BOX-SAFE] gc null → statically hidden, no entrance animation needed
      // since there's nothing to reveal (highlight-family style, this word is
      // neither the accent nor manually coloured).
      inlineGlow += gc == null
        ? `{${styleP}\\1a&HFF&\\3a&HFF&}${txt} `
        : `{${styleP}\\3c${gc}\\1c${gc}${frag(a, 'glow')}}${txt} `;
    });
    if (inlineText.trim()) {
      if (glow) lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,{${an}${pos}\\bord${gbord}\\3c${glowC}\\shad0\\blur${blur}${gAlpha}}${inlineGlow.trimEnd()}`);
      const textPrefix = cleanEdge
        ? `{${an}${pos}\\bord0${dropTag}}`
        : `{${an}${pos}\\bord3\\3c&H000000&\\shad2}`;
      lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,${textPrefix}${inlineText.trimEnd()}`);
    }
    return lines.join('\n');
  }

  const cueDialogue = (c, ci) => {
    // [BOX-HIGHLIGHT] Hanya jalur cue POLOS — lihat batasan v1 di rencana.
    // cueHasAnimOverride/hasTokens dicek ulang di sini secara sengaja: box
    // highlight harus diam-diam DILEWATI (fallback ke jalur normal), bukan
    // menabrak cabang animasi/token yang caranya berbeda menyusun Dialogue.
    //
    // [ARCH] Timing per-kata dihitung FRESH dari c.tokens + c.start/c.end di
    // sini (deriveWordTiming), BUKAN dibaca dari field `.words` yang dulu
    // tersimpan terpisah. Field itu berulang kali desync dari `.tokens` di
    // titik edit (typo fix, edit teks manual, drag retime) — audit 14 Agu
    // 2026 menemukan 8 tempat yang lupa menyinkronkannya. Menghitung ulang
    // setiap kali dipanggil membuat desync itu mustahil secara struktural.
    const cueWords = Array.isArray(c.tokens) ? deriveWordTiming(c.tokens, c.start, c.end) : [];
    // [BOX-OVERRIDE-COMPAT] Guard dulu memblokir SELURUH cue kalau ADA SAJA
    // satu kata berstyle apa pun. Diperluas 26 Agu 2026 (laporan "font di
    // dalam box highlight blackout" + "box hilang kalau ada edit manual"):
    // font (`fn`), bold (`b`), italic (`i`), dan warna (`color`) TIDAK punya
    // konflik rendering dengan box — posisi tiap kata sudah dihitung PER KATA
    // dari `layout`/`advPx` (lihat wordFont di bawah), jadi properti visual
    // murni (bukan pengukuran) aman ditumpangkan. `an` (animasi per-kata)
    // DIPERLUAS lagi hari yang sama (laporan susulan: "mode animasi typing
    // untuk kata yg ada box highlightnya masih blackout"). Verifikasi lewat
    // render ffmpeg nyata membuktikan itu BUKAN literal hitam — box-nya
    // HILANG TOTAL untuk seluruh cue (jatuh ke buildAnimTokenCue, yang tidak
    // tahu apa-apa soal box). Posisi kata di dalam box tetap dihitung STATIS
    // dari layout/advPx (BUKAN \move atau per-char stagger seperti jalur
    // animasi biasa), jadi `an` aman ditumpangkan sama seperti fn/b/i/color:
    // animasi masuknya kata itu didiamkan (tidak main), tapi box-nya sendiri
    // tetap tergambar — jauh lebih baik daripada box hilang dari SELURUH cue
    // gara-gara satu kata. dx/dy (drag manual) TETAP memblokir terpisah di
    // bawah — itu butuh \pos-nya sendiri di luar flow kata yang box tidak
    // punya model untuk itu. `fs` (ukuran per-kata) JUGA tetap memblokir:
    // advPx/layout di bawah mengukur SEMUA kata dengan `fontSize` cue, bukan
    // ukuran override — mengizinkannya tanpa membetulkan pengukuran akan
    // bikin box salah lebar/posisi (bug baru, bukan fix).
    // [MC-SIZE-PARITY] The objection above is about MIXED sizes: advPx/layout
    // measure every word with one `fontSize`, so a cue whose words differ in
    // size would get a mis-sized box. A cue where every word carries the SAME
    // size has no such problem — measuring all of them at that one size is
    // exactly right. That is precisely the Manual Caption shape:
    // mergeInlineManualCaptions stamps the entry's `fs` onto every token.
    // Blanket-skipping the box for any `fs` meant typing a SIZE silently
    // dropped the highlight from the burn while the editor kept previewing it.
    const cueUniformFs = (() => {
      if (!Array.isArray(c.tokens) || !c.tokens.length) return null;
      const vals = c.tokens.map(tk => (tk.style && tk.style.fs != null) ? +tk.style.fs : null);
      if (vals.some(v => !Number.isFinite(v))) return null;
      return vals.every(v => v === vals[0]) ? vals[0] : null;
    })();
    const BOX_COMPAT_KEYS = new Set(['fn', 'b', 'i', 'color', 'an']);
    const onlyFontOverride = (tk) => {
      if (!tk.style) return true;
      const keys = Object.keys(tk.style);
      return keys.length === 0
        || keys.every(k => BOX_COMPAT_KEYS.has(k) || (k === 'fs' && cueUniformFs != null));
    };
    // True the instant any token carries a REAL (non-font-only) override —
    // used below to switch the before/after run emitter from the old
    // font-only merged-run path (byte-identical output when nothing but font
    // ever varies, preserving every existing [BOX-*] test) to a per-word
    // emitter that can also carry bold/italic/colour safely.
    const hasRichOverride = Array.isArray(c.tokens)
      && c.tokens.some(tk => tk.style && Object.keys(tk.style).some(k => k === 'b' || k === 'i' || k === 'color'));
    // [BOX-DX-BLOCK] `dx`/`dy` (manual drag) are NOT in BOX_COMPAT_KEYS above,
    // so a dragged token already fails `onlyFontOverride` and blocks the box
    // via the check on the next line — no separate dx/dy guard needed here.
    // [BOX-ANIM-PRECEDENCE] Box highlight used to draw unconditionally even
    // when a word carried its own per-word animation override (tk.style.an) —
    // the box path returns before cueHasAnimOverride/typeMode are ever
    // consulted below, so a custom rise/drop/pop/type override on a word was
    // silently swallowed whenever box highlight was on. Skip the box path
    // entirely in that case so the cue falls through to buildAnimTokenCue /
    // buildTypeCue instead, same as a cue with no box color at all.
    const fontSizeOuter = fontSize;
    // [BOX-ELIGIBLE] The eligibility rule itself now lives in caption-box.js,
    // shared with both previews; the conditions above are its explanation.
    if (box && box.boxColor && cueWords.length && boxEligible(c, style)) {
      // [MC-SIZE-PARITY] Shadow the cue font size for THIS block only, so the
      // measuring (advPx/spacePx/layout), the box geometry and the render tag
      // all agree on one number — the size the user actually asked for.
      // Declared first: anything below referencing `fontSize` must see the
      // shadow, never the outer binding.
      const fontSize = cueUniformFs != null ? Math.round(cueUniformFs * SY) : fontSizeOuter;
      const boxLines = boxCueLines({
        words: cueWords.map(w => ({ w: w.text, start: w.start, end: w.end })),
        boxColor: box.boxColor,
      });
      // [BOX-FONT-OVERRIDE] Font efektif tiap kata: override-nya sendiri kalau
      // ada (dinormalisasi lewat alias yang sama dengan jalur normal), else
      // font cue. Dipakai untuk MENGUKUR (advPx, jadi box tetap pas untuk
      // kata berfont beda) DAN untuk MERENDER (\fn di segmen teksnya).
      const wordFont = (i) => {
        const fn = Array.isArray(c.tokens) && c.tokens[i] && c.tokens[i].style && c.tokens[i].style.fn;
        return fn ? (normFn(fn) || s.font) : s.font;
      };
      // [BOX-OVERRIDE-COMPAT] Warna per-kata hanya untuk tag render.
      // [BOX-BOLD-WIDTH] Bold/italic SEKARANG ikut ke pengukuran. Komentar lama
      // di sini menyatakan "width tidak berubah signifikan di codebase ini" —
      // itu tidak pernah benar. libass menukar face saat \b1 diemisikan, dan
      // Apple Garamond (ada di pemilih font caption sejak d4b1c95, 28 Jul 2026,
      // sebulan SEBELUM asumsi ini ditulis) punya face bold sungguhan: diburn
      // lalu diukur pikselnya, ink "Bayar" 168px pada \b0 vs 192px pada \b1,
      // +14%. Box diukur regular, jadi huruf terakhir menggantung di luar
      // highlight-nya sendiri. Jalur JUDUL (titleBoxRects) selalu mengoper
      // bold/italic ke pengukurannya — hanya jalur caption yang tertinggal.
      // `includeColor=false` dipakai untuk kata AKTIF (di dalam box) — warna
      // tintanya harus SELALU contrastInk demi keterbacaan, tidak boleh
      // ditimpa warna pilihan kata itu sendiri.
      const wordRichTag = (i, { includeColor }) => {
        const st = Array.isArray(c.tokens) && c.tokens[i] && c.tokens[i].style;
        const fn = wordFont(i);
        const b = st && st.b != null ? (st.b ? 1 : 0) : (s.bold ? 1 : 0);
        const it = st && st.i ? 1 : 0;
        const fsA = assFs(fontSize, fn, !!b, !!it);
        let tag = `\\fn${fn}\\fs${fsA}\\b${b}\\i${it}`;
        if (includeColor) tag += `\\1c${(st && st.color) ? hexToAss(st.color) : textC}`;
        return tag;
      };
      // [BOX-TRACKING] Lihat boxWordLayoutPx: lebar & posisi kata dihitung
      // DENGAN celah tracking (\fsp) yang stampBaseFsp suntikkan ke baris
      // teks — versi tanpa fsp membuat box kelebaran dan melenceng ke kanan
      // pada cue panjang, menimpa kata tetangganya.
      // Resolusi bold/italik PERSIS seperti wordRichTag di atas — kalau keduanya
      // pernah berbeda, box dan teksnya diukur dari face yang berlainan lagi.
      const wordWeight = (i) => {
        const st = Array.isArray(c.tokens) && c.tokens[i] && c.tokens[i].style;
        return {
          bold: !!(st && st.b != null ? st.b : s.bold),
          italic: !!(st && st.i),
        };
      };
      const advPx = cueWords.map((w, i) => {
        const ww = wordWeight(i);
        return textWidthEmSafe(w.text, wordFont(i), box.fontsDir, ww.bold, ww.italic) * fontSize;
      });
      const spacePx = textWidthEmSafe(' ', s.font, box.fontsDir, !!s.bold, false) * fontSize;
      // [BOX-FITS-FRAME] The box path lays the cue out as ONE line at explicit
      // \pos — it cannot wrap. A cue whose single line is wider than the frame
      // therefore gets a box wider than the video with the text running off
      // both edges. Auto cues are short enough that this never showed, but a
      // Manual Caption is a whole typed sentence in ONE token, so it overflows
      // at any size (measured on a real burn: 3804px of box in a 1080px frame,
      // and at that width the text did not render at all). Falling through
      // instead hands the cue to the normal path, which lets libass wrap it.
      //
      // [BOX-FIT-TRACKED] Measured the way the line is actually drawn: with
      // the line's \fsp tracking (boxWordLayoutPx) and the box's own 2×PAD.
      // The old check summed raw advances + raw spaces, i.e. ~|fsp| px per
      // character WIDER than libass draws it, so a cue that fits (often the
      // clip's widest one, right after [CAPTION-FIT-WIDTH] shrank the font to
      // just fit) silently lost its box in the video while the editor showed
      // it. Found in real sessions: 2 of 2948 boxed cues, e.g. "consistent,
      // from overwhelmed" = 1063 untracked vs 944 drawn, limit 1000.
      const boxLens = cueWords.map(w => Array.from(String(w.text)).length);
      const boxLayout = boxWordLayoutPx({ advPx, lens: boxLens, spacePx, fspPx: styleSpacing || 0 });
      const boxLineW = boxLayout.totalW + 2 * PAD_EM * fontSize;
      if (boxLines.length && advPx.every(a => a > 0) && spacePx > 0 && boxLineW <= Math.max(40, PR.w - 2 * marginX)) {
        const out = [];
        // [BOX-HEIGHT-CSS-NOT-LIBASS] Tinggi box HARUS ikut angka yang
        // benar-benar dirender preview (elemen inline CSS), BUKAN fontEmScale
        // (rasio OS/2-win yang dipakai untuk Style Fontsize supaya cocok
        // dengan libass — kebutuhan yang sama sekali berbeda). Diukur
        // langsung terhadap Chrome sungguhan (getBoundingClientRect, 15 Agu
        // 2026): tinggi konten inline browser cocok dengan
        // cssLineHeightEm — (hhea.ascender-hhea.descender+hhea.lineGap)/upem
        // — dalam 0.2%, sedangkan fontEmScale meleset 13% (Anton) sampai
        // 17.5% (Poppins Bold) karena OS/2 win metrics sengaja lebih longgar
        // dari yang benar-benar dipakai browser untuk line-height. Pakai
        // fontEmScale di sini membuat box burn lebih TINGGI dari preview,
        // beda per font — laporan "ukuran shapenya cacat".
        const faceRatio = cssLineHeightEm(s.font, box.fontsDir || assFontsDirFs());
        const lineHeightEm = faceRatio > 1 ? faceRatio : 1.2;
        const layout = boxLayout;
        // [BOX-VALIGN] Teks cue normal top-anchor (\an8 + MarginV = y): span
        // vertikalnya [y, y + fontSize×faceRatio]. Box harus berpusat di
        // TENGAH span itu (50/50) — versi lama memusatkan box di y sendiri
        // (\an5 pada baris teksnya juga) — teks boxed melompat setengah baris
        // ke atas relatif terhadap cue normal DAN preview, dan box-nya
        // menimpa apa pun yang ada di atas baris caption.
        //
        // [BOX-VCENTER-ASC-RETRACTED] Sempat diganti ke split ascentFrac×0.67
        // (15 Agu 2026) berdasar pengukuran "box 8px di atas pusat tinta".
        // Setelah [BORDER-SHIFTS-ORIGIN] diperbaiki terpisah (boxDrawing()
        // dulu menggeser SELURUH kotak −bordPx di x DAN y, bukan cuma x),
        // sapuan ulang 6 kata (/using-superpowers, sesi lanjutan) membuktikan
        // split 0.67 itu JADI SALAH — sekarang overshoot ~12px (persis
        // bordPx) ke arah BAWAH karena dulu diam-diam separuh mengkompensasi
        // bug pergeseran kotak yang sama, bukan properti font sungguhan.
        // Diuji ulang dari nol (render+pixel-scan, bordPx sudah benar):
        // vFrac=0.5 memberi topPad=botPad=19px PERSIS. Split 50/50 polos
        // memang benar sejak awal — laporan "terlalu tinggi" yang memicu fix
        // 0.67 adalah GEJALA dari bug border-shift, bukan bug centering yang
        // terpisah. Pelajaran: dua bug yang saling menutupi butuh diverifikasi
        // ULANG satu sama lain setelah salah satunya diperbaiki, bukan
        // diasumsikan tetap valid.
        // [BOX-VCENTER-INK] Vertical centre of the box, PER WORD.
        //
        // The line-box midpoint below (`cyLineBox`) is only a fallback now.
        // It centres the box on the middle of the line box, but glyph ink is
        // not centred there: usWinAscent carries per-face internal leading, so
        // the box floated above the ink by a different amount for every font.
        // Measured across all 23 bundled faces at Fontsize 110 (single-word
        // cue, ink scanned over the full frame so spill was visible): the gap
        // above ran 13-34px while the descender was clipped up to 22px BELOW
        // the box — Anton the worst, which is the "anton tidak presisi di box
        // highlight" report. The box height itself was never the problem: it
        // is 74px against a 54-72px ink height, i.e. tall enough for every
        // face with 2-20px to spare.
        //
        // It is resolved per WORD, not once per cue, because a per-word font
        // override changes which face is drawn — the old code read `s.font`
        // (the cue's font) for every word, so an overridden word was centred
        // with a different face's metrics than the one libass rendered.
        const cyLineBox = y + Math.round((fontSize * lineHeightEm) / 2);
        const cyFor = (i) => {
          const st = Array.isArray(c.tokens) && c.tokens[i] && c.tokens[i].style;
          const bold = st && st.b != null ? !!st.b : !!s.bold;
          const inkEm = fontInkCenterEm(wordFont(i), box.fontsDir || assFontsDirFs(), bold, !!(st && st.i));
          return inkEm == null ? cyLineBox : y + Math.round(fontSize * inkEm);
        };
        const bordPx = Math.round(fontSize * RADIUS_EM);
        // [BOX-STYLE-PARITY] textPrefix dibangun SAMA PERSIS dengan jalur
        // emisi normal di bawah — baris teks boxed dulu memakai `{\an5\pos}`
        // polos tanpa dressing style apa pun, jadi ia mewarisi Outline=4
        // dari baris Style (outline gendut salah warna), kehilangan \bord0
        // clean-edge, dan kehilangan lapisan glow. Itulah laporan "warna,
        // glow, font beda dari preview" — preview memakai styling penuh,
        // burn boxed memakai nyaris tanpa styling.
        // [BOX-STYLE-PARITY] Harus PERSIS textTag (baris ~2380) — jalur plain
        // sungguhan. Versi sebelumnya lupa \blur0 (textAnim) dan \1c${textC},
        // jadi warna & animasi-masuk teks boxed diam-diam beda dari preview.
        // [BOX-PAD-INSERT] textPrefix di bawah sengaja TANPA \pos/\an — tiap
        // segmen (before/active/after) memasang \an7\pos SENDIRI. Diverifikasi
        // lewat Chrome sungguhan (getBoundingClientRect, kontainer
        // .caption-overlay ASLI: position:absolute;left:50%;
        // transform:translateX(-50%);width:92.59%;text-align:center — persis
        // styles.css baris 692): saat sebuah kata diberi box, kata SEBELUMNYA
        // tidak bergeser relatif terhadap box, kata SESUDAHNYA bergeser
        // +2×PAD relatif terhadap box, lalu seluruh baris di-recenter ulang
        // di kontainer memakai lebar baru (totalW+2×PAD). Versi lama menulis
        // SATU baris \an8 dengan flow \fsp alami (mengasumsikan box hanya
        // "digambar di atas" teks yang tidak berubah) — itu membuat box
        // makan PAD_EM ke kiri langsung ke ruang kata sebelumnya setiap kali
        // celah alami (spasi dikurangi tracking negatif) lebih sempit dari
        // PAD_EM. Laporan "bisa dibeli": box_left makan -6.9px ke "bisa".
        // [MC-SIZE-PARITY] With a uniform per-word size the geometry above is
        // already measured at that size — the TEXT has to be drawn at it too,
        // or the box grows around letters that stayed at the Style's size.
        // (Caught exactly that way: box 320->477px wide while the text did not
        // move.) The per-word rich emitter writes its own \fs and overrides
        // this; the merged-run path has no other place to say it.
        const boxFsTag = cueUniformFs != null
          ? `\\fs${assFs(fontSize, s.font, !!s.bold, false)}`
          : '';
        // [BOX-ANIM-ONCE] Animasi MASUK milik cue harus jalan SEKALI, saat cue
        // muncul — bukan diulang tiap kali kotaknya pindah kata.
        //
        // Jalur box memecah satu cue jadi satu set Dialogue per periode
        // kata-aktif. Dulu setiap set memakai `textAnim` yang sama, jadi
        // \fad/\fscx/\blur-nya dijalankan ULANG di tiap batas kata. Terukur
        // pada burn nyata 1080x1920 (cue 1,2s, 3 kata, anim pop, piksel tinta
        // putih dihitung per frame @50fps):
        //
        //              batas 0,40s   batas 0,80s   mapan
        //   box ON        2008          1130        4859-4926
        //   box OFF       4836          4836        4836
        //
        // Jadi captionnya kehilangan 59% dan 77% tintanya, tiga kali per cue.
        // Komentar lama mengklaim baris sebelum/sesudah "still animate exactly
        // like the normal path" — itu tidak bisa benar: jalur normal memancarkan
        // SATU Dialogue untuk seluruh cue, jadi animasinya memang cuma sekali.
        //
        // Preview adalah patokannya dan sudah benar: di sana kotak cuma
        // dekorasi CSS di atas span kata yang sudah digambar, jadi cue-nya
        // dianimasikan sekali lalu kotaknya berpindah sendiri.
        //
        // Sekarang: segmen PERTAMA membawa animasi masuk (fade-out-nya
        // ditahan), segmen TERAKHIR membawa fade-out cue, segmen tengah tidak
        // membawa animasi masuk sama sekali — persis bentuk waktu yang
        // dipancarkan jalur normal.
        const fadOf = (a) => { const m = /\\fad\((\d+),(\d+)\)/.exec(a || ''); return m ? { in: +m[1], out: +m[2] } : null; };
        // Keadaan AKHIR animasi mana pun: tanpa skala-dari, tanpa blur-dari.
        // Sama dengan textAnim milik anim 'none', jadi tidak ada nilai baru
        // yang dikarang di sini.
        const STATIC_ANIM = '\\blur0';
        // Berlaku untuk lapisan MANA PUN (teks atau glow): bentuk waktu yang
        // sama, sumber animasi yang berbeda.
        const segOf = (sumber, pertama, terakhir, diam) => {
          if (pertama && terakhir) return sumber;            // cue satu segmen: tak berubah
          const f = fadOf(sumber);
          if (pertama) return f ? sumber.replace(/\\fad\(\d+,\d+\)/, `\\fad(${f.in},0)`) : sumber;
          return diam + (terakhir && f ? `\\fad(0,${f.out})` : '');
        };
        const segAnim = (pertama, terakhir) => segOf(textAnim, pertama, terakhir, STATIC_ANIM);
        // [BOX-ANIM-GLOW] Lapisan glow jalur box tidak pernah membawa animasi
        // sama sekali — `glowTags` cuma bord/warna/blur. Terlihat jelas pada
        // frame burn t=0,06s: halo hitam sudah terpampang PENUH di posisi
        // akhirnya sementara teksnya masih diskalakan 64%, jadi haloya
        // menyembul di kanan huruf sebagai gumpalan hitam yang lepas dari
        // teksnya. Jalur normal selalu memberi glow fragmen `glowAnim`-nya.
        const segGlow = (pertama, terakhir) => segOf(glowAnim, pertama, terakhir, '');
        const textPrefixFor = (pertama, terakhir) => {
          const ta = segAnim(pertama, terakhir);
          return (cleanEdge
            ? `${ta}\\bord0${dropTag}`
            : `${ta}\\bord3\\3c&H000000&\\shad2`) + boxFsTag;
        };
        // [BOX-TEXT-CRISP] The active (boxed) word must NOT carry the cue's
        // entrance pop-in (`textAnim` = \fad+\fscx64\fscy64+\blur14, easing to
        // 100%/\blur0 over 200ms). Reported live: "kalau pake box glow-nya
        // mati di text yang aktif boxnya, bukan malah gitu [blurry blob]" —
        // each word's box window is short (cue duration / word count, often
        // ~400-600ms), so a 200ms blur/scale-in transition eats a large,
        // very noticeable fraction of the time that word is even on screen,
        // reading as a blurry blob rather than the crisp readable text a
        // highlight box implies. The box IS the active word's "pop" — its
        // own text should render immediately stable, same spirit as
        // [BOX-GLOW-SUPPRESS] above. Before/after runs are UNCHANGED (still
        // use `textPrefixTags`, still animate exactly like the normal path).
        //
        // [BOX-INK-NO-OUTLINE] It must ALSO drop the black outline+shadow
        // (`\bord3\3c&H000000&\shad2`) that outlined styles give every other
        // word. On a light box `contrastInk` correctly picks BLACK ink — and
        // black ink wrapped in a 3px black outline has no gaps left between
        // the letterforms, so the word fuses into one solid black slab.
        // Reported live with a screenshot: "besar di dalam highlight box ga
        // kelihatan, blackout". The outline exists to separate text from
        // arbitrary video behind it; inside the box the SOLID BOX is that
        // separation, and `contrastInk` already guarantees ink/box contrast,
        // so the outline is pure harm here. This mirrors the DOM preview,
        // which paints `background: boxColor` + a plain `color` with no
        // text-stroke on the boxed word.
        // [BOX-ANIM-ONCE] Kata aktif ikut animasi masuk HANYA di segmen pertama.
        //
        // [BOX-TEXT-CRISP] di bawah membuat kata berkotak selalu crisp, dengan
        // alasan: jendela tiap kata pendek (~400-600ms) sehingga transisi
        // blur/scale 200ms memakan sebagian besar waktunya dan terbaca sebagai
        // gumpalan. Alasan itu adalah GEJALA dari bug pengulangan yang baru
        // diperbaiki [BOX-ANIM-ONCE] — dulu animasi dijalankan ulang di TIAP
        // periode kata, jadi memang tiap kata kena transisi di tengah cue.
        //
        // Sekarang animasi hanya jalan di entrance cue, jadi alasan itu tidak
        // berlaku untuk segmen pertama — dan menahannya di sana punya harga
        // yang terukur: cue SATU KATA (mode 1W) tidak beranimasi sama sekali
        // saat box menyala, karena satu-satunya katanya selalu jadi kata aktif.
        // Diburn dan diperiksa: box OFF memancarkan \fad(70,40)\fscx64...,
        // box ON memancarkan \pos+\blur0\bord0\shad0 — tanpa animasi apa pun.
        // Pada cue banyak kata pun kata PERTAMA menyentak masuk sementara
        // sisanya pop, jadi entrance-nya tidak pernah utuh.
        //
        // Di segmen tengah rumus ini mengembalikan persis nilai lama
        // (`\blur0` + bord0/shad0), jadi kecrispan yang diminta laporan itu
        // tetap dijaga di tempat yang memang dimaksudkannya.
        const activeTextPrefixFor = (pertama, terakhir) =>
          `${segAnim(pertama, terakhir)}\\bord0\\shad0${boxFsTag}`;
        // [BOX-COLOR-TAG] s.primary datang dari SUB_STYLES dalam format baris
        // Style (`&HAABBGGRR`, 8 digit, tanpa `&` penutup) — normalkan ke
        // bentuk override `\1c` yang benar (`&HBBGGRR&`), kalau tidak libass
        // cuma kebetulan membacanya benar untuk putih dan salah untuk
        // style berwarna.
        const restoreCol = /^&H[0-9A-Fa-f]{8}$/.test(String(s.primary))
          ? `&H${String(s.primary).slice(4)}&`
          : String(s.primary);
        const padPx = PAD_EM * fontSize;
        const adjTotalW = layout.totalW + 2 * padPx;
        const shiftX = (naturalX) => Math.round(baseX + naturalX - adjTotalW / 2);
        // [BOX-FONT-OVERRIDE] `\fn`/`\fs` HANYA ditambahkan kalau kata itu
        // memakai font BEDA dari font cue — kata-kata polos tetap mewarisi
        // Style default seperti sebelumnya, jadi tidak ada perubahan output
        // untuk cue tanpa font override sama sekali (semua test lama tetap
        // pas). `\fs` wajib ikut \fn: rasio em (fontEmScale) beda per font,
        // sama seperti jalur token-style normal (lihat `fsA` di atas).
        const fontTagFor = (fn) => fn === s.font ? '' : `\\fn${fn}\\fs${assFs(fontSize, fn, !!s.bold, false)}`;
        // Kelompokkan kata BUKAN-aktif yang bersebelahan DAN sefont jadi satu
        // segmen teks — kata aktif SELALU segmen sendiri (butuh pergeseran
        // [BOX-PAD-INSERT]). Tanpa ini, cue dengan >1 kata berfont beda di
        // sisi yang sama akan salah gabung jadi satu \pos dengan SATU \fn.
        function runsBetween(lo, hi) {
          // [BOX-OVERRIDE-COMPAT] A cue with any bold/italic/colour override
          // can't safely merge adjacent words into one flowed text run —
          // ASS's own text-flow (font metrics + \fsp) has no idea about the
          // PER-WORD `advPx`/`layout` positions computed above, so mixing
          // two differently-styled words in one run would drift them away
          // from their precomputed x — one word per run sidesteps that by
          // reusing `layout.lefts[i]` (already correct per word) instead of
          // relying on ASS to lay the text out itself.
          if (hasRichOverride) {
            const runs = [];
            for (let i = lo; i < hi; i++) runs.push({ start: i, end: i + 1, font: wordFont(i) });
            return runs;
          }
          const runs = [];
          let i = lo;
          while (i < hi) {
            const fn = wordFont(i);
            let j = i + 1;
            while (j < hi && wordFont(j) === fn) j++;
            runs.push({ start: i, end: j, font: fn });
            i = j;
          }
          return runs;
        }
        // [BOX-ANIM-TYPE] Animasi 'type' HILANG TOTAL saat box highlight nyala.
        // Dibuktikan dengan membandingkan himpunan tag yang benar-benar
        // dipancarkan pada baris teks, box OFF vs ON:
        //
        //   type boxOFF: alpha t(0,26,\alpha&H00&) t(44,70,...) ... (14 tag)
        //   type boxON : blur0                                     (NOL tag)
        //
        // Jalur box memancarkan teksnya sendiri dan tidak pernah tahu soal
        // reveal per-karakter, jadi seluruh cue langsung tampil utuh. Ini
        // setelan yang dipakai pelapor, dan satu-satunya animasi yang benar-
        // benar TIDAK TERJADI sama sekali (yang lain masih menyisakan fade).
        //
        // Jadwalnya disalin dari buildTypeCue supaya kedua jalur mengetik pada
        // kecepatan yang SAMA: cstep = min(55, cueMs*0,55/jumlahKarakter),
        // jendela per karakter 26ms, dan tiap token menyumbang len+1 karakter
        // (spasi ikut diketik bersama katanya).
        const isTypeAnim = effAnim === 'type';
        const typeLens = cueWords.map((w) => Array.from(String(w.text || '').replace(/[{}]/g, '')).length);
        const typeCharOff = [];
        { let acc = 0; for (const n of typeLens) { typeCharOff.push(acc); acc += n + 1; } }
        const typeCharCount = typeLens.reduce((a, n) => a + n + 1, 0);
        const typeCueMs = Math.max(300, (c.end - c.start) * 1000);
        const typeStep = typeCharCount > 1 ? Math.min(55, (typeCueMs * 0.55) / typeCharCount) : 0;
        const TYPE_TW = 26;
        // [TYPE-SOLID-FIRST] Same rule as buildTypeCue: a cue that directly
        // follows another shows its FIRST character from the first frame, or
        // the box sits empty for a frame at every sentence change (found by
        // re-rendering real white_clean + Type + box sessions). `ci` here is
        // still this cue's index; typeWrap's own `ci` below is a char counter.
        const typeJoinPrev = isTypeAnim && cuesJoin(cues[ci - 1], c);
        // Tiap karakter SELALU dapat blok alpha eksplisit — tidak boleh ada
        // yang mewarisi keadaan animasi karakter sebelumnya.
        const typeWrap = (txt, w0, segMs, glowLayer) => {
          if (!isTypeAnim) return txt;
          let ci = typeCharOff[w0] || 0;
          let out = '';
          for (const ch of Array.from(String(txt))) {
            const d = Math.round(ci * typeStep) - segMs;
            const solidFirst = typeJoinPrev && ci === 0;
            ci++;
            if (solidFirst || d + TYPE_TW <= 0) {
              out += glowLayer ? `{\\1a${gEnd}\\3a${gEnd}}${ch}` : `{\\alpha&H00&}${ch}`;
              continue;
            }
            const d0 = Math.max(0, d);
            out += glowLayer
              ? `{\\1a&HFF&\\3a&HFF&\\t(${d0},${d + TYPE_TW},\\1a${gEnd}\\3a${gEnd})}${ch}`
              : `{\\alpha&HFF&\\t(${d0},${d + TYPE_TW},\\alpha&H00&)}${ch}`;
          }
          return out;
        };
        boxLines.forEach((bl, si) => {
          const i = bl.activeIndex;
          const bs = tcAss(bl.start), be = tcAss(bl.end);
          // [BOX-ANIM-ONCE] Prefix teks milik SEGMEN ini.
          const textPrefixTags = textPrefixFor(si === 0, si === boxLines.length - 1);
          const activeTextPrefixTags = activeTextPrefixFor(si === 0, si === boxLines.length - 1);
          // [BOX-ANIM-MOVE] rise/drop menganimasikan POSISI lewat \move, dan
          // jalur box tidak pernah memancarkannya — setiap run dipaku dengan
          // \pos datar. Terbukti dengan membandingkan himpunan tag yang
          // benar-benar dipancarkan pada baris teks, box OFF vs ON:
          //
          //   rise boxOFF: blur2 fad(200,100) move t(0,550,\blur0)
          //   rise boxON : blur2 fad(200,100)      t(0,550,\blur0)   <- move HILANG
          //
          // Jadi rise/drop menyusut jadi sekadar fade+blur: geraknya, yang
          // justru inti animasinya, tidak pernah terjadi.
          //
          // Perjalanan \move milik jalur normal berlangsung slideMs sejak cue
          // muncul, melintasi batas kata. Karena di sini satu cue terpecah jadi
          // beberapa Dialogue, tiap segmen melanjutkan perjalanan yang sama:
          // sisa jaraknya dihitung dari berapa lama segmen ini dimulai SETELAH
          // cue muncul. \move linier dan jalur normal juga linier, jadi
          // keduanya sejajar di tiap frame, bukan cuma di ujungnya.
          const geserMs = Math.max(0, Math.round((bl.start - boxLines[0].start) * 1000));
          // Reveal 'type' dianggap mulai saat caption BENAR-BENAR muncul
          // (segmen pertama), bukan c.start — tidak ada piksel apa pun yang
          // digambar sebelum itu, jadi itulah entrance yang dilihat penonton.
          const segMs = geserMs;
          const sisaMs = slideMs - geserMs;
          const arah = effAnim === 'rise' ? 1 : effAnim === 'drop' ? -1 : 0;
          const posTagFor = (px, py) => {
            if (!arah || sisaMs <= 0) return `\\pos(${px},${py})`;
            const mulai = Math.round(py + arah * slidePx * (sisaMs / slideMs));
            return `\\move(${px},${mulai},${px},${py},0,${sisaMs})`;
          };
          // [BOX-H-FIXED] Tinggi datang dari BOX_H_EM (konstan, kelipatan
          // ukuran font). `lineHeightEm` masih dipakai — tapi HANYA untuk `cy`
          // di atas, yaitu MENCARI pusat vertikal baris teksnya; itu properti
          // teks, bukan properti kotak. Menyatukan keduanya adalah asal-usul
          // laporan "shape terlalu tinggi".
          const rect = boxRectEm({ wordWidthEm: layout.widths[i] / fontSize });
          const wPx = Math.round(rect.wEm * fontSize);
          const hPx = Math.round(rect.hEm * fontSize);
          // box_left = posisi ALAMI kata (bukan dipusatkan ulang di sekitar
          // pusat kata) — lihat catatan [BOX-PAD-INSERT] di atas.
          const bx = shiftX(layout.lefts[i]);
          const by = cyFor(i) - Math.round(hPx / 2);
          const draw = require('./caption-box').rotateBoxDrawing(boxDrawing({ wEm: rect.wEm, hEm: rect.hEm, emPx: fontSize, bordPx }), wPx, hPx, box.rotation);
          // hexToAss() lokal di buildAss — mengembalikan `&HBBGGRR&` siap pakai.
          const boxCol = hexToAss(bl.boxColor) || '&H00FFFF&';
          const inkCol = hexToAss(bl.ink) || '&H00FFFF&';
          const wordTxt = String(cueWords[i].text).replace(/[{}]/g, '');
          const activeX = shiftX(layout.lefts[i] + padPx);
          // [BOX-OVERRIDE-COMPAT] Active word's own tag NEVER carries colour
          // (includeColor:false) — its ink is always contrastInk (inkCol,
          // applied separately below) for guaranteed legibility on the box,
          // regardless of any per-word colour the user picked.
          const activeFontTag = hasRichOverride ? wordRichTag(i, { includeColor: false }) : fontTagFor(wordFont(i));
          // [BOX-ANIM-GLOW] Fragmen animasi milik SEGMEN ini mendahului tag
          // glow, persis urutan yang dipakai jalur normal.
          const glowTags = glow
            ? `${segGlow(si === 0, si === boxLines.length - 1)}\\bord${gbord}\\3c${glowC}\\1c${glowC}\\shad0\\blur${blur}${gAlpha}${boxFsTag}`
            : '';
          // Sisi SEBELUM kata aktif: posisi alami masing-masing run (tidak
          // digeser — hanya kata aktif & sesudahnya yang digeser, lihat
          // [BOX-PAD-INSERT]). Sisi SESUDAH: setiap run bergeser +2×padPx.
          // [BOX-OVERRIDE-COMPAT] Two separate tags per run: `fontTag` (with
          // colour) for the TEXT layer, `glowFontTag` (never colour) for the
          // GLOW layer — glow's own `\1c${glowC}` must not be clobbered by a
          // word's `\1c${color}` landing after it in the same override block.
          const beforeRuns = runsBetween(0, i).map(run => ({
            w0: run.start,
            x: shiftX(layout.lefts[run.start]),
            txt: cueWords.slice(run.start, run.end).map(w => w.text).join(' '),
            fontTag: hasRichOverride ? wordRichTag(run.start, { includeColor: true }) : fontTagFor(run.font),
            glowFontTag: hasRichOverride ? wordRichTag(run.start, { includeColor: false }) : fontTagFor(run.font),
          }));
          const afterRuns = runsBetween(i + 1, cueWords.length).map(run => ({
            w0: run.start,
            x: shiftX(layout.lefts[run.start] + 2 * padPx),
            txt: cueWords.slice(run.start, run.end).map(w => w.text).join(' '),
            fontTag: hasRichOverride ? wordRichTag(run.start, { includeColor: true }) : fontTagFor(run.font),
            glowFontTag: hasRichOverride ? wordRichTag(run.start, { includeColor: false }) : fontTagFor(run.font),
          }));
          // [LAYER-ORDER] Dialogue di layer yang SAMA digambar berurutan
          // sesuai urutan FILE — box (Layer 0) HARUS diemit SESUDAH semua
          // glow (Layer 0 juga) supaya menutupinya, bukan tertutup olehnya.
          // Push SEMUA glow dulu, baru box, baru semua teks — jangan
          // interleave per-run seperti sebelumnya (itu regresi z-order).
          if (glow) {
            for (const r of beforeRuns) out.push(`Dialogue: 0,${bs},${be},Default,,0,0,0,,{\\an7${posTagFor(r.x, y)}${glowTags}${r.glowFontTag}}${typeWrap(r.txt, r.w0, segMs, true)}`);
            // [BOX-GLOW-SUPPRESS] The active (boxed) word's own glow halo is
            // redundant — the box already gives it full contrast treatment —
            // and GEOMETRICALLY HARMFUL: the halo draws at the word's natural
            // top-anchor text height (blurred, bordered), while the box is a
            // much shorter BOX_H_EM-based rectangle (see [BOX-H-FIXED]
            // above). The halo's blur/border spills past the box's top/
            // bottom edges, letting the base style's glow colour — often
            // solid BLACK (e.g. style `bw`, and every bw_hi_*/bw_neon_*
            // highlight style before its own accent even applies) — bleed
            // out around/through the box. Reported live: "font di dalam box
            // highlight blackout". The segment is still EMITTED (keeps the
            // Dialogue-count contract [BOX-STYLE-PARITY]'s test relies on)
            // but fully alpha-hidden — the box's own \p1 rectangle is the
            // only visual treatment the active word should get.
            out.push(`Dialogue: 0,${bs},${be},Default,,0,0,0,,{\\an7${posTagFor(activeX, y)}\\alpha&HFF&${activeFontTag}}${wordTxt}`);
            for (const r of afterRuns) out.push(`Dialogue: 0,${bs},${be},Default,,0,0,0,,{\\an7${posTagFor(r.x, y)}${glowTags}${r.glowFontTag}}${typeWrap(r.txt, r.w0, segMs, true)}`);
          }
          // [BOX-ANIM-BOX] Kotaknya sendiri tidak pernah beranimasi: pada frame
          // burn t=0,06s ia sudah terpampang PENUH dan pekat sementara kata di
          // dalamnya masih diskalakan 64% dan kabur — kotak duluan, isinya
          // menyusul. Sekarang ia ikut animasi masuk kata yang dipeluknya.
          //
          // \blur DIBUANG dari fragmen itu: mem-blur gambar \p1 mengubah
          // kotak pekat jadi awan, bukan kotak yang masuk. \t yang isinya
          // habis setelah pembuangan ikut dibuang, kalau tidak libass menerima
          // `\t(0,200,)` yang tidak sah.
          //
          // Posisinya dikompensasi seperti pada kotak judul ([BOX-ANIM-SCALE]):
          // kotak \an7 menskala di pojok kiri-atasnya sendiri, sementara kata
          // aktif menskala di pojok kiri-atasnya sendiri pula — titik yang
          // BERBEDA. Tanpa kompensasi keduanya merenggang selama penskalaan.
          const boxAnimTags = (() => {
            if (si !== 0) return '';                        // hanya entrance cue
            let a = segAnim(true, si === boxLines.length - 1).replace(/\\blur[\d.]+/g, '');
            a = a.replace(/\\t\(([^)]*)\)/g, (m, dalam) => {
              const bersih = dalam.replace(/\\blur[\d.]+/g, '');
              return /\\[a-z]/.test(bersih) ? `\\t(${bersih})` : '';
            });
            return a;
          })();
          const boxPosTag = (() => {
            if (arah) return posTagFor(bx, by);              // rise/drop: ikut teksnya
            if (si !== 0 || !scale0 || scale0 === 1 || !scaleMs) return `\\pos(${bx},${by})`;
            return `\\move(${Math.round(activeX + scale0 * (bx - activeX))},` +
                   `${Math.round(y + scale0 * (by - y))},${bx},${by},0,${scaleMs})`;
          })();
          out.push(`Dialogue: 0,${bs},${be},Default,,0,0,0,,{\\an7${boxPosTag}${boxAnimTags}\\p1\\1c${boxCol}\\bord${bordPx}\\3c${boxCol}\\shad0}${draw}{\\p0}`);
          for (const r of beforeRuns) out.push(`Dialogue: 1,${bs},${be},Default,,0,0,0,,{\\an7${posTagFor(r.x, y)}${textPrefixTags}\\1c${textC}${r.fontTag}}${typeWrap(r.txt, r.w0, segMs, false)}`);
          out.push(`Dialogue: 1,${bs},${be},Default,,0,0,0,,{\\an7${posTagFor(activeX, y)}${activeTextPrefixTags}\\1c${inkCol}${activeFontTag}}${typeWrap(wordTxt, i, segMs, false)}{\\1c${restoreCol}}`);
          for (const r of afterRuns) out.push(`Dialogue: 1,${bs},${be},Default,,0,0,0,,{\\an7${posTagFor(r.x, y)}${textPrefixTags}\\1c${textC}${r.fontTag}}${typeWrap(r.txt, r.w0, segMs, false)}`);
        });
        return out.join('\n');
      }
    }
    const t = (c.text || '').replace(/\r?\n/g, ' \\N ').replace(/[{}]/g,'');
    const start = tcAss(c.start), end = tcAss(c.end);
    const hiC = hiColorFor(ci);   // [HL-PALETTE] may rotate per cue
    // [TYPE-OVERRIDE-PRECEDENCE] cueHasAnimOverride MUST be checked before
    // typeMode — buildAnimTokenCue already handles a per-word 'type' override
    // (and every un-overridden word falls back to the cue's own `anim`, so a
    // typed cue with a single overridden word still types normally). The old
    // order let typeMode return first whenever the CUE's default animation
    // was "Type", so any per-word override (rise/drop/pop/zoom/blur/type) on
    // an individual word was silently discarded — the whole cue just typed,
    // ignoring every per-word customization. Per-word overrides now always
    // take precedence over the cue-level default, matching how they already
    // behave for every non-"Type" default.
    if (cueHasAnimOverride(c)) {
      return buildAnimTokenCue(c, start, end, hiC,
        { joinPrev: cuesJoin(cues[ci - 1], c), joinNext: cuesJoin(c, cues[ci + 1]) });
    }
    if (typeMode) return buildTypeCue(c, start, end, ci, cuesJoin(cues[ci - 1], c));
    // Per-word styled cue: emit token-built layers. Honours glow on/off and
    // clean-edge (cinematic) the same way the plain path does, but the text
    // comes from per-word override blocks instead of one flat string.
    const hasTokens = Array.isArray(c.tokens) && c.tokens.length
      && c.tokens.some(tk => tk.style && Object.keys(tk.style).length);
    if (hasTokens) {
      // Positioned tokens (dx/dy set) are removed from the inline cue and
      // emitted as their own \pos Dialogue lines so they float freely.
      const positioned = c.tokens.filter(isPositioned);
      const inlineText = tokenText(c.tokens, true);
      const lines = [];
      if (inlineText) {
        // Layer tag carries everything EXCEPT colour — per-token colour comes
        // from tokenGlowText so a manually-highlighted word glows in its own
        // colour instead of the cue's base (often black) glowC.
        const glowLayerTag = `{${an}${posTag}${glowAnim}\\bord${gbord}\\shad0\\blur${blur}${gAlpha}}`;
        if (glow) lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${glowLayerTag}${tokenGlowText(c.tokens, hiC)}`);
        lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,${textTag}${inlineText}`);
      }
      positioned.forEach(tk => { lines.push(positionedTokLines(tk, start, end, hiC)); });
      return lines.join('\n');
    }
    if (hiC) {
      const [head, last] = splitLast(t);
      // Text layer: head in base white, last word in neon. \1c override mid-line
      // swaps the primary colour for the trailing word only.
      // [HL-PURE-GLOW] The highlighted word is a PURE GLOW accent — no black
      // stroke at all (\bord0), no synthetic bold (\b0), no drop shadow (\shad0).
      // The soft blurred colour halo (glowOnlyLast below) is the only treatment,
      // so it reads as a clean glowing word rather than an outlined block.
      const hiWordTag = `\\b0\\bord0\\shad0\\1c${hiC}`;
      const textLine = `Dialogue: 1,${start},${end},Default,,0,0,0,,${textTag}${head}{${hiWordTag}}${last}`;
      if (!glow) return textLine;
      // Glow layer: hide head with full alpha, then reveal a neon halo behind
      // the last word only. \pos keeps the word in its proper offset position.
      // [HL-SOFT-GLOW] Toned-down highlight halo — the full-bright neon bloom was
      // too hot. Thinner border (~55%), smaller blur (~65%) and a partial alpha
      // (\alpha&H80& ≈ 50% transparent) give the soft cinematic-style glow.
      const gbordHi = Math.max(2, Math.round(gbord * 0.55));
      const blurHi  = Math.max(2, Math.round(blur * 0.65));
      const glowOnlyLast = `{${an}${posTag}${glowAnim}\\bord${gbordHi}\\3c${hiC}\\1c${hiC}\\shad0\\blur${blurHi}\\alpha&HFF&}${head}{\\alpha&H80&}${last}`;
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${glowOnlyLast}\n${textLine}`;
    }
    // "og" caption (glow off): render only the crisp text layer — thin black
    // outline + shadow, no blurred halo. Glow on: a blurred halo layer sits
    // behind the text. cleanEdge styles drop the black text border but KEEP
    // the (white) glow halo when glow is ON — the halo is what makes them read.
    if (!glow) {
      return `Dialogue: 1,${start},${end},Default,,0,0,0,,${textTag}${t}`;
    }
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${glowTag}${t}\n` +
           `Dialogue: 1,${start},${end},Default,,0,0,0,,${textTag}${t}`;
  };
  // [KINETIC-CAPTION] A caption template replaces the regular cue lines: each
  // cue builds up word by word from kinetic-title.js (shared with the
  // preview). Its top sits at the caption Y, centred on the caption X; size
  // follows the caption font size (64 = the template's own scale).
  // [CAP-ALIGN] 'id@left' carries the stack alignment (kinCapParam).
  const [kinId, kinFlag] = String(kineticCaption || '').split('@');
  const kinCap = kinId && KT.TEMPLATES[kinId] && /^(cap|cc)_/.test(kinId) ? kinId : '';
  const body = kinCap
    ? cues.map((c, ci) => {
      const txt = String(c.text || '').trim();
      if (!txt) return '';
      const kx = +xPos || 540, ky = +yPos || 1200;
      const L = KT.layout(kinCap, txt, { cx: kx, top: ky, k: (+fontSize || 64) / 64, dur: Math.max(200, ((+c.end || 0) - (+c.start || 0)) * 1000), glow: kinFlag === 'glow' });
      // [KIN-CAP-NO-BLINK] No fade-out when the next cue starts right away —
      // a fade to nothing then a rebuild every ~0.8 s read as blinking. Same
      // rule as regular cues ([CUE-NO-FADEOUT]); the preview uses kinCapFadeMs.
      return KT.toAssEvents(L, { start: +c.start || 0, end: +c.end || 0, fadeOutMs: KT.kinCapFadeMs(c, cues[ci + 1], CONTIGUOUS_CUE_GAP_SEC),
        map: { s: SY, cx: kx, cy: ky, cxOut: kx * SX, cyOut: ky * SY } }).join('\n');
    }).filter(Boolean).join('\n')
    : cues.map((c, ci) => anim === 'fade' ? cueDialogue(c, ci) : applyCueContinuity(cueDialogue(c, ci), cues[ci - 1], c, cues[ci + 1])).join('\n');   // Explicit Fade must keep its opacity ramp between cues.
  // [TITLE-V1] start — emit \pos-anchored Dialogue lines for each title.
  // Every title picks its OWN style (from SUB_STYLES), OWN font size, OWN anim,
  // OWN time range. All overrides ride on Dialogue tags so a single Style: Default
  // (defined at the top of the ASS) is enough — libass applies the per-line \fn,
  // \fs, \1c, \bord, etc. Encoded onto the black-canvas mask when the inverse_auto
  // pipeline is active → titles get auto-inverted along with the caption.
  let titleBody = '';
  if (Array.isArray(titles) && titles.length) {
    const titleLines = [];
    for (const T of titles) {
      const txt0 = String(T?.text || '').trim();
      if (!txt0) continue;
      // [EVENT-WINDOW] Satu definisi jendela waktu, dibagi dengan preview.
      const tw = eventWindow(T.start, T.end);
      // [KINETIC-TITLE] A motion-graphic template replaces the whole regular
      // title emission: its own letters, shapes and keyframes (kinetic-title.js,
      // shared with the preview). Canonical 1080x1920 geometry is scaled by SY
      // around the title's anchor so square/landscape keep the lockup's shape.
      if (T.kinetic && KT.TEMPLATES[T.kinetic]) {
        const kcx = +T.x || 540, kcy = +T.y || 960;
        const L = KT.layout(T.kinetic, txt0, { cx: kcx, cy: kcy, k: (+T.fs || 96) / 96 });
        titleLines.push(...KT.toAssEvents(L, { start: tw.start, end: tw.end,
          map: { s: SY, cx: kcx, cy: kcy, cxOut: kcx * SX, cyOut: kcy * SY } }));
        continue;
      }
      const ts = tcAss(tw.start);
      const te = tcAss(tw.end);
      const ts2 = SUB_STYLES[T.style] || s;
      // [TITLE-V1] Per-word styling: a title may carry `tokens: [{text, style}]`
      // (style = {fn, b, i, color, fs}) so each word can differ, exactly like
      // caption cues. When absent, fall back to the flat title text as one token.
      // Computed here, BEFORE fs2, so its line count can drive [TITLE-FIT] below.
      const tToks = (Array.isArray(T.tokens) && T.tokens.length)
        ? T.tokens
        : txt0.split(/\s+/).filter(Boolean).map(w => ({ text: w }));
      // [TITLE-LAYOUT] Word-index positions where an auto-shaped title starts a
      // new centered line. Computed off tToks itself (not txt0) so the indices
      // always line up 1:1 with the tokens actually being emitted below, even
      // if T.tokens was hand-edited to no longer match a fresh split of txt0.
      // T.layout === 'single' is the per-title escape hatch (Titles panel).
      const titleLineBreaks = (T.layout !== 'single')
        ? autoTitleBreaks(tToks.map(tk => tk.text).join(' '), T.layout, T.lines)
        : [];
      // [TITLE-FIT] A title's fs is sized for ONE line — burning a 4-line auto
      // title at that same size covered nearly the whole frame ("layout numpuk
      // full screen"). Scale down as line count grows so a shaped title's total
      // block height stays roughly constant instead of growing with line count.
      const titleLineCount = titleLineBreaks.length + 1;
      const fitScale = autoFitScale(titleLineCount);
      let fs2 = Math.max(24, Math.round((+T.fs ? Math.min(240, +T.fs) * SY : fontSize) * fitScale));   // [AR-BURN] cap in canonical space, then scale
      // [TITLE-FIT-WIDTH] `fitScale` above only reasons about LINE COUNT — it
      // has no idea whether the text actually rendered in THIS font (italic,
      // condensed, per-word overrides) is wider than the frame. Reported
      // live with a screenshot: a 2-word title ("Solusi Trading",
      // Cinematic/Times Cond Italic/Drop) visibly overflowed past BOTH the
      // left and right video edges — a short title always gets fitScale=1
      // (no shrink at all, see autoFitScale's table), so nothing ever
      // caught this. Measure the REAL rendered width per line with the same
      // textWidthEmSafe() the box-highlight feature already trusts for
      // actual glyph widths (respecting each token's own font/size override,
      // mirroring tokOpen below), and shrink fs2 further whenever the widest
      // line would exceed the frame — on TOP of fitScale, never replacing
      // it. This is the one place that ties a title's font size back to how
      // wide it actually draws; nothing else in the preview or burn does.
      // [TITLE-TRACK] Dihitung DI ATAS fit lebar di bawah, bukan di dekat
      // tokOpen: fit itu harus memakai tracking yang sama dengan yang
      // benar-benar dipancarkan, kalau tidak ia memperkirakan lebar baris
      // untuk teks yang tidak pernah digambar. Nilainya hanya bergantung pada
      // T.track, jadi tempatnya bebas.
      const titleTrackEm = (T.track != null && Number.isFinite(+T.track))
        ? Math.max(-0.2, Math.min(0.4, +T.track))
        : null;
      {
        const fitFontsDir = assFontsDirFs();
        const fitBaseFont = T.fn || ts2.font || 'Open Sauce Two ExtraBold';
        const fitLines = splitTitleLines(tToks, titleLineBreaks);
        let widestLinePx = 0;
        for (const line of fitLines) {
          let lineW = 0;
          line.forEach((tk, k) => {
            const stw = tk.style || {};
            const fnw = stw.fn || fitBaseFont;
            const fsw = stw.fs ? Math.max(24, Math.round(Math.min(240, stw.fs) * SY)) : fs2;
            // [FIT-WIDTH-BOLD] Measure the FACE libass will render for THIS token
            // — same bold/italic resolution as tokOpen below (per-word `b`/`i`,
            // else the title style's bold). A bold/italic word on a family with
            // a real sibling (Apple Garamond) draws wider than the regular face.
            const bw = (stw.b != null) ? !!stw.b : !!ts2.bold;
            const iw = !!stw.i;
            lineW += (textWidthEmSafe(String(tk.text || ''), fnw, fitFontsDir, bw, iw) || 0) * fsw;
            if (k < line.length - 1) lineW += (textWidthEmSafe(' ', fnw, fitFontsDir, bw, iw) || 0) * fsw;
            // [TITLE-FIT-TRACK] Lebar advance saja MENGABAIKAN \fsp, dan setiap
            // token judul memancarkannya. Terukur pada burn 1080x1920, Anton
            // \fs116, "PENONTON KABUR SEBELUM DETIK KETIGA" (35 karakter):
            // \fsp0 menggambar 1002px, \fsp-5 menggambar 832px — selisih 170px,
            // tepat (35-1) x 5. Jadi biayanya per BATAS antar-karakter, bukan
            // per karakter, dan spasi ikut dihitung sebagai karakter.
            //
            // Tanpa suku ini fit menyangka baris itu 1000px (tepat budget) lalu
            // membiarkannya, padahal yang tergambar 830px: judul yang perlu
            // dikecilkan terbakar ~17% lebih kecil daripada yang ditampilkan
            // preview, yang mengukur lebar DOM nyata (letter-spacing ikut) dan
            // memang mendarat di 998,5px. Inilah selisih ukuran preview/burn
            // yang terukur untuk judul yang memakai tracking style-nya sendiri.
            const trkTok = (titleTrackEm != null)
              ? titleTrackEm
              : (() => {
                  const emTok = stw.fn ? FONT_EM(stw.fn) : (T.fn ? FONT_EM(T.fn) : null);
                  return emTok != null ? emTok : (ts2.trackEm != null ? ts2.trackEm : TRACK_EM);
                })();
            const nChar = String(tk.text || '').length;
            // Batas yang dimiliki token ini: satu setelah tiap hurufnya, plus
            // satu setelah spasi pemisah; token terakhir kehilangan batas
            // paling ujung. Jumlahnya = totalKarakter - 1, seperti yang diukur.
            const nBatas = (k < line.length - 1) ? nChar + 1 : Math.max(0, nChar - 1);
            lineW += nBatas * trkTok * fsw;
          });
          if (lineW > widestLinePx) widestLinePx = lineW;
        }
        // [TITLE-FIT-MARGIN] Was `PR.w - 40` (a flat 40-unit margin, wrongly
        // modeled on tx2's unrelated POSITION clamp two lines below) instead
        // of the WIDTH budget this fix's own comment says it mirrors — the
        // preview side (renderer.js paintTitleLayer) and styles.css:704 both
        // use 92.59% = (1080-40-40)/1080, an 80-unit margin. A title between
        // the two thresholds shrank in the editor preview but burned at full
        // size. `* 0.9259` (not a fixed px subtraction) also keeps the SAME
        // proportion across formats (PR.w=1080 portrait vs 1920 landscape),
        // matching the preview's percentage-based check exactly.
        const titleMaxWidthPx = PR.w * 0.9259;
        if (widestLinePx > titleMaxWidthPx && widestLinePx > 0) {
          fs2 = Math.max(20, Math.round(fs2 * (titleMaxWidthPx / widestLinePx)));
        }
      }
      const tx2 = Math.max(20, Math.min(PR.w - 20, Math.round((+T.x || 540) * SX)));
      // [TITLE-CENTER] \an8 anchors at the TOP of the text block, so it grows
      // downward from T.y — a title placed at the frame's true centre
      // (y:960) then visually sits BELOW centre, worse the more lines it
      // has. Shift the anchor up by HALF the full block height (every line,
      // not just the ones beyond the first) so T.y always lands on the
      // block's own visual centre — the actual meaning of "centered".
      const titleCenterShift = Math.round(titleLineCount * fs2 * 1.2 / 2);
      const ty2 = Math.max(20, Math.min(PR.h - 20, Math.round((+T.y || 960) * SY) - titleCenterShift));
      const anim2 = T.anim || 'none';
      const cleanEdge2 = !!ts2.noEdge;
      const primaryC = '&H' + String(ts2.primary).replace(/&H/i, '').replace(/&$/, '').slice(-6) + '&';
      // [TITLE-GLOW] The halo colour comes from the style, which pins a title
      // to whatever palette that style carries — there is no cyan-glowing
      // style, so a cyan accent could only ever be haloed lime. `T.glowColor`
      // lets a title state its own; absent, the style decides exactly as before.
      const glowSrc2 = T.glowColor ? hexToAss(T.glowColor) : null;
      const glowC2   = glowSrc2 || ('&H' + String(ts2.glow).replace(/&H/i, '').replace(/&$/, '').slice(-6) + '&');
      // [TITLE-FONT] Title-level font override (T.fn, set in the Titles panel).
      // Falls back to the style's own font — the previous behaviour. Without
      // this the burn ignored the title font picker entirely and only per-word
      // st.fn reached libass.
      // [BURN-FONT] Titles deliberately do NOT follow the caption font
      // override. They are a separate object with their own per-title font
      // control, and — decisively — the renderer's title painter does not
      // apply the override, so honouring it here made the burn disagree with
      // the preview for every title the user had not styled by hand.
      const fn2 = T.fn || ts2.font || 'Open Sauce Two ExtraBold';
      const b2  = ts2.bold ? 1 : 0;
      // [TITLE-ANIM-PARITY] Titles used to carry a SEPARATE, older switch here
      // (200ms fade-in, 260ms \move for rise/drop, no blur-in on pop) that had
      // drifted from both the caption burn AND the CSS preview — a title
      // animated on its own timing under a name ("pop", "rise"…) that meant
      // something else everywhere else in the app. Now titles call the exact
      // same animFragments() the caption path uses, with the TITLE's own pixel
      // size (fs2) so a 96px title travels/scales proportionally to itself, not
      // to whatever the last caption cue happened to be.
      const titleGlowMul2 = ts2.glowMul != null ? ts2.glowMul : 1;
      const { glowAnim: glowAnim2, textAnim: textAnim2, slideMs: slideMs2, slidePx: slidePx2,
              scale0: scale02, scaleMs: scaleMs2 } =
        animFragments(anim2, fs2, titleGlowMul2, 1);
      // Position anchor: rise/drop animate position via \move, from an offset
      // start point back to the real anchor — everything else keeps \pos static.
      // [TITLE-INK-LEADING] Dijadikan fungsi dari y supaya emisi per-baris
      // memakai template yang SAMA — termasuk \move untuk rise/drop, yang
      // kalau dilewatkan akan membuat baris ke-2 diam sementara baris ke-1
      // meluncur (cacat sejenis [BOX-ANIM-MOVE] yang sudah diperbaiki).
      const posAt = (y) => (
        anim2 === 'rise' ? `\\move(${tx2},${y + slidePx2},${tx2},${y},0,${slideMs2})`
        : anim2 === 'drop' ? `\\move(${tx2},${y - slidePx2},${tx2},${y},0,${slideMs2})`
        : `\\pos(${tx2},${y})`
      );
      const posT = posAt(ty2);
      // [TITLE-STYLE-PARITY] Mirror the caption look for this style exactly:
      //   • edge: cleanEdge styles (cinematic/inverse) drop the black border.
      //   • spacing: honour the style's Spacing (cinematic -12, bw -8) via \fsp
      //     when the font has no per-font tightening of its own (fontFsp).
      //   • glow: cinematic is cleanEdge but STILL wants its soft white halo —
      //     the previous `!cleanEdge2` guard wrongly stripped it, leaving flat
      //     white text. Render the halo for every style EXCEPT inverse_auto
      //     (which inverts against the video and needs no halo). Soft styles use
      //     glowMul + glowAlpha so the bloom stays gentle (matches caption).
      const isInverseStyle = (T.style === 'inverse_auto');
      // [WYSIWYG-SPACING] em-based like captions — ts2 is the TITLE's style
      // (may differ from the cue style `s` fontFsp closes over).
      const baseSpacing = emFsp(ts2.trackEm, fs2);
      const bordT = cleanEdge2 ? `\\bord0\\shad0` : `\\bord3\\3c&H000000&\\shad2`;
      const glowMul2 = ts2.glowMul != null ? ts2.glowMul : 1;
      const gBlurT = Math.max(2, Math.round((fs2 / 6) * glowMul2));
      const gBordT = Math.max(2, Math.round((fs2 / 9) * glowMul2));
      const gAlphaT = ts2.glowAlpha ? `\\1a${ts2.glowAlpha}\\3a${ts2.glowAlpha}` : '';
      // [TITLE-GLOW] Per-title glow toggle (T.glow, default on). Falls back to
      // the global subtitle glow only when the title didn't set its own.
      const titleGlowOn = (T.glow != null) ? (T.glow !== false) : glow;
      // [TITLE-TRACK] Clamped to a range that stays legible: -0.2em already
      // overlaps most faces, +0.4em is airy but still reads as one word.
      // [TITLE-WORD-GLOW] The halo is one blurred copy of the WHOLE title, so
      // turning glow on lit every word. When any word is marked `gl`, the glow
      // layer still draws the whole line — keeping the layout identical — but
      // the unmarked words are made fully transparent ON THAT LAYER so only the
      // chosen ones give off light. No `gl` anywhere keeps the old behaviour.
      const titleWordGlow = Array.isArray(T.tokens)
        && T.tokens.some(tk => tk && tk.style && tk.style.gl);
      // [TITLE-WORD-ANIM] \fad dan \move adalah tag TINGKAT-BARIS: sebuah kata
      // tidak bisa beranimasi sendiri di dalam Dialogue bersama. Kata yang
      // animasinya berbeda dari judulnya karena itu memakai jalur yang SAMA
      // dengan kata yang digeser — disembunyikan di tempatnya, digambar ulang
      // di jangkarnya sendiri. Saat judulnya sendiri 'type' jalur itu tidak
      // dipakai (mesinnya per-karakter), jadi per-kata ikut judul di sana —
      // dan preview disamakan ke situ.
      const effAnOf = (tk) => {
        // Penjaga mode type ada DI SINI, bukan di ownsLine saja: kotak highlight
        // juga memanggil effAnOf, dan kalau penjaganya cuma di ownsLine maka
        // kotak akan meluncur sendirian sementara kata yang dipeluknya diam.
        if (anim2 === 'type') return anim2;
        const a = tk && tk.style && tk.style.an;
        return (a && PER_WORD_TITLE_ANIMS.has(a)) ? a : anim2;
      };
      const ownsLine = (tk) => {
        const st = (tk && tk.style) || {};
        return !!((+st.dx) || (+st.dy)) || effAnOf(tk) !== anim2;
      };
      const titleHasDrag = Array.isArray(T.tokens) && T.tokens.some(ownsLine);
      const titleHasOutline = Array.isArray(T.tokens)
        && T.tokens.some(tk => tk && tk.style && tk.style.ol);
      const titleHasBox = Array.isArray(T.tokens)
        && T.tokens.some(tk => tk && tk.style && tk.style.box);
      const wantGlow = titleGlowOn && ts2.glow && !isInverseStyle;
      // [HOOK-WORD] Accent the title's punchline words (last 2 — see
      // title-layout.js) with the style's own highlight colour, or the brand
      // lime when the style has none of its own (inverse_auto, white_clean —
      // the two title defaults — carry no `.highlight`). A word with an
      // EXPLICIT per-word colour (user painted it by hand in the Titles
      // panel) always wins — this is a fallback, never an override. Gated on
      // the same auto-layout condition as the line breaks: both are the
      // "auto title styling" toggle, on by default, off via T.layout='single'.
      // [TITLE-BOX] A title with any manually-boxed word (tk.style.box) drops
      // hook-word auto-highlighting entirely — same gate the preview uses in
      // paintTitleLayer (renderer.js). Computed as a flat index across ALL of
      // tToks, matching titleBoxRects' own flat-indexing convention.
      const boxedIdx = new Set(tToks.reduce((arr, tk, i) => { if (tk.style && tk.style.box) arr.push(i); return arr; }, []));
      const hookOn = T.layout !== 'single' && boxedIdx.size === 0;
      const hookIdxSet = new Set(hookOn ? hookWordIndices(tToks.map(tk => tk.text).join(' '), 2) : []);
      const hookColorAss = c6(ts2.highlight || '&H0000FFF1');
      // Per-token override string. `withColor` false = glow layer (colour comes
      // from the layer's own \1c). Falls back to the style's spacing when the
      // token font has no per-font \fsp rule of its own.
      // [TITLE-BOX-TRACK] ONE tracking resolution for the \fsp tokOpen emits
      // and for the box/anchor geometry below — they drifted apart once.
      const tokTrackEm = (tk) => {
        const st = (tk && tk.style) || {};
        const tsTrackEm = ts2.trackEm != null ? ts2.trackEm : TRACK_EM;
        const emTok = st.fn ? FONT_EM(st.fn) : (T.fn ? FONT_EM(T.fn) : null);
        return (titleTrackEm != null) ? titleTrackEm : (emTok != null ? emTok : tsTrackEm);
      };
      const tokFss = (tk) => {
        const st = (tk && tk.style) || {};
        return st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fs2;
      };
      const titleTrackPxFor = (tk) => Math.round(tokTrackEm(tk) * tokFss(tk));
      const tokOpen = (tk, withColor, idx) => {
        const st = tk.style || {};
        const fn = st.fn || fn2;
        const bb = (st.b != null) ? (st.b ? 1 : 0) : b2;
        const it = st.i ? 1 : 0;
        const fss = st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fs2;   // [AR-BURN] cap in canonical space, then scale
        // Per-word font override → that font's em; otherwise the title style's
        // trackEm — mirrors the title-panel preview inline letter-spacing.
        // [TITLE-FONT] Tracking follows whichever font actually wins: the
        // per-word override, else the title-level font, else the style's trackEm.
        //
        // [TRACK-UNIFORM] `ts2.trackEm != null ? ts2.trackEm : TRACK_EM`, NOT a
        // bare `ts2.trackEm` — styles with no trackEm of their own (neon_green,
        // neon_pink, yellow, the bw_neon_* variants) used to fall through to an
        // EMPTY \fsp here, which emits no override at all for that token. Every
        // Dialogue line — caption AND title — is stamped with a base \fsp at
        // its head (see stampBaseFsp near the end of this function) computed
        // from the CAPTION cue's style and font size, not the title's own. A
        // title using a no-trackEm style silently inherited THAT unrelated
        // value instead of its own tracking — wrong style, usually wrong scale
        // too since a title's fs2 rarely matches the caption's fontSize.
        // [TITLE-TRACK] A per-title letter-spacing override, in em, on top of
        // the font/style default. Clamped in buildAss below so a typo cannot
        // fling a title off-frame. Absent, the chain is exactly as before.
        // [TITLE-BOX-TRACK] Resolved by tokTrackEm, shared with the geometry.
        const trackEm = tokTrackEm(tk);
        const fspTok = emFsp(trackEm, fss);
        // [TITLE-BOX] Boxed word ink beats everything else (per-word colour
        // included — same "box always wins" rule captions use, and the same
        // reason: contrastInk already guarantees readable ink on the box, a
        // hand-picked colour underneath it could easily be unreadable).
        const boxInkTag = tk.style && tk.style.box ? contrastInk(T.boxColor || '#F1FF00') : null;
        const fallbackColor = boxInkTag ? hexToAss(boxInkTag) : (hookIdxSet.has(idx) ? hookColorAss : primaryC);
        const colTag = withColor ? `\\1c${(!boxInkTag && st.color && hexToAss(st.color)) || fallbackColor}` : '';
        // [FS-EM-SCALE] Same split as the caption tokens: `fss` stays canonical
        // for \fsp and the glow/border maths above, and only the \fs libass
        // reads is converted — using this token's own winning face.
        // [TITLE-OUTLINE] `ol` draws the word as outline only: the fill goes
        // fully transparent and the border carries the colour. ASS has no
        // "stroke only" mode, so it is built from the two tags that produce
        // it. The border scales with the word's own size, or a small word in
        // a mixed line would get a fat outline meant for a big one. On the
        // glow layer (withColor false) the fill must stay opaque, otherwise
        // the halo is punched hollow too and the word loses its glow.
        // An ASS override holds until something changes it, so a hollow word
        // left the words AFTER it hollow too — "JANGAN SCROLL" burned with
        // both lines outlined. Every other word in a title that uses outline
        // must therefore state the solid case outright.
        // On the glow layer, an unmarked word paints nothing. ASS overrides
        // persist to the end of the line, so the marked words must restate
        // their own alpha — the same leak that made one hollow word hollow
        // out every word after it.
        // [TITLE-WORD-DRAG] A dragged word keeps its slot in the run but is
        // drawn INVISIBLE there, so the line does not reflow around the gap;
        // a separate \pos Dialogue draws it at its natural spot plus the
        // offset. Same trick the caption path uses for hidden words.
        // ASS alpha persists to the end of the line, so hiding a dragged word
        // hid every word after it too — "SATU DUA TIGA" lost TIGA. Every other
        // word in a title that has a dragged one must restate the visible case.
        const glTag = (!withColor && titleWordGlow)
          ? (st.gl ? `\\1a${ts2.glowAlpha || '&H00&'}\\3a${ts2.glowAlpha || '&H00&'}` : '\\1a&HFF&\\3a&HFF&')
          : '';
        // [TITLE-BOX-OL] Box MENANG atas outline. Kata dengan keduanya menyala
        // hilang total sebelumnya: cabang hollow di bawah membuat fill
        // transparan karena kata berongga mengandalkan stroke, lalu aturan
        // kata-berkotak menambahkan \bord0\shad0 di belakangnya dan menghapus
        // stroke itu — fill transparan tanpa stroke berarti tidak ada yang
        // tergambar. Diburn dan dilihat: kotaknya ada, katanya lenyap, dan
        // preview tetap menampilkannya. "Box selalu menang" sudah jadi aturan
        // yang dinyatakan berulang di file ini (contrastInk menjamin
        // keterbacaan; outline di atas box cuma melebur huruf jadi satu slab),
        // jadi kedua sisi disamakan ke sana.
        const olTag = !withColor ? ''
          : (st.ol && !boxInkTag)
            // Stroke colour is its own setting (`olc`); the fill stays whatever
            // `color` says. Only a word with NO fill colour goes hollow.
            ? `${st.color ? '' : '\\1a&HFF&'}\\bord${Math.max(2, Math.round(fss * 0.045))}\\3c${(st.olc && hexToAss(st.olc)) || '&HFFFFFF&'}\\3a&H00&`
            : boxInkTag ? '\\1a&H00&\\bord0'
            // [TITLE-EDGE-RESTORE] Every OTHER word restates the line's own edge
            // (bordT), not \bord0: ASS overrides run to the end of the line, so
            // after a boxed word (\bord0\shad0) or a hollow one (\bord + olc)
            // the words that follow inherited that state. With a style that HAS
            // an edge (bw, neon, …) they burned without their black outline —
            // "Orang [Nilai] Kamu": Orang outlined, Kamu bare. white_clean and
            // the other clean-edge styles keep emitting exactly what they did.
            : titleHasOutline ? `\\1a&H00&${cleanEdge2 ? '\\bord0' : bordT}`
            : (titleHasBox && !cleanEdge2) ? bordT
            : '';
        // [TITLE-DRAG-ALPHA] A dragged word is hidden where it sits and redrawn
        // at its own anchor, and ASS alpha runs to the end of the line — so
        // every OTHER word has to restate its visible alpha. Restating it as
        // blanket opacity was wrong twice over: this tag is emitted AFTER
        // olTag/glTag and ASS is last-wins, so ONE drag filled in every hollow
        // word and handed the whole title the halo that belonged to the accent
        // line alone. Reproduced from a real render. Restate the alpha the word
        // already has instead — the same two conditions olTag/glTag just used.
        const ownAlpha = !withColor
          ? (glTag || '\\1a&H00&\\3a&H00&')
          : ((st.ol && !st.color) ? '\\1a&HFF&\\3a&H00&' : '\\1a&H00&\\3a&H00&');
        const dragTag = ownsLine(tk)
          ? '\\1a&HFF&\\3a&HFF&'
          : (titleHasDrag ? ownAlpha : '');
        return `\\fn${fn}\\b${bb}\\i${it}\\fs${assFs(fss, fn, !!bb, !!it)}${fspTok}${colTag}${olTag}${glTag}${dragTag}`;
      };
      const cleanTxt = (s2) => String(s2 || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
      // [TITLE-INK-LEADING] Baris-baris judul ini, plus atas-baris yang dipakai
      // SEMUA hal yang diposisikan per baris: teksnya, kotak highlight-nya, dan
      // kata yang digeser. Satu sumber, supaya tidak bisa berpisah.
      const titleFitLines = splitTitleLines(tToks, titleLineBreaks);
      // Indeks GLOBAL token per baris — dibangun dengan aturan yang sama
      // dengan splitTitleLines, tapi menyimpan indeksnya karena tokOpen()
      // memerlukannya (hookIdxSet di-indeks secara flat).
      const titleLineIdxGroups = (() => {
        const groups = []; let cur = [];
        tToks.forEach((tk, i) => {
          if (titleLineBreaks.includes(i) && cur.length) { groups.push(cur); cur = []; }
          cur.push(i);
        });
        if (cur.length) groups.push(cur);
        return groups;
      })();
      const titleInkOpts = {
        fs2, fontsDir: assFontsDirFs(), baseFont: fn2, boldDefault: !!ts2.bold, SY,
        // WAJIB: titleInkLineTops membangun di atas titleLineTops, dan
        // titleLinePitch memakai lineHeightEm sebagai em cadangan untuk token
        // tanpa override. Tanpa ini pitch-nya NaN dan barisnya mendarat di
        // \pos(x,NaN) — terlihat langsung sebagai baris yang terbang ke atas
        // frame. Terjaring oleh [TITLE-INK-LEADING-OPTS] di test.
        lineHeightEm: fontEmScale(fn2, assFontsDirFs(), !!ts2.bold, false) || 1.2,
      };
      // Model tinta hanya dipasang saat baris-barisnya BEDA ukuran — itulah
      // satu-satunya kasus yang cacat. Judul berukuran seragam tetap lewat
      // jalur lama dan tetap byte-identik.
      const titleInkTops = (() => {
        // [TITLE-INK-LEADING] Pasangannya di preview: paintTitleLayer membungkus
        // tiap baris dengan .ttl-line dan menggesernya dengan rumus yang SAMA
        // (inkLeadOffsets), memakai leadEm/gapEm yang diukur canvas di sana.
        // Kalau salah satu sisi dimatikan sendiri, keduanya berselisih ~26px.
        if (!TITLE_INK_LEADING_ON) return null;
        // Teks satu token yang MEMUAT baris baru sendiri: cleanTxt mengubahnya
        // jadi \N, yang di jalur per-baris membuat baris visual kedua DI DALAM
        // Dialogue baris itu — diposisikan oleh pitch libass sendiri, sementara
        // baris berikutnya dipaku di atas-tintanya. Keduanya bisa bertumpuk.
        // Di jalur lama semuanya mengalir, jadi paling buruk cuma bergeser.
        //
        // Token seperti ini hanya muncul dari data yang disunting/diimpor
        // (split /\s+/ tidak pernah menghasilkannya) dan autoTitleBreaks
        // menghitungnya sebagai satu kata, jadi jalur lama dibiarkan menangani
        // kasus itu apa adanya — lebih baik bergeser daripada bertumpuk.
        if (tToks.some(tk => /\r?\n/.test(String((tk && tk.text) || '')))) return null;
        // titleInkLineTops sendiri yang memutuskan: ia mengembalikan null kalau
        // tidak ada baris yang perlu digeser. Dulu di sini ada gerbang
        // titleSizesMixed(), yang melewatkan baris ganti-FONT dan ikut menyala
        // untuk arah mengecil yang offset-nya nol.
        const tops = titleInkLineTops(titleFitLines, ty2, titleInkOpts);
        // Satu atas-baris per baris, atau tidak dipakai sama sekali. Emisi
        // per-baris meng-indeks langsung ke sini; panjang yang tidak cocok
        // akan menempatkan baris di undefined, bukan gagal dengan berisik.
        return (tops && tops.length === titleLineIdxGroups.length) ? tops : null;
      })();
      // [TITLE-BOX] Emit one \p1 rectangle Dialogue per boxed word, in the
      // SAME layer (0) as glow and BEFORE the text lines below in file order
      // — Dialogue lines in one ASS layer paint in file order, so this sits
      // on top of any glow halo and under the text, matching the caption
      // box's own [LAYER-ORDER] convention. fs2 here is the FINAL,
      // post-TITLE-FIT-WIDTH-shrink size (this code runs after that shrink),
      // so boxes never drift from the text they sit behind.
      // [HOOK-BACKDROP] A title-level backdrop behind the whole hook block:
      //   'card'     — one rounded panel around every line (cover-card hooks)
      //   'gradient' — a full-width band that darkens from just above the
      //                block down to the bottom of the frame (cinema hooks)
      // The block's extent comes from titleBoxRects with EVERY word treated as
      // boxed — the same per-word geometry the box highlight uses, whose
      // preview/burn parity is already pinned — so the panel hugs the text the
      // way a boxed word does. Fades with the title (no scale: a panel that
      // pops reads as a glitch, and the text inside still plays its own anim).
      if (T.backdrop === 'card' || T.backdrop === 'gradient') {
        const allIdx = new Set(tToks.map((_tk, k) => k));
        const blockRects = titleBoxRects({
          trackPxFor: titleTrackPxFor,
          fitLines: titleFitLines,
          boxedIdx: allIdx, fs2, fontsDir: assFontsDirFs(), baseFont: fn2, boldDefault: !!ts2.bold,
          tx2, ty2, SY, lineTops: titleInkTops,
          lineHeightEm: fontEmScale(fn2, assFontsDirFs(), !!ts2.bold, false) || 1.2,
        });
        const bd = backdropGeometry(T, blockRects, fs2, PR);
        if (bd) {
          const { fadeIn: bfi, fadeOut: bfo } = ANIM_TIMING;
          for (const part of bd.parts) {
            // Name field tags the panel (`backdrop-card` / `backdrop-gradient`)
            // so hook placement can tell a backdrop from text: the gradient
            // band may sit under captions on purpose, the card may not.
            titleLines.push(`Dialogue: 0,${ts},${te},Default,backdrop-${T.backdrop},0,0,0,,{\\an7\\pos(${part.x},${part.y})\\fad(${bfi},${bfo})\\p1\\1c${bd.color}\\1a${part.alpha}\\bord${part.bord}\\3c${bd.color}\\3a${part.alpha}\\shad0\\blur${part.blur || 0}}${part.draw}{\\p0}`);
          }
        }
      }
      if (boxedIdx.size) {
        const boxCol = hexToAss(T.boxColor || '#F1FF00') || '&H00AAFF&';
        const rects = titleBoxRects({
          trackPxFor: titleTrackPxFor,
          fitLines: titleFitLines,
          boxedIdx, fs2, fontsDir: assFontsDirFs(), baseFont: fn2, boldDefault: !!ts2.bold,
          tx2, ty2, SY, lineTops: titleInkTops,
          // [HOOK-FONT] libass spaces a title's lines by the FACE's own line
          // box, so the box pass has to use the same number or the rectangles
          // drift down the block and sit off-centre on their words. 1.2 was
          // hardcoded here and happens to be within 3% of the default face —
          // which is why only a tall-capped override (Anton, 1.505) exposed it.
          // [HOOK-FONT] Measured, not assumed: libass spaces a title's lines by
          // exactly the \fs it renders at (116px apart at \fs116, 138 at
          // \fs137). That is fsw x fontEmScale. cssLineHeightEm happens to be
          // the same number for the default face, which is why a hardcoded 1.2
          // survived here for so long, but it is 13% short for Anton and the
          // boxes drifted a little further down the block on every line.
          lineHeightEm: fontEmScale(fn2, assFontsDirFs(), !!ts2.bold, false) || 1.2,
        });
        for (const r of rects) {
          const bordPx = Math.round(r.fsw * RADIUS_EM);
          const draw = boxDrawing({ wEm: r.wPx / r.fsw, hEm: r.hPx / r.fsw, emPx: r.fsw, bordPx });
          // [BOX-ANIM] The box carried NO entrance animation while its text
          // popped in, so for the first ~200ms a full-size slab sat on screen
          // with nothing inside it — reported from a real render. It now runs
          // the SAME fragment as the text, anchored at the rectangle's own
          // centre (\an5) so the scale grows from the middle the way the text
          // does, instead of unfolding from a corner.
          // [BOX-DRAW-ANCHOR] lihat catatan di boxDrawAnchor: inset path harus
          // dikompensasi, kalau tidak kotaknya mendarat bord px ke kanan-bawah.
          const { x: bcx, y: bcy } = boxDrawAnchor({
            leftPx: r.boxLeftPx, topPx: r.boxTopPx, wPx: r.wPx, hPx: r.hPx, bordPx,
          });
          // [TITLE-WORD-ANIM] Kotak memakai animasi KATA yang dipeluknya, bukan
          // animasi judul. Kalau tidak, kotak dan isinya masuk dengan gerak
          // berbeda — jenis ketidakcocokan yang sama dengan yang sudah
          // diperbaiki [BOX-ANIM] untuk "kotak diam sementara teksnya pop".
          const boxTok = tToks[r.wordIdx];
          const boxAn = effAnOf(boxTok);
          const boxFrag = (boxAn === anim2)
            ? { textAnim: textAnim2, slideMs: slideMs2, slidePx: slidePx2,
                scale0: scale02, scaleMs: scaleMs2 }
            : animFragments(boxAn, fs2, titleGlowMul2, 1);
          // [BOX-ANIM-MOVE] rise/drop menganimasikan POSISI lewat \move, dan
          // kotak tidak pernah menerimanya — ia hanya dapat fragmen \fad/\blur.
          // Akibatnya kotak sudah terpampang di posisi akhir sementara katanya
          // masih meluncur naik, lalu keduanya menyatu: itulah "kedip" yang
          // dilaporkan. Diburn dan dilihat pada t=0.08s. [BOX-ANIM] dulu
          // memperbaiki sisi FRAGMEN dari cacat yang sama; ini sisi posisinya.
          // [BOX-ANIM-SCALE] Animasi yang MENSKALA (pop, zoom) membuat kotak dan
          // isinya berpisah, karena keduanya menskala di titik putar yang
          // BERBEDA: kotak \an5 di pusatnya sendiri, teks \an8 di atas-tengah
          // barisnya. Terukur pada burn 1080x1920 (Anton fs110, kotak 186px
          // tinggi, \fad dan \blur dilepas supaya yang tersisa murni geometri),
          // offset pusat tinta terhadap pusat kotak:
          //
          //   anim   t=0      t=0,20   pergeseran
          //   pop    -41,0    -10,5    30,5px   <- 16% tinggi kotak
          //   zoom   -18,5    -10,5     8,0px
          //   none/fade/rise/drop/blur          0,0-0,5px (stabil)
          //
          // Jadi selama 200ms pertama katanya melayang di luar kotaknya sendiri.
          // Di preview ini MUSTAHIL terjadi: kotak di sana adalah `background`
          // dari span kata itu sendiri (lihat st.box di renderer.js), satu
          // elemen, satu transform-origin — offsetnya konstan. Preview-lah
          // patokannya, jadi yang harus dikejar burn adalah offset KONSTAN.
          //
          // Perbaikannya: perlakukan titik \pos kotak seperti titik mana pun
          // pada teks, yaitu ikut diskalakan terhadap jangkar barisnya. \move
          // linier dan \t default juga linier, jadi keduanya sejajar di setiap
          // frame, bukan cuma di ujung-ujungnya.
          const boxAnchorY = (r.lineTopPx != null) ? r.lineTopPx : ty2;
          const boxScaleMove = (boxFrag.scale0 != null && boxFrag.scale0 !== 1 && boxFrag.scaleMs > 0)
            ? `\\move(${Math.round(tx2 + boxFrag.scale0 * (bcx - tx2))},` +
              `${Math.round(boxAnchorY + boxFrag.scale0 * (bcy - boxAnchorY))},` +
              `${bcx},${bcy},0,${boxFrag.scaleMs})`
            : null;
          const boxPos = boxAn === 'rise'
            ? `\\move(${bcx},${bcy + boxFrag.slidePx},${bcx},${bcy},0,${boxFrag.slideMs})`
            : boxAn === 'drop'
              ? `\\move(${bcx},${bcy - boxFrag.slidePx},${bcx},${bcy},0,${boxFrag.slideMs})`
              : (boxScaleMove || `\\pos(${bcx},${bcy})`);
          titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an5${boxPos}${boxFrag.textAnim}\\p1\\1c${boxCol}\\bord${bordPx}\\3c${boxCol}\\shad0}${draw}{\\p0}`);
        }
      }
      if (anim2 === 'type') {
        // [TITLE-BOX-TYPE-GAP] Boxed words get correct position/colour here
        // too (tokOpen is shared with the non-animated path below), but do
        // NOT get that path's \bord0\shad0 outline suppression — a boxed
        // word's typed-in text keeps its normal black outline in this one
        // combination (box + typewriter animation). Deliberately deferred,
        // not forgotten: fold noOutline into openT/openG below the same way
        // bodyText() does, if this combination needs visual parity later.
        // [TITLE-TYPE] Typewriter: reveal each character on a staggered \alpha so
        // the title types in — same feel as the caption 'type' animation.
        // [EVENT-WINDOW] Tempo ketik dihitung dari jendela EFEKTIF, bukan dari
        // rentang mentah: rentang terbalik dulu memberi durMs 300ms untuk event
        // yang sebenarnya cuma 0,05s. Untuk judul normal angkanya identik, jadi
        // tidak ada perubahan output. Preview memakai rumus yang sama.
        const durMs = Math.max(300, (tw.end - tw.start) * 1000);
        const charCount = tToks.reduce((n, tk) => n + Array.from(String(tk.text || '')).length + 1, 0);
        const cstep = charCount > 1 ? Math.min(55, (durMs * 0.55) / charCount) : 0;
        const TW = 26, gEndT = ts2.glowAlpha || '&H00&';
        // [TITLE-INK-LEADING] Dikumpulkan PER BARIS, bukan satu untai panjang,
        // supaya model tinta bisa memberi tiap baris \pos-nya sendiri. `ci2`
        // tetap berjalan menyeberangi baris, jadi urutan dan tempo ketikannya
        // sama sekali tidak berubah. Cabang ini WAJIB ikut dikonversi: kotak
        // highlight di bawah sudah memakai atas-baris berbasis tinta, jadi
        // membiarkan teksnya di model kotak-em akan memisahkan keduanya —
        // cacat yang sama dengan [TITLE-DRAG-BOX], dari arah lain.
        let ci2 = 0;
        const tParts = [''], gParts = [''];
        // Fragmen \N di tiap batas baris, disimpan supaya jalur lama
        // (ukuran seragam) tetap menghasilkan untai yang byte-identik.
        const tBreaks = [], gBreaks = [];
        // Indeks karakter awal tiap token, supaya kata yang DIGESER bisa
        // digambar ulang dengan tempo ketik yang sama persis.
        const tokStartCi = [];
        tToks.forEach((tk, idx) => {
          tokStartCi[idx] = ci2;
          const openT = tokOpen(tk, true, idx), openG = tokOpen(tk, false, idx);
          const isLastTok = idx === tToks.length - 1;
          // [TITLE-LAYOUT] \N must stay one atomic escape, never split into
          // per-character reveal units — append it AFTER the word's own typed
          // chars instead of folding it into the Array.from() char loop below.
          const breaksHere = !isLastTok && titleLineBreaks.includes(idx + 1);
          const sep = isLastTok || breaksHere ? '' : ' ';
          const chars = Array.from(cleanTxt(tk.text) + sep);
          for (const ch of chars) {
            const d = Math.round(ci2 * cstep);
            tParts[tParts.length - 1] += `{${openT}\\alpha&HFF&\\t(${d},${d + TW},\\alpha&H00&)}${ch}`;
            gParts[gParts.length - 1] += `{${openG}\\1c${glowC2}\\1a&HFF&\\3a&HFF&\\t(${d},${d + TW},\\1a${gEndT}\\3a${gEndT})}${ch}`;
            ci2++;
          }
          if (breaksHere) {
            tBreaks.push(`{${openT}\\alpha&H00&}\\N`);
            gBreaks.push(`{${openG}\\1c${glowC2}\\1a${gEndT}\\3a${gEndT}}\\N`);
            tParts.push(''); gParts.push('');
          }
        });
        const joinBreaks = (parts, brks) =>
          parts.reduce((acc, part, i) => acc + (i ? brks[i - 1] : '') + part, '');
        if (titleInkTops && titleInkTops.length === tParts.length) {
          tParts.forEach((txtL, li) => {
            const posL = posAt(titleInkTops[li]);
            if (wantGlow) titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8${posL}\\bord${gBordT}\\3c${glowC2}\\shad0\\blur${gBlurT}${gAlphaT}}${gParts[li]}`);
            titleLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8${posL}${bordT}}${txtL}`);
          });
        } else {
          const inlineText = joinBreaks(tParts, tBreaks);
          const inlineGlow = joinBreaks(gParts, gBreaks);
          if (wantGlow) titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8\\pos(${tx2},${ty2})\\bord${gBordT}\\3c${glowC2}\\shad0\\blur${gBlurT}${gAlphaT}}${inlineGlow}`);
          titleLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8\\pos(${tx2},${ty2})${bordT}}${inlineText}`);
        }
        // [TITLE-TYPE-DRAG] Kata yang digeser harus digambar ulang DI SINI juga.
        //
        // tokOpen menyembunyikan kata ber-dx/dy di alurnya (dragTag), dan blok
        // penggambaran ulang [TITLE-WORD-DRAG] hanya ada di cabang non-type —
        // jadi di mode type kata itu disembunyikan dan tidak pernah muncul lagi.
        // Terukur: anim=none menghasilkan 2 Dialogue ("...Bayar Sekali" + salinan
        // "Pernah"), anim=type hanya 1, dengan tag sembunyi tetap terpasang.
        // Kata itu HILANG dari render. Cacat lama, bukan dari perapatan baris.
        //
        // Tempo ketiknya harus sama persis dengan kalau kata itu tidak digeser,
        // jadi delay-nya dihitung dari tokStartCi — bukan dimulai ulang dari nol.
        {
          const draggedType = tToks.filter(ownsLine);
          if (draggedType.length) {
            const anchors = titleWordAnchors({ trackPxFor: titleTrackPxFor,
              fitLines: titleFitLines,
              fs2, fontsDir: assFontsDirFs(), baseFont: fn2, boldDefault: !!ts2.bold,
              tx2, ty2, lineHeightEm: fontEmScale(fn2, assFontsDirFs(), !!ts2.bold, false) || 1.2, SY,
              lineTops: titleInkTops,
            });
            const strip = (t) => String(t).replace(/\\1a&HFF&\\3a&HFF&$/, '');
            tToks.forEach((tk, i) => {
              if (!ownsLine(tk)) return;
              const an = anchors[i];
              if (!an) return;
              const st = tk.style || {};
              // SY pada KEDUA sumbu, aturan yang sama dengan [TITLE-DRAG-SCALE].
              const wx = Math.round(an.centerX + (+st.dx || 0) * SY);
              const wy = Math.round(an.lineTopPx + (+st.dy || 0) * SY);
              const openT = strip(tokOpen(tk, true, i));
              const openG = strip(tokOpen(tk, false, i));
              let ci = tokStartCi[i] || 0, fragT = '', fragG = '';
              for (const ch of Array.from(cleanTxt(tk.text))) {
                const d = Math.round(ci * cstep);
                fragT += `{${openT}\\alpha&HFF&\\t(${d},${d + TW},\\alpha&H00&)}${ch}`;
                fragG += `{${openG}\\1c${glowC2}\\1a&HFF&\\3a&HFF&\\t(${d},${d + TW},\\1a${gEndT}\\3a${gEndT})}${ch}`;
                ci++;
              }
              // [TITLE-DRAG-GLOW] Disembunyikan di KEDUA lapisan, jadi harus
              // digambar ulang di keduanya — kalau tidak, kata ber-glow yang
              // digeser kehilangan pendarnya.
              if (wantGlow) titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8\\pos(${wx},${wy})\\bord${gBordT}\\3c${glowC2}\\shad0\\blur${gBlurT}${gAlphaT}}${fragG}`);
              titleLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8\\pos(${wx},${wy})${bordT}}${fragT}`);
            });
          }
        }
      } else {
        // [TITLE-INK-LEADING] Satu badan emisi token, dua cara memisahkannya:
        // seluruh judul dalam satu Dialogue (jalur lama, \N di batas baris),
        // atau satu Dialogue PER BARIS (model tinta, tanpa \N sama sekali).
        // Logika tag per-token sengaja TIDAK diduplikasi — dua salinan pengukur
        // yang saling melenceng adalah cacat yang berulang di file ini.
        const bodyRun = (withColor, idxs, sepFor) => idxs.map((idx, k) => {
          const tk = tToks[idx];
          const sep = sepFor(idx, k, idxs);
          // [TITLE-BOX] A boxed word's own tag additionally forces \bord0\shad0
          // — the box itself is the separation from the background, an
          // outline on top of contrastInk's already-guaranteed-readable ink
          // just fuses the letterforms into one dark slab (same reasoning as
          // caption box's [BOX-INK-NO-OUTLINE]).
          const noOutline = (tk.style && tk.style.box) ? '\\bord0\\shad0' : '';
          // [TITLE-WORD-GAP-SIZE] Spasi pemisah menempel pada run kata sebelumnya,
          // jadi ia mewarisi \fs kata itu. Setelah kata yang diperbesar, celahnya
          // ikut membesar — preview tidak, karena di sana spasi milik kontainer.
          // Kata berukuran sendiri karena itu menutup runnya dan spasinya
          // dipancarkan pada ukuran judul. Kata tanpa override tidak tersentuh,
          // jadi judul biasa tetap byte-identik.
          const stW2 = tk.style || {};
          const ownFs = stW2.fs
            ? Math.max(24, Math.round(Math.min(240, stW2.fs) * SY))
            : fs2;
          const sepOut = (sep === ' ' && ownFs !== fs2)
            ? `{\\fs${assFs(fs2, fn2, !!b2, false)}} `
            : sep;
          return `{${tokOpen(tk, withColor, idx)}${withColor ? noOutline : ''}}${cleanTxt(tk.text)}${sepOut}`;
        }).join('').trimEnd();
        const allIdx = tToks.map((_, i) => i);
        const bodyText = (withColor) => bodyRun(withColor, allIdx,
          (idx) => (idx < tToks.length - 1) ? (titleLineBreaks.includes(idx + 1) ? '\\N' : ' ') : '');
        const bodyLine = (withColor, idxs) => bodyRun(withColor, idxs,
          (idx, k) => (k < idxs.length - 1 ? ' ' : ''));
        const glowHead = `\\bord${gBordT}\\3c${glowC2}\\1c${glowC2}\\shad0\\blur${gBlurT}${gAlphaT}`;
        if (titleInkTops) {
          // Satu Dialogue per baris, masing-masing di \pos-nya sendiri. libass
          // tidak punya tag jarak-baris, jadi ini SATU-SATUNYA cara menentukan
          // posisi baris — lihat [TITLE-INK-LEADING] di titleInkLineTops.
          titleLineIdxGroups.forEach((idxs, li) => {
            const posL = posAt(titleInkTops[li]);
            if (wantGlow) titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8${posL}${glowAnim2}${glowHead}}${bodyLine(false, idxs)}`);
            titleLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8${posL}${textAnim2}${bordT}}${bodyLine(true, idxs)}`);
          });
        } else {
        if (wantGlow) titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8${posT}${glowAnim2}${glowHead}}${bodyText(false)}`);
        titleLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8${posT}${textAnim2}${bordT}}${bodyText(true)}`);
        }
        // [TITLE-WORD-DRAG] Redraw every dragged word at its own anchor. The
        // anchors come from the SAME measurement the highlight boxes use, so a
        // dragged word and its box move together instead of drifting apart.
        const draggedToks = tToks.filter(ownsLine);
        if (draggedToks.length) {
          const anchors = titleWordAnchors({ trackPxFor: titleTrackPxFor,
            fitLines: titleFitLines,
            fs2, fontsDir: assFontsDirFs(), baseFont: fn2, boldDefault: !!ts2.bold,
            tx2, ty2, lineHeightEm: fontEmScale(fn2, assFontsDirFs(), !!ts2.bold, false) || 1.2, SY,
            lineTops: titleInkTops,
          });
          tToks.forEach((tk, i) => {
            const st = tk.style || {};
            const dx = +st.dx || 0, dy = +st.dy || 0;
            if (!ownsLine(tk)) return;
            const an = anchors[i];
            if (!an) return;
            // [TITLE-DRAG-SCALE] SY, not SX. buildAss states the rule for every
            // per-word offset: they are baked with a HEIGHT-based factor, so
            // they are font-proportional, not frame-width-relative. This was
            // the one place still using SX, invisible in portrait where
            // SX === SY === 1. Measured in landscape: a word dragged 200
            // canonical px moved 355px instead of 112 — the 3.16x spread that
            // same note warns about.
            const wx = Math.round(an.centerX + dx * SY);
            const wy = Math.round(an.lineTopPx + dy * SY);
            const txt = cleanTxt(tk.text);
            // The copy must be VISIBLE: tokOpen stamps the hide-in-flow alpha
            // on a dragged word, so strip it and state the visible case.
            // [TITLE-DRAG-ALPHA] ONE backslash, not two. The tag in the string is
            // \1a&HFF&, so a regex written \\1a (two literal backslashes) never
            // matched anything — the hide alpha survived into the copy, which is
            // why the copy then needed a blanket opaque reset that turned every
            // hollow dragged word solid. Strip it for real; the word's own alpha
            // then stands, and "visible" no longer means "opaque".
            // [TITLE-DRAG-ALPHA] tokOpen is (tk, withColor, idx) — this passed (tk, i,
            // true), so withColor was the word INDEX and idx was `true`. Word 0
            // therefore fell into the glow-layer branch and its copy was drawn with
            // no colour and no outline at all, and every accent word lost its
            // accent because hookIdxSet.has(true) is always false. The blanket
            // opaque reset removed above had been hiding this: the copy came out
            // plain solid white, which is exactly what the reported render shows.
            // [TITLE-DRAG-GLOW] Lepas HANYA kemunculan terakhir, dan hanya di ujung.
            // Alpha-sembunyi (dragTag) dan masker glow (glTag) adalah STRING YANG
            // SAMA. dragTag selalu ditulis paling akhir, jadi jangkar ujung ini
            // mengenai tepat satu — sementara replace global akan ikut melepas
            // maskernya dan membuat kata tanpa `gl` ikut menyala.
            const strip = (t) => String(t).replace(/\\1a&HFF&\\3a&HFF&$/, '');
            const tags = strip(tokOpen(tk, true, i));
            // [TITLE-WORD-ANIM] Fragmen animasi milik kata ini sendiri. Sama
            // dengan judulnya kalau ia cuma digeser; berbeda kalau ia memang
            // memilih animasi lain. rise/drop memindahkan posisi, jadi \move
            // dibangun dari jangkar kata itu, bukan jangkar judul.
            const wAn = effAnOf(tk);
            const wFrag = (wAn === anim2)
              ? { textAnim: textAnim2, glowAnim: glowAnim2, slideMs: slideMs2, slidePx: slidePx2 }
              : animFragments(wAn, fs2, titleGlowMul2, 1);
            const wPos = wAn === 'rise'
              ? `\\move(${wx},${wy + wFrag.slidePx},${wx},${wy},0,${wFrag.slideMs})`
              : wAn === 'drop'
                ? `\\move(${wx},${wy - wFrag.slidePx},${wx},${wy},0,${wFrag.slideMs})`
                : `\\pos(${wx},${wy})`;
            titleLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8${wPos}${wFrag.textAnim}${bordT}${tags}}${txt}`);
            // [TITLE-DRAG-GLOW] Kata yang digeser disembunyikan di tempat asalnya
            // pada KEDUA lapisan, tapi dulu hanya digambar ulang di lapisan teks —
            // jadi kata ber-glow yang digeser kehilangan pendarnya sama sekali.
            // Di preview glow itu text-shadow pada span yang sama, jadi ia ikut
            // pindah bersama transform-nya; burn harus menyusul sendiri.
            if (wantGlow) {
              const gTags = strip(tokOpen(tk, false, i));
              titleLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8${wPos}${wFrag.glowAnim}\\bord${gBordT}\\3c${glowC2}\\1c${glowC2}\\shad0\\blur${gBlurT}${gAlphaT}${gTags}}${txt}`);
            }
          });
        }
      }
    }
    // [TITLE-NOWRAP] libass MEMBUNGKUS baris judul sendiri, dan preview tidak
    // pernah melakukannya (.ttl-line memakai white-space:nowrap). Budget fit
    // lebar di atas adalah PR.w * 0,9259 = 1000px, sementara lebar wrap libass
    // adalah PR.w - MarginL - MarginR = 1080 - 40 - 40 = 1000px: ANGKA YANG SAMA.
    // Jadi fit itu selalu mendarat tepat di garis batas, dan kelebihan 2px saja
    // sudah membelah judul.
    //
    // Terukur pada burn 1080x1920, Anton, judul 5 kata satu baris, pita tinta
    // dipindai per baris:
    //   track:0      -> \fs116, lebar 1002px -> DUA pita (y 393 dan y 509)
    //   track:+0.1   -> \fs95,  lebar  1003px -> DUA pita (y 394 dan y 489)
    //   tracking style -0.07em -> \fs139, lebar 1001px -> satu pita
    // Preview menampilkan SATU baris di ketiganya. Baris kedua di y 509 itu
    // posisi yang tidak pernah ada di preview — mismatch letak yang paling
    // kentara, bukan selisih beberapa piksel.
    //
    // \q2 = WrapStyle 2: tanpa word wrapping, \N tetap dihormati. Jadi jalur
    // \N (judul berukuran seragam) tidak berubah; yang berhenti hanyalah
    // libass mengarang pemecahan barisnya sendiri. Disuntikkan di SATU tempat,
    // bukan di 13 template pemancar, memakai pola stampBaseFsp — supaya jalur
    // judul baru ikut terlindungi tanpa harus diingat.
    const stampTitleNoWrap = (l) => l.replace(/^(Dialogue: (?:[^,]*,){9})\{/, '$1{\\q2');
    if (titleLines.length) titleBody = '\n' + titleLines.map(stampTitleNoWrap).join('\n');
  }
  // [TITLE-V1] end
  // [MANUAL-CAPTION-LAYER] Emit \pos-anchored Dialogue lines for layer-mode
  // Manual Captions — same per-token/glow/animation machinery as the titles
  // block above. Each entry may now override style/font/size independently
  // (L.style/L.fn/L.fs) — falling back to the running caption's own
  // (`s`/fontSize`) when unset, same "blank = inherit" convention titles use
  // for T.style/T.fn/T.fs. See docs/superpowers/specs/2026-09-04-manual-caption-design.md.
  let layerCaptionBody = '';
  if (Array.isArray(layerCaptions) && layerCaptions.length) {
    const lcLines = [];
    for (const L of layerCaptions) {
      const txt0 = String(L?.text || '').trim();
      if (!txt0) continue;
      // [EVENT-WINDOW] Jendela yang sama dengan judul dan dengan preview.
      const lw = eventWindow(L.start, L.end);
      const ts = tcAss(lw.start);
      const te = tcAss(lw.end);
      const lToks = (Array.isArray(L.tokens) && L.tokens.length)
        ? L.tokens
        : txt0.split(/\s+/).filter(Boolean).map(w => ({ text: w }));
      const lx = Math.max(20, Math.min(PR.w - 20, Math.round((+L.x || 540) * SX)));
      const ly = Math.max(20, Math.min(PR.h - 20, Math.round((+L.y || 1500) * SY)));
      // [MC-STYLE] Per-entry style override — mirrors `ts2 = SUB_STYLES[T.style]
      // || s` above for titles. inverse_auto's auto-invert only applies to the
      // main caption/title buckets (subIsInverse split) — a layer caption isn't
      // wired into that split, so picking inverse_auto here renders it as a
      // plain (non-inverting) style rather than erroring.
      const sL = SUB_STYLES[L.style] || s;
      const effStyleL = L.style || style;
      const fsBaseL = (+L.fs) ? Math.max(24, Math.round(Math.min(240, +L.fs) * SY)) : fontSize;
      const cleanEdgeL = !!sL.noEdge;
      const bordL = cleanEdgeL ? `\\bord0\\shad0` : `\\bord3\\3c&H000000&\\shad2`;
      const glowMulL = sL.glowMul != null ? sL.glowMul : 1;
      const gBlurL = Math.max(2, Math.round((fsBaseL / 6) * glowMulL));
      const gBordL = Math.max(2, Math.round((fsBaseL / 9) * glowMulL));
      const glowCL = '&H' + String(sL.glow).replace(/&H/i, '').replace(/&$/, '').slice(-6) + '&';
      const primaryCL = '&H' + String(sL.primary).replace(/&H/i, '').replace(/&$/, '').slice(-6) + '&';
      const wantGlowL = glow && sL.glow && effStyleL !== 'inverse_auto';
      // [GLOW-ALPHA] cinematic_white/white_clean set a thin glowAlpha so their
      // halo stays subtle instead of washing out the letters — mirrors gAlpha
      // (main caption) / gAlphaT (titles) so a layer caption under one of
      // those styles renders identically to the caption/title at the same instant.
      const gAlphaL = sL.glowAlpha ? `\\1a${sL.glowAlpha}\\3a${sL.glowAlpha}` : '';
      const tokOpenL = (tk) => {
        const st = tk.style || {};
        const fn = st.fn || L.fn || sL.font || 'Open Sauce Two ExtraBold';
        const bb = (st.b != null) ? (st.b ? 1 : 0) : (sL.bold ? 1 : 0);
        const it = st.i ? 1 : 0;
        const fss = st.fs ? Math.max(24, Math.round(Math.min(240, st.fs) * SY)) : fsBaseL;
        // [TRACK-UNIFORM] Per-word font override gets THAT font's own tracking,
        // else the caption style's trackEm — mirrors tokOpen (titles) above so a
        // per-word `st.fn` override doesn't silently inherit the base-\fsp stamp.
        // [MC-TRACK] Clamped like the title's, so a typo cannot fling the
        // caption off-frame.
        const lTrack = (L.track != null && Number.isFinite(+L.track))
          ? Math.max(-0.2, Math.min(0.4, +L.track)) : null;
        const tsTrackEmL = lTrack != null ? lTrack
          : (sL.trackEm != null ? sL.trackEm : TRACK_EM);
        const emTokL = st.fn ? FONT_EM(st.fn) : (L.fn ? FONT_EM(L.fn) : null);
        const fspTokL = (lTrack != null) ? emFsp(lTrack, fss)
          : (emTokL != null) ? emFsp(emTokL, fss) : emFsp(tsTrackEmL, fss);
        const colTag = `\\1c${(st.color && hexToAss(st.color)) || primaryCL}`;
        return `\\fn${fn}\\b${bb}\\i${it}\\fs${assFs(fss, fn, !!bb, !!it)}${fspTokL}${colTag}`;
      };
      const cleanTxtL = (s2) => String(s2 || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' \\N ');
      const bodyTextL = lToks.map(tk => `{${tokOpenL(tk)}}${cleanTxtL(tk.text)}`).join(' ').trimEnd();
      if (wantGlowL) {
        lcLines.push(`Dialogue: 0,${ts},${te},Default,,0,0,0,,{\\an8\\pos(${lx},${ly})\\bord${gBordL}\\3c${glowCL}\\1c${glowCL}\\shad0\\blur${gBlurL}${gAlphaL}}${bodyTextL}`);
      }
      lcLines.push(`Dialogue: 1,${ts},${te},Default,,0,0,0,,{\\an8\\pos(${lx},${ly})${bordL}}${bodyTextL}`);
    }
    if (lcLines.length) layerCaptionBody = '\n' + lcLines.join('\n');
  }
  // [FSP-NEGATIVE] libass IGNORES a NEGATIVE Spacing in the Style line. Measured
  // with the app's own bundled ffmpeg/libass 0.17.0, same cue, fontSize 64:
  //   Spacing   0 → 483px      Spacing -6  → 483px
  //   Spacing -12 → 483px      Spacing -30 → 483px      Spacing +30 → 873px
  // i.e. every negative value is clamped away, and only positive spacing moves
  // glyphs. So NO tracking this app computed has ever reached a burned caption —
  // while the CSS preview applied it faithfully. That is the whole "preview
  // rapat, hasil burn renggang" mismatch, and also why lowering the number never
  // changed anything: the number was never used.
  //
  // The INLINE \fsp tag does honour negatives (measured on the same rig:
  // \fsp-6 → 405px, \fsp-12 → 327px), so stamp the style-level spacing at the
  // head of every Dialogue override block. Per-token blocks emit their own \fsp
  // later in the same line and therefore still win — which is exactly the
  // precedence the per-word font overrides need.
  //
  // This also removes the jump the user hit when enabling per-word animation:
  // that path already used \fsp (so it tightened) while the plain path used the
  // dead Style column (so it did not). Both go through \fsp now.
  const stampBaseFsp = (assText) => {
    if (!styleSpacing) return assText;
    return assText.replace(/^(Dialogue: (?:[^,]*,){9})\{/gm, `$1{\\fsp${styleSpacing}`);
  };
  return head + stampBaseFsp(require('./caption-extras').applyAss(body, cues, PR) + titleBody + layerCaptionBody) + '\n';
}
function tcAss(t) {
  const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = (t%60);
  return `${String(h).padStart(1,'0')}:${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;
}

// [CAPTION-DEDUP] YouTube auto-generated captions use a "rolling 2-line
// window": a cue shows [previous fragment, new fragment], then an almost-
// zero-duration "collapse" cue repeats just the new fragment alone before the
// next window begins fresh from it. Parsed verbatim this triples transcript
// size for zero new information — confirmed as the direct cause of a Groq
// 429 (a single highlight-detection call requested 92% of a 100k/day
// free-tier token budget on an otherwise-ordinary transcript) and would
// equally make burned/live captions repeat text on screen. This collapses
// the pattern back to the clean, non-redundant spoken sequence: a cue that
// exactly repeats the last kept fragment is a pure "collapse tick" (skip —
// adds nothing); a cue that STARTS WITH the last kept fragment is a "growth"
// step (keep only the new suffix, at that cue's own timing); anything else
// (a real gap/topic change) passes through unchanged.
function dedupeRollingCaptions(cues) {
  const out = [];
  let lastFragment = null;
  for (const cue of cues) {
    const t = (cue.text || '').trim();
    if (!t) continue;
    if (lastFragment === null) {
      out.push({ start: cue.start, end: cue.end, text: t });
      lastFragment = t;
      continue;
    }
    if (t === lastFragment) continue;   // pure collapse tick — no new words
    if (t.startsWith(lastFragment)) {
      const suffix = t.slice(lastFragment.length).trim();
      if (suffix) {
        out.push({ start: cue.start, end: cue.end, text: suffix });
        lastFragment = suffix;
      }
      continue;
    }
    out.push({ start: cue.start, end: cue.end, text: t });   // real new content
    lastFragment = t;
  }
  return out;
}

// [WORD-TIMING-INNERTUBE] Loads the per-word timing file the Innertube fetch
// writes next to its SRT (see the [INNERTUBE-FIRST] block). Returns [] on any
// problem — absent file, malformed JSON, wrong shape — so a stale or damaged
// file can only ever degrade back to the cue-level path, never break a run.
// [SPEAKER-MARKER] YouTube captions mark a change of speaker with ">>". The
// cue parsers stripped it only at the START of a line, and the per-word timing
// (json3 → source.words.json) keeps it as a word of its own — 199 of them in
// one 50-min session — so word-timed captions burned ">> so" / ">>" on screen.
// Strip it wherever it stands (also glued: ">>so"); a token that is nothing but
// the marker is dropped by the callers.
const SPEAKER_MARKER_RE = /(^|\s)(?:>{2,}|&gt;&gt;)(?=\s|$|\S)/g;
function stripSpeakerMarkers(t) {
  return String(t ?? '').replace(SPEAKER_MARKER_RE, '$1').replace(/\s{2,}/g, ' ').trim();
}
function loadSessionWords(sessionDir) {
  try {
    // [TIDY-SESSION] Sessions since 2.4.7 keep it in transkrip/.
    let p = path.join(sessionDir, 'source.words.json');
    if (!fs.existsSync(p)) p = path.join(sessionDir, TRANSCRIPT_DIRNAME, 'source.words.json');
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      // typeof check, not coercion: JSON.stringify turns NaN into null, and
      // +null is 0 — a word with a broken start must be dropped, not pinned
      // to t=0 where it would flash at the top of every clip containing it.
      .map(w => ({
        text: stripSpeakerMarkers(w?.text),
        start: typeof w?.start === 'number' ? w.start : NaN,
        end: typeof w?.end === 'number' ? w.end : NaN,
      }))
      .filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start);
  } catch {
    return [];
  }
}

// ─── Subtitle parsing (SRT) ──────────────────────────────
function parseSrt(text) {
  const blocks = text.replace(/\r/g,'').split(/\n\n+/).filter(b => b.trim());
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const tc = lines.find(l => /-->/i.test(l));
    if (!tc) continue;
    const [a,b2] = tc.split(/-->/).map(s => s.trim());
    let tx = lines.slice(lines.indexOf(tc)+1).join(' ')
      .replace(/<[^>]+>/g, '');
    tx = stripSpeakerMarkers(tx);
    if (tx) cues.push({ start: srtToSec(a), end: srtToSec(b2), text: tx });
  }
  if (!cues.length) {
    const fromTxt = parseTranscriptText(text);
    if (fromTxt && fromTxt.length) return fromTxt;
  }
  return dedupeRollingCaptions(cues);
}
function srtToSec(t) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t);
  if (!m) return 0;
  return (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000;
}
// VTT → cues. Handles the WEBVTT header, NOTE/STYLE/REGION blocks, cue settings
// on the timestamp line, and inline tags (<c>, <00:00:00.000>, <v Name>).
// Accepts both HH:MM:SS.mmm and MM:SS.mmm timestamp forms.
function vttToSec(t) {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(t);
  if (!m) return 0;
  const h = m[1] ? +m[1] : 0;
  return h*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000;
}
function parseVtt(text) {
  const blocks = text.replace(/\r/g,'').split(/\n\n+/).filter(b => b.trim());
  const cues = [];
  for (const b of blocks) {
    const head = b.trim();
    if (/^WEBVTT/i.test(head) || /^(NOTE|STYLE|REGION)\b/i.test(head)) continue;
    const lines = b.split('\n');
    const tc = lines.find(l => /-->/.test(l));
    if (!tc) continue;
    const [a, rest] = tc.split(/-->/);
    const b2 = (rest || '').trim().split(/\s+/)[0];   // drop cue settings after end stamp
    let tx = lines.slice(lines.indexOf(tc)+1).join(' ')
      .replace(/<[^>]+>/g, '');                                            // strip inline tags
    tx = stripSpeakerMarkers(tx);                                          // and speaker markers
    if (tx) cues.push({ start: vttToSec(a.trim()), end: vttToSec(b2), text: tx });
  }
  if (!cues.length) {
    const fromTxt = parseTranscriptText(text);
    if (fromTxt && fromTxt.length) return fromTxt;
  }
  return dedupeRollingCaptions(cues);
}

// [TXT-TIMESTAMP-PARSER] Parse text transcripts that contain timestamps (e.g. copied from YouTube,
// transcript tools, or exported subtitles):
// Supports [H:MM:SS.ms-H:MM:SS.ms] text, [MM:SS-MM:SS] text, [H:MM:SS] text, MM:SS text, etc.
// Also strips YouTube speaker markers like `>> ` and filters out empty lines.
function parseTranscriptText(raw, duration = 60) {
  const lines = String(raw || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const timeToSec = (ts) => {
    const parts = ts.trim().split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(ts) || 0;
  };

  const cues = [];
  const rangeRe = /^[\[\(]?(\d+:\d+(?::\d+)?(?:\.\d+)?)\s*(?:-|–|—|-->|\s+to\s+)\s*(\d+:\d+(?::\d+)?(?:\.\d+)?)[\]\)]?\s*(.*)$/;
  const singleRe = /^[\[\(]?(\d+:\d+(?::\d+)?(?:\.\d+)?)[\]\)]?\s*(.*)$/;

  let hasRange = false;
  for (const line of lines) {
    if (rangeRe.test(line)) {
      hasRange = true;
      break;
    }
  }

  if (hasRange) {
    for (const line of lines) {
      const m = rangeRe.exec(line);
      if (m) {
        const start = timeToSec(m[1]);
        const end = timeToSec(m[2]);
        let text = (m[3] || '').replace(/^>>\s*/, '').trim();
        text = text.replace(/<[^>]+>/g, '').trim();
        if (text && text !== '>>') {
          cues.push({ start, end: Math.max(start + 0.2, end), text });
        }
      }
    }
    if (cues.length) return dedupeRollingCaptions(cues);
  }

  let hasSingle = false;
  for (const line of lines) {
    if (singleRe.test(line)) {
      hasSingle = true;
      break;
    }
  }

  if (hasSingle) {
    const entries = [];
    for (const line of lines) {
      const m = singleRe.exec(line);
      if (m) {
        const t = timeToSec(m[1]);
        let text = (m[2] || '').replace(/^>>\s*/, '').trim();
        text = text.replace(/<[^>]+>/g, '').trim();
        if (text && text !== '>>') {
          entries.push({ time: t, text });
        }
      }
    }
    if (entries.length) {
      for (let i = 0; i < entries.length; i++) {
        const start = entries[i].time;
        const next = entries[i + 1] ? entries[i + 1].time : Number(duration) || (start + 5);
        const end = Math.min(next, start + 5);
        cues.push({ start, end: Math.max(start + 0.2, end), text: entries[i].text });
      }
      return dedupeRollingCaptions(cues);
    }
  }

  return null;
}

// Plain transcript (no timestamps) → cues evenly distributed across the whole
// video duration, proportional to each sentence's word count. Rough sync only.
function buildCuesFromPlainText(text, duration) {
  const dur = Math.max(1, Number(duration) || 1);
  const sentences = String(text || '')
    .replace(/\r/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^[\[\(]?\d+:\d+(?::\d+)?(?:\.\d+)?[\]\)]?\s*/, '').replace(/^>>\s*/, '').trim())
    .filter(Boolean);
  if (!sentences.length) return [];
  const counts = sentences.map(s => Math.max(1, s.split(/\s+/).length));
  const total = counts.reduce((a, b) => a + b, 0);
  let t = 0;
  const cues = [];
  sentences.forEach((s, i) => {
    const slice = (counts[i] / total) * dur;
    const start = t;
    const end = (i === sentences.length - 1) ? dur : Math.min(dur, t + slice);
    cues.push({ start, end: Math.max(start + 0.2, end), text: s });
    t = end;
  });
  return cues;
}
function segmentsInRange(cues, start, end, pad=1.5) {
  return cues.filter(c => c.end >= start - pad && c.start <= end + pad);
}

// ─── Speech-to-text fallback (no SRT / no YouTube captions) ───────────────
// Two-tier ASR so captions appear even for a raw imported video:
//   1) Cloud Whisper over whichever key the user has — Groq
//      (whisper-large-v3-turbo) first, then OpenAI / Sumopod. Fast, returns
//      segment AND word timestamps. See cloudAsrTiers().
//   2) Local whisper.cpp binary — fallback if `binPaths.whisper` + a model
//      file are present (offline, no key). Optional; absent by default.
// Always non-fatal: returns [] on any failure so the pipeline continues.
//
// We first transcode to 16 kHz mono Opus/Ogg (~tiny) to keep the upload small
// and well under Groq's file-size limit even for long videos.

// [ASR-PERF] The CLI defaults we inherited are tuned for a workstation, and
// this tier exists for the opposite machine: the one with no API key. Measured
// end-to-end on a real target-class laptop (Ryzen 3 7320U, 4 cores / 8 threads,
// 7.2 GB RAM, whisper.cpp v1.9.1, small-q5_1) against 122.2 s of audio:
//
//   inherited defaults ......................... 118 s   (173 words)
//   + threads + greedy (this function) ........... 58 s   (195 words)
//
// Two independent costs, each removable without touching correctness:
//
//   1. THREADS. whisper.cpp defaults to 4 threads no matter what the host has,
//      so half of an 8-thread CPU sat idle for the entire run — this is the
//      "CPU is not being used" report. Passing the host's logical CPU count cut
//      encoder time 21-24% (17.7 s -> 14.0 s per pass here). Capped at 8: ggml
//      is memory-bandwidth-bound and I have NOT measured above 8, so the cap is
//      a deliberate refusal to extrapolate, not a measured ceiling.
//
//   2. BEAM SEARCH. The CLI defaults to `-bs 5 -bo 5`, which cost 29.5 s of a
//      61 s run (2030 decoder passes); greedy does the same work in 0.05 s (3
//      passes). Quality did not regress on the measured audio — greedy actually
//      returned MORE words (195 vs 173), because beam search plus temperature
//      fallback re-runs windows it scores badly and can drop them. Honest
//      limit: that measurement was made on synthesised speech, so greedy is not
//      yet validated against real Indonesian video audio. BEAM_SIZE is a named
//      constant precisely so this is one edit to revert.
//
// `-l auto` is deliberately NOT removed even though language detection costs a
// full extra encoder pass (~9 s, 6 encode runs where the audio needs 3).
// Forcing a language is exactly the bug 111b250 fixed: a wrongly forced
// language does not fail loudly, it produces phonetic nonsense and degrades
// every downstream stage. Nine seconds is the correct price for that.
const WHISPER_BEAM_SIZE = 1;          // 1 = greedy; 5 was the inherited default
const WHISPER_MAX_THREADS = 8;        // see note 1 above — unmeasured beyond 8

// [VAD] whisper.cpp encodes EVERY 30s window including the silent ones, and the
// encoder is ~90% of the wall clock here. Silero VAD skips the silent windows:
// 58 s -> 52 s on the 122.2 s test (which was 83% speech; real video carries far
// more silence and music, so the saving there is larger).
//
// The threshold is the whole ballgame and the default is a trap. At whisper's
// own default of 0.50 the run finished in 27 s but returned 73 words where the
// audio has ~203 — it discarded 64% of the speech while still producing a
// perfectly well-formed SRT. That is the silent-degradation shape this codebase
// has already been bitten by twice: no error, no warning, just a worse video.
// At 0.25 with padding the same run returned 213 words, i.e. no loss at all.
//
// Honest limit: those numbers come from synthesised speech against digital
// silence, which is kinder to a VAD than a real room. 0.25 is therefore chosen
// to fail toward KEEPING audio — a VAD that passes silence through costs a few
// seconds, one that eats speech costs the transcript.
const WHISPER_VAD_THRESHOLD = '0.25';    // NOT whisper's 0.50 default — see above
const WHISPER_VAD_PAD_MS    = '200';     // widen each kept span; guards onsets/tails

function whisperThreads(cpuCount = os.cpus().length) {
  const n = Number(cpuCount);
  if (!isFinite(n) || n < 1) return 1;               // os.cpus() can return []
  return Math.max(1, Math.min(Math.floor(n), WHISPER_MAX_THREADS));
}
function buildWhisperArgs({ model, wav, outBase, lang, vadModel, threads = whisperThreads() } = {}) {
  const args = ['-m', model, '-f', wav, '-osrt', '-ml', '1', '-sow', '-of', outBase];
  args.push('-t', String(threads));
  // Only ever passed when the caller has confirmed the file is on disk: `-vm`
  // with a missing path makes whisper fail outright, which would trade a
  // working slow transcript for no transcript at all.
  if (vadModel) {
    args.push('--vad', '-vm', String(vadModel),
      '-vt', WHISPER_VAD_THRESHOLD, '-vp', WHISPER_VAD_PAD_MS);
  }
  if (WHISPER_BEAM_SIZE <= 1) {
    // -nf drops temperature fallback, which only ever re-runs windows the
    // decoder already scored badly; with greedy there is no beam to fall back
    // through, so it is dead cost.
    args.push('-bs', '1', '-bo', '1', '-nf');
  } else {
    args.push('-bs', String(WHISPER_BEAM_SIZE), '-bo', String(WHISPER_BEAM_SIZE));
  }
  args.push('-l', (lang && lang !== 'auto') ? lang : 'auto');
  return args;
}

// Cloud ASR endpoints the user's saved keys unlock, in the order worth trying.
// Groq stays first regardless of which provider was picked for CHAT: its
// whisper-large-v3-turbo is both the fastest of the three and free-tier, so
// leading with it means a paid key is only spent on audio when Groq is absent
// or broken. A malformed-looking key drops to the back of the list for the same
// reason it does in freeChain — see [KEY-HYGIENE].
function cloudAsrTiers(cfg = {}) {
  // Chat breakers for the same credential: a 401 on audio means the key itself
  // is rejected, so every chat node behind it can be skipped for the rest of
  // the run. Matched by baseUrl so a user-chosen model name is covered too.
  const chatFor = (baseUrl) => {
    const eff = effectiveAI(cfg);
    const keys = freeChain(cfg, { allowPaid: true })
      .filter(n => n.baseUrl === baseUrl).map(providerKey);
    if (eff.baseUrl === baseUrl && eff.provider !== 'gemini') keys.push(providerKey(eff));
    return [...new Set(keys)];
  };
  const out = [];
  const add = (field, t) => {
    const apiKey = cleanKey(cfg[field]) || (cfg.aiProvider === t.provider ? cleanKey(cfg.apiKey) : '');
    if (!apiKey) return;
    out.push({ ...t, apiKey, ok: keyLooksReal(field, apiKey),
      url: t.baseUrl + '/audio/transcriptions',
      breaker: `${t.baseUrl}::asr`, chatBreakers: chatFor(t.baseUrl) });
  };
  const groqAsrModel = cfg.whisperModel || 'whisper-large-v3-turbo';
  add('groqKey', { provider: 'groq', label: 'Groq Whisper',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: groqAsrModel });
  // [GROQ-ROTATION] whisper-large-v3 has its own free audio quota (7.2K s/hour,
  // 28.8K s/day per model). Only tried after the tier above hit a quota.
  if (groqAsrModel !== 'whisper-large-v3' && out.length) {
    const prim = out[out.length - 1];
    out.push({ ...prim, label: 'Groq Whisper (model cadangan)', model: 'whisper-large-v3',
      breaker: `${prim.baseUrl}::asr::whisper-large-v3`, onlyAfterQuota: true });
  }
  // whisper-1 specifically: OpenAI's newer gpt-4o-transcribe models reject
  // response_format=verbose_json, which is where the timestamps live — without
  // them there is nothing to align captions to.
  add('openaiKey', { provider: 'openai', label: 'OpenAI Whisper',
    baseUrl: 'https://api.openai.com/v1',
    model: cfg.openaiWhisperModel || 'whisper-1' });
  // [SUMOPOD-ASR-DEAD, 2026-08-21] Sumopod does NOT expose an audio
  // transcription route — confirmed live: an UNAUTHENTICATED GET to
  // https://ai.sumopod.com/v1/audio/transcriptions returns a clean 404
  // {"detail":"Not Found"}, while chat/completions on the SAME domain returns
  // 405 (route exists, wrong verb) — so this isn't an auth/key problem, the
  // route itself was never implemented server-side. Every alternate path
  // tried (whisper, stt, speech-to-text, transcribe, audio/translations) also
  // 404s, and their /openapi.json is itself a 404. Keeping this tier meant
  // every run with a sumopodKey silently wasted a call and a misleading
  // "ASR: transkrip via Sumopod Whisper…" log line before falling through —
  // masking that the REAL remaining options were Groq (needs a working key)
  // or local whisper.cpp (needs free RAM). Sumopod chat/completions is fine
  // and untouched — only ASR is removed. Re-add if Sumopod ever ships this.
  return [...out.filter(t => t.ok), ...out.filter(t => !t.ok)];
}

// [ASR-WATCHDOG] Every other spawn in this file that can plausibly hang has an
// explicit timeout — yt-dlp 90s, render RENDER_TIMEOUT_MS, history-thumb 15s —
// each added after a real report of a Windows machine sitting frozen forever
// on one of them (AV scanning, a stalled network share, a corrupt/adversarial
// input). transcribeAudio()'s two spawns (audio extract, whisper.cpp itself)
// were the one ASR-tier spawn missing this: on a slow/AV-throttled corporate
// laptop with a long source and no VAD, there was no watchdog and no visible
// progress (`onLine: () => {}` discarded whisper.cpp's own output), so a wedge
// here looked identical to the app being frozen with no way to recover short
// of force-quitting the whole app.
//
// Sizing is intentionally generous and UNVALIDATED against real low-spec
// Windows hardware (no such machine was available while writing this) — it
// exists to bound "forever" to "an unreasonably long time", not to fail fast.
// Mirrors RENDER_TIMEOUT_MS's shape (floor + linear-in-duration) rather than
// inventing a new one. Revisit the multiplier once measured on an actual old
// corporate laptop; err toward loosening it, not tightening it, if unsure.
//
// [ASR-WATCHDOG-MODEL] The budget MUST scale with the model or it false-kills
// the exact users it is meant to protect. Reference measurement ([ASR-PERF]
// below): 122s of audio in ~55s with small-q5_1 on an M1 Pro ≈ 2.2x realtime.
// An i7-6600U (2C/4T, ~34GB/s vs ~200GB/s memory bandwidth, and ggml here is
// bandwidth-bound) lands nearer 0.2-0.4x realtime — still inside a 12x budget,
// with room to spare. `turbo` (large-v3-turbo, selectable in Settings as
// "kualitas terbaik") is a different story: 32 encoder layers at d=1280 vs
// small's 12 at d=768, and the encoder is ~90% of wall clock, so it is roughly
// 6x the work. On that same laptop a 60-minute video would need well over 12
// hours of honest compute and a flat 12x cap would kill a transcription that
// was working. The 6x here is an architectural estimate, NOT measured — treat
// it as a lower bound and loosen it if anyone reports a timeout on turbo.
const ASR_MODEL_SLOWDOWN = { small: 1, turbo: 6 };
function asrModelSlowdown(modelName) {
  const k = String(modelName || '').toLowerCase();
  // Hand-wired WHISPER_MODEL paths are filenames, not option values — match on
  // substring so ".../ggml-large-v3-turbo-q5_0.bin" is not silently billed as
  // a small model. Unknown names get the SLOWEST factor, never the fastest.
  if (k.includes('turbo') || k.includes('large') || k.includes('medium')) return ASR_MODEL_SLOWDOWN.turbo;
  if (k.includes('small') || k.includes('base') || k.includes('tiny')) return ASR_MODEL_SLOWDOWN.small;
  return ASR_MODEL_SLOWDOWN.turbo;
}
const ASR_EXTRACT_TIMEOUT_MS = (durationSec) => Math.max(120000, Math.round(durationSec * 3000));   // floor 2min, ~3s budget per source-second
const ASR_WHISPER_TIMEOUT_MS = (durationSec, modelName) =>
  Math.max(600000, Math.round(durationSec * 12000 * asrModelSlowdown(modelName)));                  // floor 10min, ~12x realtime for small, ~72x for turbo

// [ASR-SANITY] Both ASR tiers can "succeed" — exit 0, no error, a parseable
// result — while returning a transcript that is obvious nonsense for the
// length of the audio. A real run (socl-2026-08-04T07-10-17) turned a 2.2-hour
// source into ONE word: `*terkunci*`, the junk token whisper emits when VAD has
// discarded effectively all of the audio. It was reported in LIME as
// `▶ ASR lokal: 1 kata` — a SUCCESS line — and everything downstream then ran
// on a 34-byte transcript: 4 of 5 clips came out with no captions at all.
//
// The floor sits FAR below real speech (100-150 wpm) so quiet material —
// interviews with long pauses, music-heavy podcasts, a lecture with dead air —
// is never rejected. At 3 wpm a two-hour source only has to produce ~390 words
// to pass, while the failure this catches produced 1. Sources shorter than the
// grace window are never judged on rate at all: a 20-second clip with three
// words in it is completely normal.
const MIN_WORDS_PER_MINUTE = 3;
const ASR_SANITY_GRACE_SEC = 120;
function transcriptLooksUsable(words, durationSec) {
  const n = Array.isArray(words) ? words.length : 0;
  if (!n) return false;
  const secs = Math.max(0, Number(durationSec) || 0);
  if (secs <= ASR_SANITY_GRACE_SEC) return true;
  return n >= (secs / 60) * MIN_WORDS_PER_MINUTE;
}

// [ASR-ETA] Measured end-to-end on this project's own hardware (M1, small
// model, whisper.cpp v1.9.1): 3924 s of audio transcribed in 206 s — ~19x
// realtime. Groq's cloud tier does the same job at ~68x. The number matters
// because without it a local transcription is an unbounded wait: two real runs
// were abandoned mid-ASR (socl-2026-08-06T02-59-39 after ~30 s, 02-51-43 after
// 394 s) on a job that would have finished in about six minutes.
//
// This is an ESTIMATE shown to the user, never a deadline — ASR_WHISPER_TIMEOUT_MS
// is what actually bounds the run. Slower hardware will overrun it, so the
// wording that carries it stays hedged ("perkiraan").
const ASR_LOCAL_REALTIME_RATIO = 19;
function asrEtaSeconds(durationSec, modelName) {
  const secs = Math.max(1, Number(durationSec) || 1);
  return Math.round((secs / ASR_LOCAL_REALTIME_RATIO) * asrModelSlowdown(modelName));
}
function humanDuration(secs) {
  const s = Math.max(1, Math.round(Number(secs) || 0));
  if (s < 90) return `${s} detik`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} menit` : `${Math.floor(m / 60)} jam ${m % 60} menit`;
}

// [ASR-CANCEL] cancelPipeline() kills the active children, so an in-flight
// ffmpeg/whisper spawn rejects like any other failure. Without telling the two
// apart, the ASR stage swallowed the user's Cancel as `⚠ ASR lokal gagal
// (cancelled)`, returned an empty transcript, and the run carried on for
// another ~7 s through highlight detection and hook titles — printing
// "Clip 1".."Clip 5" — before finally dying in renderOneClip. Confirmed in
// socl-2026-08-06T02-51-43.
function isCancelError(e) {
  return /cancel/i.test(String(e?.message || e || ''));
}

// [SUB-SINGLE-TRACK] YouTube metadata already tells us which caption tracks
// exist. Snapshot the SRT sidecars before yt-dlp runs so an exit-zero process
// cannot claim success merely because a stale transcript from an earlier run
// is still in the session directory.
function subtitleFileFingerprint(fullPath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(fullPath, 'r');
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function subtitleSrtSnapshot(sessionDir) {
  const snapshot = new Map();
  let names;
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return snapshot;
  }
  for (const name of names) {
    if (!/\.srt$/i.test(name)) continue;
    try {
      const stat = fs.statSync(path.join(sessionDir, name));
      if (!stat.isFile() || stat.size <= 0) continue;
      snapshot.set(name.toLowerCase(), {
        size: stat.size,
        fingerprint: subtitleFileFingerprint(path.join(sessionDir, name)),
      });
    } catch { /* one bad sidecar must not hide the other entries */ }
  }
  return snapshot;
}

function findNewSubtitleSrt(sessionDir, before) {
  let names;
  try {
    names = fs.readdirSync(sessionDir).filter((name) => /\.srt$/i.test(name)).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const fullPath = path.join(sessionDir, name);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size <= 0) continue;
      const fingerprint = subtitleFileFingerprint(fullPath);
      const previous = before.get(name.toLowerCase());
      if (!previous || previous.size !== stat.size || previous.fingerprint !== fingerprint) {
        return fullPath;
      }
    } catch { /* keep checking other candidate sidecars */ }
  }
  return null;
}

// [YTDLP-SUBS-JSON3] YouTube fallback: yt-dlp leaves the raw json3 track
// (source.<lang>.json3); this writes the srt next to it with the same parser
// the Innertube path uses and returns its real per-word timing. ffmpeg cannot
// read json3, so yt-dlp's --convert-subs is never asked to touch it. The json3
// is removed afterwards (the words are persisted by the caller). Best-effort:
// no json3 or a parse failure → [] and whatever srt exists is used as before.
function srtFromJson3Subtitle(sessionDir, language, fsMod = fs) {
  const json3Path = path.join(sessionDir, `source.${language}.json3`);
  try {
    if (!fsMod.existsSync(json3Path)) return [];
    const parsed = JSON.parse(fsMod.readFileSync(json3Path, 'utf8'));
    const srt = json3ToSrt(parsed);
    if (srt.trim()) fsMod.writeFileSync(json3Path.replace(/\.json3$/, '.srt'), srt);
    return json3ToWords(parsed);
  } catch {
    return [];
  } finally {
    try { fsMod.unlinkSync(json3Path); } catch {}
  }
}

const SUB_RATE_LIMIT_RETRY_MS = 15000;
const SUBTITLE_DOWNLOAD_TIMEOUT_MS = 90_000;

function waitForSubtitleRetry(ms, {
  isCancelled = () => cancelled,
  pollMs = 100,
} = {}) {
  const durationMs = Math.max(0, Number(ms) || 0);
  const intervalMs = Math.max(1, Math.min(250, Number(pollMs) || 100));
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      let cancelState;
      try { cancelState = isCancelled(); }
      catch (error) { reject(error); return; }
      if (cancelState) {
        reject(cancelState instanceof Error ? cancelState : new Error('cancelled'));
        return;
      }

      const remainingMs = durationMs - (Date.now() - startedAt);
      if (remainingMs <= 0) { resolve(); return; }
      setTimeout(poll, Math.min(intervalMs, remainingMs));
    };
    poll();
  });
}

function exactSubtitleLanguage(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.trim() !== value) return false;
  const normalized = value.toLowerCase();
  if (normalized === 'all' || normalized === 'live_chat') return false;
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(value) ? value : false;
}

// Runs one exact metadata-selected language. The args are constructed once and
// reused byte-for-byte for the sole permitted retry, preventing the old
// bulk-language/per-language cascade from returning.
async function downloadSingleSubtitleTrack({
  language,
  ytdlp,
  source,
  sessionDir,
  outputTemplate,
  ffArgs = [],
  qualArgs = [],
  cookieArgs = [],
  env = process.env,
  spawn: runSpawn = spawnLines,
  retryDelay = waitForSubtitleRetry,
  isRetryCancelled = () => cancelled,
  onRateLimit,
} = {}) {
  const exactLanguage = exactSubtitleLanguage(language);
  if (exactLanguage === null) {
    return { downloaded: false, language: null, reason: 'no-caption-track' };
  }
  if (exactLanguage === false) {
    return { downloaded: false, language: null, reason: 'unsafe-caption-track' };
  }

  const selectedLanguage = exactLanguage;
  const before = subtitleSrtSnapshot(sessionDir);
  // [YTDLP-SUBS-JSON3] YouTube: the raw json3 track (real per-word offsets),
  // turned into srt by the app — see srtFromJson3Subtitle. v2.4.12–2.4.38 sent
  // `--keep-subs` (not a yt-dlp option: exit 2, "no such option") together with
  // json3 + `--convert-subs srt` (ffmpeg rejects json3: "Invalid data found"),
  // so this fallback never produced a subtitle and the run paid for ASR.
  // Other sites keep yt-dlp's own conversion, which worked before that change.
  const youtube = platformLabel(source) === 'YouTube';
  const subArgs = isolatedYtdlpArgs(['--no-playlist', '--skip-download',
    ...ffArgs, ...qualArgs, ...cookieArgs,
    '--write-auto-subs', '--write-subs', '--sub-langs', selectedLanguage,
    ...(youtube ? ['--sub-format', 'json3'] : ['--convert-subs', 'srt']),
    '-o', outputTemplate, source]);
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await runSpawn(ytdlp, subArgs, {
        env,
        onLine: () => {},
        timeoutMs: SUBTITLE_DOWNLOAD_TIMEOUT_MS,
      });
      const words = youtube ? srtFromJson3Subtitle(sessionDir, selectedLanguage) : [];
      const file = findNewSubtitleSrt(sessionDir, before);
      if (!file) {
        return { downloaded: false, language: selectedLanguage, reason: 'no-new-srt', retried };
      }
      return { downloaded: true, language: selectedLanguage, file, words, retried };
    } catch (error) {
      if (isCancelError(error)) throw error;
      const rawError = `${error?.message || error || ''}\n${error?.stderr || ''}`;
      if (attempt === 0 && /429|too many request/i.test(rawError)) {
        retried = true;
        onRateLimit?.(SUB_RATE_LIMIT_RETRY_MS);
        await retryDelay(SUB_RATE_LIMIT_RETRY_MS, { isCancelled: isRetryCancelled });
        continue;
      }
      return { downloaded: false, language: selectedLanguage, error, retried };
    }
  }

  return { downloaded: false, language: selectedLanguage, reason: 'no-new-srt', retried };
}

function usableTranscriptFile(file, fsMod = fs) {
  if (typeof file !== 'string' || !file) return false;
  try {
    const stat = fsMod.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function selectTranscriptSource({
  sessionDir,
  subtitleFile,
  subtitleFileIsSidecar,
  acquiredSubtitleFile,
  fsMod = fs,
} = {}) {
  if (usableTranscriptFile(subtitleFile, fsMod)) {
    // [SIDECAR-WORDS] A user-picked "Attach transcript" file has no known
    // word timing anywhere — 'attached' correctly yields []. A sidecar found
    // automatically next to a local import can sit beside a
    // source.words.json this app wrote itself (e.g. re-importing an old
    // session's source.mp4). Tagging it separately lets subtitleWordsForSource
    // look for that sibling instead of discarding real ASR timing in favour
    // of deriveWordTiming's even-spacing guess.
    return { file: subtitleFile, kind: subtitleFileIsSidecar ? 'sidecar' : 'attached' };
  }
  if (usableTranscriptFile(acquiredSubtitleFile, fsMod)) {
    return { file: acquiredSubtitleFile, kind: 'acquired' };
  }

  let names;
  try {
    names = fsMod.readdirSync(sessionDir).filter((name) => /\.srt$/i.test(name)).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const file = path.join(sessionDir, name);
    if (usableTranscriptFile(file, fsMod)) return { file, kind: 'legacy' };
  }
  return null;
}

// A fresh subtitle and its word timing are one provenance unit. Persisting an
// explicit [] for acquisitions without words prevents a stale sidecar from a
// previous Innertube run being picked up by a later/resumed session.
function persistAcquiredSubtitleWords(sessionDir, words, fsMod = fs) {
  const currentWords = Array.isArray(words) ? words : [];
  const wordsPath = path.join(sessionDir, 'source.words.json');
  try {
    fsMod.writeFileSync(wordsPath, JSON.stringify(currentWords));
  } catch {
    // If replacing stale data failed, removing it is still safer than leaving
    // timing that belongs to a different caption file. Current-run provenance
    // remains correct in memory even if both filesystem operations fail.
    if (currentWords.length === 0) {
      try {
        if (typeof fsMod.rmSync === 'function') fsMod.rmSync(wordsPath, { force: true });
        else fsMod.unlinkSync(wordsPath);
      } catch {}
    }
  }
  return currentWords;
}

// [ASR-DETECTED-LANG] Whisper's REST API (OpenAI/Groq, `verbose_json`) always
// returns `language` as a full lowercase English name, never an ISO code —
// this is a fixed, documented enumeration (whisper.cpp's own language table),
// not something to guess at. Maps the common ones to ISO 639-1; an unlisted
// name (rare — Whisper covers ~100 languages, most never seen in practice
// here) returns null so the caller falls back to its own detection instead
// of trusting a code we can't verify.
const WHISPER_LANG_NAME_TO_CODE = {
  indonesian: 'id', english: 'en', malay: 'ms', spanish: 'es', japanese: 'ja',
  korean: 'ko', chinese: 'zh', french: 'fr', german: 'de', portuguese: 'pt',
  italian: 'it', dutch: 'nl', russian: 'ru', arabic: 'ar', hindi: 'hi',
  vietnamese: 'vi', thai: 'th', turkish: 'tr', polish: 'pl', ukrainian: 'uk',
  filipino: 'tl', tagalog: 'tl', swedish: 'sv', norwegian: 'no', finnish: 'fi',
  danish: 'da', greek: 'el', hebrew: 'he', czech: 'cs', romanian: 'ro',
  hungarian: 'hu',
};
function whisperLangNameToCode(name) {
  return WHISPER_LANG_NAME_TO_CODE[String(name || '').toLowerCase().trim()] || null;
}

function subtitleWordsForSource({ transcriptSource, acquiredSubtitleWords, sessionDir } = {}) {
  if (!transcriptSource || transcriptSource.kind === 'attached') return [];
  if (transcriptSource.kind === 'acquired') {
    return Array.isArray(acquiredSubtitleWords) ? acquiredSubtitleWords : [];
  }
  if (transcriptSource.kind === 'legacy') return loadSessionWords(sessionDir);
  if (transcriptSource.kind === 'sidecar') {
    // The sibling words.json lives beside the SIDECAR file, not the current
    // session — a local re-import reuses another session's folder entirely.
    return loadSessionWords(path.dirname(transcriptSource.file));
  }
  return [];
}

// [CLOUD-ASR] SOCL's own word-timed transcription (Workers AI whisper-large-
// v3-turbo behind the socl-asr Worker, see cloud/asr-worker). No user key:
// requests are signed with ASR_KEY from the app's license config. Long audio
// goes up as 2-minute ogg chunks (3 at a time); each chunk's real start comes
// from ffmpeg's segment list, so stitched word times stay exact.
// [ISP-BLOCK] Our own domain first: XL Axiata DNS-blocks *.workers.dev.
const SOCL_ASR_URL = 'https://cloud.socialvisuals.xyz/v1/transcribe';
const SOCL_FALLBACK_HOST = 'socl-asr.soclvisuals.workers.dev';
// Network failure (DNS block, timeout) on one host → same signed request to the other.
async function soclCloudFetch(fetchImpl, url, init) {
  try { return await fetchImpl(url, init); }
  catch (err) {
    const alt = url.replace(/^https:\/\/[^/]+/, `https://${SOCL_FALLBACK_HOST}`);
    if (alt === url) throw err;
    return fetchImpl(alt, init);
  }
}
// 2-minute chunks keep each Worker request small (the free plan caps CPU per
// request, and base64-encoding the audio is the Worker's main CPU cost).
const SOCL_ASR_CHUNK_SEC = 120;
// [CLOUD-FULL] The Worker answers 429 (per-machine budget) or a 502 that wraps
// Groq's 429 once both free engines are used up for the day. Either way it will
// not recover inside this run: go offline instead of re-asking every chunk.
function soclCloudFull(msg) {
  const m = String(msg || '');
  return /HTTP 429\b/.test(m) || (/HTTP 50[23]\b/.test(m) && /429|rate limit|quota|neuron|budget/i.test(m));
}
// [ASR-SKIP-SILENCE] A 2-minute chunk with no sound above -50 dB has nothing to
// transcribe; both free engines bill its seconds anyway. Silences come from one
// silencedetect pass over the whole file; a chunk is skipped only when one
// silence covers it end to end, so no word timing can move.
function silentChunk(start, len, silences) {
  return silences.some(([a, b]) => a <= start + 0.5 && b >= start + len - 0.5);
}
function soclAsrKey() {
  try { return String(require('./license/config.local').ASR_KEY || ''); } catch { return ''; }
}
function soclAsrAvailable(cfg = {}) {
  return cfg.cloudAsr !== false && soclAsrKey().length >= 32 && !aiProviderDead(cfg, 'socl::asr');
}
let _soclMid = null;
function soclMachineId() {
  if (_soclMid) return _soclMid;
  try { _soclMid = String(require('./license/machineId').getMachineId()).slice(0, 64); }
  catch { _soclMid = require('crypto').createHash('sha256').update(os.hostname()).digest('hex').slice(0, 32); }
  return _soclMid;
}
async function soclAsrChunk(buf, lang, { fetchImpl = fetch } = {}) {
  const crypto = require('crypto');
  const ts = Math.floor(Date.now() / 1000);
  const mid = soclMachineId();
  const sig = crypto.createHmac('sha256', soclAsrKey())
    .update(`${ts}.${mid}.${crypto.createHash('sha256').update(buf).digest('hex')}`).digest('hex');
  const r = await soclCloudFetch(fetchImpl, SOCL_ASR_URL, { method: 'POST', body: buf,
    headers: { 'x-socl-ts': String(ts), 'x-socl-mid': mid, 'x-socl-sig': sig, ...(lang && lang !== 'auto' ? { 'x-socl-lang': lang } : {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  if (!j.ok) throw new Error(j.error || 'socl asr failed');
  return j;
}
// [CLOUD-TITLES] Title + on-video hook from SOCL's Worker for users with no AI
// key (the prompt lives server-side). Same HMAC signing as the ASR chunks.
// Returns an array aligned with clipTexts: { title, hookText, virality, category } | null.
const SOCL_TITLES_URL = SOCL_ASR_URL.replace(/\/v1\/transcribe$/, '/v1/titles');
async function soclCloudTitles(clipTexts, { lang = 'id', topic = '', fetchImpl = fetch } = {}) {
  const out = Array((clipTexts || []).length).fill(null);
  const crypto = require('crypto');
  for (let off = 0; off < out.length; off += 12) {
    const part = clipTexts.slice(off, off + 12);
    if (!part.some((t) => _contentWords(t).length >= 2)) continue;
    const buf = Buffer.from(JSON.stringify({ lang, topic: String(topic || '').slice(0, 300),
      clips: part.map((t) => ({ transcript: String(t || '').replace(/\s+/g, ' ').trim().slice(0, 700) })) }));
    const ts = Math.floor(Date.now() / 1000);
    const mid = soclMachineId();
    const sig = crypto.createHmac('sha256', soclAsrKey())
      .update(`${ts}.${mid}.${crypto.createHash('sha256').update(buf).digest('hex')}`).digest('hex');
    const r = await soclCloudFetch(fetchImpl, SOCL_TITLES_URL, { method: 'POST', body: buf,
      headers: { 'content-type': 'application/json', 'x-socl-ts': String(ts), 'x-socl-mid': mid, 'x-socl-sig': sig } });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
    const j = JSON.parse(txt);
    if (!j.ok) throw new Error(j.error || 'socl titles failed');
    out.engine = j.engine || '';
    out.log = j.log || [];
    for (const row of j.rows || []) {
      const k = off + Number(row.id) - 1;
      if (!(k >= off && k < off + part.length)) continue;
      const title = cleanApiTitle(row.title, lang, 10);
      if (title) out[k] = { title, hookText: require('./clip-hook').normalizeHookText(row.hook, { maxWords: 7 }), archetype: row.archetype || '',
        virality: Math.max(1, Math.min(10, Math.round(+row.virality || 0))) || null,
        category: String(row.category || '').toLowerCase() };
    }
  }
  return out;
}
async function soclTranscribe(audioPath, { lang, log, prog, workDir } = {}) {
  const dir = path.join(workDir || path.dirname(audioPath), `_asrchunks-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const listPath = path.join(dir, 'list.csv');
    await spawnLines(FFMPEG, ['-y', '-i', audioPath, '-f', 'segment', '-segment_time', String(SOCL_ASR_CHUNK_SEC),
      '-segment_list', listPath, '-segment_list_type', 'csv', '-c', 'copy', path.join(dir, 'c%03d.ogg')], { timeoutMs: 300000 });
    const chunks = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { const [f, a] = l.split(','); return { file: path.join(dir, f), start: parseFloat(a) || 0 }; });
    const silences = await detectSilence(audioPath, { noiseDb: -50, minSec: 5 });
    chunks.forEach((c, i) => { c.len = (chunks[i + 1] ? chunks[i + 1].start : Infinity) - c.start; });
    const live = chunks.filter((c) => !(Number.isFinite(c.len) && silentChunk(c.start, c.len, silences)));
    if (live.length < chunks.length && log) log(`▶ ASR SOCL Cloud: ${chunks.length - live.length}/${chunks.length} potongan hening dilewati`, 'lime');
    let done = 0;
    const parts = await mapLimit(live, 3, async (c) => {
      const j = await soclAsrChunk(fs.readFileSync(c.file), lang);
      done++;
      prog && prog(`transkrip via SOCL Cloud… ${done}/${live.length}`, 43 + 2 * done / live.length);
      return { c, j };
    });
    const words = [], cues = [];
    let language = '';
    for (const { c, j } of parts) {
      language = language || j.language || '';
      for (const w of j.words || []) words.push({ word: w.word, start: c.start + w.start, end: c.start + w.end });
      for (const g of j.segments || []) cues.push({ start: c.start + g.start, end: c.start + g.end, text: g.text, words: [] });
    }
    return { segments: cues, words, language };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function transcribeAudio(cfg, inputPath, sessionDir, { onLog, onProgress, lang, binPaths, secretsLocked, onConfirmDownload, sourceDurationSec, audioStreamIndex } = {}) {
  const log = (m, k) => onLog?.(m, k);
  // [STALE-STATUS-FIX] The big status bar/step card (window.socl.onProgress on
  // the renderer side) only ever got ONE 'Transcribe' event from the caller,
  // right before this function was invoked — this function itself had no
  // onProgress parameter at all, only onLog. So for however long audio
  // extraction + ASR actually took (206s in a reported real run — a 65-minute
  // local import with an expired Groq key falling through to local
  // whisper.cpp), the small scrolling log panel got heartbeats but the big
  // status text/percent the user is actually watching sat frozen on whatever
  // it last said, reported as "stuck di transcribe" even though the run was
  // alive and progressing the whole time. `prog` here mirrors the log
  // heartbeats into the same channel the caller's initial 'Transcribe' event
  // used, so the visible status text moves with real elapsed time instead of
  // going silent for the one step users watch the closest during a fresh run.
  const prog = (detail, pct) => { try { onProgress?.('Transcribe', detail, pct); } catch {} };
  const durationSec = Math.max(1, Number(sourceDurationSec) || 60);
  let audioPath = null;
  try {
    // [ASR-EXTRACT-PROGRESS] This spawn used to run with an empty line
    // handler, discarding every line ffmpeg emits, while `prog` fired exactly
    // ONCE before it. On this user's long local imports that made the step silent
    // for a measured 39-163 s (worst case socl-2026-08-02T04-10-48) — the
    // single largest "the app is frozen" window in the whole run, and the one
    // an abandoned run died in. ffmpeg already reports `time=` continuously;
    // it just was not being read.
    log(`▶ ASR: menyiapkan audio (${humanDuration(durationSec)} sumber)…`, 'lime');
    prog('mengekstrak audio…', 42);
    audioPath = path.join(sessionDir, 'asr-audio.ogg');
    let lastExtractLog = 0;
    const mapArgs = Number.isInteger(audioStreamIndex) ? ['-map', `0:${audioStreamIndex}`] : [];
    await spawnLines(FFMPEG, ['-y', '-i', inputPath, ...mapArgs, '-vn',
      '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', audioPath],
      { timeoutMs: ASR_EXTRACT_TIMEOUT_MS(durationSec),
        onLine: (_k, line) => {
          const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
          if (!m) return;
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          const frac = Math.max(0, Math.min(1, t / durationSec));
          // Status bar every tick (cheap, and it is what the user watches);
          // the log panel only every 15 s so a long extract cannot evict the
          // real warnings above it from the renderer's 300-line buffer.
          prog(`mengekstrak audio… ${Math.round(frac * 100)}%`, 42 + frac * 1.5);
          const now = Date.now();
          if (now - lastExtractLog >= 15000) {
            lastExtractLog = now;
            log(`▶ ASR: menyiapkan audio ${Math.round(frac * 100)}%`, 'lime');
          }
        } });
  } catch (e) {
    if (cancelled || isCancelError(e)) throw e;
    log(`⚠ ASR: gagal ekstrak audio (${e.message})`, 'yellow');
    return { cues: [], words: [] };
  }

  // ── Tier 1: cloud Whisper over every key the user actually has ──
  // [ASR-CLOUD-TIERS] This tier used to be Groq-only, so a user who had paid
  // for an OpenAI key and no Groq key got NO cloud transcript at all — they
  // were pushed straight to a ~200 MB offline download, or, if they declined
  // it, to fixed-interval clips with no transcript analysis behind them.
  // Both remaining endpoints speak the same OpenAI /audio/transcriptions
  // multipart shape, so one loop covers them.
  //
  // Deliberately absent: OpenRouter, which has no audio/transcriptions route at
  // all (chat completions only) — listing it would only buy a guaranteed 404.
  // Sumopod is ALSO deliberately absent now, and for the same reason, not by
  // omission — see [SUMOPOD-ASR-DEAD] at cloudAsrTiers(): the original
  // reasoning here was "if it does not proxy audio the request 404s and we
  // fall through, cheap enough either way," which was a fair bet when written
  // but has since been checked directly (an unauthenticated request 404s
  // clean while a sibling route on the same host 405s), so it is confirmed
  // dead rather than merely unproven. Sumopod chat/completions is untouched.
  // ── Tier 0: SOCL Cloud ASR (no user key needed) ──
  let soclFull = false;
  if (soclAsrAvailable(cfg)) {
    try {
      log('▶ ASR: transkrip via SOCL Cloud…', 'lime');
      prog('transkrip via SOCL Cloud…', 43);
      const data = await soclTranscribe(audioPath, { lang, log, prog, workDir: sessionDir });
      const halluc = dropHallucinatedSegments(data.segments, data.words);   // [ASR-HALLUCINATION]
      const cues = halluc.segs.map(sg => ({ start: +sg.start, end: +sg.end, text: String(sg.text || '').trim() }))
        .filter(c => c.text && isFinite(c.start) && isFinite(c.end) && c.end > c.start);
      const words = halluc.words.map(w => ({ text: String(w.word || w.text || '').trim(), start: +w.start, end: +w.end }))
        .filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start);
      const sane = words.length ? words : cues;
      if (sane.length && transcriptLooksUsable(sane, durationSec)) {
        const language = whisperLangNameToCode(data.language) || (/^[a-z]{2}$/.test(data.language) ? data.language : '');
        log(`▶ ASR SOCL Cloud: ${cues.length} segmen, ${words.length} kata${data.language ? ` (bahasa: ${data.language})` : ''}`, 'lime');
        try { fs.unlinkSync(audioPath); } catch {}
        return { cues, words, language };
      }
      log('⚠ ASR SOCL Cloud: hasil tidak masuk akal — coba sumber berikutnya', 'yellow');
    } catch (e) {
      if (cancelled || isCancelError(e)) throw e;
      const msg = String(e?.message || e);
      if (/HTTP 40[13]\b/.test(msg) || soclCloudFull(msg)) markAiProviderDead(cfg, 'socl::asr', Infinity);
      if (soclCloudFull(msg)) {
        soclFull = true;
        log('⚠ SOCL Cloud sedang penuh (kuota transkrip gratis hari ini habis) — dialihkan ke sumber berikutnya / transkrip offline di komputer ini', 'yellow');
        log(`   detail: ${msg.slice(0, 260)}`, 'yellow');
      } else {
        log(`⚠ ASR SOCL Cloud gagal (${msg.slice(0, 200)}) — coba sumber berikutnya`, 'yellow');
      }
    }
  }

  let prevTierQuota = false;   // [GROQ-ROTATION] did the tier just before fail on a quota?
  for (const tier of cloudAsrTiers(cfg)) {
    // [GROQ-ROTATION] The backup Groq Whisper model is only for a quota failure
    // of the main one — on a normal run it is never touched (measured: v3 costs
    // ~1.5 s more per 10 min of audio than turbo, words on par).
    if (tier.onlyAfterQuota && !prevTierQuota) continue;
    prevTierQuota = false;
    // [AI-CIRCUIT-BREAKER] Honour the per-run breaker: when this credential
    // already failed earlier in the run there is no point uploading the audio
    // to be told so again.
    if (aiProviderDead(cfg, tier.breaker)) continue;
    try {
      log(`▶ ASR: transkrip via ${tier.label}…`, 'lime');
      prog(`transkrip via ${tier.label}…`, 43);
      const buf = fs.readFileSync(audioPath);
      const form = new FormData();
      form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'audio.ogg');
      form.append('model', tier.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
      if (lang && lang !== 'auto') form.append('language', lang);
      const r = await fetch(tier.url, {
        method: 'POST', headers: { Authorization: `Bearer ${tier.apiKey}` }, body: form,
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
      const data = JSON.parse(txt);
      const rawSegs = Array.isArray(data.segments) ? data.segments : [];
      const rawWordList = Array.isArray(data.words) && data.words.length
        ? data.words
        : rawSegs.flatMap(s => (Array.isArray(s.words) ? s.words : []));
      const halluc = dropHallucinatedSegments(rawSegs, rawWordList);   // [ASR-HALLUCINATION]
      if (halluc.dropped) log(`▶ ASR ${tier.label}: ${halluc.dropped} segmen tanpa ucapan dibuang (halusinasi pada bagian sunyi/musik)`, 'gray');
      const segs = halluc.segs;
      const cues = segs
        .map(s => ({ start: +s.start, end: +s.end, text: String(s.text || '').trim() }))
        .filter(c => c.text && isFinite(c.start) && isFinite(c.end) && c.end > c.start);
      // [WORD-TIMING] Word-level timestamps when the provider returns them (best sync).
      // [WORD-SHAPE] Two shapes in the wild for the SAME request: OpenAI puts
      // the words at the top level, others nest them inside each segment. Only
      // the top-level shape was read, so against a nesting provider `words`
      // came back empty and the run silently fell back to SEGMENT timing —
      // which is a display window, not speech, and is precisely the "subtitle
      // telat / tidak pas dengan speaker" failure. Read both, top level first.
      const rawWords = halluc.words;
      const words = rawWords
        .map(w => ({ text: String(w.word || w.text || '').trim(), start: +w.start, end: +w.end }))
        .filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start);
      if (cues.length || words.length) {
        // [ASR-SANITY] A 200 with a near-empty body is still a failed
        // transcription. Falling through to the next tier (and ultimately to
        // local whisper) is strictly better than accepting a transcript too
        // sparse to caption or to score highlights with.
        const sane = words.length ? words : cues;
        if (!transcriptLooksUsable(sane, durationSec)) {
          log(`⚠ ASR ${tier.label}: hasil cuma ${sane.length} kata untuk audio ${humanDuration(durationSec)} — tidak masuk akal, coba sumber berikutnya`, 'yellow');
          continue;
        }
        // [ASR-DETECTED-LANG] Whisper's verbose_json ALWAYS includes the
        // language it auto-detected (a full lowercase English name, e.g.
        // "indonesian"/"japanese"/"spanish") — this was being read into
        // `data` and then never looked at again. It is a far more reliable
        // signal than the stopword-count heuristic detectLanguage() falls
        // back to (that heuristic only distinguishes English vs Indonesian
        // and silently defaults every OTHER language — Japanese, Spanish,
        // French… — to Indonesian). Surface it so the caller can use it
        // instead of re-guessing.
        const language = whisperLangNameToCode(data.language);
        log(`▶ ASR ${tier.label}: ${cues.length} segmen${words.length ? `, ${words.length} kata` : ''}${language ? ` (bahasa: ${data.language})` : ''}`, 'lime');
        try { fs.unlinkSync(audioPath); } catch {}
        return { cues, words, language };
      }
      log(`⚠ ASR ${tier.label}: respons kosong — coba sumber berikutnya`, 'yellow');
    } catch (e) {
      if (cancelled || isCancelError(e)) throw e;
      const msg = String(e?.message || e);
      // A rejected credential or an exhausted quota tells us something the 10-15
      // later aiComplete() calls in this run would otherwise each rediscover the
      // slow way. A per-DAY quota cannot recover inside this run at all.
      if (/HTTP 40[13]\b|invalid.?api.?key|unauthorized/i.test(msg)) {
        markAiProviderDead(cfg, tier.breaker, Infinity);
        for (const k of tier.chatBreakers || []) markAiProviderDead(cfg, k, Infinity);
      } else if (isQuotaError(msg)) {
        prevTierQuota = true;   // [GROQ-ROTATION] lets the backup Whisper model run next
        markAiProviderDead(cfg, tier.breaker, deadTtlFor(msg));
      }
      log(`⚠ ASR ${tier.label} gagal (${msg}) — coba sumber berikutnya`, 'yellow');
    }
  }

  // ── Tier 2: local whisper.cpp ──
  // [WHISPER-LOCAL] This tier used to be reachable ONLY through a binary path
  // that nothing ever set and an env var no user sets, so in every shipped
  // install it silently evaluated to "unavailable". A machine without a
  // readable Groq key therefore had NO transcript source at all — and with no
  // transcript there is nothing for TF-IDF to score, so clip selection quietly
  // degraded to fixed-interval cuts that look like real output. The bundle is
  // downloaded on demand (same pattern as Smart Track and the hook model)
  // rather than shipped, so the installer does not grow for users who never
  // need it.
  const suppliedWhisperBin = (binPaths && binPaths.whisper) || process.env.WHISPER_BIN;
  const suppliedWhisperModel = cfg.whisperLocalModel || process.env.WHISPER_MODEL;
  const customWhisperPair = !!(suppliedWhisperBin && suppliedWhisperModel);
  let whisperBin = suppliedWhisperBin;
  let whisperModel = suppliedWhisperModel;
  let whisperModelName = suppliedWhisperModel || cfg.whisperModelSize || 'small';
  // Stays null unless the bundle actually put a VAD model on disk. A hand-wired
  // WHISPER_BIN/WHISPER_MODEL pair has no bundle behind it, so it simply runs
  // without VAD rather than guessing at a path.
  let whisperVad = null;
  // [WHISPER-CONSENT] Three states, not a boolean: true = always allowed,
  // false = never, anything else (the default) = ask the first time it is
  // actually needed. Asking at the moment of need beats a Settings switch the
  // user has to find before they know the feature exists — and beats silently
  // pulling ~200 MB mid-run, which is what this did before.
  const localAsrPref = cfg.localAsr;
  const wantLocal = localAsrPref !== false;
  // [WHISPER-OFF-BY-DEFAULT] Reaching here at all means every cheaper source
  // already failed: no captions on the video, no sidecar SRT, no API key that
  // cloudAsrTiers would accept. Local ASR now defaults to off, so this is the
  // end of the road -- and the run continues with NO transcript, which silently
  // costs more than captions: clip selection falls back to even spacing and the
  // hook titles lose their grounding.
  //
  // Before the default changed, a user in this position at least met the
  // consent dialog and learned why. Turning the tier off without saying so
  // would trade a slow path for an invisible one, which is the exact
  // silent-degradation shape this file has been bitten by before. Say it.
  if (!wantLocal) {
    if (soclFull) log('⚠ SOCL Cloud penuh hari ini dan Transkrip offline dimatikan — nyalakan "Transkrip offline" di Settings agar video tanpa subtitle tetap dapat transkrip.', 'yellow');
    log('⚠ Transkrip offline dimatikan di Settings, dan tidak ada subtitle atau API key yang bisa dipakai.', 'yellow');
    log('⚠ Klip akan dipotong berjarak rata, bukan berdasarkan isi. Isi Groq API key (gratis) di Settings untuk hasil terbaik, atau lampirkan .srt lewat "Attach transcript".', 'yellow');
  }
  if (wantLocal && !(whisperBin && whisperModel)) {
    try {
      const wb = require('./whisper-bundle');
      if (wb.isSupportedPlatform()) {
        const requestedModelName = cfg.whisperModelSize || wb.MANIFEST.defaultModel;
        // [ASR-LOW-MEMORY] A bundled model is a per-run implementation choice,
        // not a Settings rewrite. On an 8 GB Windows machine, selecting Turbo
        // here can add roughly 500 MB over Small before Electron and the WAV
        // are counted. Resolve that choice before checking/downloading files.
        const selectionPlan = localAsrPlanFor({
          platform: process.platform,
          cpuCount: os.cpus().length,
          totalMemBytes: os.totalmem(),
          freeMemBytes: undefined,
          modelName: requestedModelName,
          customModel: false,
        });
        const modelName = selectionPlan.modelName;
        if (modelName !== requestedModelName) {
          log('⚠ ASR lokal: Windows 8 GB terdeteksi — Turbo diganti Small untuk menjaga aplikasi tetap hidup.', 'yellow');
        }
        const needsDownload = !wb.isInstalled(modelName);
        const mb = Math.round(wb.downloadSize(modelName) / 1048576);
        if (needsDownload && localAsrPref !== true) {
          // [ASR-DEAD-END] Getting here means every cheap source is exhausted:
          // no captions on the video, no sidecar SRT, no key that
          // cloudAsrTiers will accept. The old dialog asked one question --
          // "download ~200 MB?" -- and both answers were bad: yes bought a
          // wait measured against the video's own length, no silently
          // produced worse clips.
          //
          // The actual fix is a free Groq key: a couple of minutes once, and
          // every later run goes through the cloud tier instead. So offer
          // THAT first and let offline be a deliberate second choice, with
          // its cost stated up front rather than discovered halfway through.
          const etaText = humanDuration(asrEtaSeconds(durationSec, modelName));
          const choice = onConfirmDownload ? await onConfirmDownload({
            title: soclFull ? 'SOCL Cloud sedang penuh' : 'Video ini tidak punya subtitle',
            message: soclFull
              ? 'Kuota transkrip gratis SOCL Cloud hari ini sudah habis, dan video ini tidak punya subtitle. Pilih "Transkrip offline" untuk memproses di komputer ini, atau ambil Groq API key gratis milikmu sendiri.'
              : 'Video ini tidak punya subtitle dan belum ada API key yang bisa dipakai. Cara tercepat: ambil Groq API key gratis sekali saja — setelah itu transkrip selesai jauh lebih cepat.',
            detail: `Transkrip offline tetap bisa dipakai tanpa key, tapi perlu unduh ~${mb} MB dan memakan waktu sekitar ${etaText} untuk video ini, karena diproses di CPU komputer kamu.`,
            groqUrl: 'https://console.groq.com/keys',
            etaText,
            mb,
          }) : 'skip';
          if (choice === 'groq') {
            log('▶ Halaman Groq dibuka. Tempel key-nya di Settings, lalu jalankan ulang — transkrip akan jauh lebih cepat.', 'lime');
            throw new Error('__skip_local_asr__');
          }
          if (choice !== 'offline') {
            log('⚠ Transkrip offline dilewati — klip dipotong berjarak rata, bukan berdasarkan isi', 'yellow');
            throw new Error('__skip_local_asr__');
          }
          log(`▶ Transkrip offline dipilih — perkiraan ${etaText}. Isi Groq key kapan saja untuk mempercepat run berikutnya.`, 'lime');
        }
        if (needsDownload) {
          // Say what it costs before it starts, not after.
          log(`▶ ASR lokal: mengunduh mesin transkrip sekali saja (~${mb} MB)…`, 'lime');
        }
        let lastPct = -1;
        const PHASE = { binary: 'mesin', model: 'model', vad: 'VAD' };
        const paths = await wb.ensureInstalled(modelName, (p) => {
          if (p.phase === 'done' || !p.percent) return;
          const pct = Math.floor(p.percent * 100 / 5) * 5;   // every 5%
          if (pct === lastPct) return;
          lastPct = pct;
          log(`▶ ASR lokal: unduh ${PHASE[p.phase] || p.phase} ${pct}%`, 'lime');
        });
        whisperBin = paths.bin;
        whisperModel = paths.model;
        whisperModelName = modelName;
        whisperVad = paths.vad || null;   // null when the VAD fetch failed
      }
    } catch (e) {
      if (e.message !== '__skip_local_asr__') {
        log(`⚠ ASR lokal tidak bisa disiapkan (${e.message})`, 'yellow');
      }
    }
  }
  const hasLocal = whisperBin && whisperModel && fs.existsSync(whisperBin) && fs.existsSync(whisperModel);
  if (hasLocal) {
    try {
      log('▶ ASR: transkrip via whisper.cpp lokal…', 'lime');
      prog('transkrip via whisper.cpp lokal…', 44);
      const outBase = path.join(sessionDir, 'asr-local');
      // whisper.cpp wants 16 kHz mono WAV; transcode from the ogg we made.
      const wavPath = path.join(sessionDir, 'asr-audio.wav');
      // [ASR-EXTRACT-PROGRESS] Also reported: this writes an uncompressed
      // 16 kHz WAV (~213 MB for a 111-minute source), so on a long import it
      // is its own multi-second silent window right after the ogg one.
      await spawnLines(FFMPEG, ['-y', '-i', audioPath, '-ac', '1', '-ar', '16000', wavPath],
        { timeoutMs: ASR_EXTRACT_TIMEOUT_MS(durationSec),
          onLine: (_k, line) => {
            const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
            if (!m) return;
            const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
            const frac = Math.max(0, Math.min(1, t / durationSec));
            prog(`menyiapkan audio untuk whisper… ${Math.round(frac * 100)}%`, 43 + frac);
          } });
      // [ASR-LOW-MEMORY] The WAV is deliberately counted after it exists: a
      // 111-minute source is ~213 MB on disk and whisper keeps decoded samples
      // alongside it. Starting the native child when Windows already has less
      // than the measured working set can make the OS terminate the whole app,
      // which no JavaScript catch block can contain.
      const wavBytes = fs.statSync(wavPath).size;
      const freeMemBytes = availableMemBytes();   // [MAC-FREEMEM] not os.freemem()
      const asrPlan = localAsrPlanFor({
        platform: process.platform,
        cpuCount: os.cpus().length,
        totalMemBytes: os.totalmem(),
        freeMemBytes,
        modelName: whisperModelName,
        customModel: customWhisperPair,
        wavBytes,
      });
      if (asrPlan.lowSpecWindows) {
        const modelLabel = asrPlan.modelClass === 'small' ? 'Small' : 'model custom';
        log(`▶ ASR lokal: mode aman Windows 8 GB — ${modelLabel}, ${asrPlan.threads} thread`, 'lime');
      }
      if (!asrPlan.allowed) {
        const freeGb = (freeMemBytes / 1024 ** 3).toFixed(1);
        const needGb = (asrPlan.requiredFreeBytes / 1024 ** 3).toFixed(1);
        try { fs.unlinkSync(wavPath); } catch {}
        log(`⚠ ASR lokal dilewati: RAM bebas ${freeGb} GB, perlu sekitar ${needGb} GB. Tutup aplikasi lain atau gunakan Groq; proses dilanjutkan tanpa transkrip agar aplikasi tidak mati.`, 'yellow');
        prog('RAM tidak cukup untuk transkrip offline; melanjutkan tanpa transkrip…', 44.9);
        return { cues: [], words: [] };
      }
      // [ASR-ETA] Tell the user the size of the wait BEFORE it starts. Both
      // abandoned runs on record were killed inside a silent stretch of a job
      // that was progressing normally and would have finished.
      const etaSec = asrEtaSeconds(durationSec, whisperModelName);
      log(`▶ ASR lokal: perkiraan ±${humanDuration(etaSec)} untuk audio ${humanDuration(durationSec)} (offline, tanpa API key — isi Groq key gratis di Settings untuk jauh lebih cepat)`, 'lime');
      // [WORD-TIMING] -ml 1 splits at every unit; -sow makes that unit a WORD
      // instead of a token. Measured on real audio (whisper.cpp v1.9.1,
      // small-q5_1): without -sow, Indonesian words shatter into sub-word
      // fragments — "rahasianya" became four separate cues, "rah/as/ian/ya" —
      // because one Indonesian word is several tokens. Every one of those
      // fragments would have been burned into the video as its own caption.
      //
      // [ASR-LANG] `-l auto` must be passed EXPLICITLY. whisper.cpp does not
      // default to detection — it defaults to English, and on Indonesian audio
      // that does not fail loudly, it TRANSLATES: the same clip came back as
      // "So the secret is not about the stomach" instead of "Jadi rahasianya
      // bukan soal bakat". Omitting the flag would have silently turned every
      // Indonesian offline transcript into broken English. With `-l auto` the
      // same file detects id at p=0.99.
      //
      // Thread count and decoding strategy come from buildWhisperArgs — see the
      // [ASR-PERF] note above it for the measurements behind them.
      // The existsSync is not belt-and-braces: the bundle can hand back a path
      // for a file a later failure removed, and `-vm` on a missing file makes
      // whisper exit instead of transcribing.
      const vadModel = (whisperVad && fs.existsSync(whisperVad)) ? whisperVad : null;
      if (vadModel) log('▶ ASR lokal: VAD aktif — bagian hening dilewati', 'lime');
      // [ASR-WATCHDOG-MODEL] This is the EFFECTIVE per-run model, not
      // necessarily the unchanged Settings value: low-memory Windows may have
      // selected Small above. Custom paths retain their filename, and unknown
      // names still receive the slowest watchdog budget.
      // Heartbeat only — whisper.cpp's own stderr is decode-progress noise, not
      // something worth surfacing line-by-line, but a totally silent multi-
      // minute step is indistinguishable from a hang.
      //
      // It BACKS OFF (20s → 1min → 5min) instead of ticking forever: the
      // renderer keeps only the last 300 log lines (shouldShowLog/logLine in
      // renderer.js), so a fixed 20s tick on a long local transcription would
      // quietly evict every real warning above it — the download error, the VAD
      // notice, the "no API key" guidance — and leave a panel of nothing but
      // heartbeats. Early ticks are the ones that answer "did it start?"; after
      // that, proof-of-life every few minutes is enough.
      const asrStarted = Date.now();
      const HEARTBEAT_STEPS_MS = [20000, 20000, 60000, 60000, 300000];   // last value repeats
      let heartbeatTick = 0;
      let heartbeat = null;
      const stopHeartbeat = () => { if (heartbeat) { clearTimeout(heartbeat); heartbeat = null; } };
      const scheduleHeartbeat = () => {
        const wait = HEARTBEAT_STEPS_MS[Math.min(heartbeatTick, HEARTBEAT_STEPS_MS.length - 1)];
        heartbeatTick++;
        heartbeat = setTimeout(() => {
          const secs = Math.round((Date.now() - asrStarted) / 1000);
          // [ASR-ETA] Carry the remaining estimate on every tick. The backoff
          // below opens a 5-minute silent window at the 2:40 mark (a run was
          // cancelled at 394 s, squarely inside it); when the gap is that
          // long, the one line that lands has to answer "how much longer?"
          // rather than just "still alive".
          const leftSec = etaSec - secs;
          const left = leftSec > 15 ? `, sisa ±${humanDuration(leftSec)}` : '';
          const detail = secs >= 120
            ? `masih memproses… (${Math.floor(secs / 60)} menit${left})`
            : `masih memproses… (${secs}s${left})`;
          log(`▶ ASR lokal: ${detail}`, 'lime');
          // Same [STALE-STATUS-FIX] as above — this is the multi-minute case
          // the fix exists for. Gentle continuous creep capped just under the
          // next step's floor (45); the number moving is secondary; the
          // status TEXT actually changing every tick is what tells the user
          // this is alive; `prog.feed()` on the renderer side is monotonic so
          // this can never move the bar backward.
          prog(detail, Math.min(44.9, 44 + secs * 0.001));
          scheduleHeartbeat();
        }, wait);
      };
      scheduleHeartbeat();
      // [ASR-DETECTED-LANG] With `-l auto`, whisper.cpp prints its own
      // detection to stderr as e.g. "auto-detected language: id (p = 0.99)" —
      // it already resolves to an ISO 639-1 code (unlike the cloud tier's
      // full-name response), so this just needs to be READ instead of
      // discarded by the empty onLine below. Absent when a language was
      // forced (no auto-detection happens), which is the correct outcome:
      // the caller falls back to its own detection in that case too.
      let localDetectedLang = null;
      try {
        await spawnLines(whisperBin, buildWhisperArgs({
          model: whisperModel, wav: wavPath, outBase, lang, vadModel,
          threads: asrPlan.threads,
        }), {
          onLine: (_k, line) => {
            const m = /auto-detected language:\s*([a-z]{2,3})\b/i.exec(line);
            if (m) localDetectedLang = m[1].toLowerCase();
          },
          timeoutMs: ASR_WHISPER_TIMEOUT_MS(durationSec, whisperModelName),
        });
      } finally {
        stopHeartbeat();
      }
      try { fs.unlinkSync(wavPath); } catch {}
      const srtOut = outBase + '.srt';
      if (fs.existsSync(srtOut)) {
        const oneWord = parseSrt(fs.readFileSync(srtOut, 'utf8'));
        try { fs.unlinkSync(srtOut); } catch {}
        if (oneWord.length) {
          const words = oneWord.map(c => ({ text: String(c.text || '').trim(), start: +c.start, end: +c.end }))
            .filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start);
          // [ASR-SANITY] The regression this replaces: the count was logged in
          // LIME unconditionally, so "1 kata" for a 2.2-hour video read as a
          // success and the run continued on a useless transcript. Say plainly
          // that it failed, and say what to do about it.
          if (!transcriptLooksUsable(words, durationSec)) {
            log(`⚠ ASR lokal GAGAL: cuma ${words.length} kata untuk audio ${humanDuration(durationSec)} — audio kemungkinan tanpa suara jelas (musik/hening), atau bahasa tidak terdeteksi.`, 'yellow');
            log('⚠ Coba: isi Groq API key (gratis) di Settings, pilih bahasa manual di Clip Options → Subtitle language, atau lampirkan file .srt lewat "Attach transcript".', 'yellow');
            return { cues: [], words: [] };
          }
          log(`▶ ASR lokal: ${words.length} kata${localDetectedLang ? ` (bahasa: ${localDetectedLang})` : ''}`, 'lime');
          return { cues: words, words, language: localDetectedLang || undefined };
        }
      }
      // whisper exited 0 but wrote no SRT (or an empty one). Previously this
      // fell out of the block with NO log line at all, and the guidance below
      // was suppressed because `hasLocal` was true — the last thing the user
      // saw was "transkrip via whisper.cpp lokal…".
      log('⚠ ASR lokal selesai tapi tidak menghasilkan teks apa pun — dilanjutkan tanpa transkrip.', 'yellow');
    } catch (e) {
      if (cancelled || isCancelError(e)) throw e;
      log(`⚠ ASR lokal gagal (${e.message})`, 'yellow');
    }
  }
  // No engine produced a transcript — guide the user to enable one.
  if (!cloudAsrTiers(cfg).length && !hasLocal) {
    // Do NOT tell the user to add a key they already added. When the OS keychain
    // refused access, cfg.groqKey is empty even though a key IS stored — the old
    // wording sent people to re-enter a working key and hid the real cause.
    log(secretsLocked
      ? '⚠ Transkrip otomatis gagal: API key kamu ada tapi tidak bisa dibaca (akses keychain ditolak). Buka ulang app dan pilih Allow — jangan isi ulang key-nya.'
      : '⚠ Transkrip otomatis gagal. Pilihan: isi Groq API key (gratis) di Settings, aktifkan ASR lokal di Settings, atau lampirkan file .srt lewat "Attach transcript".',
      'yellow');
  }
  return { cues: [], words: [] };
}

// [NON-SPEECH] Whisper and YouTube auto-captions write sound annotations as if
// they were speech: "[BLANK_AUDIO]" on silence, "[Music]"/"[musik]" over an
// intro, "(tepuk tangan)", "♪ ♪". Measured: a 99 s video with a silent audio
// track came back as ONE "word" — "[BLANK_AUDIO]" — burned as a caption, and
// a real YouTube session (socl-2026-09-14T08-04-47) carried 44 "[musik]" cues.
// A cue/word whose whole text is an annotation is dropped; annotations inside
// spoken text are cut out. Never touches ordinary words.
const NON_SPEECH_ONLY_RE = /^[\s♪♫#*~\-–—]*(?:[\[(（【][^\])）】]*[\])）】][\s♪♫#*~\-–—]*)+$|^[\s♪♫#*~\-–—]+$/;
function isNonSpeechText(text) {
  const t = String(text ?? '').trim();
  return !t || NON_SPEECH_ONLY_RE.test(t);
}
function dropNonSpeech({ cues = [], words = [] } = {}) {
  const strip = (t) => String(t ?? '').replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ').replace(/[♪♫]/g, ' ').replace(/\s+/g, ' ').trim();
  const keptCues = (cues || [])
    .filter((c) => c && !isNonSpeechText(c.text))
    .map((c) => ({ ...c, text: strip(c.text) }))
    .filter((c) => c.text);
  const keptWords = (words || []).filter((w) => w && !isNonSpeechText(w.text));
  return { cues: keptCues, words: keptWords, dropped: (cues || []).length - keptCues.length + (words || []).length - keptWords.length };
}
// [ASR-HALLUCINATION] Groq Whisper on audio with no speech (a silent or
// tone-only track) returns one stock phrase per 30 s window — measured:
// " Thank you." ×4, each segment 0–29.98 s, 30–59.98 s…, no_speech_prob 0
// (useless as a signal). Real speech segments run 3–6 s at 2–3 words/s. A
// segment ≥10 s carrying under 0.2 words/s is a hallucination, as is a
// transcript made of nothing but the well-known stock phrases. Words that fall
// inside a dropped segment go with it.
const HALLUCINATION_PHRASE_RE = /^(?:thank you(?: (?:so much|very much|for watching))?|thanks(?: for watching)?|you|bye|terima kasih(?: (?:telah|sudah) menonton)?|subtitles? by.*|amara\.org.*|please subscribe.*)[.!\s]*$/i;
function dropHallucinatedSegments(segs, words) {
  const wc = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
  const bad = (segs || []).filter((sg) => {
    const dur = (+sg.end) - (+sg.start);
    return isFinite(dur) && dur >= 10 && wc(sg.text) / dur < 0.2;
  });
  let keptSegs = (segs || []).filter((sg) => !bad.includes(sg));
  const inBad = (w) => bad.some((sg) => +w.start >= +sg.start - 0.05 && +w.end <= +sg.end + 0.05);
  let keptWords = (words || []).filter((w) => !inBad(w));
  if (keptSegs.length && keptSegs.every((sg) => HALLUCINATION_PHRASE_RE.test(String(sg.text || '').trim()))) {
    keptSegs = []; keptWords = [];
  }
  return { segs: keptSegs, words: keptWords, dropped: (segs || []).length - keptSegs.length };
}

// [SUB-COVERAGE] Share of the source the subtitle cues actually cover (union of
// cue intervals). An auto-picked sidecar/embedded track that covers a sliver of
// the video — "forced" subs for a foreign line, a two-line intro — used to
// skip ASR entirely and leave the rest of the video with no transcript.
function subtitleCoverage(cues, durationSec) {
  const dur = Number(durationSec) || 0;
  if (dur <= 0 || !Array.isArray(cues) || !cues.length) return 0;
  const iv = cues.map((c) => [Math.max(0, +c.start), Math.min(dur, +c.end)])
    .filter(([a, b]) => isFinite(a) && isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  let covered = 0, curA = -1, curB = -1;
  for (const [a, b] of iv) {
    if (a > curB) { if (curB > curA) covered += curB - curA; curA = a; curB = b; }
    else if (b > curB) curB = b;
  }
  if (curB > curA) covered += curB - curA;
  return covered / dur;
}
const SUB_COVERAGE_MIN = 0.25;
const SUB_COVERAGE_MIN_SOURCE_SEC = 60;

function localUnreadableMessage(name, raw) {
  const r = String(raw || '');
  const hint = /moov atom not found|Invalid data found|end of file|truncat/i.test(r)
    ? 'File-nya kemungkinan rusak atau belum selesai disalin/di-export (bagian akhir file hilang).'
    : 'File-nya tidak bisa dibaca sebagai video.';
  const why = (r.match(/moov atom not found|Invalid data found when processing input|Permission denied|No such file or directory/i) || [])[0];
  return `Video "${name}" tidak bisa dibuka. ${hint} Coba putar dulu di pemutar video; kalau tidak bisa juga, export ulang atau salin ulang file-nya, lalu Import lagi.${why ? ` (${why})` : ''}`;
}

function cleanCueText(text) {
  if (!text) return '';
  return String(text)
    // Strip timestamps like [0:00:03.68-0:00:07.76] or [00:03.68]
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?\]/g, '')
    // Strip audio / music markers
    .replace(/\[(?:Music|Musik|Applause|Laughter|Sound|Audio)\]/gi, '')
    .replace(/\((?:Music|Musik|Applause|Laughter|Sound|Audio)\)/gi, '')
    // Strip HTML/VTT formatting tags
    .replace(/<\/?[^>]+(>|$)/g, '')
    // Strip speaker change markers and bracket/quote symbols
    .replace(/(?:>>|<<|‹›|‹|›|«|»|\\)/g, '')
    // Normalize spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTranscriptText(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const cues = [];
  const tsRangeRegex = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*-\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\]\s*(.*)/;
  const singleTsRegex = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\]\s*(.*)/;

  function toSec(m, h, s, ms) {
    if (s === undefined) {
      // Form: [mm:ss.xx]
      const min = parseInt(m, 10) || 0;
      const sec = parseInt(h, 10) || 0;
      const frac = ms ? parseFloat('0.' + ms) : 0;
      return min * 60 + sec + frac;
    }
    // Form: [h:mm:ss.xx]
    const hr = parseInt(m, 10) || 0;
    const min = parseInt(h, 10) || 0;
    const sec = parseInt(s, 10) || 0;
    const frac = ms ? parseFloat('0.' + ms) : 0;
    return hr * 3600 + min * 60 + sec + frac;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const mRange = tsRangeRegex.exec(line);
    if (mRange) {
      const start = toSec(mRange[1], mRange[2], mRange[3], mRange[4]);
      const end = toSec(mRange[5], mRange[6], mRange[7], mRange[8]);
      const rawText = mRange[9] || '';
      const cleaned = cleanCueText(rawText);
      if (cleaned && end > start) {
        cues.push({ start: +start.toFixed(3), end: +end.toFixed(3), text: cleaned });
      }
      continue;
    }
    const mSingle = singleTsRegex.exec(line);
    if (mSingle) {
      const start = toSec(mSingle[1], mSingle[2], mSingle[3], mSingle[4]);
      const rawText = mSingle[5] || '';
      const cleaned = cleanCueText(rawText);
      if (cleaned) {
        cues.push({ start: +start.toFixed(3), end: +(start + 3.0).toFixed(3), text: cleaned });
      }
      continue;
    }
    const cleaned = cleanCueText(line);
    if (cleaned) {
      const prevEnd = cues.length > 0 ? cues[cues.length - 1].end : 0;
      cues.push({ start: prevEnd, end: +(prevEnd + 3.0).toFixed(3), text: cleaned });
    }
  }
  return cues;
}

// YouTube auto-generated subtitles use a rolling-window where each cue
// includes the tail of the previous cue. dedupeCues strips the overlap so
// each cue keeps only the NEW words it introduces. Then splits each cue
// into bite-sized chunks (3 words by default) with proportional timing.
function dedupeAndSplitCues(cues, wordsPerChunk = 3) {
  if (!cues.length) return [];
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  let prevWords = [];
  const cleaned = [];
  for (const c of cues) {
    const cleanText = cleanCueText(c.text);
    if (!cleanText) continue;
    const words = cleanText.split(/\s+/).filter(Boolean);
    const wNorm = norm(cleanText);

    // Find longest prefix of wNorm that matches a suffix of prevWords
    let overlap = 0;
    const maxOverlap = Math.min(prevWords.length, wNorm.length);
    for (let k = maxOverlap; k > 0; k--) {
      let match = true;
      for (let i = 0; i < k; i++) {
        if (prevWords[prevWords.length - k + i] !== wNorm[i]) { match = false; break; }
      }
      if (match) { overlap = k; break; }
    }
    const fresh = words.slice(overlap);
    if (!fresh.length) { prevWords = wNorm; continue; }

    // [CUE-SYNC] Two systematic timing errors used to live here, both making
    // captions appear BEFORE the words were spoken:
    //
    //   1. Fresh words were spread across the cue's ENTIRE duration starting
    //      at c.start — but in YouTube's rolling-window captions the first
    //      `overlap` words were already spoken during the PREVIOUS cue. A cue
    //      of 8 words with 5 overlapping put its 3 genuinely-new words at
    //      t=c.start instead of ~62% into the cue: on a 4s cue that is 2.5s
    //      early, far past the ~150ms where a viewer stops noticing.
    //   2. Every word got an identical slice of time, so "menjelaskan" and
    //      "di" were held equally long; the error accumulates within a cue and
    //      is worst exactly where it is most visible — the final chunk.
    //
    // Both are fixed by laying out ALL of the cue's words on a single
    // character-weighted timeline and reading the fresh ones off it. Character
    // count is a decent proxy for how long a word takes to say (better than
    // uniform, and unlike syllable counting it needs no per-language rules).
    // The +1 keeps one-letter words from collapsing to zero width.
    const dur = Math.max(0.3, c.end - c.start);
    const weights = words.map(w => w.replace(/[^\p{L}\p{N}]/gu, '').length + 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const at = [];                       // at[i] = seconds from c.start to word i
    let acc = 0;
    for (const w of weights) { at.push(dur * (acc / total)); acc += w; }
    at.push(dur);                        // sentinel: end of the last word
    for (let i = 0; i < fresh.length; i += wordsPerChunk) {
      const chunk = fresh.slice(i, i + wordsPerChunk);
      const s = c.start + at[overlap + i];
      const e = c.start + at[Math.min(words.length, overlap + i + wordsPerChunk)];
      cleaned.push({ start: s, end: Math.max(e, s + 0.12), text: chunk.join(' ') });
    }
    prevWords = wNorm;
  }

  // Final pass: enforce no temporal overlap (next.start >= prev.end)
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].start < cleaned[i-1].end) cleaned[i].start = cleaned[i-1].end;
    if (cleaned[i].end <= cleaned[i].start) cleaned[i].end = cleaned[i].start + 0.25;
  }
  return cleaned;
}

// [WORD-TIMING] Group a flat word list (each {text,start,end,style?}) into cues of
// `wordsPerChunk` words, using REAL spoken times: chunk.start = first word's start,
// chunk.end = last word's end. Unlike dedupeAndSplitCues (even distribution across a
// segment), this keeps sync tight when speech has pauses. Emits `tokens` so per-word
// styling + the editor's rechunk survive. Non-overlap is enforced like the burn pass.

// [CAP-ALIGN] Caption animasi id plus its alignment, as buildAss's
// kineticCaption argument ('cap_x' or 'cap_x@left').
// [CAP-DIM] Gelapkan background: black at cfg.captionDim over the video,
// under the captions (the preview's .cap-dim-layer).
function dimVf(cfg) {
  const d = Math.max(0, Math.min(0.6, +(cfg && cfg.captionDim) || 0));
  return d > 0 ? `drawbox=x=0:y=0:w=iw:h=ih:color=black@${d.toFixed(2)}:t=fill` : '';
}
function kinCapParam(cfg) {
  const id = (cfg && cfg.captionKinetic) || '';
  return id && cfg.subtitleGlow !== false ? `${id}@glow` : id;   // [CAP-QUOTE] glow flag (align dropped)
}
// [WPC-AUTO] Kata per caption: a number, or 'auto' = natural 1–3 word cues
// (KT.mixChunks; the Lirik look always uses it).
function wpcMode(cfg) {
  if (cfg?.subtitleWordsPerChunk !== 'auto' && Number(cfg?.subtitleWordsPerChunk) > 0) return wpcNum(cfg);
  const k = cfg && cfg.captionKinetic;
  if (k === 'cap_estetik') return 'est';   // [CAP-ESTETIK] 2–5 words around one key word
  if (k === 'cap_quote' || k === 'cap_fokus_oranye') return 'mix4';   // [CAP-QUOTE] 1–4 word cues
  return (cfg && (cfg.subtitleWordsPerChunk === 'auto' || k === 'cap_sauce_mix')) ? 'mix' : wpcNum(cfg);
}
function wpcNum(cfg) { return Math.max(1, Math.min(8, Number(cfg && cfg.subtitleWordsPerChunk) || 3)); }
// [EDGE-WORD] see the clip word slice in runPipeline.
function wordMostlyInClip(w, start, end) {
  const ov = Math.min(w.end, end) - Math.max(w.start, start);
  return ov > 0 && (ov >= 0.5 * (w.end - w.start) || ov >= 0.25);
}
function chunkWordsToCues(words, wordsPerChunk = 3) {
  const ws = (Array.isArray(words) ? words : [])
    .map(w => ({
      text: stripSpeakerMarkers(w.text),
      start: +w.start,
      end: +w.end,
      style: w.style,
    }))
    .filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start);
  if (!ws.length) return [];
  // [SAUCE-MIX] 'mix' = natural 1–3 word cues (kinetic-title.js mixChunks).
  const N = Math.max(1, wordsPerChunk | 0);
  const groups = wordsPerChunk === 'est' ? KT.estChunks(ws)
    : wordsPerChunk === 'mix' || wordsPerChunk === 'mix4' ? KT.mixChunks(ws, wordsPerChunk === 'mix4' ? 4 : 3) : null;
  const cues = [];
  for (let i = 0, g = 0; groups ? g < groups.length : i < ws.length; i += N, g++) {
    const chunk = groups ? groups[g] : ws.slice(i, i + N);
    cues.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map(w => w.text).join(' '),
      tokens: chunk.map(w => (w.style ? { text: w.text, style: w.style } : { text: w.text })),
      // [BOX-HIGHLIGHT] No `.words` field — box highlight derives per-word
      // timing fresh from `tokens` + this cue's own start/end at burn time
      // (deriveWordTiming in caption-box.js), not from a stored parallel
      // array that every edit path would need to remember to keep in sync.
    });
  }
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i].start = cues[i - 1].end;
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.25;
  }
  return cues;
}

// ─── AI provider resolution (BYOK Gemini / Groq free Llama / free fallback) ─
// Resolves the effective provider + key + model from settings. Priority:
//   explicit cfg.aiProvider → else Gemini key → else Groq key → else free.
// Comma/newline separated model ids -> array. Blank entries dropped so a
// trailing comma in the Settings box cannot send an empty model id.
function parseModelList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
}

// ─── Key hygiene: trim first, then rank by whether a key CAN work ──────────
// [KEY-HYGIENE] Keys reach cfg straight from a paste into the Settings field
// (main.js readCfg → secrets.get) and nothing ever trimmed them. A trailing
// newline or space — exactly what pasting from a provider dashboard or a chat
// message gives you — travelled into the Authorization header, and the provider
// answered 401. The user then sees "key ditolak" for a key that is
// character-for-character correct, and the run silently finishes on the free
// chain at keyless quality.
//
// The prefixes below are what each provider mints today. They are used ONLY to
// DEMOTE a key, never to discard one: providers do change key formats, and a
// hardcoded shape test that rejected a valid new-format key would be a worse
// bug than the one it fixes. A shape-failing key still gets tried — it just
// stops OUTRANKING a key that looks fine. That is the concrete failure this
// fixes: a dead/truncated Gemini key led the auto-detect order purely because
// Gemini is checked first, so the healthy Groq key below it was never reached.
const KEY_PREFIX = {
  geminiKey: /^AIza/,
  groqKey: /^gsk_/,
  openrouterKey: /^sk-or-/,
  // sk-ant- is deliberately more specific than the bare ^sk- used for OpenAI;
  // fields are matched by name, so this is documentation, not disambiguation.
  anthropicKey: /^sk-ant-/,
  openaiKey: /^sk-/,
};
// Leftovers people paste or type into the field instead of a key.
const KEY_PLACEHOLDER = /^(your|isi|masukkan|paste|todo|xxx|\.\.\.|--)/i;
function cleanKey(v) { return String(v == null ? '' : v).trim(); }
function keyLooksReal(field, v) {
  const k = cleanKey(v);
  if (k.length < 16) return false;      // no provider mints a key this short
  if (/\s/.test(k)) return false;       // a key never contains inner whitespace
  if (KEY_PLACEHOLDER.test(k)) return false;
  const p = KEY_PREFIX[field];
  return p ? p.test(k) : true;          // sumopod/custom: no stable prefix
}

// Auto-detect order when no provider was explicitly picked. Paid-tier keys
// (OpenAI / OpenRouter) rank ahead of Groq's free tier but behind Gemini,
// which stays first for backwards-compatibility with existing installs.
const AUTO_PROVIDER_ORDER = [
  ['geminiKey', 'gemini'], ['anthropicKey', 'anthropic'], ['openaiKey', 'openai'],
  ['openrouterKey', 'openrouter'], ['sumopodKey', 'sumopod'], ['groqKey', 'groq'],
  ['apiKey', 'custom'],
];
function autoProvider(cfg = {}) {
  const present = AUTO_PROVIDER_ORDER.filter(([f]) => cleanKey(cfg[f]));
  if (!present.length) return 'free';
  // First key that looks real wins; if none do, keep the historical order so
  // behaviour is unchanged for anyone whose key shape we simply don't know.
  const pick = present.find(([f]) => keyLooksReal(f, cfg[f])) || present[0];
  return pick[1];
}

// [PINNED-PROVIDER-FALLBACK] An explicitly pinned aiProvider with no key for
// it used to be used VERBATIM — autoProvider() below only ever ran when
// aiProvider was empty. Reported live: a user's ONLY real key was Gemini, but
// aiProvider was still pinned to 'openrouter' (a leftover from earlier
// testing, no key ever added for it) — every AI call, including hook/title
// regeneration, failed with "AI belum diatur" despite a perfectly valid
// Gemini key sitting right in cfg.geminiKey. Compounded by freeChain() (the
// mid-run fallback chain) never listing geminiKey at all, so there was no
// safety net either. This is the exact same bug class already fixed once for
// hookProvider (see resolveHookProviderCfg's own comment: "a user whose only
// key is a paid key got forced onto a keyless config") — just one level up,
// at the primary provider pin itself, where it has the widest blast radius.
// Reuses AUTO_PROVIDER_ORDER as the single field↔provider map rather than
// keeping a second copy that could drift from it.
function pinnedProviderHasKey(cfg) {
  const entry = AUTO_PROVIDER_ORDER.find(([, p]) => p === cfg.aiProvider);
  if (!entry) return true;   // 'free' (no entry) always counts as usable
  // Every provider branch in effectiveAI() falls back to the shared legacy
  // cfg.apiKey field when its own specific field is empty (e.g. openai:
  // `cfg.openaiKey || cfg.apiKey`) — checking only the specific field here
  // made a genuinely-usable "openai pinned + only apiKey set" config look
  // keyless, which then got wrongly swapped for a DIFFERENT auto-detected
  // provider instead of being honoured as-is.
  return !!(cleanKey(cfg[entry[0]]) || cleanKey(cfg.apiKey));
}

// Keep the configured model predictable. Earlier builds silently promoted a
// freshly entered paid key from the cheap default to a premium model, making
// the Settings value and the eventual bill disagree.
const PAID_MODEL_DEFAULT = {
  geminiModel: 'gemini-flash-latest',
  openaiModel: 'gpt-4o-mini',
  sumopodModel: 'deepseek-v4-pro',
  anthropicModel: 'claude-haiku-4-5',
};
function smartModelFor(field, cfg) {
  return cfg[field] || PAID_MODEL_DEFAULT[field];
}

function effectiveAI(cfg = {}) {
  // [PINNED-PROVIDER-FALLBACK] Only override the pin when auto-detection
  // finds a GENUINE alternative. If autoProvider(cfg) would also land on
  // 'free' (no key anywhere at all — not even the pinned one), keep the
  // pinned provider as-is so aiComplete()'s existing "API key kosong. Isi di
  // Settings" message still fires — that IS the correct, actionable answer
  // when there is truly nothing to fall back to. Silently landing on 'free'
  // in that case would swap a clear error for a confusing keyless attempt.
  const auto = autoProvider(cfg);
  const provider = (cfg.aiProvider && (pinnedProviderHasKey(cfg) || auto === 'free')) ? cfg.aiProvider : auto;
  if (provider === 'gemini') return {
    provider, apiKey: cleanKey(cfg.geminiKey) || cleanKey(cfg.apiKey) || '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    // gemini-2.5-flash was live-tested 2026-07-24 and is now a hard 404
    // ("no longer available to new users") — Google retires model names
    // over time (existing comment on the fallback-cascade below already
    // documented this exact failure mode). "gemini-flash-latest" is
    // Google's own always-current alias for the flash tier, so this default
    // stops going stale every time Google ships a new major version.
    model: smartModelFor('geminiModel', cfg) || 'gemini-flash-latest',
  };
  if (provider === 'groq') return {
    provider, apiKey: cleanKey(cfg.groqKey) || cleanKey(cfg.apiKey) || '',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Default matches the Settings dropdown's first live model — the old
    // 'llama-3.3-70b-versatile' fallback is a decommissioned Groq id (404).
    model: cfg.groqModel || cfg.model || 'openai/gpt-oss-120b',
  };
  // [ANTHROPIC] Native Claude via Anthropic's OpenAI-compatible endpoint
  // (https://api.anthropic.com/v1/chat/completions) — same Bearer + chat/
  // completions shape openaiChat() sends, so no new HTTP path is needed.
  // BYOK: the user's OWN key, billed to their OWN account.
  if (provider === 'anthropic') return {
    provider, apiKey: cleanKey(cfg.anthropicKey) || cleanKey(cfg.apiKey) || '',
    baseUrl: 'https://api.anthropic.com/v1',
    model: smartModelFor('anthropicModel', cfg) || 'claude-haiku-4-5',
  };
  if (provider === 'openrouter') return {
    // [OR-FALLBACK] Server-side failover: OpenRouter accepts a `models` array
    // in priority order and switches internally on rate-limit, downtime,
    // context-length and moderation errors — one round-trip instead of our
    // client-side chain paying a second full request (+ timeout) to discover
    // the same thing. https://openrouter.ai/docs/guides/routing/model-fallbacks
    fallbacks: parseModelList(cfg.openrouterFallbacks),
    provider, apiKey: cleanKey(cfg.openrouterKey) || cleanKey(cfg.apiKey) || '',
    baseUrl: 'https://openrouter.ai/api/v1',
    // [PAID-TIER] Paid users pick any OpenRouter model; the ":free" variant is
    // only the default when nothing was chosen. openrouterModel is the
    // provider-scoped field so switching provider back and forth doesn't leave
    // a Groq/Gemini model name sitting in the shared `model` field.
    model: cfg.openrouterModel || cfg.model || 'openrouter/free',
  };
  // [PAID-TIER] 'openai' was selectable in the API panel but effectiveAI only
  // knew 'custom' — so picking OpenAI silently fell through to the keyless
  // free chain (user paid for nothing and got worse output). Both names now
  // resolve here; 'custom' additionally honours a user-supplied baseUrl.
  // [SUMOPOD] OpenAI-compatible gateway (https://ai.sumopod.com/v1) that fronts
  // several vendors behind one key and one budget cap. Model names are the
  // gateway's own, so it gets a provider-scoped model field like the rest.
  if (provider === 'sumopod') return {
    provider, apiKey: cleanKey(cfg.sumopodKey) || cleanKey(cfg.apiKey) || '',
    baseUrl: 'https://ai.sumopod.com/v1',
    model: smartModelFor('sumopodModel', cfg) || 'gpt-4o-mini',
  };
  // Custom has no known default; OpenAI keeps the explicit/settings default.
  if (provider === 'openai' || provider === 'custom') return {
    provider, apiKey: cleanKey(provider === 'openai' ? (cfg.openaiKey || cfg.apiKey) : cfg.apiKey),
    baseUrl: (provider === 'openai' ? 'https://api.openai.com/v1' : (cfg.baseUrl || 'https://api.openai.com/v1')),
    model: (provider === 'openai' ? (smartModelFor('openaiModel', cfg) || cfg.model) : cfg.model) || 'gpt-4o-mini',
  };
  // free: the user's free-tier keys (Groq, OpenRouter free), resolved at call
  // time by freeChain(). No keyless endpoint exists any more — see keylessNode.
  const keyless = keylessNode(cfg);
  return {
    provider: 'free', apiKey: cleanKey(cfg.apiKey),
    baseUrl: keyless ? keyless.baseUrl : '',
    model: keyless ? keyless.model : '',
  };
}

// [KEYLESS-RETIRED] The keyless node used to be https://api.opencode.ai/v1 with
// nemotron-3-ultra-free. Live-checked 2026-09-19: that host answers EVERY path
// (even /v1/models) with HTTP 200 "Not Found", and run logs show it dead since
// at least 2026-09-08. Its successor, opencode.ai/zen/v1, refuses outside apps
// (403 FreeTierError "OpenCode's free tier can only be used from within
// OpenCode"), so there is no keyless LLM to fall back to. Every settings.json
// ever saved still carries the old default (readCfg spreads DEFAULTS), so the
// retired values are recognised here, not only removed from DEFAULTS. A
// base URL the user set themselves is still honoured.
const RETIRED_KEYLESS_BASEURL_RE = /^https?:\/\/api\.opencode\.ai(?:\/|$)/i;
const RETIRED_KEYLESS_MODELS = new Set(['nemotron-3-ultra-free']);
function keylessNode(cfg = {}) {
  const baseUrl = String(cfg.baseUrl || '').trim();
  if (!baseUrl || RETIRED_KEYLESS_BASEURL_RE.test(baseUrl)) return null;
  const model = [cfg.freeModel, cfg.model].map(m => String(m || '').trim())
    .find(m => m && !RETIRED_KEYLESS_MODELS.has(m));
  if (!model) return null;
  return { baseUrl, apiKey: cfg.apiKey || '', model };
}

// Ordered fallback chain for the `free` provider. Each node is an OpenAI-
// compatible endpoint; we try them in order until one returns text. Groq's
// Groq's free Llama tier is preferred when a key is present
// because it is by far the most stable free option.
// `allowPaid` — paid nodes are only prepended when this chain is being used as
// a FALLBACK from a provider the user already chose to pay for. It must stay
// off when the user explicitly selected "Free (keyless)": billing someone who
// picked the free option, just because a paid key happens to be saved in
// Settings, is a money bug, not a resilience feature.
// [GROQ-ROTATION] Groq's free plan caps EACH model separately — gpt-oss-120b,
// gpt-oss-20b and Groq's 27B model are all 8K tokens/min and 200K tokens/day
// (console.groq.com/docs/rate-limits, checked 2026-10-10). One model's daily
// quota ran out in a single afternoon of testing while the other two still
// answered on the same key. When the chosen model hits its DAILY limit, is
// retired (404), or stays over its per-minute limit, the same key moves on to
// the next model instead of the whole run losing AI.
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_CHAT_ROTATION = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
function isDailyLimit(err) {
  return /tokens per day|\(TPD\)|requests per day|\(RPD\)/i.test(String((err && err.message) || err || ''));
}
function isModelGone(err) {
  const m = String((err && err.message) || err || '');
  return /HTTP 404\b/.test(m) && /model_not_found|does not exist|decommissioned|not found/i.test(m);
}
// Worth trying a sibling model on the same key: the failure belongs to THIS
// model (its own quota, or it no longer exists) — not to the key or the prompt.
function isModelRotatable(err) {
  if (err && err.code === 'BAD_AI_OUTPUT') return false;
  const m = String((err && err.message) || err || '');
  return isDailyLimit(err) || isModelGone(err)
    || (/HTTP 429\b/.test(m) && /tokens per minute|\(TPM\)|requests per minute|\(RPM\)/i.test(m));
}
// TTL for a dead node: a daily limit or a retired model cannot recover inside
// this run, so don't spend a request every AI_DEAD_TTL_MS re-learning it.
function deadTtlFor(err) { return (isDailyLimit(err) || isModelGone(err)) ? Infinity : AI_DEAD_TTL_MS; }
// keyed by a hash of the key — never a fragment of the secret itself
const rotateFlagKey = (apiKey) => `groq-rotate::${crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 12)}`;

function freeChain(cfg = {}, { allowPaid = false } = {}) {
  // [KEY-HYGIENE] Nodes whose key fails the shape test are still tried, but
  // last — a malformed key must never make the chain spend a full round-trip
  // (and up to AI_HTTP_TIMEOUT_MS) ahead of a credential that looks valid.
  const good = [], suspect = [], keyless = [];
  // `field` names which cfg key feeds this node, so the shape test knows which
  // prefix to expect. field=null is the keyless community node, which stays
  // LAST unconditionally: it is the quality floor, so even a key we cannot
  // recognise deserves its attempt before the run settles for keyless output.
  const add = (field, node) => {
    const apiKey = cleanKey(node.apiKey);
    const bucket = !field ? keyless : (keyLooksReal(field, apiKey) ? good : suspect);
    bucket.push({ ...node, apiKey });
  };
  // [PAID-TIER] Paid keys lead the fallback chain: when the primary provider
  // dies mid-run we degrade to the user's OTHER paid credential before
  // dropping to free tiers, so a job never silently finishes at keyless
  // quality while a working paid key sits unused. Re-listing the primary here
  // costs nothing — the circuit breaker (providerKey/markAiProviderDead) has
  // already marked it dead for this run, so it's skipped.
  if (allowPaid && cleanKey(cfg.anthropicKey)) {
    add('anthropicKey', { baseUrl: 'https://api.anthropic.com/v1', apiKey: cfg.anthropicKey, model: cfg.anthropicModel || 'claude-haiku-4-5' });
  }
  if (allowPaid && cleanKey(cfg.openaiKey)) {
    add('openaiKey', { baseUrl: 'https://api.openai.com/v1', apiKey: cfg.openaiKey, model: cfg.openaiModel || 'gpt-4o-mini' });
  }
  if (allowPaid && cleanKey(cfg.openrouterKey) && cfg.openrouterModel && !/(:free|^openrouter\/free)$/.test(cfg.openrouterModel)) {
    add('openrouterKey', { baseUrl: 'https://openrouter.ai/api/v1', apiKey: cfg.openrouterKey, model: cfg.openrouterModel, fallbacks: parseModelList(cfg.openrouterFallbacks) });
  }
  if (allowPaid && cleanKey(cfg.sumopodKey)) {
    add('sumopodKey', { baseUrl: 'https://ai.sumopod.com/v1', apiKey: cfg.sumopodKey, model: cfg.sumopodModel || 'gpt-4o-mini' });
  }
  if (cleanKey(cfg.groqKey)) {
    // [GROQ-MODEL-ROTATION] Live-confirmed 2026-08-19: the old hardcoded IDs
    // `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` now BOTH return
    // HTTP 404 model_not_found — Groq rotated them out of its catalogue. The
    // user's Settings "Test" passed because it used their SELECTED model
    // (cfg.groqModel, e.g. openai/gpt-oss-120b) while generation silently fell
    // through to these dead defaults. Honour the configured model; only add a
    // distinct light fallback when the user picked the big model, and pick one
    // from the SAME current catalogue rather than a decommissioned Llama id.
    const gm = cfg.groqModel || 'openai/gpt-oss-120b';
    add('groqKey', { baseUrl: GROQ_BASE_URL, apiKey: cfg.groqKey, model: gm });
    // [GROQ-ROTATION] Sibling models on the same key; tryFreeChain only walks
    // into them after a rotatable failure on this key (see isModelRotatable).
    for (const m of GROQ_CHAT_ROTATION) {
      if (m !== gm) add('groqKey', { baseUrl: GROQ_BASE_URL, apiKey: cfg.groqKey, model: m, rotation: true });
    }
  }
  if (cleanKey(cfg.openrouterKey)) {
    add('openrouterKey', { baseUrl: 'https://openrouter.ai/api/v1', apiKey: cfg.openrouterKey, model: 'openrouter/free' });
  }
  // A user-configured OpenAI-compatible endpoint, if any, stays last. The old
  // public keyless default is retired — see keylessNode.
  const custom = keylessNode(cfg);
  if (custom) add(null, custom);
  return [...good, ...suspect, ...keyless];
}

// Is an AI call usable at all? 'free' is only usable when its chain has a node
// to call; with no readable key at all the run goes straight to local detection.
function aiAvailable(cfg) {
  const e = effectiveAI(cfg);
  if (e.provider === 'free') return freeChain(cfg).length > 0;
  if (e.apiKey) return true;
  // [PAID-TIER] The selected provider has no usable key — but aiComplete()
  // now cascades to the other saved credentials instead of throwing, so
  // callers that gate on this (rewriteHookTitle bails to a local heuristic)
  // must not declare AI dead while a working key is still reachable.
  return freeChain(cfg, { allowPaid: true }).some(n => n.apiKey);
}
function isGemini(cfg) { return effectiveAI(cfg).provider === 'gemini'; }

// [KEYLESS-RETIRED] What the run log says when no AI can be called. The case
// that matters most is a key that IS saved but locked: on an ad-hoc-signed
// macOS build every update is a new code identity, so the Keychain asks again,
// and "Deny" leaves cfg with no key at all. Telling that user to "isi API
// key" sends them to re-enter a working key and hides the real fix.
function noAiMessage({ secretsLocked = false, platform = process.platform } = {}) {
  if (secretsLocked) {
    const where = platform === 'darwin' ? 'Keychain macOS' : platform === 'win32' ? 'Credential Manager Windows' : 'penyimpanan kredensial OS';
    const fix = platform === 'darwin'
      ? 'Tutup app, buka lagi, lalu saat Keychain bertanya ketik password Mac dan pilih "Always Allow"'
      : 'Tutup app, buka lagi, lalu izinkan akses saat diminta';
    return `⚠ AI tidak dipakai: API key kamu tersimpan tapi tidak bisa dibaca (akses ${where} ditolak) — highlight & judul memakai deteksi lokal. ${fix}. Key-nya tidak perlu diisi ulang.`;
  }
  return '⚠ AI tidak dipakai: belum ada API key AI — highlight & judul memakai deteksi lokal. Isi Groq API key (gratis, console.groq.com) di Settings → AI.';
}

// [AI-CIRCUIT-BREAKER] A single pipeline run makes 10-15+ aiComplete() calls
// (topic-summary map-reduce windows, highlight-detection chunks, one
// hook-title rewrite per clip) — and BEFORE this, every single one of them
// independently re-attempted a dead/rate-limited provider from scratch,
// paying a full network round-trip (up to AI_HTTP_TIMEOUT_MS) before falling
// back through the chain. Confirmed as the dominant cost behind "10-20
// minutes for just 3 clips": wall-clock scales with call COUNT × how many
// dead nodes get re-probed each time, not with clip count/duration. A
// short-TTL per-run cache — keyed off `cfg` itself, mutated in place since
// the same cfg reference flows through the entire runPipeline() call — lets
// a provider that just failed be skipped by every later call in this run,
// while still giving it another shot after the TTL in case the failure was
// transient (Groq's per-minute TPM cap resets every 60s).
const AI_DEAD_TTL_MS = 120000;
function aiProviderDead(cfg, key) {
  const until = cfg && cfg.__aiDeadUntil && cfg.__aiDeadUntil[key];
  return typeof until === 'number' && Date.now() < until;
}
// `ttlMs` defaults to the short cooldown that suits a transient failure. Pass
// Infinity for one that provably cannot recover inside this run — a per-DAY
// quota being the case that motivated it: re-probing it every two minutes only
// spends the user's wall-clock to be told "still exhausted".
function markAiProviderDead(cfg, key, ttlMs = AI_DEAD_TTL_MS) {
  if (!cfg) return;
  if (!cfg.__aiDeadUntil) {
    Object.defineProperty(cfg, '__aiDeadUntil', { value: {}, enumerable: false, configurable: true });
  }
  cfg.__aiDeadUntil[key] = ttlMs === Infinity ? Infinity : Date.now() + ttlMs;
}
function providerKey(node) { return `${node.baseUrl}::${node.model}`; }

// One OpenAI-compatible chat call.
// [PAID-TIER] OpenAI's reasoning-era models (gpt-5*, o1/o3/o4-*) rejected the
// two parameters this function had always sent: `max_tokens` is a hard 400
// ("Unsupported parameter … use 'max_completion_tokens' instead") and any
// `temperature` other than 1 is a 400 too. A paid user typing `gpt-5-mini`
// therefore got a flat failure on EVERY call — and, because the caller treats
// any primary failure as a reason to cascade, silently finished the whole job
// on the free chain. Rather than hardcoding a model-name list that goes stale
// (this file already carries two scars from exactly that), the request adapts
// to what the server says: one retry, driven by the 400's own text.
function adaptOpenAiBody(body, errMsg) {
  const m = String(errMsg || '');
  const next = { ...body };
  let changed = false;
  if (/max_completion_tokens/.test(m) && 'max_tokens' in next) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    changed = true;
  }
  if (/temperature/.test(m) && 'temperature' in next) {
    delete next.temperature;       // fall back to the model's own default (1)
    changed = true;
  }
  return changed ? next : null;
}

const PROVIDER_KEY_FIELD = {
  gemini: 'geminiKey',
  groq: 'groqKey',
  openai: 'openaiKey',
  anthropic: 'anthropicKey',
  openrouter: 'openrouterKey',
  sumopod: 'sumopodKey',
};

function safeProviderError(error, secrets = []) {
  let message = String(error?.message || error || 'Koneksi gagal');
  for (const secret of secrets) {
    if (secret) message = message.split(String(secret)).join('[key]');
  }
  return message.replace(/\s+/g, ' ').slice(0, 220);
}

// [PROVIDER-TEST-RETRY] Reported: the Settings "Test" button for Gemini often
// comes back "gagal koneksi"/timeout. testProviderConnection made exactly ONE
// network attempt — the same bug SHAPE already fixed for downloads in a8270b3
// (a single flaky attempt declared permanently broken; measured 6/10 failure
// on an otherwise-healthy endpoint, fixed with a short bounded retry).
// AI_HTTP_TIMEOUT_MS was ALSO already raised once for this exact symptom
// (25s→45s, commit c0e2d16) — if it still surfaces, duration was never the
// whole story; a transient hiccup (connection reset, brief DNS blip, a proxy
// hop) that a retry survives is the more likely remaining gap. Retry ONLY
// error shapes that mean "the network attempt itself didn't complete" — a
// postJSON abort-timeout message, or a raw fetch-level failure (Node's
// undici throws a bare "fetch failed" TypeError, sometimes with a `.cause`
// carrying the OS error code). A real HTTP-status response (postJSON's own
// "HTTP ###: ..." shape — auth/quota/model-not-found) is a definitive answer
// already back from the server; retrying it wastes the user's wait and can
// read as the app hiding the real problem, so it must NOT match here.
function looksLikeTransientConnectionFailure(err) {
  const msg = String(err?.message || err || '');
  if (/^HTTP \d/.test(msg)) return false;
  return /timed out after \d+s/i.test(msg)
    || /^fetch failed/i.test(msg)
    || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg + ' ' + String(err?.cause?.code || ''));
}

// A deliberately direct, tiny provider probe. It must never call aiComplete():
// that function is designed to cascade to fallback providers, which could make
// a broken key look healthy and charge a different account during a "Test".
async function testProviderConnection(cfg = {}, provider, keyOverride = '', requester = postJSON) {
  const keyField = PROVIDER_KEY_FIELD[provider];
  if (!keyField) return { ok: false, provider, error: 'Provider tidak dikenal.' };
  const scoped = { ...cfg, aiProvider: provider };
  const typed = cleanKey(keyOverride);
  if (typed) scoped[keyField] = typed;
  const eff = effectiveAI(scoped);
  if (!eff.apiKey) return { ok: false, provider, model: eff.model, error: 'API key belum diisi.' };

  const started = Date.now();
  const attemptOnce = async () => {
    let response;
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(eff.model)}:generateContent`;
      response = await requester(url, {
        contents: [{ parts: [{ text: 'Reply exactly OK.' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 32 },
      }, { 'x-goog-api-key': eff.apiKey });
      if (!response || (!Array.isArray(response.candidates) && !response.promptFeedback)) {
        throw new Error('Respons tidak dikenali dari provider.');
      }
    } else {
      const url = `${String(eff.baseUrl || '').replace(/\/$/, '')}/chat/completions`;
      response = await requester(url, {
        model: eff.model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply exactly OK.' }],
      }, { Authorization: `Bearer ${eff.apiKey}` });
      if (!response || !Array.isArray(response.choices)) throw new Error('Respons tidak dikenali dari provider.');
    }
    return response;
  };

  // [PROVIDER-TEST-RETRY] One retry, only for a transient-shaped failure — see
  // looksLikeTransientConnectionFailure's own note for why. Bounded to a
  // single retry (not the download path's 5): this is a synchronous UI click
  // the user is waiting on, not a background job, so it must not turn one
  // 45s timeout into several.
  try {
    let response;
    try {
      response = await attemptOnce();
    } catch (firstError) {
      if (!looksLikeTransientConnectionFailure(firstError)) throw firstError;
      response = await attemptOnce();
    }
    return {
      ok: true,
      provider,
      model: response?.model || eff.model,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      provider,
      model: eff.model,
      latencyMs: Date.now() - started,
      error: safeProviderError(error, [eff.apiKey, typed, cfg[keyField]]),
    };
  }
}

// [GROQ-REASONING] Groq's `openai/gpt-oss-*` models are reasoning models —
// live-confirmed 2026-08-19: with the default reasoning effort, a short
// prompt (topic-summary, maxTokens=400) came back with `message.content`
// completely empty ("AI gagal (empty response)") because the whole token
// budget was spent on hidden chain-of-thought before any visible answer.
// Same failure class already fixed for Gemini's `thinkingConfig` elsewhere in
// this file. Groq's own API supports `reasoning_effort` (low/medium/high,
// default medium) precisely for this — 'low' leaves real headroom for the
// actual answer on the short, low-maxTokens calls this app makes.
function isGroqReasoningModel(model) { return /^openai\/gpt-oss/.test(String(model || '')); }

// [REQ-TOO-LARGE] "This request is too long" is a property of the PROMPT, not of
// the provider's health. Measured on Groq's free tier (openai/gpt-oss-120b,
// 8000 TPM): a highlight request with a 14 000-char transcript slice comes back
// HTTP 413 "Request too large … Requested 10335". aiComplete then marked Groq
// dead for 120 s, so the title batch a few seconds later failed too — a long
// video on a free key got local clips AND quote titles. The caller must split
// the prompt; nobody should blacklist the provider for it.
function isRequestTooLarge(err) {
  if (err && err.code === 'REQUEST_TOO_LARGE') return true;
  if (err && err.code === 'BAD_AI_OUTPUT') return false;
  const m = String((err && err.message) || err || '');
  return /HTTP 413\b|request too large|context[_ ]length[_ ]exceeded|maximum context length|reduce the length of the messages|prompt is too long/i.test(m);
}
function tooLarge(err) { if (err && typeof err === 'object') err.code = 'REQUEST_TOO_LARGE'; return err; }
// [RATE-WAIT] Groq's per-minute limit (429) clears in seconds and says how long:
// "Please try again in 7.38s" / "in 1m2.5s". Waiting that out beats failing over.
function rateLimitWaitMs(err) {
  const m = String((err && err.message) || err || '');
  if (!/HTTP 429\b|rate.?limit/i.test(m) || /per day|daily|\bRPD\b|\bTPD\b/i.test(m)) return null;
  const t = /try again in\s+(?:(\d+)m)?\s*([\d.]+)\s*s/i.exec(m) || /try again in\s+(\d+)m\b/i.exec(m);
  // Only when the provider says how long. A bare 429 keeps failing over at
  // once (the cascade + circuit breaker own that case).
  if (!t) return null;
  const secs = Number(t[1] || 0) * 60 + Number(t[2] || 0);
  return secs > 45 ? null : Math.ceil(secs * 1000) + 500;
}

async function openaiChat({ baseUrl, apiKey, model, fallbacks }, prompt, { system='', maxTokens=2048, temperature=0.6, onLog, onRateWait } = {}) {
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = base + '/chat/completions';
  let body = {
    model, temperature, max_tokens: maxTokens,
    ...(isGroqReasoningModel(model) ? { reasoning_effort: 'low' } : {}),
    messages: [ ...(system ? [{ role:'system', content: system }] : []), { role: 'user', content: prompt } ],
    // [OR-FALLBACK] Priority-ordered list; the first entry IS `model`, so the
    // two stay consistent for providers that ignore the array entirely.
    ...(fallbacks && fallbacks.length ? { models: [model, ...fallbacks] } : {}),
  };
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await postJSON(url, body, headers);
      break;
    } catch (e) {
      if (isRequestTooLarge(e)) throw tooLarge(e);   // [REQ-TOO-LARGE]
      // [RATE-WAIT] a short per-minute window: wait it out, twice at most.
      const wait = attempt < 2 ? rateLimitWaitMs(e) : null;
      if (wait !== null) {
        onLog?.(`▶ Batas per-menit AI tercapai — menunggu ${Math.ceil(wait / 1000)} dtk lalu lanjut…`, 'gray');
        try { onRateWait?.(wait); } catch {}   // lets a chunk pool serialise itself
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      // Only a parameter-shape 400 is worth a second attempt — auth, quota and
      // network errors must cascade to the fallback chain immediately.
      const adapted = /HTTP 400/.test(String(e?.message || '')) ? adaptOpenAiBody(body, e.message) : null;
      if (!adapted) throw e;
      r = await postJSON(url, adapted, headers);
      break;
    }
  }
  // [OR-FALLBACK] Billing follows whichever model actually ran, and the
  // response says which. Surfacing it is the whole answer to "I set a paid
  // key but nothing changed": the log now names the model that produced the
  // output instead of leaving the user to infer it.
  const served = r?.model;
  if (served && model && served !== model) {
    onLog?.(`▶ AI: ${served} (cadangan, diminta ${model})`, 'yellow');
  }
  const txt = r?.choices?.[0]?.message?.content || '';
  // [BAD-AI-OUTPUT] empty content (often finish_reason "length": reasoning
  // used the whole budget) is an output problem, not a dead provider.
  if (!txt) throw badAiOutput('empty', 'empty response' + (r?._raw ? ': ' + String(r._raw).slice(0, 160) : '') + (r?.choices?.[0]?.finish_reason ? ` finish_reason=${r.choices[0].finish_reason}` : ''), model);
  return txt.trim();
}

// Quota/rate-limit detection — used to auto-fallback Gemini → free chain
// without bothering the user. Covers HTTP 429, Google's RESOURCE_EXHAUSTED
// error code, and free-tier "quota exceeded" plain-text messages.
function isQuotaError(err) {
  if (err && err.code === 'BAD_AI_OUTPUT') return false;   // raw model text must never read as a quota hit
  const m = String(err?.message || err || '').toLowerCase();
  // [BARE-EXCEEDED-NOT-QUOTA] Same class of bug as [FOOTER-NOT-SIGNAL] on the
  // yt-dlp classifiers — "exceeded" alone is not a quota-specific token.
  // OpenAI/Groq/OpenRouter all phrase a too-long-prompt error as
  // "context_length_exceeded" / "maximum context length … exceeded", which
  // has nothing to do with the account's quota (the key is fine, the PROMPT
  // is too long — needs chunking/truncation, not a provider switch or a
  // quota-reset wait). Matching it here made the user see "Kuota Gemini
  // habis"/"Kuota AI habis" for a perfectly healthy key, and
  // markAiProviderDead() sidelined that key for the rest of the run over a
  // problem switching providers does not fix either. "quota"/"429"/"rate
  // limit"/"resource_exhausted"/"too many request" are each specific enough
  // on their own; verified this still catches every real 429/quota/
  // rate-limit message while no longer matching context/token-length errors.
  return /\b429\b|quota|rate.?limit|resource_exhausted|too many request/.test(m);
}

// [QUOTA-DETAIL] Google says exactly what ran out and for how long, and we
// used to throw all of it away and show "Kuota Gemini habis" — which reads as
// "your key is bad" to a user who just pasted a working key. The 429 body
// carries google.rpc.QuotaFailure (quotaId, quotaValue, the model it applies
// to) and google.rpc.RetryInfo (retryDelay).
//
// Measured live on a real free-tier key, 2026-07-29:
//   quotaId    GenerateRequestsPerDayPerProjectPerModel-FreeTier
//   quotaValue 20
//   model      gemini-3.6-flash   (what "gemini-flash-latest" resolves to)
//   retryDelay 24s
//
// Older builds could spend 20+ requests in one run (summary windows plus one
// title call per clip). Summary sampling and batched titles now keep that much
// lower, but the distinction below still matters when a daily quota is hit:
//   • PerDay  → waiting is pointless. Nothing in this run will fix it, and the
//               2-minute cooldown just burns wall-clock re-probing a provider
//               that cannot recover until tomorrow.
//   • PerMinute / PerSecond → genuinely transient; retryDelay is worth honouring.
// Returns null when the error is not a parseable Google quota failure.
function parseGeminiQuota(err) {
  const raw = String(err?.message || err || '');
  const i = raw.indexOf('{');
  if (i < 0) return null;
  let j;
  try { j = JSON.parse(raw.slice(i)); } catch { return null; }
  const details = j?.error?.details;
  if (!Array.isArray(details)) return null;
  const out = { quotaId: null, quotaValue: null, model: null, retryDelaySec: null, period: null };
  for (const d of details) {
    const t = String(d?.['@type'] || '');
    if (t.endsWith('QuotaFailure') && Array.isArray(d.violations) && d.violations[0]) {
      const v = d.violations[0];
      out.quotaId = v.quotaId || null;
      out.quotaValue = v.quotaValue || null;
      out.model = v.quotaDimensions?.model || null;
    } else if (t.endsWith('RetryInfo') && d.retryDelay) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay));
      if (m) out.retryDelaySec = Number(m[1]);
    }
  }
  if (!out.quotaId && out.retryDelaySec == null) return null;
  const id = String(out.quotaId || '');
  out.period = /PerDay/i.test(id) ? 'day'
    : /PerMinute/i.test(id) ? 'minute'
    : /PerSecond/i.test(id) ? 'second'
    : null;
  return out;
}

// The one line the user actually sees. Names the number and the period, so
// "20 per hari" makes it obvious this is a plan limit and not a broken key.
function quotaMessage(q) {
  if (!q) return null;
  const PERIOD_ID = { day: 'per hari', minute: 'per menit', second: 'per detik' };
  const where = q.model ? ` untuk model ${q.model}` : '';
  if (q.quotaValue && q.period) {
    const limit = `${q.quotaValue} permintaan ${PERIOD_ID[q.period]}`;
    return q.period === 'day'
      ? `Kuota Gemini gratis habis: batasnya ${limit}${where}, dan itu baru pulih besok. Ganti model di Settings (batas harian tiap model terpisah) atau pakai Groq/OpenRouter yang batasnya jauh lebih longgar.`
      : `Kuota Gemini kena batas ${limit}${where} — sifatnya sementara${q.retryDelaySec ? `, pulih ~${Math.ceil(q.retryDelaySec)} detik lagi` : ''}.`;
  }
  return `Kuota Gemini habis${where}${q.retryDelaySec ? ` — coba lagi ~${Math.ceil(q.retryDelaySec)} detik` : ''}.`;
}

// [BAD-AI-OUTPUT] Strike rule for (model × task): a refusal is stochastic, so
// the first one benches the model for this kind of prompt for AI_DEAD_TTL_MS,
// the second for the rest of the run. Scoped by taskClass in the run's shared
// map — a model that refuses a highlight prompt still writes titles.
const unsuitableKey = (pk, taskClass) => `${pk}::bad::${taskClass}`;
function markUnsuitable(cfg, pk, taskClass) {
  if (!cfg || !taskClass) return;
  if (!cfg.__aiDeadUntil) Object.defineProperty(cfg, '__aiDeadUntil', { value: {}, enumerable: false, configurable: true });
  const m = cfg.__aiDeadUntil;
  const sk = `${pk}::strikes::${taskClass}`;
  const prev = m[sk] || { n: 0, at: 0 };
  // two refusals from one concurrent burst are one strike, not a permanent bench
  const next = Date.now() - prev.at < 30000 ? { n: Math.max(1, prev.n), at: prev.at } : { n: prev.n + 1, at: Date.now() };
  Object.defineProperty(m, sk, { value: next, enumerable: false, configurable: true, writable: true });
  markAiProviderDead(cfg, unsuitableKey(pk, taskClass), next.n >= 2 ? Infinity : AI_DEAD_TTL_MS);
}

async function tryFreeChain(cfg, prompt, opts, { onLog, allowPaid = false, primaryError = null, primaryBadKey = null, primaryPk = null } = {}) {
  const chain = freeChain(cfg, { allowPaid });
  // [KEYLESS-RETIRED] Nothing to call. Say so, rather than "Semua free
  // endpoint gagal" about endpoints that were never tried. When a primary
  // provider already failed, ITS reason is the answer — the dead keyless node
  // used to be the only thing carrying e.g. "HTTP 401" through to the log.
  if (!chain.length) {
    if (primaryError) throw primaryError;
    throw new Error('Tidak ada API key AI yang bisa dipakai (belum diisi, atau tersimpan tapi tidak bisa dibaca) — buka Settings → AI.');
  }
  let anyQuotaHit = false;   // did ANY node in the chain fail specifically on rate-limit?
  let anyAttempted = false;
  // [CHAIN-DIAGNOSTICS] Every attempted node's own failure, not just the
  // last one — the last node in the chain is always the keyless community
  // endpoint, so a dead-endpoint-shaped message ("Not Found") from IT used to
  // be the ONLY thing ever surfaced, masking why the user's own real key
  // (e.g. Groq) actually failed earlier in the same chain.
  const attempts = [];
  // [BAD-AI-OUTPUT] keys whose model gave an unusable answer IN THIS CALL — their
  // sibling Groq models may be tried for this call without the global flag.
  const badKeys = new Set(primaryBadKey ? [primaryBadKey] : []);
  let anyBad = false, anyOther = false;
  for (const node of chain) {
    const key = providerKey(node);
    // the primary was just asked in THIS call — never send it the same request twice
    if (primaryPk && key === primaryPk) continue;
    // [GROQ-ROTATION] a sibling model is only worth a request once this key's
    // model failed for a model-specific reason; otherwise it's the same key failing.
    if (node.rotation && !aiProviderDead(cfg, rotateFlagKey(node.apiKey)) && !badKeys.has(node.apiKey)) continue;
    if (aiProviderDead(cfg, key)) { attempts.push(`${node.model || key} = dilewati (mati sementara)`); continue; }
    if (opts?.taskClass && aiProviderDead(cfg, unsuitableKey(key, opts.taskClass))) { attempts.push(`${node.model || key} = dilewati (jawaban tak terpakai sebelumnya)`); continue; }
    anyAttempted = true;
    try {
      const out = await openaiChat(node, prompt, { ...opts, onLog });
      if (opts?.accept) opts.accept(out);   // [BAD-AI-OUTPUT] validate BEFORE announcing success
      onLog?.(node.rotation
        ? `▶ Beralih ke model Groq lain (${node.model}) — berhasil tersambung`
        : `▶ Beralih ke AI cadangan — berhasil tersambung`, 'lime');
      return out;
    } catch (e) {
      if (isRequestTooLarge(e)) throw tooLarge(e);   // [REQ-TOO-LARGE] same prompt fails everywhere
      if (isBadAiOutput(e)) {
        // not the key's health: no dead mark, no rotation flag
        attempts.push(`${node.model || key} = jawaban tak terpakai (${e.kind})`);
        markUnsuitable(cfg, key, opts?.taskClass);
        badKeys.add(node.apiKey); anyBad = true;
        continue;
      }
      anyOther = true;
      attempts.push(`${node.model || key} = ${e?.message || 'unknown'}`);
      if (isQuotaError(e)) anyQuotaHit = true;
      if (node.baseUrl === GROQ_BASE_URL && isModelRotatable(e)) markAiProviderDead(cfg, rotateFlagKey(node.apiKey), Infinity);
      markAiProviderDead(cfg, key, deadTtlFor(e));
    }
  }
  // If an EARLIER node hit a real rate limit but a LATER one failed for a
  // different reason (e.g. the final keyless endpoint being simply dead),
  // the message below is what callers actually see and match against via
  // isQuotaError() to decide whether a retry-after-backoff is worthwhile —
  // without surfacing "rate limit" here, that retry never fires even though
  // the true bottleneck (the one live, working key) genuinely was transient.
  if (!anyAttempted && primaryError) throw primaryError;
  const prefix = anyQuotaHit ? 'rate limit hit on at least one endpoint; ' : '';
  const why = anyAttempted ? attempts.join(' | ') : 'semua endpoint ditandai mati dari percobaan sebelumnya di run ini';
  if (anyBad && !anyOther && !anyQuotaHit) throw badAiOutput('all', why);   // [BAD-AI-OUTPUT] every answer unusable
  throw new Error(`Semua free endpoint gagal: ${prefix}${why}`);
}

// [GEMINI-AUTH] Classic Google AI Studio API keys are "AIzaSy…" and only
// work via the `?key=` query param. Google also issues OAuth2-style
// access-token credentials (reported by a real user as now starting "AQ."
// instead of "AIza"). Per Google's current official docs
// (https://ai.google.dev/gemini-api/docs/api-key, fetched 2026-07-24):
// "All new API keys created in Google AI Studio are automatically created
// as auth keys" (bound to a service account, fast leaked-key revocation),
// and "the Gemini API will reject standard keys after September 2026" — so
// EVERY new key going forward looks like this, not just an edge case.
//
// [GEMINI-AUTH] Live-tested against a real "AQ." key on 2026-07-24: sending
// it as `Authorization: Bearer <key>` (the previous fix, based on the
// assumption it must be an OAuth2 access token) got a 401 "Expected OAuth 2
// access token, login cookie or other valid authentication credential" —
// Bearer scheme tells Google's server to validate it AS a real OAuth2
// token via token-introspection, which fails because it isn't one; "auth
// keys" are a distinct credential type entirely. Google's OWN documented
// REST examples (both the API-key guide and the quickstart) use the
// `x-goog-api-key: YOUR_API_KEY` header instead — a plain API-key-via-header
// mechanism, unrelated to OAuth. Nothing in the docs suggests classic
// "AIzaSy…" keys need a DIFFERENT mechanism than this header, so it's used
// unconditionally rather than branching on key shape (simpler, and avoids
// hardcoding an assumption about exactly which shapes exist — Google has
// already changed this once).
function isClassicGeminiApiKey(key) {
  return /^AIza/.test(key || '');
}

async function aiComplete(cfg, prompt, { system='', maxTokens=2048, temperature=0.6, json=false, onLog, accept, taskClass, modelOverride, onRateWait } = {}) {
  let eff = effectiveAI(cfg);
  // [GROQ-SPREAD] a caller may ask for a specific sibling Groq model (spreading
  // chunks over the per-model free buckets). Only within the rotation list, and
  // only while that model is neither dead nor benched for this task.
  if (modelOverride && eff.baseUrl === GROQ_BASE_URL && eff.apiKey && GROQ_CHAT_ROTATION.includes(modelOverride)) {
    const pk = providerKey({ ...eff, model: modelOverride });
    if (!aiProviderDead(cfg, pk) && !(taskClass && aiProviderDead(cfg, unsuitableKey(pk, taskClass)))) eff = { ...eff, model: modelOverride };
  }
  const chainOpts = { system, maxTokens, temperature, accept, taskClass, onRateWait };
  // A paid provider is "chosen" — its own failures may cascade onto the user's
  // OTHER paid key. Explicitly picking 'free' never does.
  const allowPaid = eff.provider !== 'free';
  if (eff.provider !== 'free' && !eff.apiKey) {
    // [PAID-TIER] This used to be an unconditional throw, which killed the
    // whole call even when the user had perfectly good OTHER credentials —
    // the exact situation after picking a provider in the panel but leaving
    // its key blank, or when the OS keychain refuses to decrypt one key
    // (secrets.diagnose() 'locked'/'undecryptable'). Only give up when there
    // is genuinely nothing else to try.
    const alt = freeChain(cfg, { allowPaid }).filter(n => n.apiKey);
    if (!alt.length) throw new Error('API key kosong. Isi di Settings (Bring Your Own Key).');
    onLog?.(`⚠ Key untuk ${eff.provider} kosong/tidak terbaca — memakai key lain yang tersimpan…`, 'yellow');
    return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid });
  }
  // [AI-CIRCUIT-BREAKER] Primary provider already failed earlier THIS run —
  // go straight to the fallback chain instead of paying another full
  // round-trip (+ timeout) to re-confirm what's already known.
  const primaryKey = eff.provider === 'gemini' ? 'gemini' : providerKey(eff);
  if (eff.provider !== 'free' && aiProviderDead(cfg, primaryKey)) {
    return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid });
  }
  // [BAD-AI-OUTPUT] benched for this kind of prompt → straight to the others,
  // siblings on the same key allowed.
  // Only when there IS another model to go to — a Gemini-only (or any
  // single-provider) user must keep reaching their one provider; benching it
  // used to end in a false "no API key" message (review 2026-10-10).
  if (eff.provider !== 'free' && taskClass && aiProviderDead(cfg, unsuitableKey(primaryKey, taskClass))) {
    const others = freeChain(cfg, { allowPaid }).filter((n) => {
      const k = providerKey(n);
      return k !== primaryKey && !aiProviderDead(cfg, k) && !aiProviderDead(cfg, unsuitableKey(k, taskClass))
        && (!n.rotation || n.apiKey === eff.apiKey || aiProviderDead(cfg, rotateFlagKey(n.apiKey)));
    });
    if (others.length) return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid, primaryBadKey: eff.apiKey, primaryPk: primaryKey });
  }
  if (eff.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(eff.model)}:generateContent`;
    const headers = { 'x-goog-api-key': eff.apiKey };
    // Every Gemini model from the 2.5 line onward ships with "thinking"
    // enabled by default — it silently consumes the output-token budget
    // before any visible text is generated, so a small maxOutputTokens
    // (e.g. 40 for a hook rewrite) returns empty `text` with
    // finishReason=MAX_TOKENS. Two things had to be live-tested and fixed
    // (2026-07-24, gemini-3.6-flash):
    //   1. `thinkingConfig: { thinkingBudget: 0 }` (works on 2.5) is REJECTED
    //      by 3.x with a 400 INVALID_ARGUMENT — 3.x thinking apparently can't
    //      be fully disabled this way (thinkingLevel:"none" is similarly
    //      rejected; thinkingLevel:"low" is accepted but still consumes the
    //      whole budget on trivial prompts). So thinkingConfig is only sent
    //      for the 2.5 line, where it's proven to fully disable thinking.
    //   2. Even with thinking un-disabled on other lines, budget just needs
    //      to be generous enough to survive it. 500 was live-tested against a
    //      short hook-title rewrite prompt and looked sufficient — but a real
    //      user's `gemini-flash-latest` (which never matches the 2.5 regex
    //      below, so thinking is NEVER disabled for it) truncated
    //      regenerateClipMeta's fuller prompt (rules section + transcript) to
    //      12-228 chars of a JSON object at 500-800, and only reliably
    //      finished at 1200+ — re-measured live (2026-08-14) with the exact
    //      failing prompt: 500→12 chars invalid, 800→228 invalid, 1200→259
    //      valid, 2000→269 valid. 2000 keeps comfortable headroom above the
    //      measured cliff rather than sitting right on it. The
    //      prompt-specified maxTokens still wins when it's already bigger
    //      (e.g. topic-summary calls asking for 2048).
    const isGemini25 = /^gemini-2\.5/.test(eff.model);
    const geminiMaxTokens = Math.max(maxTokens, 2000);
    const body = {
      contents: [{ parts: [{ text: (system ? system + '\n\n' : '') + prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: geminiMaxTokens,
        ...(json ? { responseMimeType: 'application/json' } : {}),
        ...(isGemini25 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };
    try {
      const r = await postJSON(url, body, headers);
      const cand = r?.candidates?.[0];
      const txt = cand?.content?.parts?.map(p => p?.text || '').join('') || '';
      if (!txt) {
        const reason = cand?.finishReason || r?.promptFeedback?.blockReason || 'unknown';
        const safety = cand?.safetyRatings ? ' safety=' + JSON.stringify(cand.safetyRatings).slice(0,120) : '';
        throw new Error(`Gemini empty (reason=${reason}${safety})`);
      }
      const outG = txt.trim();
      if (accept) accept(outG);   // [BAD-AI-OUTPUT]
      return outG;
    } catch (e) {
      if (isBadAiOutput(e)) {
        markUnsuitable(cfg, primaryKey, taskClass);
        onLog?.(`⚠ ${eff.model} memberi jawaban tak terpakai (${e.kind}) — mencoba AI lain…`, 'yellow');
        return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid, primaryError: e, primaryPk: primaryKey });
      }
      // Auto-fallback to the Groq/OpenRouter/keyless chain on ANY Gemini
      // failure, not just quota errors. Originally this only triggered on
      // isQuotaError — but a stale/deprecated API key or model (Google
      // periodically retires model names, e.g. "gemini-2.5-flash is no
      // longer available to new users", a plain 404 — NOT a quota error)
      // silently fell all the way through to the local-heuristic fallback
      // even when the user had a perfectly good Groq key configured. Any
      // hard failure of the PRIMARY provider should degrade to the next
      // configured one before giving up on AI entirely.
      // [QUOTA-DETAIL] Prefer Google's own explanation over a generic
      // "kuota habis" — see parseGeminiQuota. A per-DAY exhaustion cannot
      // recover inside this run, so it is marked dead for the whole job
      // rather than re-probed every AI_DEAD_TTL_MS, which only spends
      // wall-clock to be told the same thing again.
      if (isRequestTooLarge(e)) throw tooLarge(e);   // [REQ-TOO-LARGE]
      const primaryWasQuota = isQuotaError(e);
      const quota = primaryWasQuota ? parseGeminiQuota(e) : null;
      const why = quota ? quotaMessage(quota)
        : primaryWasQuota ? 'Kuota Gemini habis'
        : `Gemini gagal (${e.message})`;
      onLog?.(`⚠ ${why} — mencari AI cadangan…`, 'yellow');
      markAiProviderDead(cfg, primaryKey, quota?.period === 'day' ? Infinity : undefined);
      try {
        return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid, primaryError: e });
      } catch (chainErr) {
        // See [QUOTA-SIGNAL-LOST] on the non-Gemini branch below — same fix.
        if (primaryWasQuota && !isQuotaError(chainErr)) {
          chainErr.message = `rate limit; ${chainErr.message}`;
        }
        throw chainErr;
      }
    }
  }
  if (eff.provider === 'free') {
    return await tryFreeChain(cfg, prompt, chainOpts, { onLog });
  }
  try {
    const out = await openaiChat(eff, prompt, { system, maxTokens, temperature, onLog, onRateWait });
    if (accept) accept(out);   // [BAD-AI-OUTPUT]
    return out;
  } catch (e) {
    if (isBadAiOutput(e)) {
      // the answer, not the provider: no dead mark, no rotation flag
      markUnsuitable(cfg, primaryKey, taskClass);
      onLog?.(`⚠ ${eff.model} memberi jawaban tak terpakai (${e.kind}) — mencoba model lain…`, 'yellow');
      return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid, primaryError: e, primaryBadKey: eff.apiKey, primaryPk: primaryKey });
    }
    // Same broadened fallback as the Gemini branch above — any failure of
    // the explicitly-configured provider (groq/openrouter/openai), not just
    // quota, cascades to the next configured key instead of giving up.
    if (isRequestTooLarge(e)) throw tooLarge(e);   // [REQ-TOO-LARGE] split the prompt, keep the provider
    const primaryWasQuota = isQuotaError(e);
    const rotate = eff.baseUrl === GROQ_BASE_URL && isModelRotatable(e);   // [GROQ-ROTATION]
    const why = rotate && isDailyLimit(e) ? `Jatah harian ${eff.model} habis`
      : rotate && isModelGone(e) ? `Model ${eff.model} sudah tidak tersedia di Groq`
      : primaryWasQuota ? 'Kuota AI habis' : `AI gagal (${e.message})`;
    onLog?.(`⚠ ${why} — ${rotate ? 'mencoba model Groq lain' : 'mencari AI cadangan'}…`, 'yellow');
    if (rotate) markAiProviderDead(cfg, rotateFlagKey(eff.apiKey), Infinity);
    markAiProviderDead(cfg, primaryKey, deadTtlFor(e));
    try {
      return await tryFreeChain(cfg, prompt, chainOpts, { onLog, allowPaid, primaryError: e });
    } catch (chainErr) {
      // [QUOTA-SIGNAL-LOST] tryFreeChain's own aggregated message (each
      // fallback node's own failure reason, joined) does not itself contain
      // "quota"/"429"/"rate limit" even when the ROOT cause was the primary
      // provider's rate limit — live-confirmed 2026-08-19: 8 back-to-back
      // highlight-detection chunks all hit this and cascaded instantly with
      // ZERO pacing, because the caller's own isQuotaError(e) check (which
      // decides whether to back off before the next chunk) saw only this
      // chain-aggregated text and never detected a rate limit at all. Re-tag
      // the propagated error so that check still fires correctly.
      if (primaryWasQuota && !isQuotaError(chainErr)) {
        chainErr.message = `rate limit; ${chainErr.message}`;
      }
      throw chainErr;
    }
  }
}

// [LANG-DRIFT] A prompt written in Indonesian is NOT a guarantee of an
// Indonesian answer: gpt-4o-mini-class models drift to English on some clips
// of the same run, producing "Unlock Your Potential: The Power of Active
// Learning" next to perfectly Indonesian siblings. The prompt now forbids it
// explicitly, but instruction-following is probabilistic, so the output is
// checked too. Deliberately conservative — an English loanword or brand name
// in an otherwise Indonesian phrase must NOT trip this, so it fires only when
// English function words are present AND Indonesian ones are absent.
function looksEnglishText(text) {
  const s = String(text || '').toLowerCase();
  const tokens = s.split(/[^a-zA-Z']+/).filter(Boolean);
  if (tokens.length < 3) return false;       // too short to judge
  let en = 0, id = 0;
  for (const tok of tokens) {
    if (EN_STOPWORDS.has(tok)) en++;
    if (ID_STOPWORDS.has(tok)) id++;
  }
  return en >= 2 && id === 0;
}

// [SIDECAR-SUB] Find a subtitle file sitting next to an imported video —
// "talk.mp4" + "talk.srt", or the common "talk.id.srt" / "talk.en.vtt" shapes
// that every subtitle tool and download site produces. Without this, importing
// a local file that ALREADY ships with subtitles still ran the whole
// no-transcript path: no ASR key means no transcript at all, which means
// TF-IDF cannot score anything and clips degrade to fixed-interval cuts. The
// user's own file had the answer sitting beside it the whole time.
// Preference order: exact basename match, then the preferred language, then
// anything — a foreign-language transcript still beats none.
function findSidecarSubtitle(videoPath, preferredLang = 'auto', fsMod = fs) {
  try {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath).replace(/\.[^.]+$/, '');
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "base.srt" | "base.<tag>.srt" — the tag is a language code, never a path.
    const re = new RegExp(`^${esc}(?:\\.([A-Za-z-]{2,12}))?\\.(srt|vtt)$`, 'i');
    const hits = [];
    // [TIDY-SESSION] Next to the video first (older sessions, a user's own
    // "video.srt"), then the session's transkrip/ folder.
    for (const d of [dir, path.join(dir, TRANSCRIPT_DIRNAME)]) {
      let names = [];
      try { names = fsMod.readdirSync(d); } catch { continue; }
      for (const f of names) {
        const m = re.exec(f);
        if (m) hits.push({ file: path.join(d, f), tag: (m[1] || '').toLowerCase() });
      }
      if (hits.length) break;
    }
    if (!hits.length) return null;
    const pref = String(preferredLang || 'auto').trim().toLowerCase();
    const exact = hits.find(h => !h.tag);
    if (pref && pref !== 'auto') {
      const byLang = hits.find(h => h.tag === pref || h.tag.startsWith(pref + '-'));
      if (byLang) return byLang.file;
    }
    // In auto mode: prefer exact "video.srt", then English/original "video.en.srt", then first hit
    if (exact) return exact.file;
    const eng = hits.find(h => h.tag === 'en' || h.tag === 'eng' || h.tag.startsWith('en-'));
    if (eng) return eng.file;
    return hits[0].file;
  } catch { return null; }
}

// [TIDY-SESSION] User asked where the transcript is. Once a run's transcript
// is final, the readable transcript.txt goes to <session>/transkrip/, and the
// subtitle files the run fetched (source.<lang>.srt|vtt) move there together
// with their paired source.words.json, so word timing stays beside its
// caption file. Readers (findSidecarSubtitle, loadSessionWords) look there as
// well as at the old location. Best-effort: a tidy-up can never fail a run.
const TRANSCRIPT_DIRNAME = 'transkrip';
const SUBTITLE_FILE_RE = /^source(?:\.[A-Za-z-]{2,12})?\.(srt|vtt)$/i;
function srtTimestamp(sec) {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${String(c.text || '').trim()}\n`).join('\n');
}
async function tidyTranscriptFiles(sessionDir, transcriptText, { cues = [], words = [] } = {}) {
  const dir = path.join(sessionDir, TRANSCRIPT_DIRNAME);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'transcript.txt'), transcriptText);
    for (const name of await fs.promises.readdir(sessionDir)) {
      if (name === 'source.words.json' || SUBTITLE_FILE_RE.test(name)) {
        await fs.promises.rename(path.join(sessionDir, name), path.join(dir, name)).catch(() => {});
      }
    }
    // [TRANSKRIP-REUSE] A transcript from an API or offline Whisper had no
    // subtitle FILE, so re-importing this source.mp4 paid for ASR again.
    // With no subtitle file in the run, save the final cues + words as a
    // matched pair, which findSidecarSubtitle / loadSessionWords then reuse.
    const hasSubtitleFile = (await fs.promises.readdir(dir)).some((n) => SUBTITLE_FILE_RE.test(n));
    if (!hasSubtitleFile && Array.isArray(cues) && cues.length) {
      await fs.promises.writeFile(path.join(dir, 'source.srt'), cuesToSrt(cues));
      await fs.promises.writeFile(path.join(dir, 'source.words.json'), JSON.stringify(Array.isArray(words) ? words : []));
    }
  } catch { /* the transcript stays usable from memory for this run */ }
}

// [EMBEDDED-SUB] A local import never gets the YouTube-URL path's free
// Innertube caption fetch (<1s, near-instant), so it had exactly one fast
// path — a sidecar "video.srt" file next to the import — before falling all
// the way through to full ASR (Whisper transcribing the whole source from
// scratch, the actual "import is slow" complaint: transcribing/hook-finding
// on an imported file pays the full ASR cost that a YouTube URL usually
// skips). Many locally-downloaded/ripped videos carry a subtitle TRACK
// embedded in the container itself (mov_text/srt/ass/webvtt) that this
// pipeline never looked for — only alongside .srt/.vtt files, never inside
// the video. Detecting and extracting that track is a second, real fast path
// that costs one ffprobe + one ffmpeg -c:s srt (a few hundred ms even on a
// long source, since it copies text, not video) instead of the full ASR
// pass. Bitmap subtitle codecs (dvd_subtitle, hdmv_pgs_subtitle, dvb_subtitle)
// are images, not text — ffmpeg cannot losslessly convert those to .srt (it
// would need OCR), so they are excluded rather than attempted and silently
// producing empty/garbled cues.
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'mov_text', 'ass', 'ssa', 'webvtt']);
async function findEmbeddedSubtitleStream(videoPath, preferredLang, ffprobeBin, spawnLinesFn) {
  try {
    const { stdout } = await spawnLinesFn(ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 's', videoPath],
      { onLine: () => {}, timeoutMs: SOURCE_PROBE_TIMEOUT_MS });
    const streams = (JSON.parse(stdout || '{}').streams || [])
      .filter(s => TEXT_SUBTITLE_CODECS.has(String(s.codec_name || '').toLowerCase()));
    if (!streams.length) return null;
    const pref = String(preferredLang || 'auto').trim().toLowerCase();
    if (pref && pref !== 'auto') {
      const byLang = streams.find(s => {
        const lang = String(s.tags?.language || s.tags?.lang || '').toLowerCase();
        return lang === pref || lang.startsWith(pref + '-') || (pref === 'id' && lang === 'ind') || (pref === 'en' && lang === 'eng');
      });
      if (byLang) return { index: byLang.index, lang: byLang.tags?.language || '', codec: byLang.codec_name };
    }
    // In auto mode: prefer default stream, or English/original stream, before fallback to streams[0]
    const def = streams.find(s => s.disposition?.default === 1);
    const eng = streams.find(s => {
      const lang = String(s.tags?.language || s.tags?.lang || '').toLowerCase();
      return lang === 'en' || lang === 'eng' || lang.startsWith('en-');
    });
    const chosen = def || eng || streams[0];
    return { index: chosen.index, lang: chosen.tags?.language || '', codec: chosen.codec_name };
  } catch { return null; }
}
async function extractEmbeddedSubtitle(videoPath, streamIndex, outPath, ffmpegBin, spawnLinesFn) {
  await spawnLinesFn(ffmpegBin,
    ['-y', '-i', videoPath, '-map', `0:${streamIndex}`, '-c:s', 'srt', outPath],
    { onLine: () => {} });
  return outPath;
}

// ─── Language detection ───────────────────────────────────
// [LANG-HINT] `hintLang` — an already-known ISO 639-1 code (from the ASR
// engine's OWN language detection, see whisperLangNameToCode() and the
// local whisper.cpp `auto-detected language:` capture above) — is trusted
// outright when present: Whisper's language ID covers ~100 languages and is
// far more reliable than anything below. The stopword/script heuristics
// here only run when no such hint exists (e.g. a plain-text/attached
// transcript with no ASR pass behind it).
//
// Lightweight bag-of-stopwords classifier for the Latin-script case. Score =
// how many ID/EN/ES stopwords appear in a sample of transcript text,
// whichever clears the field wins. Falls back to 'id' for parity with the
// original v3 prompts when transcript is empty or ambiguous — unlisted
// Latin-script languages (French, German, …) still land on this default,
// same as before; only the previously-unreachable non-Latin case (CJK) and
// Spanish are new here.
const ID_STOPWORDS = new Set(['yang','dan','di','ke','dari','tidak','itu','ini','untuk','dengan','pada','ada','juga','atau','tapi','tapi','akan','sudah','jadi','gua','gue','lo','lu','aku','kamu','saya','kita','mereka','nya','aja','sih','dong','kan','deh','banget','enggak','engga','nggak','gak','iya','udah','udah','udah','bisa','mau']);
const EN_STOPWORDS = new Set(['the','and','of','to','in','a','that','is','was','for','on','with','as','at','this','it','be','are','were','have','has','had','they','their','there','from','but','not','an','by','or','one','two','do','does','did','will','would','could','should','can','if','when','what','how','why','who']);
const ES_STOPWORDS = new Set(['que','de','la','el','en','y','a','los','las','un','una','por','con','no','se','su','para','es','lo','como','pero','más','muy','esto','eso','esta','este','yo','tú','él','ella','nosotros','ellos','porque','cuando','qué','cómo','así','también','entonces','ahora','aquí','bien','nada','todo','hay']);
// [LANG-CJK] Script-based detection for languages the Latin-token regex
// below can't even see: `[^a-zA-Z']+`.split() on Japanese/Chinese/Korean
// text produces ZERO tokens (no Latin letters), so idCount=enCount=0 and it
// silently fell through to the 'id' default — exactly the bug reported
// live ("Japanese should stay Japanese"). Hiragana/Katakana are unique to
// Japanese (Chinese text never uses them); Hangul is unique to Korean;
// CJK Unified Ideographs alone (no Hiragana/Katakana/Hangul alongside them)
// point to Chinese.
function detectCjkLanguage(s) {
  const total = s.replace(/\s+/g, '').length;
  if (!total) return null;
  const hiraKata = (s.match(/[぀-ヿ]/g) || []).length;
  const hangul   = (s.match(/[가-힯]/g) || []).length;
  const hanzi    = (s.match(/[一-鿿]/g) || []).length;
  if (hiraKata / total > 0.08) return 'ja';
  if (hangul / total > 0.15) return 'ko';
  if (hanzi / total > 0.15) {
    // [LANG-CJK-KANJI] Kanji-dense but kana-sparse Japanese (technical/
    // formal speech, proper nouns) can fall below the hiraKata ratio check
    // above. Hiragana/Katakana are UNIQUE to Japanese — Chinese text never
    // contains them — so ANY presence at all, even below the ratio
    // threshold, is enough to disambiguate from Chinese before defaulting
    // to 'zh'.
    if (hiraKata > 0) return 'ja';
    return 'zh';
  }
  return null;
}
function detectLanguage(sampleText, ytInfo, hintLang) {
  // [LANG-HINT] Highest-confidence signal — trust it and skip guessing.
  const hint = String(hintLang || '').toLowerCase().trim();
  if (/^[a-z]{2,3}$/.test(hint)) return hint;
  // Sample only the first ~6000 chars — stopword/script density is uniform.
  const s = (sampleText || '').slice(0, 6000);
  if (!s.trim()) {
    // No transcript — guess from YouTube metadata language hint. Any
    // 2-letter ISO prefix is trusted (not just 'en'), since this is real
    // per-video metadata, not a guess. Anchored to require the 2 letters be
    // the WHOLE code or followed by a region subtag ("en-US") — the old
    // unanchored `/^[a-z]{2}/` also matched non-language placeholders like
    // yt-dlp's literal "und" (undetermined) as "un", or a 3-letter ISO 639-2
    // code like "ind" as "in". Those now correctly fail and fall through to
    // the 'id' default instead of propagating a bogus code.
    const meta = ((ytInfo?.language || ytInfo?.original_language || '') + '').toLowerCase().trim();
    if (/^[a-z]{2}(?:-|$)/.test(meta)) return meta.slice(0, 2);
    return 'id';
  }
  const cjk = detectCjkLanguage(s);
  if (cjk) return cjk;
  const lower = s.toLowerCase();
  // [LANG-DIACRITIC-RANGE] `à-ÿ` (U+00E0-00FF) is the classic Latin-1
  // accented-letter range gotcha: it also contains ÷ (division sign,
  // U+00F7), a non-letter. Split into à-ö / ø-ÿ to exclude exactly that one
  // codepoint — otherwise text like "100÷4" merges into one bogus token
  // instead of splitting on the division sign, degrading stopword accuracy.
  const tokens = lower.split(/[^a-zà-öø-ÿ']+/i).filter(Boolean);
  let idCount = 0, enCount = 0, esCount = 0;
  for (const tok of tokens) {
    if (ID_STOPWORDS.has(tok)) idCount++;
    if (EN_STOPWORDS.has(tok)) enCount++;
    if (ES_STOPWORDS.has(tok)) esCount++;
  }
  // Need a meaningful gap over BOTH other candidates — small differences are
  // noise. Preserves the original en-vs-id-only 1.4x threshold exactly when
  // esCount is 0 (the common case), so existing behaviour is unchanged.
  if (enCount > idCount * 1.4 && enCount > esCount * 1.4) return 'en';
  if (esCount > idCount * 1.4 && esCount > enCount * 1.4) return 'es';
  return 'id';
}

// [LANG-DISPLAY] Turns any detectedLang code into the label an AI prompt (or
// a log line) should use. Keeps the specifically-tuned, already-localized
// labels for the two languages this app has dedicated native-copy prompt
// variants for (id/ms — see rewriteHookTitle{EN,MS} above); everything else
// (en, es, ja, and any other code Whisper can detect) resolves generically
// via Intl.DisplayNames, which is built into V8/Node and covers effectively
// every language without hand-maintaining a name list per language here.
// This is the one place new "and others" language support plugs in — a
// prompt only needs "LANGUAGE: <name>" to write correctly in that language,
// it does not need a hand-translated prompt template per language (that
// hand-translated pattern is reserved for the FULL native-copy variants,
// which only exist for id/en/ms today).
function languageDisplayName(code) {
  const c = String(code || 'id').toLowerCase();
  if (c === 'id') return 'Bahasa Indonesia';
  if (c === 'ms') return 'Bahasa Melayu Malaysia';
  if (c === 'en') return 'English';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(c);
    if (name && name.toLowerCase() !== c) return name;
  } catch {}
  return 'Bahasa Indonesia';   // unrecognized code — safe default, matches detectLanguage()'s own fallback
}

// Map step: condense a long transcript into a compact digest of bullet notes by
// summarising up to maxWindows evenly-spaced windows. Gives the reduce step
// real coverage of the WHOLE video (not just head/tail) while keeping token cost
// bounded. Returns '' on any failure so the caller falls back to head+tail.
// [SCALE-TO-OUTPUT] maxWindows scales with how much output actually needs
// this context (numClips) — a 3-clip job doesn't need the same 8-window
// full-video coverage pass as a 20-clip job; each window is its own
// aiComplete() call, and this pre-pass runs BEFORE highlight detection even
// starts, so trimming it directly cuts wall-clock for small jobs regardless
// of source video length.
async function summariseTranscriptWindows(cfg, transcriptText, lang, onLog, maxWindows = 8) {
  const text = transcriptText || '';
  const WIN = 6000, MAX_WINDOWS = Math.max(2, Math.min(8, maxWindows));
  const total = text.length;
  const nWindows = Math.min(MAX_WINDOWS, Math.ceil(total / WIN));
  if (nWindows <= 1) return '';
  const step = total / nWindows;   // evenly sample so coverage is uniform
  // [AI-PARALLEL] These windows are independent summaries of disjoint slices —
  // nothing here depends on an earlier window's result, so the old strictly
  // serial loop just stacked N round-trips of pure network latency onto the
  // front of the run, BEFORE hook detection could even begin. Run a few at a
  // time (order preserved by mapLimit) and keep the per-window try/catch so a
  // single failure still degrades to "skip that window" rather than aborting
  // the digest. Kept deliberately small: these are 300-token calls and firing
  // all 8 at once is exactly what trips a free tier's rolling TPM cap.
  const indices = Array.from({ length: nWindows }, (_, i) => i);
  const results = await mapLimit(indices, 3, async (i) => {
    const start = Math.floor(i * step);
    const chunk = text.slice(start, start + WIN);
    const p = lang === 'en'
      ? `Summarise this transcript section into 3-5 short bullet notes (topics, notable claims, names, key moments, emotional beats). Plain-text bullets only.\n\nSECTION:\n${chunk}`
      : `Ringkas bagian transcript ini jadi 3-5 poin bullet singkat (topik, klaim menarik, nama, momen penting, sisi emosional). Hanya bullet teks polos.\n\nBAGIAN:\n${chunk}`;
    try {
      const out = await aiComplete(cfg, p, {
        system: lang === 'en' ? 'Concise note-taker. Bullets only.' : 'Pencatat ringkas. Bullet saja.',
        maxTokens: 300, temperature: 0.2, onLog,
      });
      return (out && out.trim()) ? `[bagian ${i + 1}/${nWindows}]\n${out.trim()}` : null;
    } catch (e) {
      onLog?.(`⚠ Map-reduce window ${i + 1}/${nWindows} gagal: ${e.message}`, 'yellow');
      return null;
    }
  });
  const notes = results.filter(Boolean);
  if (!notes.length) return '';
  onLog?.(`▶ Map-reduce: rangkum ${notes.length}/${nWindows} window transcript`, 'lime');
  return notes.join('\n\n');
}

// One bounded prompt can still cover a long source when it samples evenly
// across the timeline. This replaces the old N map calls plus one reduce call:
// the highlight stage already reads every transcript chunk afterwards, so the
// topic brief only needs broad context, not a second exhaustive analysis pass.
function sampleTranscriptForSummary(transcriptText, maxChars = 9000, parts = 5) {
  const text = String(transcriptText || '');
  if (text.length <= maxChars) return text;
  const count = Math.max(2, Math.min(parts, 8));
  const separator = '\n…\n';
  const pieceSize = Math.max(1, Math.floor((maxChars - separator.length * (count - 1)) / count));
  const maxStart = Math.max(0, text.length - pieceSize);
  const pieces = [];
  for (let i = 0; i < count; i++) {
    const start = Math.round(maxStart * (i / (count - 1)));
    pieces.push(text.slice(start, start + pieceSize));
  }
  return pieces.join(separator);
}

// ─── Topic summary (1st-pass, cheap) ──────────────────────
// Generates a 2-3 sentence brief of what the video is *actually* about, used
// as semantic context for both highlight selection and hook rewriting. Without
// this, the AI has only the YouTube title (often clickbait) and a fragmented
// transcript window — the hooks end up disconnected from the real topic.
// Long transcripts are sampled evenly so this remains one bounded request.
// [LANG-GENERIC] Was a binary en/else-Indonesian prompt — see buildHighlightPrompt
// above for why that silently forced Indonesian for every other detected
// language. This brief is fed as CONTENT BRIEF context into buildHighlightPrompt/
// rewriteHookTitlesBatch/regenerateClipMeta, so a wrong-language brief here
// degrades their grounding even where their own output-language directive is
// correct. Same fix pattern: one English-authored prompt, LANGUAGE directive.
async function generateTopicSummary(cfg, transcriptText, ytInfo, onLog, lang = 'id', numClips = 5) {
  if (!aiAvailable(cfg)) return '';
  const full = transcriptText || '';
  const excerpt = sampleTranscriptForSummary(full, 9000, Math.max(3, Math.min(5, numClips)));
  const language = languageDisplayName(lang);
  const prompt = `Read the info + transcript excerpt below. Write a SHORT BRIEF about what this video is about.

OUTPUT LANGUAGE: ${language} — plain text, NO bullet/markdown, all of it in this language.
- 1 sentence: main theme (who, what they discuss, the context).
- 1 sentence: 3-5 concrete KEYWORDS / sub-topics covered (comma-separated).
- 1 sentence: the most VIRAL angle (insight, twist, or main conflict).

RULES: total max 3 sentences, max 80 words, FACTUAL from transcript — do not invent.

${ytInfo ? `YouTube Title: ${ytInfo.title || '-'}\nChannel: ${ytInfo.uploader || '-'}\nDescription: ${(ytInfo.description||'').slice(0,400)}` : ''}

TRANSCRIPT EXCERPT:
${excerpt}`;
  try {
    // [BAD-AI-OUTPUT] a refusal used to be accepted as the brief and then pasted
    // into every highlight and title prompt of the run.
    const out = await aiComplete(cfg, prompt, {
      system: `You are a video content analyst. Output: concise, factual, in ${language}.`,
      maxTokens: 400, temperature: 0.3, onLog, taskClass: 'summary',
      accept: (r) => { const t = String(r || '').trim(); if (!t) throw badAiOutput('empty', r); if (looksLikeRefusal(t)) throw badAiOutput('refusal', t); },
    });
    const cleaned = out.replace(/^["'""]+|["'""]+$/g, '').trim();
    onLog?.(`▶ Ringkasan topik video dibuat (${language})`, 'lime');
    return cleaned;
  } catch (e) {
    onLog?.(`⚠ Ringkasan topik dilewati: ${e.message}`, 'yellow');
    return '';
  }
}

// [HIGHLIGHT-MAPREDUCE] Split a transcript (newline-delimited "[t0-t1] text"
// lines) into chunks of at most maxChars each, splitting ONLY on full lines
// so a "[start-end]" timestamp is never cut mid-line. A single line longer
// than maxChars becomes its own (oversized) chunk rather than being dropped
// or corrupted — better to send one slightly-too-big request than lose a
// moment entirely. Used to keep each highlight-detection call within a free
// AI tier's per-minute token cap (confirmed via real Groq calls: as low as
// 6,000-12,000 TPM depending on model — far stricter than the daily cap, and
// low enough that even a dedup'd hour-long transcript needs multiple calls).
// [AI-TRANSCRIPT-COMPACT] What the AI reads. The on-disk transcript stamps
// every ~3 s caption cue as "[0:01:02.00-0:01:05.00]" — measured on the real
// 33-min session (982 cues): those stamps are ~48% of the characters and ~70%
// of the TOKENS, and on Groq's free 8K-tokens/min tier tokens are wall-clock
// (the AI stage took 247 s, nearly all of it waiting for the bucket). Merge
// cues into sentence lines of minLineSec–maxLineSec with one "[m:ss-m:ss]"
// stamp each: ~58% fewer tokens, same words, in order. The model's answers are
// snapped back to exact line starts/ends by snapToAiLines.
function aiStamp(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
function buildAiTranscript(cues, { minLineSec = 6, maxLineSec = 20 } = {}) {
  const lines = [];
  let cur = null;
  const list = Array.isArray(cues) ? cues : [];
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i]?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const st = Number(list[i].start), en = Number(list[i].end);
    if (!Number.isFinite(st) || !Number.isFinite(en)) continue;
    if (cur && en - cur.start > maxLineSec) { lines.push(cur); cur = null; }
    if (!cur) cur = { start: st, end: en, parts: [] };
    cur.parts.push(text);
    if (en > cur.end) cur.end = en;
    const next = list[i + 1];
    const boundary = SENT_END_RE.test(text) || !next || (Number(next.start) - en) >= 0.6;
    if (boundary && cur.end - cur.start >= minLineSec) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  const out = lines.map((l) => ({ start: l.start, end: l.end, text: l.parts.join(' ') }));
  return { text: out.map((l) => `[${aiStamp(l.start)}-${aiStamp(l.end)}] ${l.text}`).join('\n'), lines: out };
}
// Stamps are whole seconds; put the model's start/end back on the exact line
// boundary (within ±tol s) so snapClipToSentences starts from the real cue time
// instead of a floored one that could pull it back to the previous sentence.
function snapToAiLines(lines, clip, tol = 2) {
  if (!Array.isArray(lines) || !lines.length || !clip) return clip;
  const near = (v, key) => {
    if (!Number.isFinite(v)) return null;
    let best = null, bd = tol + 1e-9;
    for (const l of lines) { const d = Math.abs(l[key] - v); if (d <= bd) { bd = d; best = l[key]; } }
    return best;
  };
  const ns = near(Number(clip.start), 'start'), ne = near(Number(clip.end), 'end');
  const start = ns ?? clip.start;
  const end = ne ?? clip.end;
  return { ...clip, start, end: end > start ? end : clip.end };
}

// [HL-SIZE] Token estimate for request sizing. Fitted to Groq's own counts on
// the highlight prompt (6k/10k/14k-char transcripts → 4 106 / 5 934 / ~7 770
// prompt tokens): digits and punctuation tokenise ~0.75 each, other text
// ~3.6 chars per token. A miss is still caught by the 413 halving.
function estimateTokens(s) {
  const t = String(s || '');
  const dp = (t.match(/[\d\p{P}]/gu) || []).length;
  return Math.ceil(dp * 0.75 + (t.length - dp) / 3.6);
}

// [HL-SIZE] n parts of roughly equal size, cut on line boundaries. The greedy
// chunkTranscriptText(text, ceil(len/n)+1) left a 2-line, 117-char third part
// on the real 33-min run — a whole request (≈2.3k instruction tokens) spent on
// two sentences, answered with 0 candidates.
function chunkTranscriptBalanced(text, n) {
  const lines = String(text || '').split('\n');
  const k = Math.max(1, Math.min(Math.floor(n) || 1, lines.length));
  if (k === 1) return [lines.join('\n')];
  const total = lines.reduce((a, l) => a + l.length + 1, 0);
  const out = [];
  let cur = [], acc = 0;
  for (let i = 0; i < lines.length; i++) {
    cur.push(lines[i]);
    acc += lines[i].length + 1;
    const left = lines.length - i - 1, partsLeft = k - out.length - 1;
    if (partsLeft > 0 && left >= partsLeft && acc >= (total * (out.length + 1)) / k) { out.push(cur.join('\n')); cur = []; }
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

function chunkTranscriptText(transcriptText, maxChars) {
  if (!transcriptText) return [];
  const lines = transcriptText.split('\n');
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (cur.length && curLen + lineLen > maxChars) {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += lineLen;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

// [HIGHLIGHT-MAPREDUCE] Reduce phase: merge candidate-highlight arrays from
// multiple independently-analyzed transcript chunks into one ranked list.
// Sorts by virality score (highest first) and greedily keeps a candidate
// only if its start time isn't within minGapSeconds of an already-kept one
// (chunk overlap or genuinely repeated beats can otherwise surface the same
// moment more than once). Final result is re-sorted chronologically so
// clip 1 is the earliest moment, matching what a single-shot call would
// have produced.
// [CLIP-RUBRIC] OpusClip-style: the model rates hook / flow / value separately
// (its help page lists Hook, Flow, Value, Trend). One global "virality_score"
// per chunk was the only ranking signal, and it is not comparable across the
// 12k-char chunks of a long video; three anchored axes are steadier. Hook gets
// the most weight — the first seconds decide whether anyone stays.
function rubricScore(c) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(10, x)) : null; };
  const h = n(c?.hook_score), f = n(c?.flow_score), v = n(c?.value_score);
  if (h === null || f === null || v === null) return n(c?.virality_score) ?? 7;
  const sh = n(c?.share_score);
  if (sh === null) return Math.round((0.4 * h + 0.25 * f + 0.35 * v) * 10) / 10;
  return Math.round((0.35 * h + 0.2 * f + 0.3 * v + 0.15 * sh) * 10) / 10;
}

// [SENTENCE-SNAP] Cue boundaries are not sentence boundaries — YouTube
// auto-captions break every ~3 s — so 42–79% of candidate starts (measured on
// 5 real transcripts) landed mid-sentence: the clip's first second, its hook,
// opened on half a phrase. Move the start back to the nearest sentence start
// and the end forward to the nearest sentence end, within small budgets, and
// only if the result still fits the duration window.
const SNAP_START_BACK_SEC = 6, SNAP_START_FWD_SEC = 1.5, SNAP_END_FWD_SEC = 5, SNAP_END_BACK_SEC = 2;
const SENT_END_RE = /[.?!…]["'’”)\]]*\s*$/;
function isSentenceStart(cues, i) {
  if (i <= 0) return true;
  const prev = cues[i - 1];
  return SENT_END_RE.test(String(prev.text || '').trim()) || (Number(cues[i].start) - Number(prev.end)) >= 0.6;
}
function isSentenceEnd(cues, i) {
  if (i >= cues.length - 1) return true;
  return SENT_END_RE.test(String(cues[i].text || '').trim()) || (Number(cues[i + 1].start) - Number(cues[i].end)) >= 0.6;
}

// ============================================================================
// [DEAD-AIR] Strict dead-air prediction so no clip carries silent stretches.
// Two sources, unioned:
//   1. audio — ffmpeg silencedetect on the source (true silence);
//   2. speech — word timings with each word clamped to a plausible spoken
//      length (YouTube auto-caption words run until the NEXT word starts, so a
//      4 s pause hides inside one "word"), [musik]/[tertawa] tokens ignored —
//      catches music-only / ambience-only stretches silencedetect misses.
// A clip is cut to its longest run of speech with no dead gap ≥ DEAD_AIR_GAP;
// if that run is too short the clip is dropped (never padded back into air).
// ============================================================================
const DEAD_AIR_GAP = 1.6;          // s — a pause this long reads as dead air in a short
const DEAD_AIR_WORD_MAX = 0.9;     // s — longest plausible single spoken word
const DEAD_AIR_LEAD = 0.12, DEAD_AIR_TAIL = 0.35;
function speechIntervals(words, cues) {
  const out = [];
  const src = Array.isArray(words) && words.length ? words : (cues || []).map((c) => ({ text: c.text, start: c.start, end: c.end }));
  const perWord = Array.isArray(words) && words.length;
  for (const w of src) {
    const t = String(w.text != null ? w.text : w.word || '').trim();
    const s = +w.start, e = +w.end;
    if (!t || !(e > s)) continue;
    // Reactions ([tertawa], [bersorak], [tepuk tangan]) are SOUND the viewer
    // enjoys, not dead air; only music-only / bracketed silence counts as air.
    if (isNonSpeechText(t) && (/music|musik|lagu|hening|silence|♪/i.test(t) || !/^\s*[\[(]/.test(t))) continue;
    out.push([s, perWord ? Math.min(e, s + DEAD_AIR_WORD_MAX) : e]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
async function detectSilence(file, { noiseDb = -38, minSec = 1.0 } = {}) {
  const out = [];
  let open = null;
  try {
    await spawnLines(FFMPEG, ['-hide_banner', '-nostats', '-vn', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'], {
      timeoutMs: 300000, stallMs: 120000,
      onLine: (_k, line) => {
        let m = /silence_start: ([\d.]+)/.exec(line); if (m) open = +m[1];
        m = /silence_end: ([\d.]+)/.exec(line); if (m && open != null) { out.push([open, +m[1]]); open = null; }
      },
    });
  } catch { /* best effort: speech gaps still apply */ }
  return out;
}
// Dead intervals (union of silences and speech gaps ≥ gap) inside [a, b].
// [DEAD-AIR-NO-TEXT] An empty speech timeline means no transcript (speech
// unknown), not silence: only real audio silence counts then. Treating it as
// one long gap dropped every candidate of a video whose ASR had failed.
function deadAirIn(a, b, speech, silences, gap = DEAD_AIR_GAP) {
  const dead = [];
  if (speech.length) {
    let cur = a;
    for (const [s, e] of speech) {
      if (e <= a) continue;
      if (s >= b) break;
      if (s - cur >= gap) dead.push([cur, s]);
      cur = Math.max(cur, e);
    }
    if (b - cur >= gap) dead.push([cur, b]);
  }
  for (const [s, e] of silences || []) if (e > a && s < b && Math.min(e, b) - Math.max(s, a) >= gap) dead.push([Math.max(s, a), Math.min(e, b)]);
  dead.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const d of dead) { const last = merged[merged.length - 1]; if (last && d[0] <= last[1]) last[1] = Math.max(last[1], d[1]); else merged.push(d.slice()); }
  return merged;
}
// → { start, end, cut } (cut = dead air removed) or null when nothing is spoken.
function trimDeadAir(clip, speech, silences, gap = DEAD_AIR_GAP) {
  const a = +clip.start, b = +clip.end;
  const dead = deadAirIn(a, b, speech, silences, gap);
  const runs = [];
  let cur = a;
  for (const [s, e] of dead) { if (s > cur) runs.push([cur, s]); cur = Math.max(cur, e); }
  if (b > cur) runs.push([cur, b]);
  // Each run's real speech edges (no leading/trailing air inside it).
  const live = !speech.length ? runs : runs.map(([s, e]) => {
    const inRun = speech.filter(([x, y]) => y > s && x < e);
    return inRun.length ? [Math.max(s, inRun[0][0]), Math.min(e, inRun[inRun.length - 1][1])] : null;
  }).filter(Boolean);
  if (!live.length) return null;
  const best = live.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
  const start = Math.max(a, best[0] - DEAD_AIR_LEAD), end = Math.min(b, best[1] + DEAD_AIR_TAIL);
  return { start, end, cut: dead.length > 0 || start > a + 0.5 || end < b - 0.5, dead };
}

// ============================================================================
// [EDGE-SNAP] Clip edges land on a real breath, not mid-word. Caption word
// timings drift a few hundred ms, so cutting at them clipped the first or last
// syllable — measured on a real 6-clip session: 11 of 12 cut points fell while
// someone was still speaking (Silero VAD). Each edge is moved to the nearest
// low-energy valley in the actual audio (relative to the local speech level,
// so a noisy podcast room still has valleys), and a clip may not OPEN on a
// connective ("tapi", "jadi", "karena" …) that leans on what came before.
// ============================================================================
const EDGE_HOP = 0.02;             // s — envelope step
// A clip must not stop on a word that promises more ("makanya…", "kalau…").
const DANGLING_END_RE = /^(makanya|jadi|terus|trus|tapi|kalau|kalo|yang|dan|karena|soalnya|misalkan|misalnya|kayak|sama|atau|but|and|so|because|like|the|a|to|of)$/;
const CONNECTIVE_OPEN_RE = /^(tapi|tetapi|jadi|karena|soalnya|terus|trus|lalu|dan|nah|makanya|sehingga|but|so|and|because|then)\b/i;
function audioEnvelope(file, t0, dur) {
  return new Promise((resolve) => {
    const sr = 8000, hopN = Math.round(sr * EDGE_HOP);
    let p;
    try {
      p = spawn(FFMPEG, ['-v', 'error', '-ss', String(Math.max(0, t0)), '-t', String(dur), '-i', file,
        '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { windowsHide: true });
    } catch { resolve(null); return; }
    const bufs = [];
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 20000);
    p.stdout.on('data', (b) => bufs.push(b));
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(bufs);
      const n = Math.floor(buf.length / 2);
      if (n < hopN * 4) { resolve(null); return; }
      const env = [];
      for (let i = 0; i + hopN <= n; i += hopN) {
        let acc = 0;
        for (let k = i; k < i + hopN; k++) { const v = buf.readInt16LE(k * 2) / 32768; acc += v * v; }
        env.push(Math.sqrt(acc / hopN));
      }
      resolve(env);
    });
  });
}
const wText = (w) => String(w.text != null ? w.text : w.word || '').trim();
// Sentences from per-word timings (they carry the punctuation the SRT blocks
// often lose): a sentence ends on . ? ! … or before a gap ≥ 0.8 s.
function wordSentences(words) {
  const ws = (words || []).filter((w) => wText(w) && +w.end >= +w.start && !isNonSpeechText(wText(w)));
  const out = [];
  let s0 = 0;
  for (let i = 0; i < ws.length; i++) {
    const last = i === ws.length - 1;
    if (last || SENT_END_RE.test(wText(ws[i])) || +ws[i + 1].start - +ws[i].end >= 0.8) {
      out.push({ i0: s0, i1: i, start: +ws[s0].start, end: +ws[i].end, n: i - s0 + 1,
        first: wText(ws[s0]).replace(/^["'“(\[]+/, ''), last: wText(ws[i]).toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '') });
      s0 = i + 1;
    }
  }
  return { ws, sentences: out };
}
// Quietest instant (60 ms window) of `env` inside [a, b] (absolute seconds).
function quietestIn(env, base, a, b) {
  if (!env || !(b > a)) return (a + b) / 2;
  const i0 = Math.max(0, Math.floor((a - base) / EDGE_HOP));
  const i1 = Math.min(env.length - 3, Math.ceil((b - base) / EDGE_HOP) - 2);
  if (i1 < i0) return (a + b) / 2;
  let bi = i0, bv = Infinity;
  for (let i = i0; i <= i1; i++) { const v = env[i] + env[i + 1] + env[i + 2]; if (v < bv) { bv = v; bi = i; } }
  return Math.min(b, Math.max(a, base + (bi + 1.5) * EDGE_HOP));
}
// → { start, end } on whole sentences (connective openers skipped), or null.
function sentenceBounds(sentences, start, end, minDur, maxDur) {
  const fits = (a, b) => b - a >= minDur && b - a <= maxDur;
  const starts = sentences.filter((x) => x.start >= start - 10 && x.start <= start + 6);
  const ends = sentences.filter((x) => x.end >= end - 8 && x.end <= end + 8);
  const order = (list, t, back) => list.slice().sort((p, q) => {
    const dp = (back ? t - p : p - t), dq = (back ? t - q : q - t);
    const ap = dp >= -0.3 ? dp : 50 - dp, aq = dq >= -0.3 ? dq : 50 - dq;   // preferred side first
    return ap - aq;
  });
  // Openers: a real sentence (≥3 words, not "Iya." / "Oke."), not leaning on
  // a connective. Closers: never a dangling word. Weaker picks only as backup.
  const goodS = new Set(starts.filter((x) => x.n >= 3 && !CONNECTIVE_OPEN_RE.test(x.first)).map((x) => x.start));
  const goodE = new Set(ends.filter((x) => !DANGLING_END_RE.test(x.last)).map((x) => x.end));
  const sCand = order(starts.map((x) => x.start), start, true);
  const eCand = order(ends.map((x) => x.end), end, false);
  const sOrdered = sCand.filter((t) => goodS.has(t)).concat(sCand.filter((t) => !goodS.has(t)));
  const eOrdered = eCand.filter((t) => goodE.has(t)).concat(eCand.filter((t) => !goodE.has(t)));
  for (const s0 of sOrdered) for (const e0 of eOrdered) if (e0 > s0 && fits(s0, e0)) return { start: s0, end: e0 };
  return null;
}
async function snapClipEdges(file, clip, { words, minDur = 0, maxDur = Infinity } = {}) {
  const { ws, sentences } = wordSentences(words);
  if (!sentences.length) return clip;
  let b = sentenceBounds(sentences, +clip.start, +clip.end, minDur, maxDur);
  if (!b) {
    // No punctuation nearby: still never cut inside a word — use the widest
    // word gap within ±3 s of each edge.
    const gapAt = (t, isStart) => {
      let best = null, bw = -1;
      for (let i = 1; i < ws.length; i++) {
        const g = +ws[i].start - +ws[i - 1].end, at = isStart ? +ws[i].start : +ws[i - 1].end;
        if (Math.abs(at - t) <= 3 && g - Math.abs(at - t) * 0.05 > bw) { bw = g - Math.abs(at - t) * 0.05; best = at; }
      }
      return best;
    };
    const s1 = gapAt(+clip.start, true), e1 = gapAt(+clip.end, false);
    if (s1 == null || e1 == null || !(e1 - s1 >= minDur && e1 - s1 <= maxDur)) return clip;
    b = { start: s1, end: e1 };
  }
  // Word gap around each edge, then the quietest instant inside it.
  const wi = ws.findIndex((w) => +w.start >= b.start - 1e-3);
  const we = ws.findIndex((w) => +w.end >= b.end - 1e-3);
  const prevEnd = wi > 0 ? +ws[wi - 1].end : Math.max(0, b.start - 0.4);
  const nextStart = we >= 0 && we + 1 < ws.length ? +ws[we + 1].start : b.end + 0.5;
  const sLo = Math.max(prevEnd + 0.03, b.start - 0.3), sHi = b.start;
  const eLo = b.end, eHi = Math.min(nextStart - 0.03, b.end + 0.45);   // short tail: no dead air
  const envS = await audioEnvelope(file, Math.max(0, sLo - 0.2), sHi - sLo + 0.4);
  const envE = await audioEnvelope(file, Math.max(0, eLo - 0.2), eHi - eLo + 0.4);
  let start = sHi - sLo < 0.05 ? sHi - 0.03 : quietestIn(envS, Math.max(0, sLo - 0.2), sLo, sHi);
  let end = eHi - eLo < 0.05 ? eLo + 0.05 : quietestIn(envE, Math.max(0, eLo - 0.2), eLo + 0.04, eHi);
  start = Math.max(0, Math.min(start, b.start)); end = Math.max(end, b.end);
  return { ...clip, start, end, _edgeSnap: true };
}

// ============================================================================
// [CLIP-TIMELINE] Delivery-time edits on a finished clip, applied LAST (after
// captions, hook title, effect and B-roll) so burned captions travel with the
// pixels and nothing has to be re-timed:
//   • HOOK TEASER — the clip's most gripping line (AI-picked, else scored
//     locally) replayed as a 1–4 s cold open, then a short white flash, then
//     the clip from its start. The hook headline therefore lands on the first
//     frame of the real clip, right after the teaser.
//   • PAUSE TRIM — word gaps ≥ 0.6 s that are genuinely quiet in the audio
//     are cut down to a ~0.25 s breath (a laugh or a reaction is never cut).
// raw/ stays the contiguous plate; renderClipEdit re-applies the same
// timeline after its own render, so Editor output matches the pipeline's.
// ============================================================================
const TEASER_MIN = 1.0, TEASER_MAX = 4.2, TEASER_FLASH = 0.12;
// Words that make a line land on its own (emotion, oath, twist) vs. fillers
// that make it sound like the middle of a conversation.
const TEASER_STRONG = new Set('sumpah demi gila parah serius beneran bohong jujur rahasia kaget nyesel menyesal nangis takut marah malu ternyata padahal justru anehnya bayangin bayangkan pertama terakhir jangan wajib harus never secret honestly actually crazy insane truth'.split(' '));
const TEASER_FILLER_RE = /^(e+|eh+|em+|hm+|ehm+|anu|apa\s?namanya|uh+|um+)[,.]?$/i;
const TEASER_WEAK_OPEN_RE = /^(habis|abis|oh|ya|iya|terus|trus|nah|oke|ok|eh|ee+|jadi|tapi|so|well|yeah)\b/i;
const PAUSE_MIN = 0.6, PAUSE_KEEP_HEAD = 0.15, PAUSE_KEEP_TAIL = 0.1;
function pickHookTeaser(words, clipDur, { ctxText = '', aiRel = null, heatAt = null, sec = null } = {}) {
  if (!(clipDur >= 20)) return null;
  // [INSERT-SEC] A chosen length narrows the line to [sec-1.2, sec+0.3] s
  // (whole sentences only); with nothing that short-and-strong, the best
  // default line is trimmed at the last word that ends inside `sec`.
  const T_MIN = sec ? Math.max(1.5, sec - 1.2) : TEASER_MIN, T_MAX = sec ? sec + 0.3 : TEASER_MAX;
  const { ws, sentences } = wordSentences(words);
  if (aiRel && aiRel.end > aiRel.start) {
    // snap the model's stamps to whole words inside the clip
    const inn = ws.filter((w) => +w.start >= aiRel.start - 0.3 && +w.end <= aiRel.end + 0.3);
    if (inn.length >= 2) {
      const a = +inn[0].start, b = +inn[inn.length - 1].end;
      if (a >= 3 && b - a >= T_MIN && b - a <= T_MAX + (sec ? 0 : 1) && b <= clipDur - 1)
        return { start: Math.max(0, a - 0.05), end: Math.min(clipDur, b + 0.12), text: inn.map(wText).join(' '), by: 'ai' };
    }
  }
  const ctx = new Set(String(ctxText).toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((x) => x.length >= 4));
  let best = null;
  for (const st of sentences) {
    const d = st.end - st.start;
    if (st.start < Math.max(5, clipDur * 0.15) || st.end > clipDur - 1.5) continue;
    if (d < T_MIN || d > T_MAX || st.n < 3) continue;
    const sw = ws.slice(st.i0, st.i1 + 1);
    // Hard gates — a cold open must make sense with zero context:
    // no connective/weak opener, no filler, a finished sentence, no reaction tag.
    if (CONNECTIVE_OPEN_RE.test(st.first) || TEASER_WEAK_OPEN_RE.test(st.first)) continue;
    if (sw.some((w) => TEASER_FILLER_RE.test(wText(w)) || /^[\[(]/.test(wText(w)))) continue;
    if (!SENT_END_RE.test(wText(sw[sw.length - 1]))) continue;
    const strongWord = sw.some((w) => {
      const k = wText(w).toLowerCase().replace(/[^\p{L}]+/gu, '');
      return TEASER_STRONG.has(k) || BROLL_PAIN.has(k);
    });
    if (!strongWord && !/[?!]["'”)]*$/.test(wText(sw[sw.length - 1]))) continue;
    const sc = sw.map((w) => brollWordScore(wText(w), ctx)).sort((x, y) => y - x);
    let score = Math.max(0, sc[0] || 0) + Math.max(0, sc[1] || 0) / 2;
    const lastT = wText(sw[sw.length - 1]);
    if (/[?!]["'”)]*$/.test(lastT)) score += 5;
    if (CONNECTIVE_OPEN_RE.test(st.first) || TEASER_WEAK_OPEN_RE.test(st.first)) score -= 5;
    for (const w of sw) {
      const k = wText(w).toLowerCase().replace(/[^\p{L}]+/gu, '');
      if (TEASER_FILLER_RE.test(wText(w))) score -= 4;
      else if (TEASER_STRONG.has(k)) score += 4;
    }
    if (heatAt) score += Math.max(-2, Math.min(4, (heatAt((st.start + st.end) / 2) - 1) * 2));
    if (!best || score > best.score) best = { score, st, sw };
  }
  if (!best || best.score < 18) {
    if (!sec) return null;
    const wide = pickHookTeaser(words, clipDur, { ctxText, aiRel, heatAt });
    if (!wide) return null;
    if (wide.end - wide.start <= sec + 0.3) return wide;
    const inn = ws.filter((w) => +w.start >= wide.start - 0.01 && +w.end <= wide.start + sec);
    if (inn.length < 3) return null;
    return { ...wide, end: Math.min(clipDur, +inn[inn.length - 1].end + 0.12), text: inn.map(wText).join(' '), trimmed: true };
  }
  return { start: Math.max(0, best.st.start - 0.05), end: Math.min(clipDur, best.st.end + 0.12),
    text: best.sw.map(wText).join(' '), by: 'local', score: +best.score.toFixed(1) };
}
// Quiet word gaps to cut, as [a, b] clip-relative. `env` = audio envelope of
// the clip (EDGE_HOP steps from 0) — a gap is cut only when it is quiet.
function pickPauseCuts(words, clipDur, env) {
  const ws = (words || []).filter((w) => wText(w) && +w.end >= +w.start);
  if (!env || env.length < 50) return [];
  const sorted = env.slice().sort((x, y) => x - y);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  if (p90 < 1e-4) return [];
  const cuts = [];
  for (let i = 1; i < ws.length; i++) {
    const g0 = +ws[i - 1].end, g1 = +ws[i].start;
    if (g1 - g0 < PAUSE_MIN || g0 < 0.5 || g1 > clipDur - 0.5) continue;
    if (isNonSpeechText(wText(ws[i - 1])) || isNonSpeechText(wText(ws[i]))) continue;   // laugh / reaction
    const a = g0 + PAUSE_KEEP_HEAD, b = g1 - PAUSE_KEEP_TAIL;
    const i0 = Math.floor(a / EDGE_HOP), i1 = Math.min(env.length, Math.ceil(b / EDGE_HOP));
    if (i1 - i0 < 3) continue;
    let acc = 0, mx = 0;
    for (let k = i0; k < i1; k++) { acc += env[k]; mx = Math.max(mx, env[k]); }
    if (acc / (i1 - i0) > p90 * 0.3 || mx > p90 * 0.8) continue;   // someone is still talking/laughing
    cuts.push([+a.toFixed(3), +b.toFixed(3)]);
  }
  return cuts;
}
// Ordered output parts [{a, b, teaser}] for a timeline over a clip of `dur`.
function timelineParts(tl, dur) {
  const parts = [];
  if (tl?.teaser && tl.teaser.end > tl.teaser.start) parts.push({ a: tl.teaser.start, b: tl.teaser.end, teaser: true });
  let cur = 0;
  for (const [a, b] of (tl?.cuts || []).slice().sort((p, q) => p[0] - q[0])) {
    if (a > cur + 0.05) parts.push({ a: cur, b: Math.min(a, dur) });
    cur = Math.max(cur, b);
  }
  if (dur > cur + 0.05) parts.push({ a: cur, b: dur });
  return parts;
}
function timelineIsEdit(tl) { return !!(tl && ((tl.teaser && tl.teaser.end > tl.teaser.start) || (tl.cuts && tl.cuts.length))); }
// One encode: trim/concat every part, white flash out of the teaser and into
// the clip, 20 ms audio fades at every join (no clicks). → temp file or null.
async function applyClipTimeline(inFile, tl, { cwd, encArgs, log } = {}) {
  if (!timelineIsEdit(tl)) return null;
  let dur = 0, hasAudio = false;
  try {
    const { stdout } = await spawnLines(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', inFile], { onLine: () => {} });
    const meta = JSON.parse(stdout || '{}');
    dur = +meta.format?.duration || 0;
    hasAudio = (meta.streams || []).some((x) => x.codec_type === 'audio');
  } catch { return null; }
  if (!(dur > 1)) return null;
  const parts = timelineParts(tl, dur);
  if (parts.length < 2) return null;
  const f = [];
  parts.forEach((p, k) => {
    const d = p.b - p.a;
    let v = `[0:v]trim=start=${p.a.toFixed(3)}:end=${p.b.toFixed(3)},setpts=PTS-STARTPTS`;
    if (p.teaser) v += `,fade=t=out:st=${Math.max(0, d - TEASER_FLASH).toFixed(3)}:d=${TEASER_FLASH}:color=white`;
    else if (k > 0 && parts[k - 1].teaser) v += `,fade=t=in:st=0:d=${TEASER_FLASH}:color=white`;
    f.push(`${v}[v${k}]`);
    if (hasAudio) f.push(`[0:a]atrim=start=${p.a.toFixed(3)}:end=${p.b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, d - 0.02).toFixed(3)}:d=0.02[a${k}]`);
  });
  f.push(`${parts.map((_, k) => `[v${k}]${hasAudio ? `[a${k}]` : ''}`).join('')}concat=n=${parts.length}:v=1:a=${hasAudio ? 1 : 0}[vo]${hasAudio ? '[ao]' : ''}`);
  const out = inFile.replace(/\.mp4$/, `.tl-${process.pid}.mp4`);
  const args = ['-y', '-i', inFile, '-filter_complex', f.join(';'), '-map', '[vo]', ...(hasAudio ? ['-map', '[ao]', '-c:a', 'aac', '-b:a', '160k'] : []),
    ...(encArgs || ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
  try {
    await spawnLines(FFMPEG, args, { cwd: cwd || path.dirname(inFile), onLine: () => {}, timeoutMs: 1800000, stallMs: 180000 });
    return out;
  } catch (e) {
    log?.(`⚠ hook pembuka / pangkas jeda gagal (${e?.message || e}) — klip tetap tanpa itu`, 'warn');
    try { fs.unlinkSync(out); } catch {}
    return null;
  }
}

function snapClipToSentences(cues, clip, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(cues) || !cues.length) return clip;
  const s0 = Number(clip.start), e0 = Number(clip.end);
  if (!Number.isFinite(s0) || !Number.isFinite(e0) || e0 <= s0) return clip;
  let start = s0, end = e0;
  // start: latest sentence start at or before s0 (within budget), else the first one just after
  let back = null, fwd = null;
  for (let i = 0; i < cues.length; i++) {
    const t = Number(cues[i].start);
    if (t > s0 + SNAP_START_FWD_SEC) break;
    if (t < s0 - SNAP_START_BACK_SEC || !isSentenceStart(cues, i)) continue;
    if (t <= s0 + 0.05) back = t; else if (fwd === null) fwd = t;
  }
  if (back !== null) start = back; else if (fwd !== null) start = fwd;
  // end: earliest sentence end at or after e0 (within budget), else the last one just before
  let after = null, before = null;
  for (let i = 0; i < cues.length; i++) {
    const t = Number(cues[i].end);
    if (t < e0 - SNAP_END_BACK_SEC) continue;
    if (t > e0 + SNAP_END_FWD_SEC) break;
    if (!isSentenceEnd(cues, i)) continue;
    if (t >= e0 - 0.05) { if (after === null) after = t; } else before = t;
  }
  if (after !== null) end = after; else if (before !== null) end = before;
  const fits = (a, b) => b - a >= min && b - a <= max;
  if (!fits(start, end)) {
    if (fits(start, e0)) end = e0;
    else if (fits(s0, end)) start = s0;
    else { start = s0; end = e0; }
  }
  return { ...clip, start, end };
}

// [HEATMAP] YouTube "Most Replayed" (yt-dlp info.json `heatmap`, ~100 bins of
// {start_time,end_time,value}) is free, real-audience evidence of which part
// of a video people rewatch. It already rode along in every session's
// source.info.json, unused. Score bonus on the clip scale (0–10): a clip whose
// mean replay level is 1.5× the video median gains ~+1, a dead stretch loses
// up to 1. Ranking only — never invents a clip, never moves its edges.
function heatScore(heatmap, start, end) {
  if (!Array.isArray(heatmap) || heatmap.length < 5 || !(end > start)) return null;
  let acc = 0, w = 0;
  for (const h of heatmap) {
    const a = Math.max(start, +h.start_time), b = Math.min(end, +h.end_time);
    if (b > a && Number.isFinite(+h.value)) { acc += (b - a) * +h.value; w += b - a; }
  }
  if (!w) return null;
  const vals = heatmap.map((h) => +h.value).filter(Number.isFinite).sort((x, y) => x - y);
  const med = vals[Math.floor(vals.length / 2)] || 0;
  if (med <= 1e-6) return null;
  const rel = (acc / w) / med;
  return { rel, bonus: Math.max(-1, Math.min(2, (rel - 1) * 2)) };
}
// Peaks of the replay heatmap as clip candidates (≥1.5× median), one per
// distinct peak, a window of `ideal` seconds placed slightly before the peak
// so the build-up is kept; edges are snapped to sentences by filterByWindow.
function heatCandidates(heatmap, ideal, vidDur, max = 6) {
  if (!Array.isArray(heatmap) || heatmap.length < 5) return [];
  const vals = heatmap.map((h) => +h.value).filter(Number.isFinite).sort((x, y) => x - y);
  const med = vals[Math.floor(vals.length / 2)] || 0;
  if (med <= 1e-6) return [];
  const out = [];
  for (const h of heatmap.slice().sort((a, b) => b.value - a.value)) {
    if (+h.value < med * 1.5 || out.length >= max) break;
    const mid = (+h.start_time + +h.end_time) / 2;
    if (mid < 20) continue;                      // cold-open / intro spike
    if (out.some((o) => Math.abs(o.peak - mid) < ideal)) continue;
    const start = Math.max(0, Math.min(mid - ideal * 0.45, (vidDur || Infinity) - ideal));
    // Base on the transcript ranker's 0–10 scale: a 2× peak ≈ 7.5, a 12× peak ≈ 8.8 (+ the merge's heat bonus).
    out.push({ start, end: start + ideal, peak: mid, score: 7 + Math.min(2, Math.log2(+h.value / med) / 2), origin: `most replayed (${(+h.value / med).toFixed(1)}×)`, title: '', hook: '', why: '' });
  }
  return out;
}
function mergeHighlightCandidates(candidateArrays, numClips, minGapSeconds, heatmap = null) {
  const all = candidateArrays.flat();
  if (heatmap) for (const c of all) {
    if (c._heat != null) continue;
    const h = heatScore(heatmap, +c.start, +c.end);
    if (h) { c._heat = +h.rel.toFixed(2); c.score = (Number(c.score) || 0) + h.bonus; }
  }
  all.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const kept = [];
  for (const c of all) {
    if (kept.some(k => Math.abs(k.start - c.start) < minGapSeconds)) continue;
    kept.push(c);
    if (kept.length >= numClips) break;
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

// ─── Highlight detection prompt (migrated from v2, bilingual) ────────
// [LANG-GENERIC] Was a hard binary (lang==='en' → buildHighlightPromptEN,
// else → a fully separate, hand-authored Indonesian prompt body). Any OTHER
// detected language — Japanese, Spanish, and everything else this session's
// language-matching fix taught detectLanguage() to recognise — silently fell
// into the Indonesian branch, whose own instructions explicitly FORBID
// English output. Reported live: this is the PRIMARY clip title/hook_text/
// description/category generator (runs before rewriteHookTitlesBatch, which
// only refines candidates AND does nothing at all without a paid/BYOK hook
// key) — fixing only the refinement passes left this, the dominant path,
// still hard-forcing Indonesian for a Japanese/Spanish/etc. source. English-
// authored instructions work identically well regardless of target OUTPUT
// language (the same reasoning already proven in rewriteHookTitlesBatch), so
// this collapses the old bilingual pair into ONE body (the former EN variant,
// already a faithful 1:1 structural translation of the ID one) driven by a
// LANGUAGE directive — no separate per-language prompt is needed anymore.
// [SAFE-RETRY] `safe: true` is the variant for a retry after a model refused or
// answered unusably. The refusal analysed on 2026-10-10 most likely came from
// the CONTENT BRIEF (an ASR mishearing turned into "TOR … hide digital
// traces") plus the S-tier wording ("shocking confession / heated conflict /
// rumor / secret") with no way out. The safe variant drops the brief, states
// the benign editing task, neutralises those words and allows [].
function buildHighlightPrompt(cfg, transcriptText, videoInfo, numClips, topicSummary = '', lang = 'id', { safe = false } = {}) {
  const language = languageDisplayName(lang);
  const dur = resolveDuration(cfg.clipDuration);
  const info = videoInfo
    ? `VIDEO INFO:\n- Title: ${videoInfo.title || '-'}\n- Channel: ${videoInfo.uploader || '-'}\n- Description: ${(videoInfo.description||'').slice(0,500)}`
    : '';
  const topic = topicSummary && !safe ? `\nCONTENT BRIEF (auto-analysis):\n${topicSummary}\n` : '';
  const criteria = safe
    ? `  S (9–10): the most engaging self-contained moment — a strong story beat, a clear insight, a genuinely funny exchange.
  A (7–8): a complete thought with a clear payoff, an honest personal story, useful advice.
  B (5–6): interesting but plain.
  Avoid filler, smalltalk, dry explanation.`
    : `  S (9–10): shocking confession, controversial statement, plot-twist, quote-worthy hard punchline, heated conflict.
  A (7–8): setup→tension→payoff emotional story, counter-intuitive insight, perfectly timed funny moment.
  B (5–6): interesting insight without twist.
  Avoid filler, smalltalk, dry explanation.`;
  const patterns = safe
    ? `  • how something started, a before→after, a turning point.
  • numbers and results: money, views, age, dates, milestones.
  • a personal story, a lesson learned, a plan, honest advice.
  • a claim the speaker explains or a common belief they correct, with the reason.`
    : `  • origin story / transformation: how it started, before→after, turning point.
  • numbers and jumps: money, views, age, dates, milestones, measurable results.
  • conflict / controversy / rumor with context and payoff.
  • confession, secret, mistake, dream, future plan, personal reveal.
  • counter-intuitive claim or myth the speaker breaks, with the reason.`;
  return `You are a SENIOR VIRAL EDITOR for short-form video (TikTok/Reels/Shorts).
Task: from the transcript below, pick EXACTLY ${numClips} BEST moments to turn into viral clips.${safe ? `
This is an ordinary editing task on the creator's own published conversation: you only choose time ranges and write short titles. If no moment qualifies, return [] (an empty JSON array).` : ''}

OUTPUT LANGUAGE — MANDATORY: ${language} — title, hook_text AND description must ALL be in this language, matching the transcript's own language. Do not code-switch into another language even if the transcript itself mixes in foreign loanwords/terms — keep the surrounding sentence in ${language}.

DURATION MODE: ${dur.label}
${dur.rule}

VIRAL CRITERIA:
${criteria}

MUST EXCLUDE — never turn into a clip (even if the tone is energetic):
  • ADS / SPONSORS: sponsor reads, promo/discount codes, "use code...", "link in description", product/brand endorsements, giveaways.
  • CHANNEL SELF-PROMO: calls to subscribe/follow/like/share, "hit the bell", promo of the creator's own course/merch/membership.
  • Intro/outro greetings & filler, comment shout-outs, jingles.
  If a great moment is glued to a sponsor read, move start/end so the sponsor part is NOT included.

SELF-CONTAINED CONTEXT (so the clip stands on its own):
  • Pick moments understandable WITHOUT watching the rest of the video.
  • If the payoff refers to something set up earlier ("that", "it", "he/she"), START from the sentence that builds that context — never open on a dangling reference.

STRONG MOMENT PATTERNS (from THIS transcript — never assume names or topics it does not contain):
${patterns}

CLIP STRUCTURE (what a finished short needs): HOOK (first 3 s) → brief CONTEXT → TENSION or insight →
PAYOFF. Prefer moments that already contain all four; stop right after the payoff, never trail on.

SCORE EACH MOMENT ON FOUR AXES (0–10, be strict — most moments are 4–7):
  • hook_score: do the FIRST 3 SECONDS work on their own? A question, bold claim, surprising fact,
    strong emotion, or conflict — tied to what the clip is about. Starting on filler ("so", "um",
    "yeah", "anyway", "jadi gini", "nah"), a greeting, or mid-sentence scores ≤3.
  • flow_score: does it run as one thread and END on a complete payoff (the answer, the punchline,
    the conclusion)? Cut before the point lands, or trailing into a new topic, scores ≤3.
  • value_score: does the viewer get something — insight, emotion, a story, a laugh?
  • share_score: would people comment, argue, tag a friend, or save it ("this is so me")?

COLD-OPEN TEASER: also pick the single most gripping line INSIDE the clip (1–4 s, a whole spoken
sentence: the boldest claim, the punchline, the question everyone wants answered) that is NOT in the
first 5 seconds. It will be replayed as a 2–3 s teaser before the clip starts. Give its exact stamps as
teaser_start / teaser_end (copied from transcript line stamps, inside start_time..end_time), or omit
both if no line is strong enough on its own.

REJECT / DOWNRANK:
  • sponsor, ads, ad read, paid partnership, promo code, link in bio/description.
  • CTA: subscribe, follow, like, share, checkout, use code.
  • intro/outro, empty recap, smalltalk, filler, repetition, disclaimer.
  If a sponsor block comes before a good moment, start_time MUST begin after the sponsor ends.

TRANSCRIPT FORMAT: each line is "[start-end] text" in m:ss (h:mm:ss past one hour). start_time must be the
start of a line and end_time the end of a line — copy those stamps exactly.

CUT ACCURACY (critical):
  • start_time at the BEGINNING of the strongest opening sentence — the hook line itself, not the
    filler before it and never mid-sentence. If the strongest line is a question, start on it.
  • end_time AFTER the payoff/punchline, at the end of a complete sentence (+0.3–1s breathing room).
  • Questions MUST include their answers; setups MUST include their punchlines.

TITLE = VIRAL HOOK HEADLINE (most important). This is a scroll-stopping headline, NOT a summary.
  Use ONE of these hook formulas:
    • Myth-buster:      "Rich Doesn't Mean Smart — Here's Proof"
    • Counter-intuitive:"High IQ Isn't the Key to Wealth"
    • Curiosity gap:    "The Unexpected Factor Behind Wealth"
    • Sharp how-to:     "How to Get Rich Without Big Capital"
    • Versus/contrast:  "Wealth Distribution vs Intelligence Distribution"
  RULES: max 60 chars, Title Case, natural English, no emoji/hashtag/clip number.
  FORBIDDEN: generic ("Clip 1", "Discussion", "Funny Moment") or raw transcript quotes.

CATEGORY (pick EXACTLY ONE that fits best):
  EDUCATIONAL  → teaches facts/insights/data/research.
  INSPIRATIONAL→ motivation, mindset, growth, "you can do it too".
  CONTROVERSIAL→ challenging opinion, debunking common assumption, debate.
  STORYTELLING → personal story/experience, anecdote, plot-twist.
  ENTERTAINING → funny, absurd, light entertainment.
  RELATABLE    → "this is so me", venting, daily struggle.

DESCRIPTION = 1-sentence teaser that creates curiosity (≤110 chars), don't spoil the whole thing.
  Example: "Research shows intelligence alone isn't enough to get rich…"

HOOK_TEXT (video overlay): max 15 words, "Name: sharp quote" or provocative question.

${info}${topic}

OUTPUT JSON ARRAY ONLY (no markdown):
[{"start_time": "m:ss", "end_time": "m:ss", "category": "EDUCATIONAL", "title": "Viral Hook Headline", "hook_text": "...", "hook_score": 7, "flow_score": 8, "value_score": 7, "share_score": 6, "teaser_start": "m:ss", "teaser_end": "m:ss", "description": "curiosity teaser ≤110 chars"}]

Transcript:
${transcriptText.slice(0, 180000)}`;
}

// Normalize an AI-returned category into our controlled vocabulary.
const CATEGORIES = ['EDUCATIONAL','INSPIRATIONAL','CONTROVERSIAL','STORYTELLING','ENTERTAINING','RELATABLE'];
function normalizeCategory(raw, text = '') {
  const v = String(raw || '').trim().toUpperCase();
  if (CATEGORIES.includes(v)) return v;
  // fuzzy match (e.g. "EDUKASI", "INSPIRASI", "CONTROVERSY")
  const map = { EDUKAS:'EDUCATIONAL', EDUCA:'EDUCATIONAL', INSPIR:'INSPIRATIONAL', MOTIV:'INSPIRATIONAL',
    CONTRO:'CONTROVERSIAL', KONTRO:'CONTROVERSIAL', DEBAT:'CONTROVERSIAL', STORY:'STORYTELLING', CERITA:'STORYTELLING',
    ENTERTAIN:'ENTERTAINING', HIBUR:'ENTERTAINING', LUCU:'ENTERTAINING', RELAT:'RELATABLE', CURHAT:'RELATABLE' };
  for (const k in map) if (v.startsWith(k)) return map[k];
  // heuristic from text
  const t = (text || '').toLowerCase();
  if (/\b(mitos|sebenarnya|salah|bantah|padahal|justru)\b/.test(t)) return 'CONTROVERSIAL';
  if (/\b(cara|tips|kenapa|sebab|karena|data|riset|fakta)\b/.test(t)) return 'EDUCATIONAL';
  if (/\b(bisa|sukses|mimpi|berani|mulai|berubah)\b/.test(t)) return 'INSPIRATIONAL';
  return 'EDUCATIONAL';
}

// Sanitize/parse JSON returned by the model
// [BAD-AI-OUTPUT] A model can answer HTTP 200 with something that is not an
// answer: a refusal ("I'm sorry, but I can't help with that." — gpt-oss-20b on
// a benign Indonesian talk-show chunk, real run 2026-10-10), an empty body, a
// JSON array cut off by max_tokens, or prose. That belongs to the (model ×
// prompt) pair, not to the key's health: it must not mark the provider dead or
// trip the rotation flag, and the same call should move to another model.
// The message deliberately avoids quota/413 words so isQuotaError,
// isRequestTooLarge and isModelRotatable all stay false for it.
const REFUSAL_RE = /^\s*(?:I['’]m sorry|I am sorry|Sorry[,.]|I can(?:not|['’]t) (?:help|comply|assist|provide|do)|I won['’]t|As an AI\b|Maaf,? (?:saya|aku) (?:tidak|nggak|gak) (?:bisa|dapat))/i;
function badAiOutput(kind, raw, model) {
  const e = new Error(`AI_OUTPUT_${String(kind).toUpperCase()}${model ? ` (${model})` : ''}: ${String(raw || '').replace(/\s+/g, ' ').slice(0, 80)}`);
  e.code = 'BAD_AI_OUTPUT'; e.kind = kind; e.model = model || null;
  return e;
}
function isBadAiOutput(e) { return !!e && e.code === 'BAD_AI_OUTPUT'; }
// Must also sound like an assistant declining — "I Won't Go Back To My 9-5 Job"
// and "Maaf, Aku Tidak Bisa Lupakan Dia" are titles, not refusals.
const REFUSAL_ASSIST_RE = /\b(?:help|assist|comply|provide|fulfil+|request|with that|as an ai|language model|policy|guidelines|permintaan|membantu|memenuhi)\b/i;
function looksLikeRefusal(s) {
  const t = String(s || '').trim();
  return t.length > 0 && t.length < 400 && REFUSAL_RE.test(t) && REFUSAL_ASSIST_RE.test(t) && !/[\[{]/.test(t);
}

function parseJsonLoose(s) {
  // <think> blocks (a reasoning model that returns its thinking inline) can carry "[".
  let t = String(s ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!t) throw badAiOutput('empty', s);
  const i = t.indexOf('[');
  if (i < 0) {
    if (looksLikeRefusal(t)) throw badAiOutput('refusal', t);
    try { return JSON.parse(t); } catch { throw badAiOutput('not_json', t); }
  }
  const j = t.lastIndexOf(']');
  if (j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* maybe truncated inside */ } }
  // [SALVAGE] cut off by max_tokens: keep every complete object before the cut.
  const body = t.slice(i);
  for (let k = body.lastIndexOf('}'); k > 0; k = body.lastIndexOf('}', k - 1)) {
    try {
      const v = JSON.parse(body.slice(0, k + 1) + ']');
      if (Array.isArray(v) && v.length) { Object.defineProperty(v, 'salvaged', { value: true }); return v; }
    } catch { /* keep backing off */ }
  }
  if (looksLikeRefusal(t)) throw badAiOutput('refusal', t);
  throw badAiOutput('truncated', t);
}
// Validator for aiComplete({ accept }): throws BAD_AI_OUTPUT unless the text
// parses to a JSON array.
function acceptJsonArray(raw) {
  const v = parseJsonLoose(raw);
  if (!Array.isArray(v)) throw badAiOutput('not_json', raw);
}
function toSeconds(tc) {
  if (typeof tc === 'number') return Number.isFinite(tc) ? tc : 0;
  // Accepts H:MM:SS(.f|,ms), M:SS(.f) and plain seconds. Hours are OPTIONAL:
  // the AI often answers "0:15" (M:S) for short videos — the old H:M:S-only
  // regex silently returned 0 for those, so every clip collapsed to 0s and
  // the duration filter dropped them all ("Tidak ada clip valid…").
  const m = /^\s*(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?\s*$/.exec(String(tc));
  // Colon-less fallback ("10.5", "10,5"). The comma swap matters: the colon
  // branch above already accepts `[.,]` as the decimal mark, but bare
  // `Number("10,5")` is NaN → 0. TIMECODE_RE (manual segments) accepts a comma
  // decimal, so without this a user typing the Indonesian "10,5" in the manual
  // start field passed validation and then silently became "start at 0s" — the
  // precise silent-zero failure that validation exists to prevent.
  if (!m) { const n = Number(String(tc).trim().replace(',', '.')); return Number.isFinite(n) ? n : 0; }
  // Fraction part is decimal digits ("12.08" → .08s; SRT "12,080" → .080s).
  const frac = m[4] ? parseFloat('0.' + m[4]) : 0;
  return (+m[1] || 0)*3600 + (+m[2])*60 + (+m[3]) + frac;
}

// ─── 2-pass: rewrite each clip title into a TRENDING viral hook ────
// Builds a headline from the clip's MEANING (idea/insight/claim), using proven
// hook formulas — NOT a paraphrase of a transcript line. Context-aware (uses
// video topic + clip category) so titles feel like real trending Shorts titles.
const HOOK_STYLE_BY_CAT = {
  CONTROVERSIAL: 'patahkan anggapan umum / opini menantang (mis. "Mitos X = Y, Terbantahkan")',
  EDUCATIONAL:   'insight counter-intuitive / fakta mengejutkan (mis. "Kenapa X Bukan Kunci Y")',
  INSPIRATIONAL: 'mindset / "kamu juga bisa" tanpa lebay (mis. "Cara Cerdas X Tanpa Y")',
  STORYTELLING:  'teaser plot-twist / pengakuan (mis. "Pengakuan X yang Bikin Hening")',
  ENTERTAINING:  'absurd / lucu yang bikin penasaran',
  RELATABLE:     '"ini relatable banget" / struggle yang dikenali banyak orang',
};
// Shared post-processor for API (Gemini/Groq) hook titles. Preserves whole
// phrases — the old .slice(0, 60) truncation cut mid-word ("Enggak Si…") and
// looked awful. Now: strip labels/quotes, drop a trailing dangling connector,
// hard-cap at maxWords only if the model went overboard.
function cleanApiTitle(raw, lang = 'id', maxWords = 6) {
  let t = String(raw || '').trim();
  if (looksLikeRefusal(t)) return null;   // [BAD-AI-OUTPUT] never a title
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const labelOnly = /^(judul|tajuk|title|hook|output|jawaban|answer)[^\n:]{0,20}:?\s*$/i;
  t = (lines.find(l => !labelOnly.test(l)) || lines[0] || '').trim();
  t = t.replace(/^[\s"'“”「」『』\-–—•*_]+|[\s"'“”「」『』\-–—•*_]+$/g, '');
  t = t.replace(/^(judul|tajuk|title|hook|jawaban|output|answer)[^\n:]{0,20}:\s*/i, '');
  t = t.replace(/^\d+[\.\)]\s*/, '');
  t = t.replace(/[\s:\-–—,;]+$/, '');
  if (!t || t.length < 6) return null;
  if (/^(clip|klip|video|momen|moment|part)\s*#?\d/i.test(t)) return null;
  // Detect model regurgitating input (e.g. "Itu Suami Aku Ngingetin Aku Itu
  // Suami Aku Ngingetin Aku") — reject if any 4-word block repeats.
  const wordsRaw = t.split(/\s+/).filter(Boolean);
  if (wordsRaw.length >= 8) {
    const first4 = wordsRaw.slice(0, 4).map(w => w.toLowerCase()).join(' ');
    const rest   = wordsRaw.slice(4).map(w => w.toLowerCase()).join(' ');
    if (rest.includes(first4)) return null;
  }
  if (wordsRaw.length > maxWords) {
    const cut = wordsRaw.slice(0, maxWords);
    const danglingID = /^(yang|dan|atau|tapi|karena|untuk|dengan|di|ke|dari|buat|sama|kalau|biar|jadi|tuh|sih)$/i;
    const danglingMS = /^(yang|dan|atau|tapi|kerana|untuk|dengan|di|ke|dari|buat|kalau|biar|jadi)$/i;
    const danglingEN = /^(the|and|or|but|for|with|of|to|from|a|an|in|on|at|by|as)$/i;
    const danglingES = /^(el|la|los|las|de|del|y|o|pero|para|con|en|a|un|una|que|por)$/i;
    // [LANG-GENERIC] Only the languages with a hand-tuned list above get one —
    // any other detected language (ja, ko, …) falls back to danglingID, same
    // as before this list existed: a mild truncation-quality nit (an
    // occasional trailing connector word when a title is cut to maxWords),
    // never a wrong-language bug, since the LANGUAGE the text is WRITTEN in
    // is controlled upstream by the prompt (languageDisplayName), not here.
    const dangling = lang === 'en' ? danglingEN : lang === 'ms' ? danglingMS : lang === 'es' ? danglingES : danglingID;
    while (cut.length > 3 && dangling.test(cut[cut.length - 1])) cut.pop();
    t = cut.join(' ').replace(/[\s,;:\-–—]+$/, '');
  }
  return t.trim();
}

// [HOOK-PROVIDER] cfg.hookProvider ('groq' default | 'gemini',
// main.js) is a HOOK-TITLE-SPECIFIC provider preference, separate from the
// GENERAL cfg.aiProvider setting (topic summary, transcript rewrite, etc —
// Settings' "AI Provider" dropdown). Before this fix, effectiveAI() only
// ever read cfg.aiProvider; hookProvider was consulted nowhere except the
// 'local' special-case below, so its 'groq'/'gemini' values did nothing —
// a user on the shipped hookProvider:'groq' default whose cfg ALSO happened
// to carry a (possibly stale/invalid) geminiKey got Gemini attempted for
// EVERY hook title regardless, since aiProvider:'' auto-detection picks
// Gemini before Groq purely on key presence. Confirmed via a real session
// with exactly that cfg shape (hookProvider:'groq' + valid groqKey +
// dubious geminiKey) where every clip's title shipped in raw-extraction
// quality — the AI prompt's grounded-paraphrase style never produces that.
//
// Fix: when aiProvider is unset (the "auto" default), let hookProvider pick
// the provider for hook titles specifically. An EXPLICIT general aiProvider
// choice still wins everywhere (including hooks) — a user who deliberately
// set aiProvider to 'gemini'/'custom'/etc for all features keeps consistent
// behavior; only the ambiguous "nothing chosen" case defers to hookProvider.
function resolveHookProviderCfg(cfg) {
  // [PAID-TIER] Any real provider is selectable for hooks, not just the two
  // free-tier ones. 'auto'/'' means "use whatever the main pipeline provider
  // is" — which is what a paid user expects after configuring one good key.
  const HOOK_KEY_FIELD = {
    groq: 'groqKey', gemini: 'geminiKey', openrouter: 'openrouterKey',
    openai: 'openaiKey', anthropic: 'anthropicKey', sumopod: 'sumopodKey',
  };
  const field = HOOK_KEY_FIELD[cfg?.hookProvider];
  // Only override when that provider actually HAS a key. hookProvider defaults
  // to 'groq' for every install, so without this check a user whose only key is
  // a paid OpenAI/OpenRouter one got their hook titles forced onto a keyless
  // Groq config — an instant "API key kosong" throw, then silent degradation to
  // the free chain, on the one stage they most wanted the paid model for.
  if (!cfg?.aiProvider && field && cfg[field]) {
    // [GROQ-ROTATION] share the run's dead/rotation map with the copy, so a
    // daily limit learned by the highlight step is not re-learned per title batch.
    if (!cfg.__aiDeadUntil) Object.defineProperty(cfg, '__aiDeadUntil', { value: {}, enumerable: false, configurable: true });
    const copy = { ...cfg, aiProvider: cfg.hookProvider };
    Object.defineProperty(copy, '__aiDeadUntil', { value: cfg.__aiDeadUntil, enumerable: false, configurable: true });
    return copy;
  }
  return cfg;
}

// Rewrite titles in small batches so five clips cost one request, not five.
// Highlight detection already produced candidate titles; this pass only makes
// them punchier, so a compact transcript excerpt per clip is sufficient.
async function rewriteHookTitlesBatch(cfg, clips, clipTexts, ytInfo, topicSummary = '', onLog, lang = 'id') {
  const hookCfg = resolveHookProviderCfg(cfg);
  const count = Array.isArray(clips) ? clips.length : 0;
  // [AIDA-FREE] The old gate demanded a PAID key, which locked the
  // AIDA title writer to a PAID key. Every other AI stage in this pipeline —
  // the topic brief, clip detection, even the language-drift repair that
  // rewrites these very titles — gates on aiAvailable(), which accepts the free
  // provider chain. So a free-tier user got AI-CHOSEN clips with titles pulled
  // straight out of the transcript ("Orang Tahu Ya Kita Enggak Harus Terlalu
  // Yap Tentang Kita Nih"), and that raw phrase became the output FILENAME.
  // Reported exactly that way. The grounding gate in the caller was already
  // written for this path — its comment says "defensive for a no-key path;
  // current no-key generation already returns null immediately", i.e. it was
  // dead code waiting for this gate to open. Cost is one batched request per 12
  // clips, far less than the stages already allowed to use the free chain, and
  // the circuit breaker skips a dead provider for the rest of the run.
  if (!count || !aiAvailable(hookCfg)) return Array(count).fill(null);
  // [NO-TEXT-TITLE] Nothing spoken in any clip → nothing to title; skip the call.
  if (!(clipTexts || []).some((t) => _contentWords(t).length >= 2)) return Array(count).fill(null);

  const output = Array(count).fill(null);
  const batchSize = 12;
  for (let offset = 0; offset < count; offset += batchSize) {
    const batch = clips.slice(offset, offset + batchSize).map((clip, index) => ({
      id: offset + index + 1,
      current_title: String(clip.title || clip.hook || '').slice(0, 100),
      category: clip.category || 'EDUCATIONAL',
      transcript: String(clipTexts[offset + index] || '').replace(/\s+/g, ' ').trim().slice(0, 520),
    }));
    // [LANG-GENERIC] Was a 3-way ternary (en/ms/else-Indonesian) — any OTHER
    // detected language (Japanese, Spanish, …) silently got Indonesian-
    // language titles regardless of the source. languageDisplayName()
    // keeps the same id/ms/en labels and resolves everything else
    // generically, so this prompt (already written to accept ANY language
    // name in its LANGUAGE: directive) now actually reaches languages
    // beyond the original three.
    const language = languageDisplayName(lang);
    // [HOOK-AIDA] Titles are written with the AIDA lens (Attention → Interest →
    // Desire → Action) and one of a fixed set of proven short-form hook angles,
    // chosen per clip to fit that clip's own moment. The model picks the angle;
    // it is NOT allowed to fabricate — every hook must stand on words actually
    // in that clip's transcript. Output shape is unchanged ([{id,title}]) so
    // downstream parsing/dedup is untouched — the richness is all in the prompt.
    // [HOOK-AIDA-V2] Two outputs per clip, like the strongest competitor
    // output we studied: a TITLE (headline, also the file name) and a separate
    // on-video HOOK (2–4 words, capitals, usually a question or exclamation,
    // built on the clip's one subject — "KENAPA GILANG GAGAL VISA?",
    // "BAHAYA NAHAN PIPIS!", "MESSI ATAU RONALDO?"). The hook is no longer the
    // title chopped to fit.
    const prompt = `You package short-form video clips (TikTok/Reels/Shorts). For EACH clip write:
1. "title": a scroll-stopping headline using the AIDA principle — the first 2-3 words grab ATTENTION, the rest builds INTEREST and DESIRE (a payoff is inside). 5-10 words. Lead with the clip's concrete subject (a name, thing, number). May end with "?" or "!".
2. "hook": the text burned on the video for its first 3 seconds. 2-4 words, ALL CAPS, built on the SAME subject. Prefer a question ("KENAPA X?", "X ATAU Y?", "X DI Y?") or an exclamation ("BAHAYA X!", "3 MENIT PERTAMA!"). It must be a COMPLETE phrase — never end on a connector (di, ke, dan, yang, of, the, and).
3. "category": one of comedy, dramatic, inspirational, controversial, educational.
4. "virality": 1-10, how likely this exact moment stops a scroll.

LANGUAGE: ${language} — title and hook in this language.

Pick the strongest angle per clip: CURIOSITY GAP, CONTROVERSIAL (never hateful), HONEST CLICKBAIT (the clip delivers it), MYTH-BUSTER, COUNTER-INTUITIVE, VERSUS, STORY TEASE.

HARD RULES:
- One object for every id.
- GROUNDED: only facts, names and claims present in THAT clip's transcript. Invent nothing.
- The title is never a flat summary or a raw transcript quote.
- No emoji, hashtag, quotation marks or clip numbers.
- Output JSON array ONLY: [{"id":1,"title":"...","hook":"...","category":"...","virality":7}]
${topicSummary ? `\nVIDEO CONTEXT:\n${topicSummary.slice(0, 700)}\n` : ''}
CLIPS:
${JSON.stringify(batch)}`;
    try {
      const raw = await aiComplete(hookCfg, prompt, {
        system: 'You are an elite viral short-form editor who writes AIDA-driven hook titles. Return valid JSON only.',
        // reasoning models spend part of max_tokens thinking; 48/title truncated the JSON
        maxTokens: Math.max(isGroqReasoningModel(effectiveAI(hookCfg).model) ? 600 : 260, batch.length * 96),
        temperature: 0.75,
        json: isGemini(hookCfg),
        onLog, accept: acceptJsonArray, taskClass: 'title',   // [BAD-AI-OUTPUT]
      });
      const rows = parseJsonLoose(raw);
      for (const row of rows) {
        const index = Number(row?.id) - 1;
        if (index >= offset && index < offset + batch.length) {
          // maxWords=9 matches the AIDA prompt's 4-9 word range so a longer
          // hook (e.g. a VERSUS/KONTRAS angle) isn't chopped mid-thought.
          const title = cleanApiTitle(row.title, lang, 10);
          // A plain string keeps old callers working; the hook rides along.
          if (title) {
            output[index] = { title, hookText: require('./clip-hook').normalizeHookText(row.hook),
              virality: Math.max(1, Math.min(10, Math.round(+row.virality || 0))) || null,
              category: String(row.category || '').toLowerCase() };
          }
        }
      }
    } catch (e) {
      onLog?.(`⚠ Batch judul gagal (${e.message}) — memakai judul dari deteksi awal`, 'yellow');
    }
  }
  return output;
}

async function rewriteHookTitle(cfg, clipText, hintHook, category, ytInfo, topicSummary = '', onLog, lang = 'id') {
  // Hook titles never load a local generative model. With a real cloud key we
  // preserve the provider-specific rewrite; without one, return immediately so
  // the caller uses the transcript-grounded localHookTitle() path. This keeps
  // the no-API Windows path fast, deterministic, and free of native model RAM.
  const hookCfg = resolveHookProviderCfg(cfg);
  const eff = effectiveAI(hookCfg);
  const hasCloudKey = eff.provider !== 'free' && !!eff.apiKey;
  if (!hasCloudKey) return null;
  if (!aiAvailable(hookCfg)) return null;
  if (lang === 'en') return rewriteHookTitleEN(hookCfg, clipText, hintHook, category, ytInfo, topicSummary, onLog);
  if (lang === 'ms') return rewriteHookTitleMS(hookCfg, clipText, hintHook, category, ytInfo, topicSummary, onLog);
  const topic = ytInfo ? `TOPIK VIDEO: ${ytInfo.title || ''} — ${ytInfo.uploader || ''}` : '';
  const brief = topicSummary ? `\nBRIEF KONTEN:\n${topicSummary}\n` : '';
  const styleHint = HOOK_STYLE_BY_CAT[String(category || '').toUpperCase()] || 'curiosity gap kuat';
  // Take a tight 10-15s window (~350 chars) — the emotional peak, not the
  // whole clip. Prevents the model from drowning in transcript noise and
  // forces it to hook from the most charged phrase.
  const snippet = (clipText || '').replace(/\s+/g, ' ').trim().slice(0, 380);
  const prompt = `Tulis SATU hook TikTok/Reels Indonesia — 3-5 kata saja — dari momen di bawah.

${topic}${brief}${hintHook ? `\nRASA MOMEN INI: ${hintHook}\n` : ''}
MOMEN (10-15 detik):
"""${snippet}"""

FRAMING AIDA — hook harus punya salah satu:
• ATTENTION: kejutan / kontradiksi ("Ternyata Gue Salah")
• INTEREST: rahasia / bocoran ("Rahasia yang Disembunyiin")
• DESIRE: keinginan mendalam pemirsa ("Cara Cepat Bahagia")
• ACTION: dorongan action / regret ("Jangan Ulang Kesalahan Ini")

RASA — WAJIB HUMANIS + EMOSIONAL:
- Bicara ke SATU orang (lo, kamu, gue), jangan formal
- Sentuh emosi: takut, marah, penasaran, envy, bangga, kagum, sedih, kaget
- Kalimat manusia — bukan kutipan transkrip, bukan iklan, bukan judul artikel
- Kalau bisa pakai kata kerja aktif ("Bikin", "Ngerusak", "Nyembuhin", "Ngubah")

7 CONTOH HOOK 3-5 KATA (tiru VIBE emosinya, jangan copy isinya):
- Gue Salah Selama Ini
- Ini Bikin Gue Nangis
- Rahasia Orang Kaya Sebenarnya
- Jangan Lakuin Kesalahan Ini
- Ternyata Semua Bohong
- Berhenti Kejar Uang Dulu
- Yang Nggak Ada Yang Ngasih Tau

HARAM:
- Lebih dari 5 kata
- Tanda kutip, emoji, hashtag, titik-dua di tengah, angka urutan
- "Video/Klip/Momen/Episode" — bahas ISInya, bukan wadahnya
- Bahasa kaku ("Individu", "Fenomena", "Perlu diketahui")
- Ngutip transcript mentah — paraphrase malas

Output: SATU BARIS hook 3-5 kata, tanpa label, tanpa penjelasan.`;
  try {
    // MUST be hookCfg, not cfg — this is the path resolveHookProviderCfg exists
    // for. The EN/MS variants receive hookCfg as their own `cfg` param; this
    // inline Indonesian path (the app's default language) is the one place the
    // resolution can be silently dropped, which is exactly what it did.
    let txt = await aiComplete(hookCfg, prompt, {
      system: 'Kamu copywriter viral TikTok. Bicara humanis + emosional. Output HANYA satu hook 3-5 kata bahasa Indonesia gaul. TIDAK ADA penjelasan.',
      maxTokens: 40, temperature: 0.85, onLog,
    });
    return cleanApiTitle(txt, 'id');
  } catch (e) {
    onLog?.(`⚠ Hook AI gagal (${e.message}) — memakai judul lokal`, 'yellow');
    return null;
  }
}

// English variant of rewriteHookTitle. Same constraints, English copy +
// hook formulas the AI is told to pick from.
async function rewriteHookTitleEN(cfg, clipText, hintHook, category, ytInfo, topicSummary = '', onLog) {
  const topic = ytInfo ? `VIDEO TOPIC: ${ytInfo.title || ''} — ${ytInfo.uploader || ''}` : '';
  const brief = topicSummary ? `\nCONTENT BRIEF:\n${topicSummary}\n` : '';
  const styleHintEN = {
    CONTROVERSIAL: 'debunk a common assumption / challenging opinion (e.g. "Rich Doesn\'t Mean Smart — Here\'s Proof")',
    EDUCATIONAL:   'counter-intuitive insight / surprising fact (e.g. "Why X Isn\'t the Key to Y")',
    INSPIRATIONAL: 'mindset / "you can do it too" without being cheesy (e.g. "Smart Way to X Without Y")',
    STORYTELLING:  'plot-twist teaser / confession (e.g. "The Confession That Silenced the Studio")',
    ENTERTAINING:  'absurd / funny that creates curiosity',
    RELATABLE:     '"so relatable" / struggle many can recognize',
  }[String(category || '').toUpperCase()] || 'strong curiosity gap';
  const snippetEN = (clipText || '').replace(/\s+/g, ' ').trim().slice(0, 380);
  const prompt = `Write ONE TikTok/Reels hook — 3-5 words only — for the moment below.

${topic}${brief}${hintHook ? `\nMOOD OF THE MOMENT: ${hintHook}\n` : ''}
MOMENT (10-15 seconds):
"""${snippetEN}"""

AIDA FRAMING — hook must hit ONE of:
• ATTENTION: surprise / contradiction ("Turns Out I Was Wrong")
• INTEREST: secret / behind-the-scenes ("The Secret They Hide")
• DESIRE: viewer's deep want ("How To Feel Alive")
• ACTION: regret / warning ("Don't Repeat My Mistake")

VOICE — MUST BE HUMAN + EMOTIONAL:
- Talk to ONE person (you, I) — never formal or academic
- Hit an emotion: fear, anger, envy, awe, sadness, curiosity, pride
- Sound like a real person — not a headline, not an ad, not a quote
- Prefer active verbs ("Ruined", "Freed", "Broke", "Saved")

7 EXAMPLES OF 3-5 WORD HOOKS (mimic the EMOTIONAL VIBE, don't copy content):
- I Was Wrong About Money
- This Broke Me
- The Real Rich Secret
- Don't Do What I Did
- Turns Out Everyone Lied
- Stop Chasing Money First
- Nobody Warned Me About This

FORBIDDEN:
- More than 5 words
- Quotes, emojis, hashtags, mid-sentence colons, ordinal numbers
- "Video/Clip/Moment/Episode" — talk about the CONTENT, not the container
- Formal words ("Individual", "Phenomenon", "It should be noted")
- Quoting the transcript raw — lift the MEANING

Output: ONE LINE hook 3-5 words, no label, no explanation.`;
  try {
    let txt = await aiComplete(cfg, prompt, {
      system: 'You are a viral TikTok copywriter. Speak human + emotional. Output ONLY one 3-5 word hook. NO explanation.',
      maxTokens: 40, temperature: 0.85, onLog,
    });
    return cleanApiTitle(txt, 'en');
  } catch (e) {
    onLog?.(`⚠ Hook AI failed (${e.message}) — using local title`, 'yellow');
    return null;
  }
}

// Malay (Malaysia) variant of rewriteHookTitle. Same structure, Malay copy.
async function rewriteHookTitleMS(cfg, clipText, hintHook, category, ytInfo, topicSummary = '', onLog) {
  const topic = ytInfo ? `TOPIK VIDEO: ${ytInfo.title || ''} — ${ytInfo.uploader || ''}` : '';
  const brief = topicSummary ? `\nRINGKASAN KANDUNGAN:\n${topicSummary}\n` : '';
  const styleHintMS = {
    CONTROVERSIAL: 'patahkan tanggapan biasa / pendapat mencabar (cth. "Kaya Tak Bermakna Pandai — Ini Buktinya")',
    EDUCATIONAL:   'insight tak terjangka / fakta mengejutkan (cth. "Kenapa X Bukan Kunci Y")',
    INSPIRATIONAL: 'mindset / "kau pun boleh" tanpa cheesy (cth. "Cara Bijak X Tanpa Y")',
    STORYTELLING:  'teaser plot-twist / pengakuan (cth. "Pengakuan Yang Buat Studio Sunyi")',
    ENTERTAINING:  'absurd / lawak yang cetuskan rasa ingin tahu',
    RELATABLE:     '"relate sangat" / cerita yang ramai kenal',
  }[String(category || '').toUpperCase()] || 'curiosity gap yang kuat';
  const snippetMS = (clipText || '').replace(/\s+/g, ' ').trim().slice(0, 380);
  const prompt = `Tulis SATU hook TikTok/Reels Malaysia — 3-5 patah perkataan sahaja — dari momen di bawah.

${topic}${brief}${hintHook ? `\nRASA MOMEN INI: ${hintHook}\n` : ''}
MOMEN (10-15 saat):
"""${snippetMS}"""

FRAMING AIDA — hook mesti ada salah satu:
• ATTENTION: kejutan / kontradiksi ("Rupanya Aku Salah")
• INTEREST: rahsia / bocoran ("Rahsia Yang Disorok")
• DESIRE: keinginan dalam penonton ("Cara Cepat Bahagia")
• ACTION: dorongan action / kesal ("Jangan Ulang Kesilapan Ni")

RASA — WAJIB HUMANIS + EMOSIONAL:
- Cakap dengan SATU orang (kau, aku), jangan formal
- Sentuh emosi: takut, marah, ingin tahu, cemburu, bangga, kagum, sedih, terkejut
- Ayat manusia — bukan petikan transkrip, bukan iklan, bukan tajuk artikel
- Guna kata kerja aktif ("Buat", "Rosakkan", "Sembuhkan", "Ubah")

7 CONTOH HOOK 3-5 PATAH (tiru VIBE emosinya, JANGAN salin isinya):
- Aku Salah Selama Ini
- Ni Buat Aku Nangis
- Rahsia Orang Kaya Sebenarnya
- Jangan Buat Kesilapan Ni
- Rupanya Semua Tipu
- Berhenti Kejar Duit Dulu
- Tiada Sesiapa Bagitau Ni

HARAM:
- Lebih 5 patah perkataan
- Tanda petik, emoji, hashtag, titik bertindih di tengah, nombor urutan
- "Video/Klip/Momen/Episod" — bahas ISInya, bukan bekasnya
- Bahasa kaku ("Individu", "Fenomena", "Perlu diketahui")
- BUKAN Indonesia (lo/gua/nggak). Bahasa Melayu Malaysia (kau/aku/tak/macam)
- Salin transkrip mentah — angkat MAKSUDNYA

Output: SATU BARIS hook 3-5 patah, tanpa label, tanpa penjelasan.`;
  try {
    let txt = await aiComplete(cfg, prompt, {
      system: 'Awak copywriter viral TikTok. Cakap humanis + emosional. Output HANYA satu hook 3-5 patah Bahasa Melayu Malaysia. TIADA penjelasan.',
      maxTokens: 40, temperature: 0.85, onLog,
    });
    return cleanApiTitle(txt, 'ms');
  } catch (e) {
    onLog?.(`⚠ Hook AI gagal (${e.message}) — guna tajuk lokal`, 'yellow');
    return null;
  }
}

// Grammar/connector words (as opposed to disfluency FILLERS above) — fine to
// keep for a FULL sentence, but a 3-5 word hook needs to shed them so what's
// left is the actual content, not "kalau...bahwa...dan...adalah...untuk".
const STOP_ID = new Set(['yang','itu','ini','untuk','dengan','dari','ke','di','dan','atau','kalau','jika','karena','bahwa','adalah','akan','sudah','juga','pada','ada','pun','sebuah','suatu','tuh','nya','aku','kita','kamu','dia','saya']);
const STOP_EN = new Set(['the','a','an','of','to','in','that','is','was','for','on','with','as','at','this','it','be','are','were','and','or','but','so','then','than','have','has','had','they','their','there','from','i','you','we']);

// Hot triggers — verbs/nouns that mark "this sentence has hook potential".
// Module scope (not local to localHookTitle) so condenseToHookPhrase can
// share the exact same trigger list for its window-centering logic below.
const HOT_ID_RE = /\b(jangan|harus|rahasia|kesalahan|bangkrut|nyesel|takut|nangis|kaya|miskin|uang|cinta|ditipu|bohong|jujur|ngaku|kenapa|gimana|trik|cara|bukti|tapi|namun|justru|ternyata|sebenarnya|padahal|salah|mitos|bantah|gila|parah|shock|kaget|marah|berani|toxic|sumpah|fakta|riset|data)\b/i;
const HOT_EN_RE = /\b(don't|must|secret|mistake|broke|regret|afraid|cry|rich|poor|money|love|lied|honest|admit|why|how|trick|way|proof|but|however|actually|turns out|surprisingly|though|wrong|myth|debunk|crazy|insane|shocked|angry|brave|toxic|swear|fact|research|data|never|always|nobody)\b/i;
// [NO-HARDCODE] Was seeded with one benchmark video's names (onlyfans, mr beast,
// kim, kardashian) plus "pa" (matches casual Indonesian) and "brand" (rewarded
// sponsor talk). Generic hook words only.
const LOKA_HOT_RE = /\b(viral|followers?|overnight|scandal|celebrity|fame|terkenal|secret|hack|quote|dream|marriage|creator|mencuri|curi|skandal|kontroversi)\b/i;
// [PROMO-ID] See the Indonesian alternatives at the end of this pattern.
const PROMO_SEGMENT_RE = /\b(disponsori|sponsor|sponsored|ad\s*read|paid\s*partnership|brought\s+to\s+you\s+by|episode\s+(is\s+)?brought\s+to\s+you|kode\s*promo|promo\s*code|link\s*(di|in)\s*(deskripsi|description|bio)|subscribe|subrek|follow\s*(channel|akun)?|like\s*(dan|and)\s*subscribe|gunakan\s*kode|use\s*code|checkout|check\s*out|head\s+to\s+[\w.-]+\.(com|co|io)|save\s+(some\s+)?money|shopback|cashback|flash\s*sale|voucher|kode\s*(?:voucher|referral)|promo\s*\d+|diskon\s*\d+|potongan\s*harga|grand\s*pri[cz]e|gratis\s*ongkir|download\s+(?:aplikasi|app)(?:nya)?|klik\s+link|link\s*(?:nya\s+)?(?:ada\s+)?di\s*(?:bawah|bio)|dipromoin|endorse(?:ment)?|paid\s*promote)\b/i;
const PROMO_START_RE = /\b(this\s+)?(episode|video|show)\s+(is\s+)?(brought|presented|sponsored)\s+(to\s+you\s+)?by\b|\bbrought\s+to\s+you\s+by\b|\bpaid\s+partnership\b/i;
const PROMO_CTA_RE = /\b(use|gunakan|pakai)\s+(the\s+)?(promo\s+)?code\b|\b(kode|code)\s+[a-z0-9_-]+\b|\bhead\s+to\s+[\w.-]+\.(com|co|io)\b|\blink\s+(in|di)\s+(the\s+)?(description|bio|deskripsi)\b|\bsave\s+(some\s+)?money\b|\bdownload\s+(?:aplikasi|app)(?:nya)?\b|\bklik\s+link\b|\bcek\s+di\s+shopback\b/i;

// Sponsor reads are spans, not isolated keywords. A 60-second candidate can
// begin on legitimate conversation and still pull a full ad into its tail, so
// keyword penalties on the 15-20s scoring window are insufficient. Detect the
// handoff, carry the quarantine through the CTA/brand sign-off, then vet the
// FINAL clip range against these spans.
const PROMO_DENSITY_RE = /\b(?:shopback|cashback|flash\s*sale|kode\s*(?:promo|voucher|referral|diskon)|promo\s*code|discount\s*code|use\s+(?:my\s+|the\s+)?code|gunakan\s+kode|pakai\s+kode|promo\s*\d+|diskon\s*\d+|potongan\s*harga|grand\s*pri[cz]e|gratis\s*ongkir|download\s+(?:aplikasi|app)(?:nya)?|link\s*(?:nya\s+)?(?:ada\s+)?di\s*(?:bawah|bio|deskripsi)|link\s+in\s+(?:the\s+)?(?:bio|description)|dipromoin|endorse(?:ment)?|paid\s*(?:promote|partnership)|disponsori|sponsored\s+by|brought\s+to\s+you\s+by)\b/i;
const PROMO_DENSITY_MAX_SEC = 180;
function detectPromoRanges(cues) {
  const ranges = [];
  for (let i = 0; i < cues.length; i++) {
    const text = String(cues[i]?.text || '');
    if (!PROMO_START_RE.test(text)) continue;
    const start = Number(cues[i].start) || 0;
    let end = Number(cues[i].end) || start;
    let sawCta = PROMO_CTA_RE.test(text);
    let lastCommercialEnd = end;
    for (let j = i + 1; j < cues.length; j++) {
      const next = String(cues[j]?.text || '');
      const nextEnd = Number(cues[j].end) || end;
      const commercial = PROMO_SEGMENT_RE.test(next) || PROMO_CTA_RE.test(next);
      if (commercial) {
        sawCta = sawCta || PROMO_CTA_RE.test(next);
        lastCommercialEnd = nextEnd;
      }
      // Once a CTA has happened, the first real conversational question marks
      // the return to content. Keep brand sign-off cues between CTA and it.
      if (sawCta && /\?/.test(next) && !commercial) break;
      if (nextEnd - start > 150) break;
      end = nextEnd;
      if (!sawCta && nextEnd - lastCommercialEnd > 90) break;
    }
    ranges.push({ start, end: Math.max(end, lastCommercialEnd), kind: 'promo' });
  }
  // [PROMO-DENSITY] A sponsor read woven into the conversation has no
  // "brought to you by" opener — measured on a real ShopBack read
  // (socl-2026-09-13T15-15-21, 11:25–13:50 and ~29:50–31:50): "endorse", "pakai
  // aplikasi ShopBack", "dapat cashback" every few seconds. The AI picked it as
  // two of three clips. Three or more promo hits with ≤45 s between them form
  // a range; a cluster overlapping an opener-based range above is already covered.
  // Only words that mean a sponsor read on their own — NOT "follow",
  // "check out", "subscribe", "code …" (review 2026-10-10: "code base" every
  // 30 s in a coding talk chained into a 20-minute block). Ranges are capped at
  // PROMO_DENSITY_MAX_SEC like the opener-based ones.
  const hits = [];
  for (const c of cues) {
    if (PROMO_DENSITY_RE.test(String(c?.text || ''))) hits.push({ start: Number(c.start) || 0, end: Number(c.end) || 0 });
  }
  let group = [];
  const flush = () => {
    if (group.length >= 3) {
      const r = { start: Math.max(0, group[0].start - 3), end: group[group.length - 1].end + 3, kind: 'promo-density' };
      if (!ranges.some((x) => Math.min(x.end, r.end) - Math.max(x.start, r.start) > 0)) ranges.push(r);
    }
    group = [];
  };
  for (const h of hits) {
    if (group.length && (h.start - group[group.length - 1].end > 45 || h.end - group[0].start > PROMO_DENSITY_MAX_SEC)) flush();
    group.push(h);
  }
  flush();
  return ranges;
}

function rangeOverlapsBlocked(start, end, ranges, minOverlap = 1) {
  return (ranges || []).some(r => Math.max(0, Math.min(end, r.end) - Math.max(start, r.start)) >= minOverlap);
}

// [TFIDF-HOOK] Local (no-API) clip scoring, upgraded from "does this single
// cue line contain a trigger word" to TF-IDF over sliding 15-20s transcript
// windows. Rationale: a keyword hit on a single short line scores the same
// whether the word is generic filler repeated all video ("banget", "kan") or
// a genuinely rare, on-topic term — and the previous scorer also threw the
// computed score away, hardcoding every local clip to a flat 6 regardless of
// how hook-worthy it actually was (so "Hot" (score>=8) never fired on local
// detection). TF-IDF fixes both: rare, topic-specific terms weigh a lot,
// video-wide filler weighs ~nothing, and the score that comes out is what
// actually gets stored on the clip. Windows and titles are built from the
// SAME text span, so score/title/clip boundaries all stay grounded together.
function tokenizeForTfidf(text, lang) {
  const stop = lang === 'en' ? STOP_EN : STOP_ID;
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stop.has(w));
}

// Slide 15-20s candidate windows over the transcript and score each by TF-IDF.
//
// [TFIDF-IDF-CORPUS] The IDF denominator MUST be counted over NON-overlapping
// documents. The natural ones here are the transcript cues themselves — one
// cue = one document. An earlier version counted df over the sliding windows
// instead; because windows overlap 15-20s forward, a term spoken ONCE landed
// in ~8 overlapping windows, inflating its df to ~8 and DEFLATING its IDF —
// destroying the exact rare-term discrimination TF-IDF exists to provide.
// Counting df over cues restores it: "rahasia" (1 cue) → high IDF, "jadi"
// (most cues) → ~0 IDF.
//
// [TFIDF-SPEED] Each cue is tokenized ONCE and reused by every window that
// spans it (no re-tokenizing the same overlapping text ~8x), and windows are
// emitted on a stride (not one-per-cue) so a long video yields O(duration/stride)
// candidates instead of O(cues). Peak-finding granularity stays fine because a
// window starting ≤stride seconds earlier still fully contains the same hook.
function buildTfidfWindows(cues, duration, lang = 'id') {
  if (!cues.length) return [];
  const hot = lang === 'en' ? HOT_EN_RE : HOT_ID_RE;

  // Pre-tokenize every cue once; also build df over cues as documents.
  const cueTokens = new Array(cues.length);
  const df = new Map();
  for (let i = 0; i < cues.length; i++) {
    const toks = tokenizeForTfidf(cues[i].text, lang);
    cueTokens[i] = toks;
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const Ndoc = cues.length;
  const idf = (term) => Math.log(1 + Ndoc / (1 + (df.get(term) || 0)));

  const STRIDE = 4;  // seconds between successive window starts
  const windows = [];
  let lastStart = -Infinity;
  for (let i = 0; i < cues.length; i++) {
    const wStart = cues[i].start;
    if (wStart - lastStart < STRIDE) continue;
    let j = i;
    // [TFIDF-GAP] Grow the window to ~15s of CONTENT but never leap a
    // silence/music gap: only append the next cue if it ALSO starts within
    // 20s of the window start. The earlier two-loop form checked the gap in
    // the first loop but the second loop grew on cues[j].end alone — so across
    // a gap it appended one post-gap cue 30-60s away, fusing two unrelated
    // moments into a single 40-65s "window" whose score/title/boundary no
    // longer matched any real clip. One gap-safe loop + a hard 20s cap fixes it.
    while (j + 1 < cues.length
           && cues[j + 1].start - wStart < 20
           && cues[j].end - wStart < 15) j++;
    const wEnd = Math.min(cues[j].end, wStart + 20);
    if (wEnd - wStart < 4) continue; // too thin (tail of video), not a usable window

    // Window tokens = concat of the pre-tokenized cues it spans (no re-tokenize).
    const tf = new Map();
    let total = 0;
    for (let k = i; k <= j; k++) {
      for (const t of cueTokens[k]) { tf.set(t, (tf.get(t) || 0) + 1); total++; }
    }
    const text = cues.slice(i, j + 1).map(c => c.text || '').join(' ');
    let score = 0, hookHits = 0;
    if (total) {
      for (const [term, count] of tf) {
        const weight = (count / total) * idf(term);
        if (hot.test(term) || LOKA_HOT_RE.test(term)) { score += weight * 2.2; hookHits += count; }  // hook-lexicon terms weigh more
        else score += weight;
      }
    }
    const hasQ = /[?]/.test(text), hasE = /[!]/.test(text);
    if (hasQ) score += 0.4;   // open question = curiosity gap
    if (hasE) score += 0.25;  // emphasis / emotion
    const promoHits = (text.match(PROMO_SEGMENT_RE) || []).length;
    if (promoHits) {
      score -= 1.25 * promoHits;
      hookHits = Math.max(0, hookHits - 2 * promoHits);
    }
    // hookHits = an ABSOLUTE, lexicon-based hook-signal count (comparable
    // across videos), used by normalizeTfidfScores to anchor the 1-10 score
    // so "Hot" means genuinely strong — not just "least boring window here".
    // [TOPIC-DIVERSITY] The window's most salient terms (tf × idf) — a
    // video-agnostic topic fingerprint used to keep picks on different topics.
    const terms = new Set([...tf].sort((a, b) => b[1] * idf(b[0]) - a[1] * idf(a[0])).slice(0, 8).map(([t]) => t));
    windows.push({ start: wStart, end: wEnd, text, tfidf: score, promoHits, terms,
      hookHits: hookHits + (hasQ ? 1 : 0) + (hasE ? 0.5 : 0) });
    lastStart = wStart;
  }
  return windows;
}

// Map raw TF-IDF windows onto the app's 1-10 clip.score scale (score >= 8 is
// the "Hot" threshold in the UI). BLEND of two signals, not pure min-max:
//   • absHook — ABSOLUTE hook density (lexicon hits + ?/! ), comparable across
//     videos. Dominant (0.6) so "Hot" requires genuinely strong hook content.
//   • relRank — RELATIVE tf-idf rank within THIS video (topic-specificity).
// Pure min-max (the earlier version) was purely relative: the top window of
// EVERY video mapped to exactly 10 — so an all-filler video showed a "Hot"
// clip — and on an all-hook video genuinely strong clips collapsed to 1. The
// blend fixes both directions: filler tops out ~5 (never Hot), and a strong
// clip never reads as 1 just because the video is uniformly good.
function normalizeTfidfScores(windows) {
  if (!windows.length) return;
  // Loop-based min/max — never `Math.max(...windows)`; spreading a long
  // video's window array into a call blows the argument-count stack limit
  // (RangeError) on some V8 builds. Stable across all platforms this way.
  let min = Infinity, max = -Infinity;
  for (const w of windows) { if (w.tfidf < min) min = w.tfidf; if (w.tfidf > max) max = w.tfidf; }
  const range = max - min;
  for (const w of windows) {
    const relRank = range < 1e-6 ? 0.5 : (w.tfidf - min) / range;
    const absHook = Math.min(1, (w.hookHits || 0) / 3);   // 3+ hook signals ⇒ full
    const promoPenalty = Math.min(4, (w.promoHits || 0) * 4);
    w.score10 = Math.max(1, Math.min(10, Math.round(1 + 9 * (0.6 * absHook + 0.4 * relRank) - promoPenalty)));
  }
}

// [TOPIC-DIVERSITY] Two windows are the same topic when their salient-term
// fingerprints overlap heavily (Jaccard). Replaces contextTopicKey, which only
// knew six stories from one benchmark video. Measured on a real 85-min
// interview: 3 of 6 picks were the same "240 million followers" exchange.
const SAME_TOPIC_JACCARD = 0.25;
function sameTopic(a, b) {
  const A = a && a.terms, B = b && b.terms;
  if (!A || !B || !A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= SAME_TOPIC_JACCARD;
}

// Condense one already-selected sentence down to a short (<=5 word) hook
// phrase — no AI call, pure text processing, used by the no-API-key default
// path. Real semantic paraphrasing (e.g. turning a whole question into "Tanda
// Kamu Siap Nikah") fundamentally needs an LLM and is out of reach here; this
// only gets us from "one full run-on sentence" to "the punchiest short
// window of it", centred on whichever hook-trigger word fired the scoring
// above so the fragment stays recognisably about the same idea.
// Connector-type hot words carry twist/contrast (tapi/namun/…) but make a weak
// TITLE anchor: centering on "tapi tau gak" reads far worse than on the strong
// content hook ("rahasia orang kaya") a few words later. Prefer the first STRONG
// hook word; only fall back to a connector if the window has nothing stronger.
const HOOK_CONNECTORS_RE = /^(tapi|namun|tetapi|justru|padahal|kalau|jika|but|however|though|actually)$/i;

// [TITLE-PHRASE-DEDUP] Collapse consecutively repeated word-PHRASES (up to 4
// words), not just single repeated words. Real unscripted speech stutters
// phrases, not just words ("harus semangat harus semangat harus semangat"),
// and a single-word adjacent dedup ("A A" -> "A") lets a repeated 2+ word
// phrase sail through untouched. Generic — no special-casing any one phrase.
// Shared by buildViralHookTitle and condenseToHookPhrase since both have the
// exact same root-cause gap (only condenseToHookPhrase's downstream seen-set
// word dedup partially masks it on short windows).
function collapseRepeatedPhrases(words) {
  // Compare on a punctuation-stripped key so a sentence-boundary period on
  // one occurrence ("bertahan." vs "bertahan") doesn't defeat the match —
  // repeats commonly straddle a ". " when the same clause gets restated as
  // its own sentence ("...bisa bertahan. Untuk bisa bertahan it's...").
  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  let out = words.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = Math.min(4, out.length >> 1); n >= 1; n--) {
      const result = [];
      let i = 0;
      while (i < out.length) {
        if (i + 2 * n <= out.length) {
          const a = out.slice(i, i + n).map(key);
          const b = out.slice(i + n, i + 2 * n).map(key);
          if (a.every((w, idx) => w === b[idx])) {
            let j = i + n;
            const aKey = a.join(' ');
            while (j + n <= out.length && out.slice(j, j + n).map(key).join(' ') === aKey) {
              j += n;
            }
            // Keep the LAST repeated occurrence, not the first — trailing
            // punctuation (a period ending the utterance) lives on whichever
            // repeat came last, and dropping it would silently fuse this
            // sentence span with whatever follows.
            result.push(...out.slice(j - n, j));
            i = j;
            changed = true;
            continue;
          }
        }
        result.push(out[i]);
        i++;
      }
      out = result;
    }
  }
  return out;
}

function condenseToHookPhrase(sentence, lang) {
  const stop = lang === 'en' ? STOP_EN : STOP_ID;
  const hot = lang === 'en' ? HOT_EN_RE : HOT_ID_RE;
  const words = collapseRepeatedPhrases(sentence.split(/\s+/).filter(Boolean));
  if (!words.length) return [];
  const bare = (w) => w.toLowerCase().replace(/[^\p{L}']/gu, '');
  let hotIdx = words.findIndex(w => hot.test(w) && !HOOK_CONNECTORS_RE.test(bare(w)));
  if (hotIdx < 0) hotIdx = words.findIndex(w => hot.test(w));
  let windowWords;
  if (hotIdx >= 0) {
    let start = Math.max(0, hotIdx - 2);
    let end = Math.min(words.length, start + 5);
    start = Math.max(0, end - 5);
    windowWords = words.slice(start, end);
  } else {
    windowWords = words.slice(0, 5);
  }
  let content = windowWords.filter(w => !stop.has(bare(w)));
  // [TITLE-STOPWORD] If stripping stopwords leaves <3 words, revert to the raw
  // window ONLY when it still holds at least one content word — a window of
  // pure function words ("yang dan di ke dari") makes a meaningless title, so
  // leave it short and let the caller fall back to a generic label instead.
  if (content.length < 3) content = content.length ? windowWords : [];
  // [TITLE-DEDUPE] Drop repeated content words (keep first) so a looping
  // transcript ("rahasia orang kaya rahasia orang") condenses to "Rahasia
  // Orang Kaya", not a visibly duplicated phrase. No-op on normal phrases;
  // reverts if dedupe would over-trim below 3 words.
  const seen = new Set();
  const deduped = content.filter(w => {
    const k = bare(w);
    if (!k) return true;             // non-letter token (number/emoji): keep as-is
    if (seen.has(k)) return false;   // repeated content word: drop
    seen.add(k); return true;
  });
  return (deduped.length >= 3 ? deduped : content).slice(0, 5);
}

// [TITLE-LONG] Build a 10–15 word viral-hook TITLE from the transcript window,
// preserving natural sentence flow — NOT the tight 3–5 word condensation of
// condenseToHookPhrase. Used by the pipeline when a longer, sentence-shaped
// title is desired (matches how creators actually caption viral shorts).
//
// Algorithm (all pure text, no LLM — stays grounded in the actual transcript):
//   1. Strip annotations ([music], (applause)) and duplicated cue overlaps,
//      then collapse repeated stutter PHRASES (not just single words), so
//      unscripted-speech repeats never survive into the anchor search or the
//      final title (see collapseRepeatedPhrases).
//   2. Split into sentences and score each with the SAME sentence-scoring
//      heuristic localHookTitle already uses (proven, validated: hook-lexicon
//      hit + ?/! + length) to find the window's actual highlight sentence —
//      not just "first hot word in raw reading order", which can land on a
//      weak/generic hit before the real payoff.
//   3. Anchor on the first STRONG hook word in that best sentence (fallback:
//      a contrast connector, else the sentence's first word).
//   4. Expand up to 5 words BEFORE + 10 AFTER the anchor across the full
//      window (viral hooks land the payoff after the hook word), targeting
//      10–15 words, but prefer stopping on a clause boundary (. ? ! ,) within
//      a few words of the cap over cutting mid-clause.
//   5. Trim leading/trailing filler + collapse whitespace + Title-Case.
//   6. Never emit an empty string; caller supplies fallback if this returns
//      too few words to be usable.
function buildViralHookTitle(raw, lang = 'id') {
  let t = (raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // Drop non-spoken annotations before word-splitting.
  t = t.replace(/[\[(][^\])]*[\])]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  const hot = lang === 'en' ? HOT_EN_RE : HOT_ID_RE;
  const bare = (w) => w.toLowerCase().replace(/[^\p{L}']/gu, '');

  // Collapse the SRT-cue duplication ("A. A B. A B C.") AND any repeated
  // stutter phrase ("harus semangat harus semangat harus semangat") before
  // any scoring/anchor logic sees the words.
  const words = collapseRepeatedPhrases(t.split(/\s+/).filter(Boolean));
  if (words.length < 3) return '';

  // Build sentence spans over the (deduped) word array so indices line up
  // with `words` directly — avoids re-tokenizing/re-mapping a separate
  // sentence split back onto word positions.
  const spans = [];
  {
    let start = 0;
    for (let i = 0; i < words.length; i++) {
      if (/[.?!]$/.test(words[i]) || i === words.length - 1) {
        spans.push({ start, end: i + 1 });
        start = i + 1;
      }
    }
  }
  let bestSpan = spans[0] || { start: 0, end: words.length };
  let bestScore = -Infinity;
  for (const sp of spans) {
    const text = words.slice(sp.start, sp.end).join(' ');
    const score = (hot.test(text) ? 4 : 0) + (/[?!]/.test(text) ? 2 : 0) + Math.min(text.length, 100) / 40;
    if (score > bestScore) { bestScore = score; bestSpan = sp; }
  }

  // Prefer a STRONG hook first within the best sentence; fall back to a
  // contrast connector; else the sentence's first word.
  let anchor = -1;
  for (let i = bestSpan.start; i < bestSpan.end; i++) {
    if (hot.test(words[i]) && !HOOK_CONNECTORS_RE.test(bare(words[i]))) { anchor = i; break; }
  }
  if (anchor < 0) {
    for (let i = bestSpan.start; i < bestSpan.end; i++) {
      if (hot.test(words[i])) { anchor = i; break; }
    }
  }
  if (anchor < 0) anchor = bestSpan.start;

  // [TITLE-STANDALONE] Real unscripted speech often already contains a
  // complete, punchy rhetorical question or exclamation verbatim — e.g.
  // "Kenapa istriku? Kenapa kamu senyam-senyum seperti itu?" or "Eh, koy
  // gimana koy?". When the best-scoring SENTENCE ITSELF (bestSpan — the
  // same span that fed the anchor search above) is already such a unit —
  // between 4 and 12 words and ending on the transcript's own "?"/"!" — use
  // that span as-is instead of running it through the ~12-word-floor
  // expansion below. That expansion pulls in flat declarative words from
  // the PRECEDING/FOLLOWING sentence to hit the floor, which both dilutes
  // the hook and can chop the anchor sentence's own leading word off (e.g.
  // "Apa yang berubah bro?" losing "Apa"). Length should serve the hook,
  // not the other way around; a shorter, honest, un-diluted quote beats a
  // padded one. Declarative bestSpans (no trailing ?/!) are unaffected —
  // they still get the full expansion since there's no natural short unit
  // to preserve.
  const bestSpanN = bestSpan.end - bestSpan.start;
  const bestSpanText = words.slice(bestSpan.start, bestSpan.end).join(' ');
  const standalone = bestSpanN >= 4 && bestSpanN <= 12 && /[?!]$/.test(bestSpanText.trim());

  let s, e;
  if (standalone) {
    s = bestSpan.start;
    e = bestSpan.end;
  } else {
    // Expand 5 back + 10 forward around the anchor, clipped to array bounds.
    s = Math.max(0, anchor - 5);
    e = Math.min(words.length, anchor + 11);
    // Aim for ~12 words when we have room — extend forward first (viral hooks
    // land the payoff AFTER the hook word), then backward if still short.
    while (e - s < 12 && e < words.length) e++;
    while (e - s < 12 && s > 0)            s--;
    // Never exceed 15 words (readability + real short-form titles cap here) —
    // but if a clause boundary (. ? ! ,) falls within a few words of the cap,
    // extend to it rather than cutting mid-clause (whether the natural
    // expansion landed exactly on the cap or ran past it).
    // CLAUSE_SLACK was 3 — too tight in practice: a real window needed the
    // boundary 4 words past the cap ("...gua itu enggak pernah berantem
    // lagi." — cap landed on "itu", the payoff "lagi." sat 4 words later)
    // and lost it, cutting the hook right before its own punchline. 5 gives
    // a bit of margin without let titles run away in length (the loop still
    // requires an ACTUAL nearby boundary to extend at all).
    const HARD_CAP = 15, CLAUSE_SLACK = 5;
    // Clamp to words.length: without this, a window with no clause boundary
    // near the cap (common when the anchor sits close to the transcript's
    // tail) let `e` overrun the array — the filler-trim loop below then read
    // words[e-1] past the end (undefined) and crashed on .toLowerCase().
    const capE = Math.min(s + HARD_CAP, words.length);
    const softE = Math.min(e, capE);
    if (!/[.,?!]$/.test(words[softE - 1] || '')) {
      let probe = softE;
      while (probe < words.length && probe - s <= HARD_CAP + CLAUSE_SLACK && !/[.,?!]$/.test(words[probe - 1])) probe++;
      e = (probe - s <= HARD_CAP + CLAUSE_SLACK && /[.,?!]$/.test(words[probe - 1] || ''))
        ? probe
        : capE;
    } else {
      e = softE;
    }
  }

  // Trim leading/trailing standalone fillers so the phrase doesn't start
  // with "ee" or end on "aja". Bounded so the trim never eats the anchor.
  // 'itu'/'dan' added: real windows showed titles opening AND closing on
  // "itu" ("Itu Setelah Kita ... Gua Itu") and opening on "dan" ("Dan Itu
  // Salah Satu Apa Namanya") — both carry no unique information as a title
  // boundary word (loose demonstrative / bare conjunction), same class as
  // the already-listed 'tuh'/'nih'.
  const FILLER_ID = new Set(['ee','eh','uh','ah','um','ehm','hmm','aja','gitu','tuh','kok','sih','ya','nah','loh','deh','dong','nih','kayaknya','gini','itu','dan']);
  const FILLER_EN = new Set(['uh','um','er','ah','like','okay','ok','so','well','yeah','yep','nope']);
  const filler = lang === 'en' ? FILLER_EN : FILLER_ID;
  while (s < anchor && filler.has(bare(words[s]))) s++;
  while (e > anchor + 1 && filler.has(bare(words[e - 1]))) e--;

  const picked = words.slice(s, e);
  if (picked.length < 3) return '';

  // Title-case, strip punctuation (keep intra-word hyphens/apostrophes).
  return picked
    .map(w => {
      // Preserve ALL-CAPS acronyms (LP, YT, etc.).
      if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
      // Lower-then-cap first letter, keeping any hyphenated segment mid-word.
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\s+([,.:;!?])/g, '$1')
    .replace(/[,.:;!?"“”]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^[\s\-—]+|[\s,.\-—]+$)/g, '')
    .trim();
}

// Local sanitizer fallback (no API). Picks the most "hook-worthy" sentence
// from the clip text. Rejects sub-word fragments ("P", "Rah", "Ah") that
// happen when a 1-letter interjection ends with a period in the transcript.
function localHookTitle(raw, idx, lang = 'id', avoid = null) {
  let t = (raw || '').replace(/\s+/g,' ').trim();
  // Transcript annotations ([berdehem], [musik], (tepuk tangan)) are NOT
  // spoken words — they leaked into titles like "[berdehem] Elizabeth".
  t = t.replace(/[\[(][^\])]*[\])]/g, ' ');
  // Lang-specific filler list — applied as standalone-word strip. Includes
  // bare vowel stutters ("e", "ee", "a") that survived as words like
  // "Sebenarnya E Mostly".
  const FILLERS_ID = /\b(uh|eh|ee?|a+h?|um|ehm|hmm|loh|kan|deh|sih|ya kan|nah|gitu loh|gimana ya|heeh|hee|yha|ya ya|iya iya|aja|gitu|gini|tuh|dong|nih|kok|sih|ya|hah|hoh|woi|wkwk|hahaha?)\b/gi;
  const FILLERS_EN = /\b(uh|um|er|ah|like|you know|i mean|sort of|kind of|basically|literally|actually|right|okay|ok|so|well|hmm|haha+|yeah|yep|nope)\b/gi;
  t = t.replace(lang === 'en' ? FILLERS_EN : FILLERS_ID, '');
  t = t.replace(/\s+/g,' ').replace(/^[\s,.\-—]+|[\s,.\-—]+$/g,'');
  const fallbackLabel = lang === 'en' ? `Moment #${idx + 1}` : `Momen #${idx + 1}`;
  if (!t) return fallbackLabel;
  const taken = (s) => avoid && avoid.has(_normPhrase(s));
  const cap = (short) => short
    .map(w => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) ? w : (w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
    // Titles carry no internal punctuation (the prompt bans it too) — drop
    // stray commas/colons/quotes that survive from mid-sentence extraction,
    // but keep intra-word hyphens ("hati-hati").
    .replace(/\s+([,.:;!?])/g, '$1')
    .replace(/[,.:;!?"“”]+/g, ' ')
    // Drop emoji and any other symbol that slipped through (🔥😂💰…) — titles
    // are letters/numbers/spaces plus intra-word ' and - only.
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^[\s\-—]+|[\s,.\-—]+$)/g, '')
    .trim();
  const sentences = t.split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(s => {
      const words = s.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
      return words.length >= 3 && s.length >= 12;
    });
  const hot = lang === 'en' ? HOT_EN_RE : HOT_ID_RE;
  if (!sentences.length) {
    const words = t.split(/\s+/).filter(w => w.length > 1);
    if (words.length < 3) return fallbackLabel;
    const short = condenseToHookPhrase(words.join(' '), lang);
    if (short.length < 3) return fallbackLabel;
    return cap(short) || fallbackLabel;   // cap() can empty out a punctuation-only window
  }
  sentences.sort((a, b) => {
    const sa = (hot.test(a) ? 4 : 0) + (/[?!]/.test(a) ? 2 : 0) + Math.min(a.length, 100)/40;
    const sb = (hot.test(b) ? 4 : 0) + (/[?!]/.test(b) ? 2 : 0) + Math.min(b.length, 100)/40;
    return sb - sa;
  });
  // Walk sentences best-first; take the first whose condensed hook is a real
  // 3+ word phrase not already used by another clip (dedup).
  let firstPick = null;
  for (const s of sentences) {
    const short = condenseToHookPhrase(s.replace(/[\s,.\-—?!]+$/, ''), lang);
    if (short.length < 3) continue;
    const pick = cap(short);
    if (!pick) continue;
    if (!firstPick) firstPick = pick;
    if (!taken(pick)) return pick;
  }
  return firstPick || fallbackLabel;
}

// [TITLE-SHAPE] A title becomes the output FILENAME
// (`${NN}-${slugify(title)}.mp4`), and slugify caps at 60 chars — so a
// sentence-length title is not merely ugly, it gets cut mid-phrase on disk.
// Real example from a reported session: a 15-word title landed as
// "01-Benar Benar Kita Perlu Untuk Mencapai Tujuan Mana Ini.mp4".
//
// Speech fragments also start and end on connectors, because the window is cut
// out of the middle of a sentence — "Dan Ini Jangan Di Apa",
// "…Karena Itu Cuma". Trimming those edges costs nothing and is what separates
// a headline from a transcript slice.
const TITLE_LEAD_RE = /^(dan|tapi|namun|tetapi|atau|untuk|karena|kalau|jika|nah|jadi|yang|itu|ini|kan|maka|serta|dengan|di|ke|dari|pada|akan|sudah|juga|and|but|or|for|because|so|the)$/i;
// Prepositions/conjunctions belong here too: a headline that ends on "tentang"
// or "about" is visibly cut off mid-thought.
// Deliberately EXCLUDES the demonstratives (itu/ini/that) and "when": those
// legitimately END an Indonesian or English headline — "Ternyata Alasan
// Sebenarnya Bukan Itu", "I Never Knew That" — and listing them here trimmed
// the payoff off a perfectly good hook (caught by this file's own
// "a clean headline is left completely alone" test). A genuinely dangling
// "Karena Itu" is caught by the PAIR rule below instead, which needs the
// conjunction to be there too.
const TITLE_TAIL_RE = /^(dan|tapi|namun|atau|untuk|karena|kalau|jika|yang|dengan|di|ke|dari|pada|adalah|akan|cuma|buat|sama|biar|jadi|nah|tentang|kepada|terhadap|oleh|sebagai|bagi|hingga|sampai|seperti|agar|supaya|bahwa|and|but|or|for|with|of|to|from|the|a|an|about|into|over|under|than|while|as|in|on|at|by)$/i;
// A trailing conjunction followed by ONE short word ("… Card And You") reads
// just as cut-off as a bare trailing conjunction, but neither word alone is
// caught by the tail list. Detect the PAIR.
//
// The pair only dangles when the FINAL word carries no content: "Calling Card
// And You" is cut off, but "Planning For 29" is finished — the number IS the
// payoff. An earlier version dropped both words unconditionally and ate the
// "For 29" off a curated template headline (caught by tfidf-hook.test.js).
// So the last word must itself be a bare pronoun to qualify.
const TITLE_TAIL_PAIR_RE = /^(dan|atau|tapi|namun|karena|untuk|and|or|but|because|for|with)$/i;
const TITLE_TAIL_PRONOUN_RE = /^(you|i|we|they|it|he|she|me|us|them|him|her|kamu|kita|aku|saya|dia|mereka|gua|gue|lu|elu|nya|anda)$/i;
const TITLE_MIN_WORDS = 3;
const TITLE_MAX_WORDS = 9;   // same ceiling the AIDA prompt asks the model for

function titleWordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}
// Never trims below `min` — a short phrase made of connectors is still better
// than an empty one, and the caller has its own fallback for that.
function trimTitleEdges(s, min = TITLE_MIN_WORDS) {
  const bare = (w) => String(w || '').replace(/[^\p{L}]/gu, '');
  const words = String(s || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > min && TITLE_LEAD_RE.test(bare(words[0]))) words.shift();
  let changed = true;
  while (changed && words.length > min) {
    changed = false;
    if (TITLE_TAIL_RE.test(bare(words[words.length - 1]))) { words.pop(); changed = true; continue; }
    // "… Calling Card And You" → drop both, not neither. Never "… For 29".
    if (words.length > min + 1
        && TITLE_TAIL_PAIR_RE.test(bare(words[words.length - 2]))
        && TITLE_TAIL_PRONOUN_RE.test(bare(words[words.length - 1]))) {
      words.pop(); words.pop(); changed = true;
    }
  }
  return words.join(' ');
}

function localContextTitle(raw, idx, lang = 'id', avoid = null) {
  // [TITLE-SHAPE] Every candidate is held to the SAME length contract the AI
  // path enforces via cleanApiTitle(…, 9). Before this, none of them were:
  // concreteContextTitle and contextTemplateTitle had no length check at all,
  // and buildViralHookTitle was accepted on a >= 6 word FLOOR with no ceiling
  // — it deliberately targets ~12 words (it doubles as the on-screen hook), so
  // 15- and 19-word titles shipped as filenames. Worse, the un-length-checked
  // first candidate won even when a later one was better: on the reported clip,
  // concreteContextTitle returned a 15-word run-on while buildViralHookTitle
  // had already produced "Gimana Cara Antum Menunda Dan Akhirnya Tetap Nikah
  // Muda" — a genuine hook that could never be reached.
  const fits = (s) => {
    const n = titleWordCount(s);
    return n >= TITLE_MIN_WORDS && n <= TITLE_MAX_WORDS;
  };
  const free = (s) => s && !(avoid && avoid.has(_normPhrase(s)));
  // [NO-HARDCODE] contextTemplateTitle ("From PA To Mr Beast", "Stolen Car:
  // A Real-Life Heist", "Future Mom Goals: Planning For 29") and
  // concreteContextTitle (scored on the same benchmark-video keywords) are
  // gone — they only fired on that one video's stories. The title is cut from
  // the clip's own speech.
  const candidates = [
    buildViralHookTitle(raw, lang),
  ].filter(Boolean);

  // Pass 1 — a candidate that already reads as a title, as-is.
  for (const c of candidates) {
    const t = trimTitleEdges(c);
    if (fits(t) && free(t)) return t;
  }
  // Pass 2 — shape an over-long candidate down with the same helper the AI
  // titles go through, so both paths drop dangling connectors identically.
  for (const c of candidates) {
    const shaped = cleanApiTitle(trimTitleEdges(c), lang, TITLE_MAX_WORDS);
    if (!shaped) continue;
    const t = trimTitleEdges(shaped);
    if (fits(t) && free(t)) return t;
  }
  // Pass 3 — the 5-word phrase extractor, which was always the last resort.
  const short = localHookTitle(raw, idx, lang, avoid);
  const trimmed = trimTitleEdges(short);
  // Only take the trimmed form when trimming did not push it under the floor;
  // localHookTitle's own fallback label ("Momen #3") must survive untouched.
  return (fits(trimmed) && free(trimmed)) ? trimmed : short;
}

function titleCaseHeadline(raw) {
  return String(raw || '').trim().split(/\s+/).map(token =>
    token.split('-').map(part => {
      if (!part) return part;
      if (part.length > 1 && part === part.toUpperCase() && /[A-Z]/.test(part)) return part;
      const match = part.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}])(.*)$/u);
      if (!match) return part;
      return match[1] + match[2].toUpperCase() + match[3].toLowerCase();
    }).join('-')
  ).join(' ');
}





// [HOOK-GROUND] Few-shot example hooks that appear in the title-rewrite
// prompts used by cloud providers. Strong cloud models obey
// "mimic the vibe, don't copy", but weaker providers can still parrot
// these verbatim, so a whole batch came out titled "Gue Salah Selama Ini" /
// "Berhenti Kejar Uang Dulu" — literal examples, absent from every clip's
// transcript. Kept in sync with the example lists in both prompts.
const HOOK_EXAMPLE_HOOKS = [
  // Indonesian examples used by the cloud rewrite prompt.
  'gue salah selama ini', 'ini bikin gue nangis', 'rahasia orang kaya sebenarnya',
  'jangan lakuin kesalahan ini', 'ternyata semua bohong', 'berhenti kejar uang dulu',
  'yang nggak ada yang ngasih tau', 'ternyata gue salah',
  // Malay examples.
  'aku salah selama ini', 'ni buat aku nangis', 'rahsia orang kaya sebenarnya',
  'jangan buat kesilapan ni', 'rupanya semua tipu', 'berhenti kejar duit dulu',
  // English examples.
  'i was wrong about money', 'this broke me', 'the real rich secret',
  "don't do what i did", 'turns out everyone lied', 'stop chasing money first',
];

function _normPhrase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // drop punctuation (incl. apostrophes)
    .replace(/\s+/g, ' ')
    .trim();
}

// Does a generated title echo a prompt example? True when the normalized
// title equals an example, either phrase contains the other, or their word
// sets overlap heavily (≥0.7 of the shorter) — catching padded copies like
// "Ternyata Gue Salah Selama Ini" (example "ternyata gue salah" + filler).
// [ECHO-CONTENT] The overlap ratio counts CONTENT words, not every token.
// Measured on real offline-model output: "Ini Bikin penasaran. Gaji gue" scored
// 0.75 against the example "ini bikin gue nangis" and was discarded — but the
// three tokens it shared were "ini", "bikin", "gue", two of which are function
// words that say nothing about whether the model parroted anything. The prompt
// hands the model "Ini Bikin" as an opener stem, so a title built from it is
// doing exactly what it was told, and the gate punished it for that. On content
// words the same title scores 0.50 and survives.
//
// Real parroting is unaffected, checked both ways: "Ini Bikin Gue Nangis"
// scores 1.00 on content words too, and the exact/substring tests above catch
// verbatim copies and bare stems regardless of any ratio — a title that IS just
// "ini bikin" is still rejected, which is right, because a bare stem is not a
// hook.
function echoesExampleHook(title) {
  const t = _normPhrase(title);
  if (!t) return false;
  const tw = new Set(_contentWords(t));
  for (const ex of HOOK_EXAMPLE_HOOKS) {
    const e = _normPhrase(ex);
    if (t === e || t.includes(e) || e.includes(t)) return true;
    const ew = new Set(_contentWords(e));
    // An example that reduces to fewer than two content words cannot support a
    // ratio: "this broke me" keeps only {broke} once function words are dropped,
    // so min(|t|,|e|) collapses to 1 and ANY title containing "broke" scores
    // 1.00. That regression was caught by the existing [HOOK-PROMPT] test —
    // "This Broke Duit Umur Dua", a stem legitimately completed with transcript
    // words, was suddenly discarded. Verbatim copies of these short examples are
    // still caught by the exact/substring tests above, which need no ratio.
    if (ew.size < 2 || !tw.size) continue;
    const shorter = Math.min(tw.size, ew.size) || 1;
    let inter = 0;
    for (const w of ew) if (tw.has(w)) inter++;
    // 0.60, not the 0.70 the all-token version used. Dropping function words
    // makes every ratio stricter, so keeping 0.70 would have quietly let real
    // parroting through: "Jangan Ulang Kesilapan Ni" — named in 89df75e as a
    // phrase the gate must catch — shares 2 of 3 content words with "jangan
    // buat kesilapan ni" and scores 0.667. Measured against the full example
    // list, genuine offline-model hooks top out at 0.500 while parrots start at
    // 0.667, so the threshold sits in that gap rather than on either edge.
    if (inter / shorter >= 0.6) return true;
  }
  return false;
}

// Indonesian/Malay/English function words that carry no topical meaning — they
// don't count toward "is this title grounded in the clip".
const _STOP = new Set(('yang di ke dari dan atau tapi tetapi namun untuk pada dengan '
  + 'ini itu gue gua aku lo lu kamu kau kita kami mereka dia nya ada aku nggak gak '
  + 'tak nggak enggak akan sudah udah lagi juga aja saja kan sih deh dong nih tuh '
  + 'the a an of to and or but for on with this that is are was i you we they it my '
  + 'your our their he she his her selama masih karena kok banget mesti demi').split(/\s+/));

function _contentWords(s) {
  return _normPhrase(s).split(' ').filter(w => w.length >= 3 && !_STOP.has(w));
}

// A title is "grounded" when at least one of its meaningful content words
// actually appears in the clip transcript (loose stem match). A hallucinated
// title (e.g. "Rahasia Sukses Trading Saham" over a clip about marriage)
// shares no content word and is rejected.
function titleGroundedInText(title, clipText) {
  const words = _contentWords(title);
  if (!words.length) return false;
  const hay = ' ' + _normPhrase(clipText) + ' ';
  let hits = 0;
  for (const w of words) {
    const stem = w.slice(0, Math.max(4, w.length - 2));
    if (hay.includes(' ' + w) || hay.includes(stem)) hits++;
  }
  // Require a real anchor: ≥1 content-word hit AND ≥1/3 of content words.
  return hits >= 1 && hits / words.length >= 0.34;
}

// Gate a generatively-produced title: null (caller falls back to transcript
// extraction) if it parrots a prompt example or isn't grounded in the clip.
function validateGeneratedTitle(title, clipText, lang = 'id') {
  const t = String(title || '').trim();
  if (!t) return null;
  if (echoesExampleHook(t)) return null;
  if (!titleGroundedInText(t, clipText)) return null;
  return t;
}

// Windows reserved device names — using these as filenames triggers an
// EEXIST-like error even though they don't exist on disk. Append a suffix
// when the slug collides with one.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Title-cases each space-joined word (LokaClip-style filenames) instead of
// leaving the whole slug lowercase, and trims to the last whole word inside
// the length cap instead of cutting mid-word ("...your care" -> never
// "...your c"). Words are joined with a plain space, not a hyphen.
function slugify(s) {
  let words = (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]+/g, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(Boolean);
  let out = '';
  for (const w of words) {
    const cased = w[0] ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
    const next = out ? `${out} ${cased}` : cased;
    if (next.length > 60) break;
    out = next;
  }
  if (!out) out = 'Clip';
  if (WIN_RESERVED.test(out.toLowerCase())) out = out + ' Clip';
  return out;
}

// [RAW-EDITED-SPLIT] Session folders keep freshly-cut clips in raw/ and every
// Caption Editor "Apply"/crop result in edited/ — flat sessions used to mix
// both (plus, until the smartTrackTemp fix above, leftover tracking
// intermediates) in one folder with no way to tell which file was which.
// Given a directory that HOLDS a clip file, walks back up to the session
// root: if that directory IS raw/ or edited/, its parent is the root;
// otherwise the directory itself is treated as the root (old sessions cut
// before this split, or any file outside the expected layout) so existing
// clips/paths keep working unchanged.
// [CLEAN-PLATE-DIR] Every known per-session subfolder a clip's current file
// can live in must be listed here, or output paths built from it (editedDir,
// cleanDir below) silently nest one level too deep. `_clean` (crop-only
// "Apply crop" output) and `burn-edited` (initial pipeline auto-burn
// deliverable) were both added after this allow-list existed and never
// backfilled into it: re-editing a clip whose file/rawFile already sat in
// EITHER of those (e.g. crop-only applied once, then Apply crop + subs; or
// editing a clip whose very first render auto-burned into burn-edited/)
// computed sessionRootFor('.../_clean' or '.../burn-edited') as that folder
// itself (unrecognized → falls through to clipDir), landing the next output
// nested one level too deep (e.g. `burn-edited/edited/`) instead of the
// session's real top-level folder — confirmed present on disk in a real
// session (`.../burn-edited/edited/`).
// [TIDY-SESSION] New names first; burn-edited/_clean are the pre-2.4.7 names
// of subtitle/ and crop-*/ and must keep resolving for old sessions.
const SESSION_CLIP_SUBDIRS = new Set(['raw', 'subtitle', 'edited', 'efek', 'crop-biasa', 'crop-gaming', 'hasil', 'burn-edited', '_clean']);
function sessionRootFor(clipDir) {
  const name = path.basename(clipDir);
  return SESSION_CLIP_SUBDIRS.has(name) ? path.dirname(clipDir) : clipDir;
}
// [OPEN-HASIL] Where exportToUserFolder puts a session's finished clips:
// <export base>/<session>/hasil — same base rules as deliveredClipFor below.
function hasilDirFor(cfg, sessionRoot) {
  if (typeof sessionRoot !== 'string' || !sessionRoot) return null;
  let base = typeof cfg?.exportPath === 'string' ? cfg.exportPath.trim() : '';
  if (base === '~' || base.startsWith('~/') || base.startsWith('~\\')) base = path.join(os.homedir(), base.slice(1));
  if (!base || !path.isAbsolute(base)) base = path.dirname(sessionRoot);
  return path.join(base, path.basename(sessionRoot), 'hasil');
}

// [REVEAL-CLIP] The file the Caption Editor's "Finder" button should highlight:
// the delivered copy of THIS clip — <export>/<session>/hasil/NN-*.ext, where
// exportToUserFolder puts it (same base rules: custom export path, "~", or the
// session's parent when none) — else the clip's own file. Returns null unless
// the result is an existing regular file, so the caller can only ever reveal a
// real clip. Reported on 2.4.22: the button opened the export ROOT instead.
function deliveredClipFor(cfg, clipFile, clipIndex) {
  if (typeof clipFile !== 'string' || !clipFile) return null;
  let st;
  try { st = fs.statSync(clipFile); } catch { return null; }
  if (!st.isFile()) return null;
  const sessionRoot = sessionRootFor(path.dirname(clipFile));
  let base = typeof cfg?.exportPath === 'string' ? cfg.exportPath.trim() : '';
  if (base === '~' || base.startsWith('~/') || base.startsWith('~\\')) base = path.join(os.homedir(), base.slice(1));
  if (!base || !path.isAbsolute(base)) base = path.dirname(sessionRoot);
  const hasil = path.join(base, path.basename(sessionRoot), 'hasil');
  if (Number.isInteger(clipIndex) && clipIndex >= 0) {
    const nn = String(clipIndex + 1).padStart(2, '0');
    const ext = path.extname(clipFile).toLowerCase();
    let best = null, bestT = -1;
    let names = [];
    try { names = fs.readdirSync(hasil); } catch { /* nothing delivered there */ }
    for (const name of names) {
      if (!name.startsWith(`${nn}-`) || path.extname(name).toLowerCase() !== ext) continue;
      const p = path.join(hasil, name);
      try { const s = fs.statSync(p); if (s.isFile() && s.mtimeMs > bestT) { best = p; bestT = s.mtimeMs; } } catch { /* vanished */ }
    }
    if (best) return best;
  }
  return clipFile;
}

// ─── [EXPORT-PATH] Default export folder ──────────────────
// Reported: "custom folder untuk output tidak works di setting". Three real
// defects behind that, all fixed here + at the call sites:
//   1. The copy ran ONLY at the end of a full runPipeline. Everything the user
//      actually finishes with — Editor Apply, batch re-render — wrote into the
//      session dir and was never copied out, so the chosen folder stayed empty.
//   2. The guard was `if (exportPath && fs.existsSync(exportPath))`: a folder
//      that had been moved/renamed/unmounted (or one on an external drive not
//      yet mounted) made the whole copy vanish with NO log line at all. Now we
//      create it when missing and report every failure with its real cause.
//   3. Failures were swallowed into one vague yellow line with no path/reason.
//
// [EXPORT-PATH-HANG] Reported: clips render successfully but "never come
// out" when Default Export Path points at an external SSD/HD — root-caused
// to this function's fs.mkdirSync/fs.copyFileSync being fully SYNCHRONOUS
// with NO timeout, unlike every subprocess call elsewhere in this file
// (yt-dlp, ffmpeg — all guarded by stallMs/timeoutMs). Worse: runPipeline,
// apply-crop, and render-edit all call this DIRECTLY on Electron's single-
// threaded main process, not a worker — a sync fs call blocking on an
// unresponsive device (asleep, mid-disconnect, a stalled USB/exFAT
// controller) freezes the ENTIRE app, not just this copy step, and it
// blocks BEFORE runPipeline's own `prog('Done', …)` ever fires — so the
// renderer never learns the run finished, even though the files already
// exist safely in the internal session folder. Internal-drive exports never
// showed this because a local SSD/HDD essentially never stalls a syscall
// for multiple seconds; external media routinely does (power-saving sleep,
// a cable knocked loose, a spun-down platter). Wrapping each fs op in a
// timeout can't fix a genuinely dead device, but it turns "the whole app
// hangs forever" into "one copy step fails after N seconds, pipeline still
// finishes, clips still show up from the session folder" — the exact
// difference between the reported symptom and safe degraded behaviour.
const EXPORT_MKDIR_TIMEOUT_MS = 15000;
const EXPORT_COPY_TIMEOUT_MS = 60000;
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    // [TIMEOUT-CODE] Callers test the code, never the text (the text holds paths).
    const t = setTimeout(() => reject(Object.assign(new Error(`${label} timeout setelah ${Math.round(ms / 1000)}s (drive lambat/tidur/terputus?)`), { code: 'ETIMEDOUT' })), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// "D:\\" on Windows, "/Volumes/Name" for a mounted drive on macOS, else the
// system drive. For messages only.
function driveLabel(p) {
  const abs = path.resolve(String(p || ''));
  const vol = /^\/Volumes\/[^/]+/.exec(abs);
  if (vol) return vol[0];
  const root = path.parse(abs).root;
  return root && root !== '/' ? root : 'drive sistem';
}

// [EXPORT-ATOMIC] Copy to a private .part file, rename it into place on
// success. A timed-out copy keeps running in the background; when it settles
// only its own .part file is removed — never the final name, which a later
// successful export (Apply on the same clip) may own by then.
// [EXPORT-NO-DOUBLE-SPACE] The work now lives in the output folder, so every
// exported clip has a second name on the SAME drive. Measured on APFS with df:
// Node's COPYFILE_FICLONE silently made a FULL copy (FICLONE_FORCE -> ENOSYS),
// while `cp -c` (clonefile) and a hard link cost 0 MB. macOS: clone with
// /bin/cp -c — independent copy-on-write files, so editing the export never
// touches the session file. Windows: hard link (NTFS has no clone; the app
// never rewrites a session clip in place — every render gets a new name).
// Anything that fails (exFAT, another volume) falls back to a plain copy.
let macClone = (src, dst) => new Promise((resolve, reject) => {
  require('child_process').execFile('/bin/cp', ['-c', src, dst], { timeout: 120000 }, (e) => (e ? reject(e) : resolve()));
});
function __setMacClone(fn) { const prev = macClone; macClone = fn; return () => { macClone = prev; }; }
async function cloneOrCopy(src, dst) {
  if (process.platform === 'darwin') {
    try { await macClone(src, dst); return; } catch { await fs.promises.unlink(dst).catch(() => {}); }
  } else if (process.platform === 'win32') {
    try { await fs.promises.link(src, dst); return; } catch { /* other volume / FAT / not permitted */ }
  }
  await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_FICLONE);
}

async function copyFileAtomic(src, dest, timeoutMs, label) {
  const part = `${dest}.part-${process.pid}-${Date.now()}`;
  const copying = cloneOrCopy(src, part);
  try {
    await withTimeout(copying, timeoutMs, label);
  } catch (e) {
    copying.catch(() => {}).finally(() => fs.promises.unlink(part).catch(() => {}));
    throw e;
  }
  // [AV-RENAME-RETRY] Windows Defender briefly locks a file it is scanning,
  // so renaming a just-written .part can fail with EPERM/EBUSY/EACCES. Retry
  // a few times (~1.5 s total) before giving up on this clip's export.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(part, dest);
      return;
    } catch (e) {
      if (attempt < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) {
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      await fs.promises.unlink(part).catch(() => {});
      throw e;
    }
  }
}

// Names in `dir` that are this app's exports of clip `nn` with extension
// `ext` ("03-Judul.mp4", "03-Judul-1.mp4"). Never throws.
async function ownClipExports(dir, nn, ext) {
  try {
    const names = await withTimeout(fs.promises.readdir(dir), EXPORT_MKDIR_TIMEOUT_MS, 'Membaca folder ekspor');
    return names.filter((n) => n.startsWith(`${nn}-`) && path.extname(n).toLowerCase() === String(ext).toLowerCase());
  } catch { return []; }
}

// Returns { dir, copied, error } — never throws, so an export problem can never
// fail a render that already succeeded.
async function exportToUserFolder(cfg, files, sessionDir, log = () => {}) {
  // `config.json` is a plain user-editable file and nothing validates this
  // field on the way in, so it can be anything. An unvalidated value did not
  // fail loudly — it "succeeded" into a folder the user could never find:
  //   "folder-saya"  → relative to Electron's cwd, i.e. C:\Program Files\… in
  //                    a packaged app (or / on macOS)
  //   "~/export"     → a directory named literally "~", since nothing expands it
  //   {a:1}          → a directory named "[object Object]"
  // All three then logged the green success line.
  const rawExport = cfg?.exportPath;
  // A corrupt, non-string value is refused (it used to become "[object Object]").
  if (rawExport != null && typeof rawExport !== 'string') return { dir: null, copied: 0, error: null };
  let base = typeof rawExport === 'string' ? rawExport.trim() : '';
  if (!base) {
    // [HASIL-DEFAULT] No output folder set (user's choice): the session still
    // gets its own hasil/ in the default folder, same layout either way.
    if (!sessionDir) return { dir: null, copied: 0, error: null };
    base = path.dirname(sessionRootFor(sessionDir));
  }
  if (base === '~' || base.startsWith('~/') || base.startsWith('~\\')) {
    base = path.join(os.homedir(), base.slice(1));
  }
  if (!path.isAbsolute(base)) {
    const msg = `⚠ Folder ekspor harus jalur absolut (dapat: "${base}"). File tetap ada di folder sesi.`;
    log(msg, 'yellow');
    return { dir: null, copied: 0, error: msg, fatal: true };
  }
  const list = (Array.isArray(files) ? files : [files]).filter(f => f && fs.existsSync(f));
  if (!list.length) return { dir: null, copied: 0, error: null };
  // Group per session so repeated runs don't pile into one flat folder — same
  // layout the original runPipeline copy used.
  const sessionRoot = sessionDir ? sessionRootFor(sessionDir) : null;
  // [TIDY-SESSION] <output>/<session>/hasil/ — one ready-to-upload file per
  // clip. When the session itself lives in the output folder (the normal
  // case now), that is simply its own hasil/ subfolder.
  const destDir = sessionRoot ? path.join(base, path.basename(sessionRoot), 'hasil') : base;
  // Exporting INTO the session we are exporting FROM makes every clip copy
  // itself next to itself: the collision loop appends -1, then -2 on the next
  // run, and the duplicates surface in the gallery as real clips. Reachable in
  // one click, because "open output folder" shows the user precisely the
  // parent directory that triggers this.
  if (sessionRoot && path.resolve(destDir) === path.resolve(sessionRoot)) {
    const msg = '⚠ Folder ekspor sama dengan folder sesi — dilewati (file sudah ada di sana).';
    log(msg, 'yellow');
    return { dir: null, copied: 0, error: null };
  }
  try {
    // [DRIVE-ROOT-EPERM] ensureDir: an existing D:\ root throws EPERM on mkdir.
    await require('./work-root').ensureDir(destDir, EXPORT_MKDIR_TIMEOUT_MS);
  } catch (e) {
    const msg = `⚠ Folder ekspor tidak bisa dibuat: ${base} — ${e?.message || e}. File tetap ada di folder sesi.`;
    log(msg, 'yellow');
    return { dir: null, copied: 0, error: msg, fatal: true };
  }
  // [EXPORT-TITLE] Name the exported copy from the clip's CURRENT title.
  // The session filename is stamped once, at render time, from whatever the
  // title was then (`${NN}-${slugify(c.title)}.mp4`) — so a user who later
  // regenerates or edits the headline got a file still carrying the old one,
  // which is exactly what was reported. The session file deliberately keeps
  // its original name: the gallery, the preview, the caption editor and every
  // re-render all reference it by path, and renaming it out from under them is
  // how a clip disappears from the UI. The export copy has no such
  // constraint — nothing points at it — so that is where the fresh title goes.
  // Reads report.json (which now persists edited titles — see clip-report.js
  // [META-PERSIST]); on any problem it falls back to the original basename,
  // because a naming nicety must never cost the user their export.
  const titleByFile = new Map();
  if (sessionRoot) {
    try {
      const rep = JSON.parse(fs.readFileSync(SF.reportPathFor(sessionRoot), 'utf8'));
      (rep?.clips || []).forEach((c, i) => {
        const t = String(c?.title || '').trim();
        if (!t) return;
        const nn = String(i + 1).padStart(2, '0');
        for (const key of [c.file, c.rawFile]) {
          if (key) titleByFile.set(path.resolve(key), `${nn}-${slugify(t)}`);
        }
      });
    } catch { /* no report / unreadable — keep original names */ }
  }
  let copied = 0, firstErr = null, fatal = false;
  for (const f of list) {
    try {
      // Never clobber an earlier export of the same name (re-renders reuse
      // filenames): suffix -1, -2, … instead.
      const ext = path.extname(f);
      const stem = titleByFile.get(path.resolve(f)) || path.basename(f, ext);
      let dest = path.join(destDir, stem + ext);
      // Belt-and-braces against self-copy for any destDir that resolves onto
      // the file itself (e.g. no sessionDir was passed).
      if (path.resolve(dest) === path.resolve(f)) continue;
      // [EXPORT-REPLACE] In a session's export folder, "NN-…<ext>" files are
      // this app's exports of clip NN. A new export of that clip replaces them
      // (also one under an old title, or an old "-1" copy) — reported: the
      // folder held clip 03 twice after an Apply. Anything else is never
      // clobbered.
      const nn = /^(\d{2,3})-/.exec(stem)?.[1];
      const own = nn ? await ownClipExports(destDir, nn, ext) : [];
      if (!own.includes(path.basename(dest))) {
        let n = 1;
        for (; fs.existsSync(dest) && n < 1000; n++) dest = path.join(destDir, `${stem}-${n}${ext}`);
        // Falling through the loop used to silently OVERWRITE stem-999, which
        // contradicts the never-clobber contract. Report instead.
        if (fs.existsSync(dest)) throw new Error(`terlalu banyak salinan bernama sama (${stem}${ext})`);
      }
      // A timed-out copy never leaves a truncated clip under the final name;
      // the rename replaces this clip's own earlier export in one step.
      await copyFileAtomic(f, dest, EXPORT_COPY_TIMEOUT_MS, `Menyalin ${stem}${ext}`);
      // Only once the new file is in place: drop this clip's other versions.
      for (const name of own) {
        if (name !== path.basename(dest)) await fs.promises.unlink(path.join(destDir, name)).catch(() => {});
      }
      copied++;
    } catch (e) {
      if (!firstErr) firstErr = e?.message || String(e);
      // A stalled drive, not a one-off name problem: retrying just waits again.
      if (e?.code === 'ETIMEDOUT') fatal = true;
    }
  }
  if (firstErr) {
    const msg = `⚠ Sebagian file gagal disalin ke folder hasil (${copied}/${list.length}) — ${firstErr}`;
    log(msg, 'yellow');
    return { dir: destDir, copied, error: msg, fatal };
  }
  log(`▶ ${copied} file disalin ke folder hasil: ${destDir}`, 'lime');
  return { dir: destDir, copied, error: null };
}

// [EXPORT-PER-CLIP] Export each clip the moment it is rendered. The only
// export call used to sit after the whole render loop, so a run that ended in
// an error or a cancel after N clips had rendered exported NONE of them —
// found in real sessions: clips in raw/, no report.json, export folder empty.
function createClipExporter(cfg, sessionDir, log = () => {}) {
  const done = new Set();
  let dir = null, copied = 0, error = null, lastMsg = null, gaveUp = false;
  // Per-clip "1 file disalin" lines are dropped (runPipeline logs one total at
  // the end); each distinct problem is shown once, as soon as it happens.
  const quietLog = (msg, kind) => {
    if (/^▶/.test(msg) || msg === lastMsg) return;
    lastMsg = msg; log(msg, kind);
  };
  return {
    async exportOne(file) {
      // [EXPORT-GIVE-UP] After the export drive failed outright (unreachable,
      // stalled, bad path), every further clip would pay its own 15-60 s
      // timeout while holding a render slot. Stop trying for this run.
      if (!file || gaveUp) return;
      const key = path.resolve(file);
      if (done.has(key)) return;
      done.add(key);
      const r = await exportToUserFolder(cfg, [file], sessionDir, quietLog);
      if (r.dir) dir = r.dir;
      copied += r.copied;
      if (r.error && !error) error = r.error;
      if (r.fatal) gaveUp = true;
    },
    summary() { return { dir, copied, error }; },
  };
}

// ─── Smart face tracking sidecar ─────────────────────────
// Spawns the Python sidecar (sidecar/tracker/main.py) via the dev venv,
// pipes the analysis job in as JSON, streams {type:progress} lines back to
// onProgress, and resolves with the final {type:result, keyframes:[...]}
// trackPlan. Returns null (with a warning logged) when the venv isn't
// available yet — the caller then falls back to the default center crop
// so pipeline still completes.
function devTrackerPaths() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const pyRel = process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
  return {
    python: path.join(repoRoot, 'sidecar', 'tracker', pyRel),
    main:   path.join(repoRoot, 'sidecar', 'tracker', 'main.py'),
    cwd:    path.join(repoRoot, 'sidecar', 'tracker'),
  };
}
function trackerPaths() {
  if (_testTrackerPaths) return _testTrackerPaths;
  const dev = devTrackerPaths();
  if (fs.existsSync(dev.python) && fs.existsSync(dev.main)) return dev;
  try {
    const bundle = require('./tracker-bundle');
    if (bundle.isInstalled()) return bundle.bundlePaths();
  } catch { /* electron not available (unit tests) */ }
  return dev; // return dev paths as the "expected" location for error messages
}
function trackerAvailable() {
  const { python, main } = trackerPaths();
  return fs.existsSync(python) && fs.existsSync(main);
}
// [TRACKER-ACCEL-CAP] How many tracker workers can usefully run at once.
// Extracted to a pure function so the pre-warm gate below and the real
// CLIP_CONCURRENCY calculation can never disagree about when exactly one
// worker will run for the whole job.
//
// This used to be a boolean (trackingParallelSafeOn) that trusted the
// ENCODER's verdict as a stand-in for "does this machine have a usable
// accelerator for face tracking" — two unrelated questions, conflated because
// darwin's videotoolbox and win32's nvenc both happen to mean "there is a real
// accelerator" on THOSE platforms. It does not generalise: measured on a real
// reporting machine (Ryzen 3 7320U, Radeon 610M), the ENCODER lost its own
// race against libx264 and got demoted to 'software' (see
// hw-encoder-calibration.json's own verdict), while the TRACKER's DirectML
// session was present, bound, and 1.7-1.9x faster than CPU for the SCRFD
// detector — so the boolean gate serialized a machine that could have run 2
// at a time. 12 clips at 60s each took 20-30 minutes because of this.
//
// The DML path earns its OWN cap, separately measured on that same machine
// (multi-process, 25 inferences @ 640x640): N=2 peaks at 1.70-1.89x in both
// idle and CPU-loaded conditions; N=3 and N=4 regress on throughput AND roughly
// double the per-inference latency (153ms -> 362ms) even where aggregate
// throughput holds flat. This is a DEVICE ceiling (an iGPU sharing memory
// bandwidth), not a core-count one — raising it needs a new measurement on a
// faster device, not a guess.
function trackerAccelCapFor({ platform, hw, dmlAvailable, totalMemBytes }) {
  if (platform === 'win32') {
    const total = Number(totalMemBytes);
    const lowMemoryWindows = Number.isFinite(total) && total > 0
      && total <= LOW_SPEC_WINDOWS_TOTAL_BYTES;
    return dmlAvailable && !lowMemoryWindows ? 2 : 1;
  }
  if (platform === 'darwin') return 4;                        // CoreML/ANE — measured 2026-07-19, 1.96x peak
  return 1;                                                     // no evidence of a usable accelerator — serialize
}

// Pre-warming hides the first tracker model load behind earlier AI stages, but
// it also makes the tracker resident while those stages run. On an 8 GB Windows
// machine that stage overlap is the wrong trade: defer the model until the UI
// actually enters Face Tracking. Unknown memory evidence fails open. Windows
// DirectML cap 2 may still pre-warm one sidecar because resolveTrackerWorker()
// claims exactly one warmed worker; the second render slot spawns fresh.
function trackerPrewarmAllowedFor({ platform, totalMemBytes, cap }) {
  const workerCap = Math.max(1, Math.floor(Number(cap) || 1));
  const total = Number(totalMemBytes);
  const lowMemoryWindows = platform === 'win32'
    && Number.isFinite(total) && total > 0
    && total <= LOW_SPEC_WINDOWS_TOTAL_BYTES;
  if (lowMemoryWindows) return false;
  if (workerCap === 1) return true;
  return platform === 'win32' && workerCap === 2;
}

// [TRACKER-ACCEL-CAP] Only meaningful on win32 today: darwin's cap comes from
// the platform alone (CoreML), and nvenc already implies a real dGPU without
// needing this probe. Injectable spawnSync so the decision logic is testable
// without a real Python or a real DirectML-capable machine.
//
// Returns true/false when the probe RAN (real evidence either way), or null
// when it could not (missing python, timeout, crash) — mirrors raceEncoders()'s
// own rule that a failed probe is not evidence AGAINST the accelerator, so a
// machine whose only crime was a slow launch does not get serialized for it.
const TRK_ACCEL_PROBE_TIMEOUT_MS = 15000;
function probeDmlAvailable(pythonPath, spawnSyncFn) {
  try {
    const spawnSync = spawnSyncFn || require('child_process').spawnSync;
    const r = spawnSync(pythonPath,
      ['-c', 'import onnxruntime as ort; print(",".join(ort.get_available_providers()))'],
      { encoding: 'utf8', timeout: TRK_ACCEL_PROBE_TIMEOUT_MS, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return /DmlExecutionProvider/.test(r.stdout || '');
  } catch { return null; }
}

const TRK_ACCEL_CACHE_FILE = 'tracker-accel-calibration.json';
function trkAccelCacheKey(trackerVersion) {
  // Bundle version, not just platform/arch: the wheel set (and so DML support)
  // can change between tracker-runtime releases, and a stale verdict from an
  // old bundle must not silently answer for a new one.
  return [process.platform, process.arch, trackerVersion].join('|');
}

let _trkAccelCacheDir = null;
let _trkAccelDmlCache = null;
function __setTrackerAccelCacheDir(dir) {
  if (dir === _trkAccelCacheDir) return;
  _trkAccelCacheDir = dir;
  _trkAccelDmlCache = null;
}
// Cached exactly like detectHwEncoder()'s race verdict: probing is a real
// subprocess spawn + Python import, not something to pay on every launch.
function detectTrackerAccel() {
  if (process.platform !== 'win32') return { dmlAvailable: false };   // only relevant path today
  if (_trkAccelDmlCache !== null) return { dmlAvailable: _trkAccelDmlCache };
  if (!trackerAvailable()) return { dmlAvailable: false };
  let version = 'dev';
  try { version = require('./tracker-bundle').MANIFEST.version; } catch {}
  const key = trkAccelCacheKey(version);
  const dir = _trkAccelCacheDir;
  const file = dir ? path.join(dir, TRK_ACCEL_CACHE_FILE) : null;
  let entry = null;
  if (file) { try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  if (entry && entry.key === key && typeof entry.at === 'number'
      && typeof entry.dmlAvailable === 'boolean') {
    try {
      const { CACHE_TTL_MS } = require('./hw-accel');
      if (entry.at <= Date.now() && Date.now() - entry.at <= CACHE_TTL_MS) {
        _trkAccelDmlCache = entry.dmlAvailable;
        return { dmlAvailable: _trkAccelDmlCache };
      }
    } catch {}
  }
  const { python } = trackerPaths();
  const probed = probeDmlAvailable(python);
  if (probed === null) return { dmlAvailable: false };   // no evidence -> today's (safe) behaviour, not cached
  if (file) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ key, dmlAvailable: probed, at: Date.now() }, null, 2));
    } catch {}
  }
  _trkAccelDmlCache = probed;
  return { dmlAvailable: probed };
}
function __setTrackerAccelDml(v) { _trkAccelDmlCache = v; }

// [TRACKER-PREWARM] Resolve which tracker worker a render-pool slot should
// use: the pre-warmed one (claimed at most once, whichever slot asks first —
// the claim is set synchronously before the await, so no two concurrent
// slots can both win it) if it succeeds, or a freshly spawned one otherwise.
// Extracted to a pure-ish function so the "claim once, fall back on failure"
// contract is unit-testable without a real render pipeline or subprocess.
async function resolveTrackerWorker(prewarmedPromise, claimState, spawnFresh) {
  if (prewarmedPromise && !claimState.claimed) {
    claimState.claimed = true;
    try { return await prewarmedPromise; } catch { /* fall through to fresh */ }
  }
  return spawnFresh();
}

// Test seam: point trackerPaths() at a fake sidecar (e.g. Node itself running
// a fixture script) so TrackerWorker's real spawn/handshake/job protocol can
// be exercised without a real Python runtime installed.
let _testTrackerPaths = null;
function __setTrackerPaths(paths) { _testTrackerPaths = paths; }
function formatToAspect(fmt) {
  return fmt === 'landscape' ? '16:9' : fmt === 'square' ? '1:1' : '9:16';
}
// [TRACKER-POOL] The sidecar process is now PERSISTENT (main.py loops reading
// one job per stdin line; Detector/Landmarker are cached module-level
// singletons in pipeline.py) — model load/compile is the single biggest
// fixed cost per analyze() call (~7-8s, measured), so paying it once per
// WORKER rather than once per CLIP matters a lot once CLIP_CONCURRENCY runs
// several clips at a time. One TrackerWorker is created per concurrency slot
// (see runPipeline's clip worker pool below) and reused for every clip that
// slot processes, instead of spawning+loading a fresh process per clip.
// [TRACKER-WATCHDOG] Two failure modes must never hang the whole batch:
//   1. Legacy runtime: bundle 0.1.0's main.py does ONE `sys.stdin.read()`
//      (blocks until EOF) while this class keeps stdin open to send more
//      jobs — both sides wait forever. New sidecars announce themselves
//      with {"type":"ready","protocol":2} at startup; if that line doesn't
//      arrive within READY_TIMEOUT the runtime is treated as legacy and
//      every job runs in a fresh per-job process with stdin closed after
//      the write (the old protocol), which the old bundle understands.
//   2. A genuinely wedged/crashed analysis: an idle watchdog (no stdout at
//      all for IDLE_TIMEOUT) kills the child and rejects that one job —
//      the caller already falls back to centre crop and the batch moves on.
//
// IDLE_TIMEOUT must be GENEROUS: runtime 0.2.0's analysis is silent from the
// job write until ~10% through detection (heavy model import + audio extract
// + scene detection emit nothing), which under CLIP_CONCURRENCY-way CPU
// contention can exceed several minutes for a 60s clip. A 120s watchdog
// killed EVERY job right before its first progress line — whole batches
// silently rendered as centre crops (2026-07-18 incident). Runtime 0.2.1+
// emits early-stage heartbeats, but the timeout stays sized for 0.2.0.
const TRACKER_READY_TIMEOUT_MS = Number(process.env.TRACKER_READY_TIMEOUT_MS || 15000);
const TRACKER_IDLE_TIMEOUT_MS  = Number(process.env.TRACKER_IDLE_TIMEOUT_MS  || 600000);

class TrackerProcessError extends Error {
  constructor(message, code = 'PROCESS') {
    super(message || 'tracker process failed');
    this.name = 'TrackerProcessError';
    this.code = code;
  }
}

class TrackerFailurePolicy {
  constructor() {
    this.crashes = 0;
    this.disabled = false;
  }
  record(error) {
    if (!(error instanceof TrackerProcessError)) {
      return { centreFallback: true, restart: false, disableRemaining: false };
    }
    this.crashes += 1;
    if (this.crashes === 1) {
      return { centreFallback: true, restart: true, disableRemaining: false };
    }
    this.disabled = true;
    return { centreFallback: true, restart: false, disableRemaining: true };
  }
}

class TrackerWorker {
  constructor() {
    this._queue = [];   // FIFO of {resolve, reject, onProgress, payload, timer} — one per in-flight job
    this._spawn();
  }
  _spawn() {
    const { python, main, cwd } = trackerPaths();
    // [TRACKER-SPAWN-UNKNOWN] spawn() THROWS synchronously for Windows'
    // `spawn UNKNOWN` (AV blocking the unsigned bundled python.exe) — only
    // ENOENT/EACCES/EAGAIN/EMFILE/ENFILE arrive via 'error'. Uncaught, this
    // escaped `new TrackerWorker()` in the render-pool slot and failed the
    // WHOLE render with a bare "spawn UNKNOWN". Park the error on the worker
    // instead so run() rejects and TrackerFailurePolicy falls back to centre
    // crop like any other sidecar crash.
    let ch;
    try {
      ch = spawn(python, [main], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.child = null;
      this._dead = true;
      this._spawnError = new TrackerProcessError(
        `${e?.message || 'tracker spawn failed'}${spawnFailureHint(e, python)}`, 'SPAWN');
      return;
    }
    this._spawnError = null;
    this.child = ch;
    activeChildren.add(ch);
    // [DISK-LEAK] Pin this runtime for as long as the sidecar is alive, so the
    // stale-version sweep in tracker-bundle.js can never pull the interpreter
    // out from under a running analysis. Released exactly once per spawn:
    // 'error' and 'close' can both fire for the same child, and the pin is
    // refcounted across the CLIP_CONCURRENCY workers that share this path.
    markBundleInUse(python);
    let released = false;
    const releaseOnce = () => { if (released) return; released = true; releaseBundleInUse(python); };
    ch.on('close', releaseOnce);
    ch.on('error', releaseOnce);
    this._buf = '';
    this._errBuf = '';
    this._dead = false;
    this._sawLine = false;   // any valid JSON line ever received from this child
    ch.stdout.on('data', (d) => { if (this.child === ch) this._onStdout(d); });
    ch.stderr.on('data', (d) => { if (this.child === ch) this._errBuf += d.toString(); });
    const failCurrentProcess = (error) => {
      if (this.child !== ch) return;
      this._dead = true;
      while (this._queue.length) {
        const q = this._queue[0];
        this._settle(q, q.reject, error);
      }
    };
    // EPIPE is emitted by the stdin stream asynchronously, not by ChildProcess
    // and not necessarily by stdin.write(). Without this listener Node treats
    // it as an uncaught exception and Electron's main process can terminate.
    ch.stdin.on('error', (e) => failCurrentProcess(new TrackerProcessError(e?.message || 'tracker stdin failed', e?.code || 'EPIPE')));
    ch.stdout.on('error', (e) => failCurrentProcess(new TrackerProcessError(e?.message || 'tracker stdout failed', e?.code || 'STDOUT')));
    ch.stderr.on('error', (e) => failCurrentProcess(new TrackerProcessError(e?.message || 'tracker stderr failed', e?.code || 'STDERR')));
    ch.on('close', (code, signal) => {
      activeChildren.delete(ch);
      if (this.child !== ch) return;   // superseded by a respawn — stale event
      const detail = this._errBuf.trim() || `tracker worker exited (${code ?? signal ?? 'unknown'})`;
      const oom = code === 137 || /out of memory|bad alloc|memoryerror/i.test(detail);
      failCurrentProcess(new TrackerProcessError(detail, oom ? 'OOM' : 'EXIT'));
    });
    ch.on('error', (e) => {
      failCurrentProcess(new TrackerProcessError(
        `${e?.message || 'tracker spawn failed'}${spawnFailureHint(e, python)}`, e?.code || 'SPAWN'));
    });
    // Legacy-runtime detection: a protocol-2 sidecar emits its ready line
    // immediately (heavy imports are deferred until the first job), so a
    // silent child almost certainly means the old single-job bundle.
    if (!TrackerWorker.legacy) {
      this._readyTimer = setTimeout(() => {
        if (this._dead || this._sawLine) return;
        TrackerWorker.legacy = true;
        const pending = this._queue.splice(0);
        this.kill();
        // Re-run anything already queued through the legacy path instead of
        // failing those clips.
        for (const q of pending) {
          clearTimeout(q.timer);
          TrackerWorker._runLegacy(q.payload, q.onProgress).then(q.resolve, q.reject);
        }
      }, TRACKER_READY_TIMEOUT_MS);
      this._readyTimer.unref?.();
    }
  }
  _settle(entry, fn, value) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    const index = this._queue.indexOf(entry);
    if (index >= 0) this._queue.splice(index, 1);
    fn(value);
    return true;
  }
  _armIdle(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      // Drop only this job, then recycle the child so the next clip gets a
      // clean process. The caller's catch falls back to centre crop.
      this._settle(entry, entry.reject, new TrackerProcessError(
        `tracker idle >${Math.round(TRACKER_IDLE_TIMEOUT_MS / 1000)}s — killed (clip falls back to centre crop)`,
        'TIMEOUT'));
      this.kill();
    }, TRACKER_IDLE_TIMEOUT_MS);
    entry.timer.unref?.();
  }
  _onStdout(d) {
    this._buf += d.toString();
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }  // library stdout noise — ignore
      this._sawLine = true;
      if (obj.type === 'ready') { clearTimeout(this._readyTimer); continue; }
      const cur = this._queue[0];
      if (!cur) continue;
      this._armIdle(cur);   // any traffic for the current job resets its watchdog
      if (obj.type === 'progress') cur.onProgress?.(obj);
      else if (obj.type === 'result') this._settle(cur, cur.resolve, obj);
      else if (obj.type === 'error')  this._settle(cur, cur.reject, new Error(obj.message || 'tracker error'));
    }
  }
  static _jobPayload({ video, clipStart, clipEnd, format, asdMode }) {
    return JSON.stringify({
      video,
      clip_start: clipStart,
      clip_end: clipEnd,
      output_aspect: formatToAspect(format),
      // Adaptive runtime scouts at 4fps and refines unstable intervals at this
      // full-density rate. Old runtimes ignore config.adaptive and therefore
      // still receive the quality-safe 12fps value.
      sample_fps: 12,
      // [ASD FIX] The sidecar's active-speaker-detection needs ffmpeg to pull
      // the clip's audio for its loudness heuristic. It used to hardcode the
      // original developer's own Mac path, which silently doesn't exist on
      // any other machine (see asd.py's _resolve_ffmpeg) — extract_audio_rms
      // swallowed the failure and returned all-zero RMS, so speaker score
      // was ALWAYS 0 and split-screen (which requires >=2 *active* speakers)
      // could never trigger on Windows. Passing the app's own already-
      // resolved FFMPEG path is the only reliable cross-machine fix.
      ffmpeg: FFMPEG,
      config: {
        asd_threshold: 0.2, split_screen: true, adaptive: true,
        // [ASD-MODE-CHOICE] User opt-in only — 'blendshape' (MediaPipe, the
        // shipped default since Phase 3a) unless the user explicitly picked
        // the experimental engine in Settings. Never silently defaults to
        // motion_vad: that mode's tuning is still fresh (recalibrated once
        // already after a false-positive speaker bug) and forcing it on
        // every install would turn a beta experiment into an unannounced
        // behaviour change for people who never opted in. Read from
        // pipeline.py's _asd_mode(job_config) — see
        // [[lokaclip-asd-algorithm-reverse-engineered]] for what motion_vad is.
        asd_mode: asdMode === 'motion_vad' ? 'motion_vad' : 'blendshape',
      },
    });
  }
  // Old-protocol fallback: fresh process per job, stdin closed after the
  // write (bundle 0.1.0's `sys.stdin.read()` returns on EOF). Slower (model
  // load per clip) but correct; the real fix is shipping the 0.2.x bundle.
  static _runLegacy(payload, onProgress) {
    return new Promise((resolve, reject) => {
      const { python, main, cwd } = trackerPaths();
      let ch;
      try {
        ch = spawn(python, [main], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {   // [TRACKER-SPAWN-UNKNOWN] see TrackerWorker._spawn
        return reject(new TrackerProcessError(
          `${e?.message || 'tracker spawn failed'}${spawnFailureHint(e, python)}`, 'SPAWN'));
      }
      activeChildren.add(ch);
      markBundleInUse(python);   // see TrackerWorker._spawn
      let buf = '', errBuf = '', done = false, timer = null;
      const finish = (fn, v) => {
        if (done) return; done = true;
        clearTimeout(timer);
        activeChildren.delete(ch);
        releaseBundleInUse(python);
        killTree(ch);   // [WIN-KILL-TREE]
        fn(v);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(reject, new Error(
          `tracker idle >${Math.round(TRACKER_IDLE_TIMEOUT_MS / 1000)}s (legacy runtime) — killed`)), TRACKER_IDLE_TIMEOUT_MS);
        timer.unref?.();
      };
      arm();
      ch.stdout.on('data', (d) => {
        buf += d.toString();
        arm();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === 'progress') onProgress?.(obj);
          else if (obj.type === 'result') finish(resolve, obj);
          else if (obj.type === 'error')  finish(reject, new Error(obj.message || 'tracker error'));
        }
      });
      ch.stderr.on('data', (d) => { errBuf += d.toString(); });
      ch.on('close', () => { finish(reject, new Error(errBuf.trim() || 'tracker exited without result')); });
      ch.on('error', (e) => finish(reject, e));
      try { ch.stdin.write(payload + '\n'); ch.stdin.end(); }
      catch (e) { finish(reject, e); }
    });
  }
  run(job, onProgress) {
    const payload = TrackerWorker._jobPayload(job);
    if (TrackerWorker.legacy) return TrackerWorker._runLegacy(payload, onProgress);
    if (this._dead) this._spawn();   // self-heal after a watchdog kill/crash
    if (this._spawnError) return Promise.reject(this._spawnError);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress, payload, timer: null, settled: false };
      this._queue.push(entry);
      this._armIdle(entry);
      try { this.child.stdin.write(payload + '\n'); }
      catch (e) {
        this._settle(entry, reject, new TrackerProcessError(e?.message || 'tracker write failed', e?.code || 'WRITE'));
      }
    });
  }
  kill() {
    if (this._dead) return;
    this._dead = true;
    clearTimeout(this._readyTimer);
    try { this.child.stdin.end(); } catch {}
    killTree(this.child);   // [WIN-KILL-TREE]
  }
}
TrackerWorker.legacy = false;

// [BOT-CHECK] YouTube demanding a signed-in session for this IP. Distinct from
// a stale yt-dlp (which the regex below also matches, deliberately — a refresh
// is cheap and sometimes IS the fix): no yt-dlp version solves this one, only
// cookies do.
function looksLikeBotCheck(raw) {
  return /sign ?in to confirm|not a bot|confirm you.?re not a bot|cookies are no longer valid|--cookies-from-browser/i
    .test(String(raw || ''));
}

// [AGE-GATE] YouTube refusing an AGE-RESTRICTED video to an anonymous session.
// Shares the "Sign in to confirm" prefix with the bot check above and therefore
// always matches it too — so every caller must test this one FIRST. The remedy
// overlaps (both need cookies) but the diagnosis and the fallbacks do not:
// waiting, a different network and a VPN all lift rate limiting and none of
// them lift an age gate, and the cookies have to come from an account that can
// actually open the video, not merely from one that is signed in.
function looksLikeAgeRestricted(raw) {
  return /sign ?in to confirm your age|age.?restricted|inappropriate for some users/i
    .test(String(raw || ''));
}

// [EMBED-UNAVAILABLE] YouTube saying the video cannot be had: the bare "Video
// unavailable" the embedded client returns when the owner blocks playback
// outside YouTube (reported on FIFA highlights, I_KDgVKGu6o — public, and
// 1080p with yt-dlp's own client order), plus the specific reasons the other
// clients spell out. The bare form gets one retry on another client; whatever
// remains is explained by videoUnavailableMessage().
function looksLikeVideoUnavailable(raw) {
  return /video unavailable|video is unavailable|content isn.?t available|private video|this video is private|has been removed|no longer available|not made this video available in your country|not available in your country|members-only|join this channel/i
    .test(String(raw || ''));
}

// [EMBED-UNAVAILABLE] What to tell the user once even the retry failed, by
// reason. Always ends at Import: a video they can watch in a browser can be
// saved and brought in as a local file.
function videoUnavailableMessage(raw, site = 'YouTube') {
  const s = String(raw || '');
  const out = 'Kalau kamu bisa menontonnya di browser, download videonya secara manual lalu masukkan lewat tombol Import di kanan atas — semua fitur tetap jalan seperti biasa.';
  if (/content isn.?t available|try again later/i.test(s)) {
    return `${site} sedang membatasi jaringan kamu untuk SEMENTARA ("This content isn't available, try again later") — biasanya karena terlalu banyak permintaan dari koneksi yang sama. Ini bukan soal videonya.\n\nTunggu 15–30 menit lalu coba lagi, atau pindah jaringan (misalnya hotspot HP). Memasang cookies.txt di Settings → Cookies juga sering membantu. ${out}`;
  }
  if (/private video|this video is private/i.test(s)) {
    return `Video ini PRIVAT — ${site} hanya mengizinkan akun yang diberi akses oleh pemiliknya. Aplikasi tidak bisa mengambilnya tanpa izin itu.\n\n${out}`;
  }
  if (/has been removed|no longer available|account associated with this video has been terminated/i.test(s)) {
    return `Video ini sudah dihapus dari ${site} (oleh pemiliknya, atau karena akunnya ditutup), jadi memang tidak bisa diambil lagi.\n\nKalau kamu masih punya salinan videonya, masukkan lewat tombol Import di kanan atas.`;
  }
  if (/not made this video available in your country|not available in your country/i.test(s)) {
    return `Pemilik video ini tidak mengizinkannya diputar di negara kamu, jadi ${site} menolak dari jaringan ini.\n\n${out}`;
  }
  if (/members-only|join this channel|premium members/i.test(s)) {
    return `Video ini khusus member channel — ${site} hanya memberikannya ke akun yang sudah join membership.\n\nPasang cookies.txt dari akun member itu di Settings → Cookies, lalu coba lagi. ${out}`;
  }
  // Reached only after the retry on another client also failed, and that retry
  // is what rescues a public video the owner merely keeps off embeds — so do
  // not blame the owner outright: one browser check tells the two cases apart.
  return `${site} menyatakan video ini tidak tersedia, dan aplikasi sudah mencoba jalur lain tapi tetap ditolak.\n\nCek dulu dengan membuka link-nya di browser:\n• Kalau di browser JUGA tidak bisa diputar — videonya sudah dihapus, diprivat, atau link-nya salah/terpotong. Salin ulang link-nya dari aplikasi YouTube.\n• Kalau di browser BISA diputar — pemiliknya membatasi pemutaran di luar ${site} (sering pada highlight olahraga, siaran TV, dan sebagian video musik). ${out}`;
}

// [COOKIE-SOURCE] The browser-cookie FALLBACK failing to even open the browser's
// own cookie store. This is not a verdict on the download — yt-dlp never got as
// far as talking to YouTube — and it is routine on Windows: Chrome holds an
// exclusive lock on its cookie DB while running (yt-dlp #7271), and recent
// Chrome also encrypts it so an outside reader is refused even when closed.
//
// Two consequences, both of which bit a real user on 2.3.41: this must never be
// reported AS the failure (they were sent to a yt-dlp GitHub issue about a
// cookie database when the actual problem was YouTube demanding a login), and it
// must not stop the search — a locked Chrome says nothing about Edge or Firefox.
//
// [COOKIE-SOURCE-MAC] macOS has two more shapes of this, and missing them in
// 2.4.7 put a raw `Operation not permitted: '…/Cookies.binarycookies'` in the
// error banner of a run whose real problem was a YouTube login demand:
//   * Safari — its cookie jar lives inside the app sandbox container and is
//     TCC-protected, so without Full Disk Access yt-dlp gets EPERM ("[Errno 1]
//     Operation not permitted"). Nothing about the download; we never dialled out.
//   * Chrome — the AES key lives in a Keychain item ("Chrome Safe Storage")
//     whose ACL admits only Chrome itself, so `security find-generic-password`
//     is refused and every v10 cookie stays encrypted. Note yt-dlp EXITS 0 on
//     this one and carries on anonymously, so the only evidence is these lines:
//     "Extracted 0 cookies from chrome (3418 could not be decrypted)".
function looksLikeBrowserCookieBlocked(raw) {
  return /could not copy .{0,40}cookie|cookie database|unable to (open|read|decrypt)[^\n]{0,30}cookie|failed to decrypt|DPAPI|no such table: cookies|permission denied[^\n]{0,40}cookie/i
      .test(String(raw || ''))
    // macOS TCC (Safari, and any store under a protected container).
    || /binarycookies|operation not permitted[^\n]{0,200}cookie/i.test(String(raw || ''))
    // macOS Keychain refusing Chrome's decryption key. `extracted 0 cookies` is
    // deliberately last and deliberately zero-only: a store we read PARTIALLY
    // still gave us a session worth trying.
    || /find-generic-password|cannot decrypt[^\n]{0,30}cookies|no key found|extracted 0 cookies/i
      .test(String(raw || ''));
}

// [COOKIE-SOURCE-WIN] WHY a store looksLikeBrowserCookieBlocked refused us,
// because the remedy differs and the old one-size note ("browser itu sedang
// terbuka… Menutup browser SEPENUHNYA kadang menolong") was wrong for the most
// common Windows case. Reported 2026-10-05: edge failed with
//   ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927
// which is Chrome's App-Bound Encryption (Chrome 127+, Edge followed): the
// cookie key is bound to the browser itself, no other app can decrypt a single
// cookie, and closing the browser changes nothing. A LOCKED Chrome/Edge counts
// as sealed too — closing it only gets yt-dlp as far as that same wall.
//   'mac'        → Keychain ACL / Full Disk Access (see [COOKIE-SOURCE-MAC])
//   'sealed'     → App-Bound Encryption, only cookies.txt helps
//   'locked'     → the browser holds the file open; quitting it can help
//   'unreadable' → anything else
const APP_BOUND_BROWSERS = new Set(['chrome', 'edge']);
function blockedCookieKind(browser, raw, platform) {
  if (platform === 'darwin') return 'mac';
  const s = String(raw || '');
  if (/failed to decrypt with dpapi|app.?bound/i.test(s)) return 'sealed';
  if (platform === 'win32' && APP_BOUND_BROWSERS.has(browser)) return 'sealed';
  if (/could not copy .{0,40}cookie/i.test(s)) return 'locked';
  return 'unreadable';
}

const BLOCKED_COOKIE_REASON = {
  mac: 'diblokir Keychain/Full Disk Access macOS',
  sealed: 'Chrome/Edge versi baru mengunci cookie-nya khusus untuk browser itu sendiri — menutup browser tidak menolong',
  locked: 'browser-nya sedang terbuka, Windows mengunci file cookie-nya',
  unreadable: 'cookie-nya terenkripsi atau tidak bisa dibuka',
};

// The paragraph appended to the age-gate / bot-check messages. `blocked` is
// [{ browser, kind }] from the --cookies-from-browser fallback.
function describeBlockedCookieBrowsers(blocked, platform) {
  if (!blocked.length) return '';
  const text = platform === 'darwin' ? {
    mac: 'macOS tidak mengizinkan aplikasi lain membuka cookie browser: kunci cookie Chrome disimpan di Keychain dan hanya boleh dibuka Chrome sendiri, sedangkan Safari butuh izin Full Disk Access. Menutup browser TIDAK menolong di Mac',
  } : {
    sealed: 'Chrome dan Edge versi baru mengunci cookie-nya supaya hanya bisa dibuka oleh browser itu sendiri, jadi aplikasi lain tidak bisa membacanya sama sekali. Menutup browser TIDAK menolong',
    locked: 'browser itu sedang terbuka sehingga Windows mengunci file cookie-nya. Menutup browser itu SEPENUHNYA lalu coba lagi bisa menolong',
    unreadable: 'cookie-nya terenkripsi atau tidak bisa dibuka',
  };
  const groups = Object.keys(text)
    .map((kind) => [blocked.filter((b) => b.kind === kind).map((b) => b.browser).join(', '), text[kind]])
    .filter(([names]) => names);
  // Name the browsers per reason only when the reasons differ — the head
  // sentence already lists them all.
  const why = groups.length > 1 ? groups.map(([names, t]) => `${names}: ${t}`) : groups.map(([, t]) => t);
  return `\n\nAplikasi sempat mencoba meminjam sesi login dari ${blocked.map((b) => b.browser).join(', ')}, tapi cookie-nya tidak bisa dibaca — ${why.join('. ')}. Jadi cara yang andal tetap cookies.txt di atas.`;
}

// [YTDLP-SELFHEAL] Does this download failure look like a STALE yt-dlp that a
// fresh version would fix? YouTube changes its player/signature
// protocol constantly; when the current yt-dlp can't keep up it fails with one
// of these extraction signatures. Plain 403 and bot checks are deliberately
// excluded: changing player client or cookies handles those, while downloading
// the same yt-dlp release only adds a long delay.
function looksLikeStaleYtdlp(msg) {
  const s = String(msg || '');
  // [SSL-CERT-NOT-STALE] An SSL certificate-verify failure is a LOCAL problem
  // (the machine's CA store, a corporate MITM proxy, antivirus HTTPS scanning,
  // or a wrong system clock) — NOT a stale yt-dlp. But yt-dlp appends "please
  // report this issue … Confirm you are on the latest version using yt-dlp -U"
  // to the SSL error too, which the stale-signature regex below matches on,
  // so without this guard the app pointlessly downloads a fresh 17MB yt-dlp,
  // retries, and hits the exact same local cert failure. Bail out first so the
  // SSL branch in surfaceDownloadError gives the real, actionable remedy.
  if (looksLikeSslCertError(s)) return false;
  // [FOOTER-NOT-SIGNAL] `please report this` was REMOVED from this list. It
  // reads like a stale-version hint but is actually yt-dlp's UNIVERSAL error
  // footer — "please report this issue on …github… . Confirm you are on the
  // latest version using yt-dlp -U" is appended to nearly every ERROR it
  // raises, including permanent ones a fresh binary can NEVER fix: private /
  // unavailable / geo-blocked / members-only videos, DNS/network failures, and
  // the SSL cert error that surfaced this audit. Matching on it made all of
  // those pointlessly download a fresh 17MB yt-dlp and retry before failing
  // anyway — pure wasted time on videos that will never download. Every
  // genuinely stale-specific signature below still fires on its own real
  // token (nsig, signature, unable to extract, player response, the
  // older-than-N-days warning, the Python TypeError), so nothing is lost.
  //
  // "expected string or bytes-like object" = Python TypeError inside yt-dlp
  // (re.* fed None) — the extractor got a YouTube response shape it no longer
  // understands. Only a newer yt-dlp fixes it.
  return /nsig|n-sig|signature|unable to extract|player.*(extract|response)|precondition check failed|older than \d+ days|use the latest version|yt-dlp --update|update to the latest|expected string or bytes-like object/i
    .test(s);
}

// [PLATFORM-LABEL] Every download message in this file used to say "YouTube"
// unconditionally, because YouTube was the only source when they were written.
// A user importing a TikTok link was told "YouTube menolak versi yt-dlp" —
// naming a site they never touched, which reads as the app being confused and
// sends them looking in the wrong place. yt-dlp handles ~1800 sites; name the
// one actually in the URL.
function platformLabel(url) {
  const s = String(url || '');
  if (/(^|[./])youtube\.com|(^|[./])youtu\.be/i.test(s)) return 'YouTube';
  if (/(^|[./])tiktok\.com/i.test(s)) return 'TikTok';
  if (/(^|[./])(drive|docs)\.google\.com/i.test(s)) return 'Google Drive';
  if (/(^|[./])instagram\.com/i.test(s)) return 'Instagram';
  if (/(^|[./])facebook\.com|(^|[./])fb\.watch/i.test(s)) return 'Facebook';
  if (/(^|[./])(x|twitter)\.com/i.test(s)) return 'X/Twitter';
  if (/(^|[./])vimeo\.com/i.test(s)) return 'Vimeo';
  return 'Sumber';
}

// [TRANSIENT-EXTRACT] An extraction step that fails at RANDOM on the same URL,
// same binary, same args — nothing about it is stale, blocked, or permanent, so
// the ONLY correct response is to try again.
//
// MEASURED on the reported TikTok URL (yt-dlp 2026.08.19, the current stable):
// 6 failures in 10 identical bare runs, and the app's own full arg list needed
// 6 attempts before one succeeded. Every failure was the same line —
// "Unable to extract universal data for rehydration" — raised after TikTok's JS
// challenge step. Because that message contains "unable to extract",
// looksLikeStaleYtdlp() matched it and the app spent ~10MB and a long pause
// downloading a yt-dlp it ALREADY had (2026.08.19 is the latest stable), then
// retried exactly once and gave up. So a video that downloads fine on the
// second or third try looked permanently broken.
//
// Deliberately matched on SITE-SPECIFIC tokens, never on shared boilerplate:
// this file has twice shipped a classifier that keyed off yt-dlp's universal
// "please report this issue … Confirm you are on the latest version" footer and
// mis-routed unrelated failures (SSL cert, private video). "unable to extract"
// alone is NOT in here for the same reason — it appears on permanent failures
// too, and retrying those just wastes the user's time before the same verdict.
//
// Google Drive's quota wall is included because it is the same shape: Google
// refuses a file for a while when it has been fetched too often, then serves it
// normally again. Nothing about the request is wrong.
function looksLikeTransientExtractFailure(raw) {
  const s = String(raw || '');
  return /universal data for rehydration/i.test(s)                       // TikTok JS-challenge flake
    || /too many users have viewed or downloaded this file/i.test(s)     // Google Drive quota wall
    || /can'?t view or download this file at this time/i.test(s)         // Google Drive, same wall
    || /unable to (?:solve|extract) .{0,40}challenge/i.test(s);          // challenge step, any site
}

// [DRIVE-FOLDER] A Google Drive FOLDER link, not a file link. Sharing a folder
// is the normal way people hand over videos here, so this URL shape arrives
// often — and it fails in the worst possible way. MEASURED against the live
// yt-dlp 2026.08.19: the GoogleDrive:Folder extractor gets HTTP 400 from
// Google's internal API and then dies inside yt-dlp itself with
// "ERROR: expected string or bytes-like object, got 'bool'". That message is
// meaningless to a user, AND it contains the exact token looksLikeStaleYtdlp()
// keys off, so the app also spent ~10MB re-downloading a binary that was never
// the problem before failing again. Detected up front instead: the pipeline
// takes ONE video, so a folder can never be the answer regardless of whether
// yt-dlp could list it.
function isGoogleDriveFolderUrl(url) {
  return /(?:docs|drive)\.google\.com\/drive\/(?:u\/\d+\/)?folders\//i.test(String(url || ''));
}

// [DRIVE-ACCESS] Google Drive refusing the file. The remedy is never the one
// this file's other branches give: Drive answers 404 for a file that exists but
// is not shared, so "cookies YouTube kedaluwarsa" and "coba jaringan lain" both
// send the user somewhere useless. Split out so surfaceDownloadError can say
// the one thing that actually fixes it — open the sharing dialog.
function looksLikeDriveAccessProblem(raw) {
  const s = String(raw || '');
  if (!/\[GoogleDrive/i.test(s)) return false;
  return /HTTP Error 40[0-9]|Unable to download (?:JSON metadata|webpage)|sign ?in|permission|not found|private/i.test(s);
}

// [SSL-CERT] A local TLS trust failure, not anything wrong with YouTube or the
// app. On Windows the frozen yt-dlp.exe verifies against a bundled CA set, so
// "unable to get local issuer certificate" almost always means something on the
// machine is between it and YouTube: a corporate/school MITM proxy or antivirus
// (Kaspersky/ESET/BitDefender) doing HTTPS inspection with its own root cert,
// or a wrong system clock making every certificate look out-of-date. None of
// those are fixed by a fresher binary, more retries, a lower resolution, or a
// different YouTube route — so this must be classified on its own and given its
// own remedy, never funnelled into the throttling/stale/403 paths.
function looksLikeSslCertError(raw) {
  return /CERTIFICATE_VERIFY_FAILED|unable to get local issuer certificate|certificate verify failed|SSLCertVerificationError|CertificateVerifyError|self.?signed certificate/i
    .test(String(raw || ''));
}

// YouTube's 2026 PO Token/GVS rollout can still return 403 after yt-dlp has
// been refreshed and after cookies are present. That is distinct from the
// explicit bot-check text above. web_embedded is now the primary route; for this
// class we retry once with android_vr so the second attempt changes clients.
function looksLikeYoutubePoToken403(raw) {
  const s = String(raw || '');
  if (!s) return false;
  if (looksLikeBotCheck(s)) return false;
  // [FORMAT-STRIP] The PO-token failure does NOT always surface as a literal
  // 403. When YouTube gates the client it hands back a manifest with the real
  // muxed/DASH formats stripped, leaving only storyboard images — yt-dlp then
  // reports "Only images are available for download" / "Requested format is not
  // available" (verified 2026-08-17 on the web/tv/ios clients). These are the
  // SAME root cause and the SAME fix (retry via web_embedded), so they must
  // trigger the fallback too — otherwise the download just dies with a
  // confusing "format not available" and the working embedded path is never
  // tried. Bot-check is excluded above; a genuinely impossible format selector
  // simply fails the embedded retry as well and surfaces the real error.
  return /\b403\b|forbidden|PO Token|Proof.?of.?Origin|\bGVS\b|SABR|only images are available|requested format is not available/i.test(s);
}

// [PO-TOKEN-NOT-COOKIES] The format-gate family (PO token / GVS / SABR / only
// storyboard images left / "requested format is not available") is YouTube
// refusing the CLIENT, not the session. The 403 branch below told every such
// buyer their cookies had expired — screenshot 2026-10-06, where the real
// cause was Deno never having installed (GitHub reset by the ISP).
function looksLikeYoutubeFormatGate(raw) {
  return /PO Token|Proof.?of.?Origin|\bGVS\b|SABR|only images are available|requested format is not available/i.test(String(raw || ''));
}
const FIX_YOUTUBE_PATH = 'Settings → Mesin aplikasi → Perbaiki YouTube';
const NETWORK_REMEDY = 'ganti jaringan (mis. hotspot HP) atau pakai DNS 1.1.1.1 / Cloudflare WARP';
function youtubeGateMessage({ deno, denoError } = {}) {
  if (!deno) {
    return `YouTube menolak unduhan karena komponen Deno belum terpasang. YouTube sekarang mewajibkan Deno untuk membuka video — ini BUKAN masalah cookies dan bukan antivirus.\n\nCara memperbaiki:\n1. Buka ${FIX_YOUTUBE_PATH}, tunggu sampai Deno berstatus terpasang.\n2. Kalau gagal (ERR_CONNECTION_RESET / timeout), jaringanmu memutus server unduhan — ${NETWORK_REMEDY}, lalu klik Perbaiki YouTube lagi.\n3. Setelah Deno terpasang, jalankan ulang.${denoError ? `\n\nDetail pemasangan Deno: ${denoError}` : ''}`;
  }
  return `YouTube membatasi format video ini untuk aplikasi pengunduh (PO token) — bukan masalah cookies.\n\nCoba:\n1. ${FIX_YOUTUBE_PATH} (memperbarui yt-dlp & Deno), lalu jalankan ulang.\n2. Kalau masih gagal, coba beberapa menit lagi atau ${NETWORK_REMEDY}.\n\nAlternatif paling pasti: download videonya manual lalu pakai menu Import file lokal.`;
}
// [YTDLP-STALL] yt-dlp went silent for the whole watchdog window.
function ytdlpStallMessage({ site = 'YouTube', stallSec = 90, deno = true } = {}) {
  return `Unduhan dari ${site} macet — tidak ada data sama sekali selama ${stallSec} detik, jadi dihentikan. Ini masalah koneksi ke server ${site}, bukan antivirus dan bukan kerusakan aplikasi.\n\nCoba:\n1. Jalankan ulang — unduhan dilanjutkan dari posisi terakhir.\n2. ${NETWORK_REMEDY[0].toUpperCase()}${NETWORK_REMEDY.slice(1)}.\n3. Turunkan Resolution ke 720p.${deno ? '' : `\n\nCatatan: komponen Deno juga belum terpasang — buka ${FIX_YOUTUBE_PATH} setelah koneksi lancar.`}\n\nKalau tetap macet, download videonya manual lalu pakai menu Import file lokal.`;
}

function youtubeEmbeddedFallbackArgs() {
  // The primary route already uses web_embedded. A retry must genuinely change
  // the request, so switch to the token-free android_vr client instead of
  // repeating the same failing URL and making the user wait twice.
  return ['--extractor-args', 'youtube:player-client=android_vr'];
}

function youtubeEmbeddedFallbackSelector(normalSelector) {
  return normalSelector;
}

// Force-download the newest official yt-dlp into the app-managed bin dir and
// return its path (or null if unavailable). Lazily requires bootstrap so the
// pipeline module stays loadable in tests (no electron) — this path only runs
// inside a real Electron session during a reactive retry.
// [DENO-REQUIRED] Same lazy pattern for Deno: install it on demand (null when
// bootstrap is unavailable, e.g. under tests).
async function installDenoNow(onStatus) {
  let boot = null;
  try { boot = require('./bootstrap'); } catch { return null; }
  if (!boot || typeof boot.ensureDeno !== 'function') return null;
  return boot.ensureDeno(onStatus || (() => {}));
}
let denoInstallError = null;

async function refreshYtdlpBinary(onStatus) {
  try {
    const boot = require('./bootstrap');
    if (typeof boot.refreshYtdlp === 'function') return await boot.refreshYtdlp(onStatus);
  } catch { /* bootstrap unavailable (e.g. tests) → no reactive refresh */ }
  return null;
}

const SOURCE_PROBE_TIMEOUT_MS = 30_000;

async function validateDownloadedSource(
  sessionDir,
  { runProbe = spawnLines, ffprobe = FFPROBE } = {},
) {
  const inventory = sourceInventory(sessionDir);
  const candidate = resolveDownloadedVideo(sessionDir);
  if (!candidate) {
    throw new Error(acquisitionFailureMessage(inventory, 'tidak ada container video selesai'));
  }

  let probeRaw = '';
  try {
    ({ stdout: probeRaw } = await runProbe(ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', candidate,
    ], { onLine: () => {}, timeoutMs: SOURCE_PROBE_TIMEOUT_MS }));
  } catch (e) {
    if (cancelled || isCancelError(e)) throw e;
    throw new Error(acquisitionFailureMessage(
      inventory,
      `file hasil tidak bisa dibaca ffprobe (${e?.message || e})`,
    ));
  }

  if (!probeHasVideoStream(probeRaw)) {
    throw new Error(acquisitionFailureMessage(
      inventory,
      `file ${path.basename(candidate)} tidak memiliki video stream`,
    ));
  }
  fs.mkdirSync(SF.dataPath(sessionDir), { recursive: true });
  fs.writeFileSync(SF.dataPath(sessionDir, 'metadata.json'), probeRaw);
  return candidate;
}

// ─── Main pipeline ────────────────────────────────────────
async function runPipeline({ source, sessionDir, cfg, binPaths, subtitleFile, noTranscript, userDataDir, secretsLocked, onLog, onProgress, onClip, onSourcePreview, onClipsDetected, onClipState, onConfirmDownload }) {
  if (binPaths) {
    if (binPaths.ytdlp)  YTDLP   = binPaths.ytdlp;
    if (binPaths.ffmpeg)  FFMPEG  = binPaths.ffmpeg;
    if (binPaths.ffprobe) FFPROBE = binPaths.ffprobe;
    if (binPaths.deno)    DENO    = binPaths.deno;
  }
  cancelled = false;
  // [RUN-LOG] Tee every log line into the session folder. The renderer's log
  // panel is the ONLY place these lines existed, and it is wiped when the app
  // closes — so every "it failed again" started with asking the user to
  // reproduce the failure and screenshot a panel. The run that produced a
  // session folder now explains itself from disk.
  //
  // Deliberately: append-mode (a retry into the same folder keeps both runs),
  // never throws (a logging failure must not fail a render), and no rotation —
  // the file is a few KB next to a 600MB source.mp4.
  // [DATA-DIR] data/ holds the session's app data; created before the first log line.
  if (sessionDir) { try { fs.mkdirSync(SF.dataPath(sessionDir), { recursive: true }); } catch {} }
  const runLogPath = sessionDir ? SF.dataPath(sessionDir, 'pipeline.log') : null;
  // [RUN-LOG-PER-RUN] A fresh chain per run: a write stuck on a PREVIOUS run's
  // hung export drive must not hold back this run's log (reproduced: run B's
  // pipeline.log was never created behind run A's hung write).
  runLogQueue = Promise.resolve();
  // [RUN-LOG-ASYNC] Ordered async queue, never appendFileSync: the session
  // can live on an export drive now, and a sync write to a drive that stalls
  // mid-run froze Electron's main process at the next log line.
  const toRunLog = (line) => {
    if (!runLogPath) return;
    const text = `[${new Date().toISOString()}] ${line}\n`;
    runLogQueue = runLogQueue.then(() => fs.promises.appendFile(runLogPath, text)).catch(() => {});
  };
  const log = (l, kind='') => { toRunLog(l); try { onLog(l, kind); } catch {} };
  // Bookend the file so a stale log from a previous attempt is never mistaken
  // for this one, and so the environment behind a bug report is in the log
  // rather than in a follow-up question.
  toRunLog(`=== run start — app ${process.platform}/${process.arch}, source=${source}`);
  // [FFMPEG-FILTERS] Before anything spawns: does this ffmpeg actually have the
  // filters this run is going to build? One memoised probe — see
  // checkFfmpegFilters. Reported, never thrown: a gap here does not
  // necessarily doom the run (it depends which knobs the user turned on), and
  // a named filter in the log beats ffmpeg's `Filter not found` arriving
  // twenty minutes into a batch.
  checkFfmpegFilters(FFMPEG, log);
  toRunLog(`=== cfg: provider=${cfg?.aiProvider || 'auto'} hook=${cfg?.hookProvider || '-'} ` +
           `clips=${cfg?.clipCount} dur=${cfg?.clipDuration} res=${cfg?.resolution} ` +
           `format=${cfg?.format} smartTrack=${!!cfg?.smartTrack} burnSubs=${!!cfg?.burnSubtitles} ` +
           `localAsr=${cfg?.localAsr} aiAvailable=${aiAvailable(cfg)} keys=${secretsLocked ? 'LOCKED' : 'ok'}`);

  // [ENC-CACHE-ORDER] Must be set BEFORE anything can call detectHwEncoder(),
  // which is what triggers the encoder race and then wants somewhere to
  // persist the verdict. It used to be set down at the Export stage, but the
  // tracker pre-warm reads detectHwEncoder() back at the transcript stage —
  // so the race ran once with no cache dir (verdict computed, never written),
  // then this reset the memo and the whole probe + race ran a SECOND time.
  // Caught in a real app log: two full nvenc/qsv probe rounds in one run.
  // Worse than the wasted ~10s, nothing was ever written to disk, so every
  // run re-raced forever and the persistence built for it never engaged.
  __setEncoderCacheDir(calibrationCacheDir(userDataDir));
  // [TRACKER-ACCEL-CAP] Same reasoning, same fix: pin the dir once so a probed
  // DirectML verdict actually persists instead of re-probing (a real Python
  // spawn + import, not free) on every call within the run.
  __setTrackerAccelCacheDir(calibrationCacheDir(userDataDir));

  const isUrl = /^https?:\/\//i.test(source || '');
  if (isUrl) {
    // URL parsing is local and immediate: paint a dependable YouTube poster
    // before yt-dlp's metadata/download round-trips begin. Metadata and the
    // extracted local frame below may replace this with richer information.
    const thumbnail = youtubePosterFromSource(source);
    if (thumbnail) {
      try { onSourcePreview?.({ phase: 'remote', thumbnail, title: '', channel: '', sourceType: 'youtube' }); } catch {}
    }
  }

  // Detect libass support — silently disable burn-in if ffmpeg lacks `subtitles` filter
  let ffmpegHasSubs = true;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(validateBinaryPath(FFMPEG), ['-hide_banner', '-filters'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });   // [EPIPE] see tryEncode()
    ffmpegHasSubs = /\bsubtitles\b/.test(out);
  } catch { ffmpegHasSubs = false; }
  if (cfg.burnSubtitles && !ffmpegHasSubs) {
    log('⚠ Komponen subtitle tidak tersedia — caption tidak akan dibakar ke video', 'yellow');
    cfg = { ...cfg, burnSubtitles: false };
  }

  const prog = (step, detail, percent) => { try { onProgress(step, detail, percent); } catch {} };
  log(`▶ Memulai sesi baru`, 'lime');
  log(`▶ Sumber: ${isUrl ? 'Tautan online' : 'File lokal'}`);
  // [MANUAL-SEGMENTS] In manual mode the duration preset and clip count don't
  // apply — echoing them here would describe a run that isn't happening.
  const _modeKey = String(cfg.clipMode || 'auto').toLowerCase();
  const _segCount = Array.isArray(cfg.manualSegments) ? cfg.manualSegments.length : 0;
  log(_modeKey === 'manual'
    ? `▶ Mode: Manual · ${_segCount} segmen · ${cfg.format} · ${cfg.resolution}`
    : `▶ Mode: ${resolveDuration(cfg.clipDuration).label} · ${cfg.clipCount} clip${_modeKey === 'hybrid' ? ` (${_segCount} manual)` : ''} · ${cfg.format} · ${cfg.resolution}`);

  const stages = makeStageTimer(log);

  // ── 1) Acquire source ──
  stages.begin('Sumber');
  let inputPath, ytInfo = null, acquiredSubtitleFile = null, acquiredSubtitleWords = [], subtitleFileIsSidecar = false;
  // [SUBTITLE-LANG-HINT] The confirmed language code of whichever caption
  // track actually got fetched (Innertube or yt-dlp). detectLanguage() below
  // only recognises id/en/es (Latin stopwords) and a handful of CJK scripts
  // by re-guessing from the transcript text — every other option in the
  // Subtitle language dropdown (ar/hi/th/ru/uk/tr/vi/fr/de/it/nl/pt/...) has
  // no script/stopword detector and silently defaulted to 'id'. The track we
  // already fetched KNOWS its own language; feed that in directly instead of
  // re-guessing from scratch.
  let subtitleTrackLang = null;
  prog('Download', isUrl ? 'checking dependencies' : 'Loading local file…', 2);
  // [DISK-CHECK] v2.1.13 — fail fast with a clear message if the disk is nearly
  // full (was surfacing as an opaque yt-dlp "Errno 28 No space left on device"
  // deep inside the download). 2 GB is enough headroom for a typical HD source
  // + yt-dlp fragment scratchpad; the actual render output can grow later but
  // by then the user has feedback.
  try {
    const stats = fs.statfsSync(sessionDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const MIN_FREE = 2 * 1024 * 1024 * 1024;   // 2 GB
    if (isFinite(freeBytes) && freeBytes > 0 && freeBytes < MIN_FREE) {
      const freeGB = (freeBytes / (1024 ** 3)).toFixed(1);
      // Name the drive: with an export folder set, the session lives on THAT
      // drive (work-root.js), and "disk penuh" alone sent users to clean C:.
      throw new Error(`Ruang disk tidak cukup di ${driveLabel(sessionDir)}: tinggal ${freeGB} GB. Butuh minimal 2 GB untuk download + render. Kosongkan drive itu (Recycle Bin, cache, file besar) atau pilih folder ekspor di drive lain, lalu coba lagi.`);
    }
  } catch (e) {
    if (/Ruang disk tidak cukup/.test(e.message)) throw e;   // re-throw our own
    // fs.statfsSync unavailable on this Node build — silently skip (Node ≥18.15 supports it).
  }
  if (isUrl) {
    // Readiness check WITHOUT a `--version` probe: bootstrap already canExec-
    // validated the binary, and a cold `--version` here re-triggers yt-dlp's
    // 10+s PyInstaller unpack (bootstrap.js:105 avoids it for exactly this
    // reason) and can spuriously fail — which surfaced as a misleading
    // "yt-dlp tidak ditemukan" even when the binary was fine.
    const ytReady = !!YTDLP && (fs.existsSync(YTDLP) || !!which(YTDLP));
    if (!ytReady) {
      const why = binPaths?.ytdlpError ? `\n\nDetail: ${binPaths.ytdlpError}` : '';
      throw new Error(`yt-dlp belum siap — auto-setup gagal.${why}\n\nCoba buka ulang aplikasi (auto-download akan dijalankan lagi), atau install manual: brew install yt-dlp (mac) / scoop install yt-dlp (win). Catatan: API key AI di Settings tidak dipakai untuk mengunduh video.`);
    }

    // Cookies — REQUIRED for reliable HD. Without a logged-in session,
    // YouTube returns 403 on the actual fragment GET even when challenge
    // solving + format selection succeed. v2 makes this mandatory; we
    // auto-discover then warn loudly if none found.
    const cookieCandidates = [
      cfg.cookiesPath,
      path.join(sessionDir, '..', 'cookies.txt'),     // userData/output/cookies.txt
      path.join(sessionDir, '..', '..', 'cookies.txt'), // userData/cookies.txt
      path.join(process.cwd(), 'cookies.txt'),
    ].filter(Boolean);
    const cookiesFile = cookieCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    // `let`: replaced in-place by the browser-cookie retry below.
    let cookieArgs = cookiesFile ? ['--cookies', cookiesFile] : [];
    // [COOKIE-SOURCE] Browsers whose cookie store we could not read at all
    // during the fallback below, as { browser, kind } (see blockedCookieKind).
    // Read back by surfaceDownloadError so the final
    // message names the real obstacle instead of implying YouTube rejected us.
    const blockedCookieBrowsers = [];
    if (cookiesFile) log(`▶ Cookies sesi login terdeteksi`, 'lime');
    else log('⚠ Belum ada cookies — kualitas HD/4K mungkin gagal. Buka Settings → Cookies untuk upload file cookies.txt.', 'yellow');

    // [BOT-CHECK] Fallback cookie source: read the session straight out of an
    // installed browser (`--cookies-from-browser`). Only used AFTER a download
    // has already failed YouTube's bot check, and only when the user hasn't
    // supplied a cookies.txt — it touches the browser's own cookie store, so
    // it must never be a silent default. `cfg.cookiesBrowser`:
    //   ''     → auto-detect (this list)
    //   'off'  → never (user opted out)
    //   name   → force that browser
    // Order = most likely to hold a signed-in youtube.com session first.
    const browserCookieCandidates = () => {
      const forced = String(cfg.cookiesBrowser || '').trim().toLowerCase();
      if (forced === 'off') return [];
      if (forced) return [forced];
      const home = os.homedir();
      const mac = process.platform === 'darwin';
      const win = process.platform === 'win32';
      const local = win ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')) : '';
      const roaming = win ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : '';
      // [browser name for yt-dlp, the store yt-dlp itself will open]
      // Safari's entry is the sandbox container, NOT ~/Library/Cookies: that
      // legacy directory exists on every Mac and holds no Safari cookies, so it
      // offered Safari to every user and spent an attempt on a store yt-dlp
      // would then refuse. The container path is the one in yt-dlp's own error.
      const table = mac ? [
        ['chrome',  path.join(home, 'Library/Application Support/Google/Chrome')],
        ['brave',   path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser')],
        ['edge',    path.join(home, 'Library/Application Support/Microsoft Edge')],
        ['firefox', path.join(home, 'Library/Application Support/Firefox')],
        ['safari',  path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies')],
      ] : win ? [
        ['chrome',  path.join(local, 'Google/Chrome/User Data')],
        ['brave',   path.join(local, 'BraveSoftware/Brave-Browser/User Data')],
        ['edge',    path.join(local, 'Microsoft/Edge/User Data')],
        ['firefox', path.join(roaming, 'Mozilla/Firefox')],
      ] : [
        ['chrome',  path.join(home, '.config/google-chrome')],
        ['brave',   path.join(home, '.config/BraveSoftware/Brave-Browser')],
        ['firefox', path.join(home, '.mozilla/firefox')],
      ];
      // Readability, not existence. Under macOS TCC a protected path answers
      // stat() normally and only refuses open(), so `existsSync` reported
      // Safari as installed-and-usable on a Mac where reading it was EPERM.
      // R_OK is precisely what yt-dlp needs next, so ask that instead.
      const readable = (p) => {
        try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
      };
      return table.filter(([, p]) => readable(p)).map(([name]) => name);
    };

    // [DENO-REQUIRED] YouTube now makes every client solve a JS challenge, and
    // Deno is what yt-dlp solves it with. A missing Deno used to be a quiet
    // "soft failure" from the splash screen — the download then died as a 403,
    // "Only images are available" or a stall, and the app blamed cookies
    // (reported 2026-10-06, Deno BELUM TERPASANG in the buyer's screenshot).
    // Try to install it right here, through the same GitHub → dl.deno.land →
    // mirror chain, before the first YouTube request. Still not fatal: if it
    // cannot be installed the download is attempted anyway, and the error that
    // follows says Deno is the reason.
    denoInstallError = null;
    if (!DENO && /(?:^|\.|\/\/)(?:youtube\.com|youtu\.be)\b/i.test(String(source))) {
      log('▶ Komponen Deno (wajib untuk YouTube) belum terpasang — memasang sekarang…', 'lime');
      prog('Download', 'memasang Deno…', 4);
      try {
        const d = await installDenoNow((msg) => prog('Download', typeof msg === 'string' ? msg : 'memasang Deno…', 4));
        if (d) { DENO = d; log('✓ Deno terpasang', 'lime'); }
      } catch (e) {
        denoInstallError = String(e?.message || e);
        log(`⚠ Deno gagal dipasang: ${denoInstallError}`, 'warn');
      }
    }

    // Tell yt-dlp where ffmpeg lives so format-merging works in the packaged app
    // (PATH doesn't include the bundled binary).
    const ffArgs = (FFMPEG && fs.existsSync(FFMPEG)) ? ['--ffmpeg-location', FFMPEG] : [];

    // HD-quality args (ported from socl-visuals-v2, which produces noticeably
    // sharper downloads):
    //   1. `--remote-components ejs:github` — opt-in to fetching yt-dlp-ejs
    //      challenge-solver scripts. Without this, even with deno installed,
    //      yt-dlp cannot solve YouTube's `n`/signature challenges and falls
    //      back to a 360p combined stream.
    //   2. `--js-runtimes deno:PATH` — explicit deno location (more reliable
    //      than PATH discovery).
    //   3. NO `player_client` override — yt-dlp's default client ordering is
    //      already optimal and is what unlocks 4K formats when combined with
    //      cookies. v2 explicitly notes overriding it can bypass cookie auth.
    //   4. NO codec lock — YouTube's H.264 caps at 1080p; VP9/AV1 carry the
    //      1440p/4K streams. Sorting by resolution first lets us pick those.
    //      Codec preference within a resolution: see the `-S` note below.
    const qualArgs = [];
    if (DENO) qualArgs.push('--remote-components', 'ejs:github', '--js-runtimes', `deno:${DENO}`);

    // Metadata comes from the DOWNLOAD call via `--write-info-json` (see the
    // download args below) — there is no separate probe pass any more.
    //
    // WHY (measured 2026-07-27): the old `--dump-single-json` pass ran to
    // completion BEFORE the download started and cost a flat 11-12s on every
    // job (11.0-12.8s across 9 runs, and identical with or without the Deno/EJS
    // flags — it's yt-dlp's extraction round-trips, not our args). That is the
    // bulk of the "Menyiapkan sumber lama sekali" complaint.
    //
    // It was also pure duplicate work: the download has to run the exact same
    // extraction to resolve formats. `--write-info-json` just asks it to keep
    // the JSON it already built. Verified: same fields we consume (title,
    // uploader, duration, language, id, webpage_url, description), and yt-dlp
    // writes the file BEFORE the first byte of video, so `onInfoJson` below
    // still surfaces the title/channel at the same point in the log.
    //
    // Deliberately NOT the literal "run both in parallel" version: that fires
    // two extractions at YouTube from one IP for the same video, which is the
    // kind of pattern that earns a rate-limit. Removing the work beats
    // overlapping it.
    const infoJsonPath = SF.dataPath(sessionDir, 'source.info.json');
    // Reads the info JSON as soon as yt-dlp announces it. Safe to call more
    // than once; first successful read wins.
    const readInfoJson = () => {
      if (ytInfo) return;
      try {
        ytInfo = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
        log(`▶ Video ditemukan: ${ytInfo.title}`, 'lime');
        // Google Drive (and plain file hosts) carry no uploader — printing
        // the raw field there produced a literal "Channel: undefined".
        if (ytInfo.uploader) log(`▶ Channel: ${ytInfo.uploader}`, 'lime');
        const thumbnail = remotePoster(ytInfo);
        if (thumbnail) {
          try { onSourcePreview?.({ phase: 'remote', thumbnail, title: ytInfo.title || '', channel: ytInfo.uploader || '', sourceType: 'youtube' }); } catch {}
        }
      } catch { /* not written yet, or unreadable — retried after download */ }
    };

    const tmpl = path.join(sessionDir, 'source.%(ext)s');
    const cap = sourceHeightCap(cfg.resolution, cfg.format || 'face');
    // Selector ports v2's recipe verbatim: require ≥720p (refuses the 360p
    // combined fallback); cap at the user's chosen tier; fall back to any
    // best video+audio if no stream fits the window. Sort by resolution then
    // bitrate — picks the sharpest stream within the band.
    const sel = `bestvideo[height>=720][height<=${cap}]+bestaudio/best[height>=720][height<=${cap}]/bestvideo+bestaudio/best`;
    let activeExtractorArgs = youtubePrimaryExtractorArgs();
    // [GGC-400] Some ISPs host a Google cache node (rr<N>---sn-…, first in the
    // stream URL's `mn` list) that answers HTTP 400 for certain videos — every
    // format, every client. The second `mn` node serves the same signed URL.
    // Once seen, every later attempt (other client, HD re-download) extracts
    // first, points the URLs at that node and downloads from the edited JSON.
    let viaBackupNode = false;
    let loadInfoJsonPath = null;
    const backupNodeJson = SF.dataPath(sessionDir, 'yt-backup-node.json');
    let activeSelector = sel;
    // Video-only pass — subtitle download is split into a second call below so
    // a subtitle rate-limit (429) doesn't fail the entire video download.
    // Keep retries bounded. A broken edge connection should fail over quickly
    // instead of holding the UI for several minutes before the next route gets
    // a chance. 10M chunks still limit how much a resumed request repeats.
    // `--newline` forces yt-dlp to terminate each `[download] NN%` progress
    // update with a real newline instead of a bare `\r`, keeping logs and progress
    // consistent across yt-dlp versions.
    //
    // Earlier tried `-N 4` + chunk 50M for
    // more speed; on real runs it triggered HARDER throttling from YouTube
    // (parallel fragment + big chunks look bot-like), making the download
    // MORE variable, not faster. Reverted. Real speed wins come from
    // fresh cookies + lower resolution, not from more aggressive args.
    // Built lazily: `cookieArgs` can be REPLACED after a failed attempt (the
    // browser-cookie retry below), so the arg list must be rebuilt per spawn
    // rather than frozen once.
    const buildArgs = ({ extractOnly = false } = {}) => isolatedYtdlpArgs(['--no-playlist', '--newline',
      ...(extractOnly ? ['--skip-download'] : []),
      ...ytdlpNetworkArgs(),
      ...ffArgs, ...qualArgs, ...activeExtractorArgs, ...cookieArgs,
      '-f', activeSelector,
      // Codec preference, measured 2026-07-27 (M1 Pro, software decode — we
      // never pass `-hwaccel`, that was measured SLOWER):
      //   `br` alone sorts bitrate DESCENDING, so it always grabbed the
      //   FATTEST stream at a given resolution — H.264, which is the least
      //   efficient codec YouTube serves. Preferring VP9 first cuts the
      //   download 26-39% at IDENTICAL resolution (1080p, 3 videos:
      //   44.0→32.7MB, 288→200MB, 290→177MB) for ZERO render cost —
      //   crop+scale+encode of a 60s clip is 7.5s from either source.
      //   4K stays reachable (2160p resolves to vp9 format 315), and VP9
      //   muxes into mp4 fine (vp09 track, merge verified).
      //
      //   DELIBERATELY NOT AV1, even though it is ~2x smaller again
      //   (`-S res,+size` picks it): AV1 has no hardware decode path on
      //   pre-2021 Intel / pre-M3 Apple, and every stage of this pipeline
      //   decodes the source again (transcribe, scene-detect, track, render).
      //   Measured on the same file: full-file software decode 42.7s for AV1
      //   vs 3.6s VP9 vs 2.8s H.264 — 12x worse than VP9 — and +29% on a real
      //   clip render. The bytes saved are dwarfed by the decode tax.
      '-S', ytdlpFormatSort(cfg.subtitleLang),
      '--merge-output-format', 'mp4',
      // Replaces the separate `--dump-single-json` probe pass — see the note
      // above `infoJsonPath`.
      '--write-info-json',
      // [DATA-DIR] the info JSON goes to data/, the video stays source.mp4.
      '-o', `infojson:${SF.dataPath(sessionDir, 'source.%(ext)s')}`,
      '-o', tmpl, ...(loadInfoJsonPath ? ['--load-info-json', loadInfoJsonPath] : [source])]);
    prog('Download', 'preparing download', 5);
    log(`▶ Menyiapkan unduhan ${cfg.resolution} (source 720p–${cap}p)`, 'lime');
    if (!DENO) log(`⚠ Komponen JS runtime tidak ada — resolusi mungkin terbatas`, 'yellow');
    const attemptDownload = async () => {
      // Friendly progress: parse yt-dlp's stream and derive a STRICTLY
      // monotonic 1→100% display value, regardless of yt-dlp's internal
      // reporting quirks.
      //
      // WHY the strict clamp: yt-dlp emits per-stream 0→100% (bestvideo then
      // bestaudio) AND per-fragment 0→100% on DASH/HLS AND per-chunk 0→100%
      // when `--http-chunk-size` is set. Detecting each transition
      // heuristically is fragile — a single missed transition line makes the
      // percent LOOP backwards ("10% ke 1%"). The fix is to guarantee
      // monotonicity at the DISPLAY layer: whatever yt-dlp reports, `_shown`
      // only ever goes UP. Combined with 3 explicit phases (video 1→85,
      // audio 85→98, merge → 100) that give the bar a plausible pacing.
      let _lastBucket = -1, _mergeLogged = false;
      let phase = 0;              // 0 = video stream, 1 = audio stream, 2 = merging
      let _peakInPhase = 0;       // highest raw % seen in current phase
      let _shown = 1;             // monotonic integer 1..100 shown to the user
      const PHASE_RANGE = [[1, 85], [85, 98], [98, 100]];
      const emitShown = () => {
        prog('Download', `${_shown}%`, 5 + Math.min(19, _shown * 0.19));
        const bucket = Math.floor(_shown / 25);
        if (bucket > _lastBucket) {
          _lastBucket = bucket;
          if (bucket >= 1 && bucket <= 4) log(`▶ Mengunduh video: ${bucket * 25}%`, 'lime');
        }
      };
      const advance = (target) => {
        const clamped = Math.max(1, Math.min(100, Math.round(target)));
        if (clamped > _shown) { _shown = clamped; emitShown(); }
      };
      // Publish initial 1% so the substep never shows "0%".
      emitShown();
      // [YTDLP-MERGE-SILENCE] After "Merging formats" yt-dlp hands the two streams
      // to ffmpeg and prints NOTHING until the remux ends. On a slow disk a long
      // 1080p source (several GB) needs minutes, so the 90s download watchdog
      // killed a perfectly healthy merge and blamed "koneksi ke YouTube" — and
      // since a re-run resumes at 100% and merges again, it failed identically
      // forever. Once merging starts, silence is expected: allow far longer.
      const ytSpawnOpts = {
        env: ytEnv(),
        stallMs: YTDLP_STALL_MS,
        onLine: (_kind, line) => {
          // yt-dlp writes the info JSON before the first video byte, so this
          // surfaces title/channel at the same point in the log as the old
          // separate probe pass did — without the extra 12s round-trip.
          if (/Writing video metadata as JSON/i.test(line)) { readInfoJson(); return; }
          // Explicit phase transition: new Destination line = new stream.
          // Only advances phase forward, never back.
          if (/^\[download\]\s+Destination:/.test(line)) {
            if (_peakInPhase > 20 && phase < 1) { phase = 1; _peakInPhase = 0; }
            return;
          }
          const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
          if (m) {
            const raw = parseFloat(m[1]);
            // Implicit phase 0→1 fallback: yt-dlp sometimes omits the second
            // "Destination:" line (fmt-specific). Detect a big drop after we
            // saw a near-completion peak — that's the video→audio boundary.
            if (phase === 0 && _peakInPhase >= 95 && raw < 15) { phase = 1; _peakInPhase = 0; }
            if (raw > _peakInPhase) _peakInPhase = raw;
            const [lo, hi] = PHASE_RANGE[phase];
            advance(lo + (hi - lo) * (_peakInPhase / 100));
            return;
          }
          if (/Merging formats|^\[(?:Merger|VideoRemuxer|Fixup\w*)\]/.test(line)) {
            ytSpawnOpts.stallMs = YTDLP_MERGE_STALL_MS;
          }
          if (/Merging formats/.test(line)) {
            phase = 2; _peakInPhase = 100;
            advance(100);
            prog('Download', 'merging…', 24);
            if (!_mergeLogged) { log('▶ Menggabungkan audio & video…', 'lime'); _mergeLogged = true; }
            return;
          }
          // [GGC-400] Not shown live: the backup-node retry handles it and says so
          // in its own line; read as a red ERROR above a working download. If it
          // still fails, surfaceDownloadError prints yt-dlp's full output.
          if (/^ERROR\b/i.test(line) && !(site === 'YouTube' && looksLikeVideoData400(line))) log(line, 'err');
          // Everything else (format probing, fragment fetches, debug noise) is
          // intentionally suppressed.
        },
      };
      if (viaBackupNode) {
        await spawnLines(YTDLP, buildArgs({ extractOnly: true }), { env: ytEnv(), stallMs: YTDLP_STALL_MS,
          onLine: (_kind, line) => { if (/^ERROR\b/i.test(line)) log(line, 'err'); } });
        const info = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
        if (rewriteToBackupNode(info) > 0) {
          fs.writeFileSync(backupNodeJson, JSON.stringify(info));
          loadInfoJsonPath = backupNodeJson;
        }
      }
      try { await spawnLines(YTDLP, buildArgs(), ytSpawnOpts); }
      finally {
        if (loadInfoJsonPath) { loadInfoJsonPath = null; try { fs.unlinkSync(backupNodeJson); } catch {} }
      }
    };

    // Turn a raw yt-dlp failure into an actionable message. Shared by the first
    // attempt and any post-refresh retry.
    const surfaceDownloadError = (e) => {
      // Dump the FULL yt-dlp stderr into the renderer log before we replace it
      // with a friendlier message. The onLine handler above deliberately
      // suppresses everything except ERROR lines to keep the log readable while
      // downloading — but once we've failed, that suppressed noise is the only
      // evidence of WHY, and the single-line error banner can't carry it.
      // NOTE: renderer's shouldShowLog() drops raw tool output — every line
      // here MUST carry a leading marker (⏵) or it is silently filtered out,
      // `[youtube] …` prefixes especially (LOG_NOISE_RE).
      if (e && e.stderr) {
        const lines = String(e.stderr).split('\n').map(l => l.trim()).filter(Boolean).slice(-40);
        if (lines.length) log('⚠ Output lengkap yt-dlp (untuk diagnosis):', 'yellow');
        for (const line of lines) log(`⏵ ${line}`, /^ERROR\b/i.test(line) ? 'err' : '');
      }
      // Classify against the RAW output, not the (now condensed) message: the
      // giveaway lines for throttling are yt-dlp WARNINGs that pickErrorLines
      // drops once a real ERROR line is present.
      const raw = `${e?.message || ''}\n${e?.stderr || ''}`;
      // [YTDLP-STALL] Silence for the whole watchdog window: a connection that
      // stopped answering. Said plainly instead of "encoder wedged".
      if (e && (e.stalled || /\bstalled — no output\b/.test(String(e.message || '')))) {
        throw new Error(ytdlpStallMessage({ site, stallSec: Math.round(YTDLP_STALL_MS / 1000), deno: !!DENO || site !== 'YouTube' }));
      }
      // YouTube anti-bot returns 403 on the fragment GET when the request has
      // no logged-in session (or expired cookies). Surface an actionable hint
      // instead of the raw child-process stack.
      // [DRIVE-ACCESS] Checked BEFORE the bot-check/403 branches: Drive answers
      // 404 for a file that exists but is not shared, and 403 when the quota
      // wall is up. Both would otherwise fall into the YouTube branches below
      // and tell the user to re-export youtube.com cookies — advice that can
      // never fix a Drive permission, and that sends them to the wrong site
      // entirely. The real remedy is the sharing dialog.
      if (looksLikeDriveAccessProblem(raw)) {
        const hint = cookiesFile
          ? `File cookies kamu sudah terpasang, tapi Drive tetap menolak. Pastikan cookies itu di-export saat kamu login dengan akun Google yang PUNYA akses ke file ini (export ulang lewat ekstensi SCL VSL Cookies Exporter — sejak v1.1.0 cookies google.com ikut terbawa otomatis).`
          : `Kalau file-nya memang harus tetap privat, kamu bisa pasang cookies.txt: login ke Google dengan akun yang punya akses, export lewat ekstensi SCL VSL Cookies Exporter (v1.1.0+ sudah ikut membawa cookies google.com yang dibutuhkan Drive), lalu pasang di Settings → Cookies.`;
        throw new Error(`Google Drive menolak file ini — kemungkinan besar file-nya tidak dibagikan secara publik (Drive menjawab "not found" untuk file yang ada tapi tidak di-share).\n\nCara paling cepat:\n1. Buka file itu di Google Drive → klik "Bagikan" / "Share".\n2. Ubah akses umum jadi "Siapa saja yang memiliki link" ("Anyone with the link").\n3. Salin ulang link-nya (bentuk .../file/d/XXXX/view), lalu coba lagi.\n\n${hint}\n\nCek juga: link masih hidup (file belum dihapus/dipindah), dan yang kamu tempel adalah link FILE, bukan link folder.\n\nAlternatif paling pasti: download videonya dari Drive ke komputer, lalu pakai menu Import file lokal.`);
      }
      // [COOKIE-SOURCE] Say plainly WHY borrowing a browser session failed.
      // "tetap ditolak" was wrong and actively misleading when the truth was
      // that we could never read the cookies in the first place. Shared by the
      // age-gate and bot-check branches: both arrive here through that fallback.
      // [COOKIE-SOURCE-MAC] / [COOKIE-SOURCE-WIN] The remedy differs per OS
      // and per browser — see describeBlockedCookieBrowsers.
      const blockedNote = describeBlockedCookieBrowsers(blockedCookieBrowsers, process.platform);
      // [AGE-GATE] MUST precede the bot-check branch: looksLikeBotCheck also
      // matches "Sign in to confirm your age", and reporting an age gate as a
      // bot check hands the user three remedies (wait / change network / VPN)
      // that cannot lift an age restriction, plus a cookies instruction that
      // omits the one thing that matters — WHICH account the cookies come from.
      if (looksLikeAgeRestricted(raw)) {
        const hint = cookiesFile
          ? `File cookies kamu (${cookiesFile}) kemungkinan berasal dari akun yang belum bisa membuka video ini. Buka dulu videonya di browser untuk memastikan akun itu memang bisa memutarnya, lalu export ulang cookies youtube.com sambil login dengan akun ITU dan ganti filenya lewat Settings → Cookies.`
          : `Login ke youtube.com dengan akun yang memang bisa memutar video ini (buka videonya di browser dulu untuk memastikan), lalu export cookies.txt (ekstensi "Get cookies.txt LOCALLY" di Chrome/Edge, atau "cookies.txt" di Firefox) dan pasang di Settings → Cookies.`;
        throw new Error(`Video ini dibatasi usia oleh YouTube ("Sign in to confirm your age") — bukan throttling dan bukan kerusakan aplikasi. Video seperti ini hanya dilepas ke sesi yang sudah login.\n\n${hint}${blockedNote}\n\nCatatan: menunggu, pindah jaringan, atau memakai VPN tidak menolong untuk pembatasan usia — hanya cookies dari akun yang sudah login yang membukanya.\n\nAlternatif paling pasti: download videonya manual lalu pakai menu Import file lokal.`);
      }
      // Bot check — checked BEFORE 403 because the two overlap and this one
      // has a different remedy (a session, not a fresher binary).
      if (looksLikeBotCheck(raw)) {
        const hint = cookiesFile
          ? `File cookies kamu (${cookiesFile}) sepertinya sudah KEDALUWARSA. Export ulang cookies youtube.com (ekstensi "Get cookies.txt LOCALLY" di Chrome/Edge, atau "cookies.txt" di Firefox) sambil dalam keadaan login, lalu ganti filenya lewat Settings → Cookies.`
          : `Login ke youtube.com di Chrome/Edge/Firefox, lalu export cookies.txt (ekstensi "Get cookies.txt LOCALLY" / "cookies.txt") dan pasang di Settings → Cookies. Ini cara yang paling andal — sekali terpasang, masalah ini tidak muncul lagi.`;
        throw new Error(`YouTube minta verifikasi login ("Sign in to confirm you're not a bot") untuk video ini.\n\n${hint}${blockedNote}\n\nAlternatif: tunggu beberapa saat, ganti jaringan/VPN, atau download videonya manual lalu pakai menu Import file lokal.`);
      }
      // [EMBED-UNAVAILABLE] After the age gate and bot check (their remedies are
      // more specific), before 403: say WHY in the user's language instead of
      // yt-dlp's text with an AppData path in it.
      if (looksLikeVideoUnavailable(raw)) {
        throw new Error(videoUnavailableMessage(raw, site));
      }
      // [GGC-400] The cache node already rejected this video and the backup
      // node did not help — what is left is the network, not cookies/binary.
      if (viaBackupNode && /\b40[03]\b/.test(raw)) {
        throw new Error(cacheNodeRejectedMessage(site));
      }
      // [PO-TOKEN-NOT-COOKIES] Before the generic 403 branch: its remedy
      // (re-export cookies) cannot fix a client gate or a missing Deno.
      if (site === 'YouTube' && (looksLikeYoutubeFormatGate(raw) || (!DENO && /403|forbidden/i.test(raw)))) {
        throw new Error(youtubeGateMessage({ deno: !!DENO, denoError: denoInstallError }));
      }
      if (/403|forbidden/i.test(raw)) {
        // Was English-only and hardcoded to YouTube, in a UI that is otherwise
        // entirely Indonesian — and simply wrong for any other site.
        const hint = cookiesFile
          ? `\n\nFile cookies kamu (${cookiesFile}) kemungkinan sudah KEDALUWARSA. Export ulang cookies-nya lewat ekstensi SCL VSL Cookies Exporter sambil dalam keadaan login, lalu ganti filenya di Settings → Cookies.`
          : `\n\nBelum ada cookies.txt terpasang. Login ke situsnya, export cookies lewat ekstensi SCL VSL Cookies Exporter, lalu pasang di Settings → Cookies.`;
        throw new Error(`${site} menolak unduhan ini (HTTP 403).${hint}`);
      }
      // [SSL-CERT] Local TLS trust failure — checked BEFORE the throttling and
      // stale branches because its remedy is completely different (fix the
      // machine, not the network or the binary) and because the throttling
      // regex below can otherwise swallow an SSL failure whose retries printed
      // "Retrying (N/3)". None of "ganti jaringan / turunkan resolusi / coba
      // lagi nanti" helps here, so saying them would send the user chasing the
      // wrong thing — exactly the mis-diagnosis this branch exists to stop.
      if (looksLikeSslCertError(raw)) {
        throw new Error(`Gagal memverifikasi sertifikat keamanan (SSL) saat menghubungi YouTube. Ini masalah di komputer/jaringan kamu, BUKAN kerusakan aplikasi atau throttling YouTube.\n\nPenyebab paling umum (cek berurutan):\n1. Jam/tanggal komputer salah — perbaiki lewat Settings Windows → Time & language → Date & time → nyalakan "Set time automatically".\n2. Antivirus/firewall yang men-scan HTTPS (Kaspersky, ESET, Bitdefender, Avast) — matikan sementara fitur "HTTPS scanning" / "SSL/TLS inspection" lalu coba lagi.\n3. Jaringan kantor/sekolah dengan proxy yang menyadap HTTPS — coba pakai jaringan lain (mis. hotspot HP).\n\nKalau semua sudah benar dan masih gagal, download videonya manual lalu pakai menu Import file lokal.`);
      }
      // Mid-stream connection drops that exhausted every retry ("N bytes read,
      // M more expected … Giving up after X retries") — server-side throttling,
      // not a broken install. Tell the user what actually helps.
      if (/more expected|Giving up after \d+ retr/i.test(raw)) {
        throw new Error(`Koneksi ke server ${site} terputus berulang kali di tengah unduhan (throttling dari sisi server, bukan kerusakan aplikasi).\n\nCoba jalankan ulang pipeline — unduhan akan dilanjutkan dari posisi terakhir. Kalau masih gagal: coba beberapa menit lagi, pakai jaringan lain, atau turunkan Resolution.`);
      }
      throw e;
    };

    // [YTDLP-SELFHEAL] Run the download; if it fails in a way a fresh yt-dlp
    // would fix (YouTube changed its protocol — the #1 cause of 403 / "Sign in
    // to confirm" / nsig failures, on BOTH Mac and Windows), auto-download the
    // latest yt-dlp and retry ONCE before blaming cookies. Guarded so it can
    // never loop, and a failed refresh falls straight through to the normal
    // actionable error — offline/GitHub-down never bricks the download.
    let ytdlpRefreshed = false;
    const rawOf = (e) => `${e?.message || ''}\n${e?.stderr || ''}`;
    const site = platformLabel(source);

    // [DRIVE-FOLDER] Refuse a folder link before spending a download attempt
    // and a pointless binary refresh on it (see isGoogleDriveFolderUrl).
    if (isGoogleDriveFolderUrl(source)) {
      throw new Error(`Link itu adalah FOLDER Google Drive, bukan satu file video. Aplikasi memproses satu video per run.\n\nCara memperbaiki:\n1. Buka folder itu di Google Drive.\n2. Klik kanan video yang mau diproses → "Dapatkan link" / "Get link".\n3. Pastikan aksesnya "Siapa saja yang memiliki link" ("Anyone with the link").\n4. Tempel link file itu (bentuknya .../file/d/XXXX/view) ke sini.\n\nKalau mau memproses beberapa video, jalankan satu per satu.`);
    }

    // [TRANSIENT-EXTRACT] Retry a randomly-failing extraction before ANY of the
    // heavier remedies below (fresh binary, browser cookies, embedded player) —
    // it is the cheapest possible fix and, for the reported TikTok link, the
    // only one that was ever going to work. Measured 6/10 failure on identical
    // runs, so a single attempt loses more often than it wins; 5 retries puts
    // the odds of a spurious total failure at roughly 5%. Each attempt is only
    // a few seconds, and the backoff is short and linear because there is
    // nothing to back off FROM — this is not rate limiting, and the site is not
    // asking us to slow down.
    const TRANSIENT_EXTRACT_RETRIES = 5;
    const attemptDownloadWithRetries = async () => {
      let lastErr;
      for (let attempt = 0; attempt <= TRANSIENT_EXTRACT_RETRIES; attempt++) {
        try {
          return await attemptDownload();
        } catch (e) {
          lastErr = e;
          // A user pressing Cancel must never be retried into ignoring them.
          if (isCancelError(e)) throw e;
          if (attempt === TRANSIENT_EXTRACT_RETRIES) break;
          if (!looksLikeTransientExtractFailure(rawOf(e))) break;
          log(`⚠ ${site} gagal di tahap ekstraksi (gangguan sesaat, bukan video-nya) — mencoba lagi (${attempt + 1}/${TRANSIENT_EXTRACT_RETRIES})…`, 'yellow');
          prog('Download', `mencoba lagi (${attempt + 1}/${TRANSIENT_EXTRACT_RETRIES})…`, 4);
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      throw lastErr;
    };

    try {
      await attemptDownloadWithRetries();
    } catch (e) {
      // Match on the raw stderr, not the condensed message — the stale-yt-dlp
      // giveaways ("nsig", "unable to extract", "player response") often appear
      // on WARNING lines that pickErrorLines drops.
      let err = e;
      // [GGC-400] First: it is not the client, the binary or the cookies, so
      // every remedy below would hit the same node. Only when the failed run's
      // URLs name a backup node (otherwise there is nothing to switch to).
      if (site === 'YouTube' && !isCancelError(err) && looksLikeVideoData400(rawOf(err))) {
        let hasBackup = false;
        try { hasBackup = rewriteToBackupNode(JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'))) > 0; } catch {}
        if (hasBackup) {
          viaBackupNode = true;
          log('⚠ Server cache YouTube di jaringanmu menolak video ini (HTTP 400) — mengunduh langsung dari server Google…', 'yellow');
          prog('Download', 'lewat server Google langsung…', 4);
          try { await attemptDownloadWithRetries(); err = null; }
          catch (e6) { if (isCancelError(e6)) throw e6; err = e6; }
        }
      }
      if (err && !ytdlpRefreshed && looksLikeStaleYtdlp(rawOf(err))) {
        ytdlpRefreshed = true;
        let fresh = null;
        try {
          log(`▶ ${site} menolak versi yt-dlp — mengunduh yt-dlp terbaru lalu coba lagi…`, 'lime');
          prog('Download', 'memperbarui yt-dlp…', 4);
          fresh = await refreshYtdlpBinary((msg, pct) => prog('Download', typeof msg === 'string' ? msg : 'memperbarui yt-dlp…', 4));
        } catch (re) {
          log(`⚠ Update yt-dlp otomatis gagal: ${re?.message || re}`, 'warn');
        }
        if (fresh) {
          YTDLP = fresh;
          log('✓ yt-dlp diperbarui otomatis — mengunduh ulang…', 'lime');
          try { await attemptDownloadWithRetries(); err = null; }
          catch (e2) { err = e2; }
        }
      }
      // [EMBED-UNAVAILABLE] The primary route asks as an embedded player, and an
      // owner can block exactly that — YouTube then says "Video unavailable"
      // for a public video. One retry with yt-dlp's own client order (measured:
      // 1080p on the reported video, where android_vr got 403). Before the
      // bot-check block on purpose: if this client is asked to sign in, the
      // cookie fallback below still gets its turn.
      if (err && site === 'YouTube' && looksLikeVideoUnavailable(rawOf(err))) {
        log('▶ YouTube menolak pemutar tersemat untuk video ini — mencoba jalur lain…', 'lime');
        prog('Download', 'mencoba jalur lain…', 4);
        activeExtractorArgs = youtubeDefaultClientArgs();
        try { await attemptDownloadWithRetries(); err = null; }
        catch (e5) { err = e5; }
      }
      // [BOT-CHECK] A fresh yt-dlp does NOT fix "Sign in to confirm you're not
      // a bot" — that one is YouTube demanding a logged-in session from this
      // IP. If the user has no cookies.txt, borrow the session from a browser
      // they already have signed in. One try per installed browser, then give
      // up with an actionable message.
      if (err && !cookiesFile && looksLikeBotCheck(rawOf(err))) {
        for (const browser of browserCookieCandidates()) {
          log(`▶ YouTube minta bukti login — mencoba cookies dari ${browser}…`, 'lime');
          prog('Download', `cookies dari ${browser}…`, 4);
          cookieArgs = ['--cookies-from-browser', browser];
          try { await attemptDownload(); err = null; break; }
          catch (e3) {
            // [COOKIE-SOURCE] Could not open this browser's cookie store, so
            // yt-dlp never reached YouTube. Deliberately leave `err` holding the
            // ORIGINAL bot-check failure — overwriting it here is exactly what
            // made the reported error a red herring — and try the next browser,
            // because a locked Chrome tells us nothing about Edge or Firefox.
            if (looksLikeBrowserCookieBlocked(rawOf(e3))) {
              const kind = blockedCookieKind(browser, rawOf(e3), process.platform);
              blockedCookieBrowsers.push({ browser, kind });
              log(`⚠ Cookies ${browser} tidak bisa dibaca (${BLOCKED_COOKIE_REASON[kind]}) — lanjut ke browser lain…`, 'warn');
              continue;
            }
            err = e3;
            log(`⚠ Cookies dari ${browser} tidak bisa dipakai: ${(e3?.message || e3 || '').toString().split('\n')[0]}`, 'warn');
            if (!looksLikeBotCheck(rawOf(e3))) break;   // a genuinely different download failure — stop guessing
          }
        }
      }
      if (err && looksLikeYoutubePoToken403(rawOf(err))) {
        log('▶ YouTube memblokir format (403/PO-token) — mencoba fallback embedded player…', 'lime');
        prog('Download', 'mencoba fallback embedded…', 4);
        activeExtractorArgs = youtubeEmbeddedFallbackArgs();
        activeSelector = youtubeEmbeddedFallbackSelector(sel);
        try { await attemptDownload(); err = null; }
        catch (e4) { err = e4; }
      }
      if (err) surfaceDownloadError(err);
    }
    // [YT-LOW-RES] YouTube can quietly offer only format 18 (360p) to a
    // throttled client — no error, so the gate handling above never runs and
    // the selector's last "/best" takes it. Measured 2026-10-11: the same
    // video came down 1080p at 16:30 and 640×360 at 17:16, and the clips
    // were upscaled 3x ("burik"). Retry once on another player client.
    try {
      const want = parseInt(String(cfg.resolution || '1080p'), 10) || 1080;
      const got = (await getStreamDims(resolveDownloadedVideo(sessionDir) || '')).h || 0;
      // Highest video height YouTube listed for this run (info json).
      let maxAvail = 0;
      try {
        const infoFile = [sessionDir, path.join(sessionDir, 'data')].flatMap((d) => { try { return fs.readdirSync(d).filter((f) => /\.info\.json$/.test(f)).map((f) => path.join(d, f)); } catch { return []; } })[0];
        const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
        for (const f of info.formats || []) if (f && f.vcodec && f.vcodec !== 'none' && +f.height > maxAvail) maxAvail = +f.height;
      } catch {}
      log(`▶ Kualitas sumber: ${got || '?'}p (tersedia s/d ${maxAvail || '?'}p, target ${want}p)`, 'gray');
      // Throttle signature (≤480p for an HD target, often only format 18 is
      // listed) OR a lower height than YouTube itself offered.
      const throttled = want >= 720 && got > 0 && got <= 480;
      const underServed = got > 0 && maxAvail > got && got < Math.min(want, maxAvail);
      if (site === 'YouTube' && (throttled || underServed)) {
        log(`⚠ YouTube hanya memberi ${got}p (target ${want}p) — mengunduh ulang dengan jalur lain…`, 'yellow');
        prog('Download', 'mengunduh ulang kualitas HD…', 4);
        for (const f of fs.readdirSync(sessionDir)) {
          if (/^source\.(mp4|mkv|webm|m4a|part)$|^source\..*\.part$|^source\.f\d+/.test(f)) { try { fs.unlinkSync(path.join(sessionDir, f)); } catch {} }
        }
        // yt-dlp's own client order (measured 1080p on this video); NOT
        // android_vr, which offers only format 18 (360p) here.
        activeExtractorArgs = require('./source-acquisition').youtubeDefaultClientArgs();
        try { await attemptDownload(); } catch (e5) { if (isCancelError(e5)) throw e5; log(`⚠ Unduh ulang gagal (${String(e5 && e5.message || e5).split('\n')[0]})`, 'yellow'); }
        const got2 = (await getStreamDims(resolveDownloadedVideo(sessionDir) || '')).h || 0;
        if (got2 > got) log(`✓ Kualitas sumber naik ke ${got2}p`, 'lime');
        else log(`⚠ YouTube tetap hanya memberi ${got2 || got}p untuk koneksi ini — hasil klip akan buram. Coba lagi beberapa menit, pasang cookies (Settings → Cookies), ganti jaringan, atau download video manual lalu pakai Import file lokal.`, 'warn');
      }
    } catch (e) { if (isCancelError(e)) throw e; }

    inputPath = await validateDownloadedSource(sessionDir);
    log(`✓ Video lokal siap: ${path.basename(inputPath)}`, 'lime');

    // ── Subtitle pass (best-effort, non-fatal, single-track) ──
    // [INNERTUBE-FIRST] Try a direct Innertube caption fetch before falling
    // back to the yt-dlp subprocess loop below. One player-API call reveals
    // every available caption track at once (no per-language round trips),
    // typically finishes in under a second, and sidesteps the subtitle
    // endpoint's own 429s entirely — see innertube-transcript.js. On any
    // failure (network, no captions, YouTube API shape change) this falls
    // through to one metadata-selected yt-dlp track.
    let subtitleDownloadedViaInnertube = false;
    try {
      readInfoJson();
      const preferredLang = (cfg.subtitleLang || 'auto').toLowerCase();
      const langHint = ytInfo?.original_language || ytInfo?.language || '';
      const it0 = Date.now();
      const result = await fetchTranscriptViaInnertube(source, {
        lang: preferredLang,
        langHint,
        timeoutMs: 12000,
        onLog: (m) => log(m, 'gray'),
      });
      const innertubeSubtitlePath = path.join(sessionDir, `source.${result.lang}.srt`);
      fs.writeFileSync(innertubeSubtitlePath, result.srt);
      acquiredSubtitleFile = innertubeSubtitlePath;
      const currentInnertubeWords = Array.isArray(result.words) ? result.words : [];
      acquiredSubtitleWords = persistAcquiredSubtitleWords(sessionDir, currentInnertubeWords);
      // [WORD-TIMING-INNERTUBE] Persist the per-word times alongside the SRT.
      // The SRT alone carries only display-window cues; deriving word timing
      // from those put 97% of caption chunks >0.5s late (mean +1.64s measured
      // on a real 44-min source), while these real word starts sit within
      // ~0.1-0.3s of a Whisper ground truth. The transcript stage below loads
      // this into `words`, the same tight-sync path ASR transcripts use.
      subtitleDownloadedViaInnertube = true;
      subtitleTrackLang = String(result.lang || '').toLowerCase().split(/[-_]/)[0] || null;
      log(`▶ Subtitle terunduh via Innertube (${result.lang}, ${Date.now() - it0}ms${currentInnertubeWords.length ? `, ${currentInnertubeWords.length} kata ber-timestamp` : ''})`, 'lime');
    } catch (e) {
      if (isCancelError(e)) throw e;
      log(`⚠ Innertube caption fetch gagal (${e.message}) — lanjut ke yt-dlp…`, 'yellow');
    }
    // YouTube rate-limits subtitle endpoints heavily. Metadata from the video
    // pass already lists every caption track, so resolve ONE exact key locally
    // instead of probing multiple languages or downloading every translation.
    if (!subtitleDownloadedViaInnertube) {
      readInfoJson();
      const selectedLanguage = selectSubtitleTrack(ytInfo, cfg.subtitleLang || 'auto');
      if (!selectedLanguage) {
        log('⚠ Metadata video tidak menyediakan caption yang bisa dipakai — yt-dlp subtitle dilewati', 'yellow');
      } else {
        log(`▶ Mengambil satu track subtitle (${selectedLanguage})…`, 'lime');
        const subtitleResult = await downloadSingleSubtitleTrack({
          language: selectedLanguage,
          ytdlp: YTDLP,
          source,
          sessionDir,
          outputTemplate: tmpl,
          ffArgs,
          qualArgs,
          cookieArgs,
          env: ytEnv(),
          onRateLimit: (retryMs) => log(`⚠ Subtitle (${selectedLanguage}) kena rate limit — coba lagi dalam ${retryMs / 1000}s…`, 'yellow'),
        });
        if (subtitleResult.downloaded) {
          acquiredSubtitleFile = subtitleResult.file;
          const ytdlpWords = Array.isArray(subtitleResult.words) ? subtitleResult.words : [];
          acquiredSubtitleWords = persistAcquiredSubtitleWords(sessionDir, ytdlpWords);
          subtitleTrackLang = String(selectedLanguage || '').toLowerCase().split(/[-_]/)[0] || null;
          log(`▶ Subtitle terunduh (${selectedLanguage}${ytdlpWords.length ? `, ${ytdlpWords.length} kata ber-timestamp` : ''})`, 'lime');
        } else if (subtitleResult.error && /429|too many request/i.test(`${subtitleResult.error.message || ''}\n${subtitleResult.error.stderr || ''}`)) {
          log('⚠ YouTube subtitle rate-limit (429) — lanjut tanpa transkrip', 'yellow');
        } else {
          log('⚠ Subtitle tidak tersedia — lanjut tanpa transkrip', 'yellow');
        }
      }
    }
    // Backstop: if the "Writing video metadata" line never reached onLine (a
    // retry path that reuses an already-downloaded file, a localised yt-dlp
    // build, a suppressed line), pick the JSON up off disk now. Without this a
    // missed log line would silently strip video context out of every AI
    // prompt downstream — the exact failure mode the old probe's catch block
    // was written to make visible.
    readInfoJson();
    if (!ytInfo) log('⚠ Tidak bisa membaca info video — lanjut tanpa metadata (judul/channel tidak masuk prompt AI)', 'yellow');
  } else {
    if (!fs.existsSync(source)) throw new Error('File tidak ditemukan: ' + source);
    inputPath = source;
    log(`▶ File lokal dimuat`, 'lime');
    // [SIDECAR-SUB] Pick up "video.srt" / "video.id.srt" sitting beside the
    // import — unless the user already attached one by hand, which always wins.
    if (!subtitleFile && !noTranscript) {
      const sidecar = findSidecarSubtitle(inputPath, cfg.subtitleLang || 'auto');
      if (sidecar) {
        subtitleFile = sidecar;
        subtitleFileIsSidecar = true;
        log(`▶ Subtitle ditemukan di samping video: ${path.basename(sidecar)}`, 'lime');
      } else {
        // [EMBEDDED-SUB] No sidecar file — check for a text subtitle track
        // INSIDE the container before falling all the way through to full
        // ASR. See the comment at findEmbeddedSubtitleStream for why this
        // matters: a YouTube URL import gets a free Innertube caption fetch
        // in under a second, a local import previously had no equivalent
        // fast path at all once the sidecar check missed.
        try {
          const embedded = await findEmbeddedSubtitleStream(
            inputPath, cfg.subtitleLang || 'auto', FFPROBE, spawnLines);
          if (embedded) {
            const embeddedPath = path.join(sessionDir, 'source.embedded.srt');
            await extractEmbeddedSubtitle(inputPath, embedded.index, embeddedPath, FFMPEG, spawnLines);
            subtitleFile = embeddedPath;
            subtitleFileIsSidecar = true;   // same "already available, skip ASR" treatment
            log(`▶ Subtitle tertanam di video ditemukan (track ${embedded.lang || '?'}, ${embedded.codec}) — dipakai, ASR dilewati`, 'lime');
          }
        } catch (e) {
          log(`⚠ Cek subtitle tertanam gagal (${e.message}) — lanjut cek transkrip lain`, 'gray');
        }
      }
    }
  }
  if (cancelled) throw new Error('cancelled');

  // ── 2) ffprobe ──
  stages.begin('Analisa');
  prog('Analyze', 'ffprobe metadata', 28);
  const metadataPath = SF.dataPath(sessionDir, 'metadata.json');
  let probeRaw = '';
  try { probeRaw = fs.readFileSync(metadataPath, 'utf8'); } catch {}
  if (!probeHasVideoStream(probeRaw)) {
    try {
      ({ stdout: probeRaw } = await spawnLines(FFPROBE,
        ['-v','error','-print_format','json','-show_format','-show_streams', inputPath],
        { onLine: () => {}, timeoutMs: SOURCE_PROBE_TIMEOUT_MS }));
    } catch (e) {
      if (cancelled || isCancelError(e) || isUrl) throw e;
      // [LOCAL-UNREADABLE] A half-copied or truncated file surfaced as a raw
      // "ffprobe exited 1 … moov atom not found" with the binary's full path.
      throw new Error(localUnreadableMessage(path.basename(inputPath), e && e.message));
    }
    // [LOCAL-NOT-VIDEO] An audio file or an image imported as "video" used to
    // run on with an empty video stream and fail somewhere far downstream.
    if (!isUrl && !probeHasVideoStream(probeRaw)) {
      throw new Error(`File "${path.basename(inputPath)}" tidak berisi gambar video (hanya audio, gambar, atau formatnya tidak dikenali). Import file video seperti MP4, MOV, MKV, atau WEBM.`);
    }
  }
  fs.writeFileSync(metadataPath, probeRaw);
  const meta = JSON.parse(probeRaw);
  const duration = Math.max(1, Number(meta.format?.duration || ytInfo?.duration || 60));
  const vstream = meta.streams?.find(s => s.codec_type === 'video') || {};
  let audioStreamIndex = findBestAudioStream(meta.streams, cfg.subtitleLang || 'auto');   // let: [MULTI-AUDIO-ASR] may move to the track that has the speech
  // [NO-AUDIO-SOURCE] An imported video with no audio track (screen recording,
  // muted export, B-roll) sails through Transcribe/Hooks/Titles — ASR is
  // non-fatal — and then died at Render: the Smart Track path extracts the
  // clip's audio to its own .m4a, and with nothing to extract ffmpeg 6.1
  // refuses the empty output ("Error opening output file …_clipaudio-….m4a.
  // Error opening output files: Invalid argument", exit 4294967274 = -22).
  const sourceHasAudio = (meta.streams || []).some((s) => s && s.codec_type === 'audio');
  if (!sourceHasAudio) log('▶ Video ini tidak punya audio — klip dirender tanpa suara', 'yellow');
  if (Number.isInteger(audioStreamIndex)) {
    const s = meta.streams?.find(x => x.index === audioStreamIndex);
    const sLang = s?.tags?.language || s?.tags?.lang || s?.tags?.title || '';
    log(`▶ Audio stream: track #${audioStreamIndex}${sLang ? ` (${sLang})` : ''}`, 'lime');
  }
  log(`▶ Durasi video: ${(duration/60).toFixed(1)} menit · ${vstream.width}×${vstream.height}`, 'lime');

  // Thumbnail
  prog('Analyze', 'thumbnail', 36);
  const thumbPath = SF.dataPath(sessionDir, 'thumbnail.jpg');
  try {
    await spawnLines(FFMPEG, ['-y','-ss', String(Math.min(2, duration/3)), '-i', inputPath, '-frames:v','1','-q:v','2', thumbPath], { onLine: () => {} });
    try { onSourcePreview?.({ phase: 'local', file: inputPath, thumbnail: thumbPath, title: ytInfo?.title || path.basename(inputPath), channel: ytInfo?.uploader || '', sourceType: isUrl ? 'youtube' : 'file' }); } catch {}
  } catch (e) {
    log(`⚠ Thumbnail source gagal dibuat (${e?.message || e}) — pipeline tetap dilanjutkan`, 'yellow');
    try { onSourcePreview?.({ phase:'local', file:inputPath, title:ytInfo?.title || path.basename(inputPath), sourceType:isUrl ? 'youtube' : 'file' }); } catch {}
  }

  // ── 3) Transcript ──
  stages.begin('Transkrip');
  prog('Transcribe', 'looking for subtitles…', 42);
  let cues = [];
  let words = [];   // [WORD-TIMING] flat word-level list (absolute times) when ASR provides it
  const transcriptSource = noTranscript
    ? null
    : selectTranscriptSource({ sessionDir, subtitleFile, subtitleFileIsSidecar, acquiredSubtitleFile });
  if (noTranscript) {
    log('▶ Tanpa transcript — potong otomatis (even chunk)', 'yellow');
  } else if (transcriptSource) {
    try {
      const transcriptPath = transcriptSource.file;
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      const ext = (transcriptPath.split('.').pop() || '').toLowerCase();
      if (ext === 'vtt')      cues = parseVtt(raw);
      else if (ext === 'txt') cues = parseTranscriptText(raw, duration) || buildCuesFromPlainText(raw, duration);
      else                    cues = parseSrt(raw);   // .srt and any fallback
      if (transcriptSource.kind === 'attached') {
        log(`▶ Transcript "${transcriptPath.split(/[/\\]/).pop()}" dimuat (${cues.length} baris)`, 'lime');
      } else {
        log(`▶ Transkrip subtitle dimuat (${cues.length} baris)`, 'lime');
      }
      // [WORD-PROVENANCE] Fresh acquisitions use only timing captured in this
      // run; attached files use none; persisted timing is reserved for a true
      // legacy/session transcript selected by the boundary above.
      words = subtitleWordsForSource({ transcriptSource, acquiredSubtitleWords, sessionDir });
      if (words.length) log(`▶ Timing per-kata dimuat (${words.length} kata) — sinkron caption presisi`, 'lime');
      ({ cues, words } = dropNonSpeech({ cues, words }));   // [NON-SPEECH]
      // [SUB-COVERAGE] Only an AUTO-picked track (sidecar beside the file or
      // embedded in it) is second-guessed; a file the user attached by hand
      // is their call — warn, don't override.
      const coverage = subtitleCoverage(cues, duration);
      if (cues.length && sourceHasAudio && duration >= SUB_COVERAGE_MIN_SOURCE_SEC && coverage < SUB_COVERAGE_MIN) {
        const pct = Math.round(coverage * 100);
        if (transcriptSource.kind === 'sidecar') {
          log(`⚠ Subtitle bawaan cuma mencakup ${pct}% video — dianggap tidak lengkap, transkrip dibuat dari audio`, 'yellow');
          cues = []; words = [];
          // Our own extraction of an embedded track lives in the session; left
          // there, tidyTranscriptFiles counts it as "the subtitle file" and never
          // saves the ASR result, so a re-import reloads the partial track.
          // A sidecar beside the user's video is outside the session — untouched.
          if (path.resolve(transcriptSource.file).startsWith(path.resolve(sessionDir) + path.sep)) {
            try { fs.unlinkSync(transcriptSource.file); } catch {}
          }
        } else {
          log(`⚠ Transcript yang dilampirkan cuma mencakup ${pct}% video — bagian lain tidak akan punya caption`, 'yellow');
        }
      }
    } catch (e) {
      log(`⚠ Gagal baca transcript (${e.message}) — lanjut tanpa transkrip`, 'yellow');
      cues = [];
    }
  }
  // ── ASR fallback: no SRT, no YouTube captions → transcribe the audio ──
  // Runs for both imported local files and downloads where subtitles were
  // unavailable, so captions still appear (and can be burned). Non-fatal.
  // [LANG-HINT] Whisper's OWN language detection (cloud verbose_json or local
  // whisper.cpp's stderr) — see transcribeAudio() — hoisted here so it
  // survives past the `if` block below and can feed detectLanguage() as the
  // highest-confidence signal, instead of re-guessing from a 2-language
  // stopword count on the resulting transcript text.
  let asrDetectedLang = null;
  // [NO-AUDIO-SOURCE] Nothing to transcribe: skip ASR instead of letting it
  // fail with an ffmpeg exit code — and before it can ask the user to fetch a
  // Whisper model or a Groq key for a video that has no sound at all.
  if (!noTranscript && !cues.length && !sourceHasAudio) {
    log('⚠ Video tanpa audio — transkrip & caption otomatis dilewati', 'yellow');
  } else if (!noTranscript && !cues.length) {
    stages.begin('ASR');
    prog('Transcribe', 'speech-to-text (Whisper)…', 44);
    // [ASR-LANG] cfg.subtitleLang defaults to 'id' and had no 'auto' option, so
    // EVERY transcription was forced to Indonesian — including English videos,
    // where forcing the decoder to the wrong language does not translate, it
    // produces mangled phonetic nonsense. Whisper's own language detection is
    // reliable and the failure modes are asymmetric: a wrong forced language
    // destroys the transcript, while a mis-detected one is usually a close
    // sibling (id/ms) that everything downstream tolerates. So 'auto' now
    // means auto, and a language is only forced when the user explicitly
    // picked one.
    const rawLang = String(cfg.subtitleLang || 'auto').toLowerCase();
    const asrLang = (rawLang && rawLang !== 'auto') ? rawLang : undefined;
    log(asrLang
      ? `▶ Transkrip: bahasa dipaksa ke "${asrLang}" (ubah di Clip Options → Subtitle language)`
      : '▶ Transkrip: bahasa dideteksi otomatis', 'lime');
    const _asr = await transcribeAudio(cfg, inputPath, sessionDir, {
      onLog: log, onProgress: prog, lang: asrLang, binPaths, secretsLocked, onConfirmDownload,
      sourceDurationSec: duration, audioStreamIndex,
    });
    if (cancelled) throw new Error('cancelled');   // [ASR-CANCEL] before any retry work
    let asrBest = dropNonSpeech({ cues: _asr.cues || [], words: _asr.words || [] });   // [NON-SPEECH]
    let asrBestLang = _asr.language || null;
    // [MULTI-AUDIO-ASR] OBS and many cameras write several audio tracks
    // (desktop + mic, music + voice, dub + original). findBestAudioStream picks
    // one by metadata alone; when that track turns out to carry (almost) no
    // speech, try the others and keep whichever actually has the words — and
    // render with that track too, or the captions would play over audio that
    // does not contain them. Measured: speech on track #2, track #1 a tone →
    // transcript "[Music]", 1 word.
    const speechWords = (r) => (r.words.length || r.cues.length);
    const minSpeech = Math.max(5, Math.ceil((duration / 60) * MIN_WORDS_PER_MINUTE));
    const otherAudio = (meta.streams || []).filter((st) => st && st.codec_type === 'audio' && st.index !== audioStreamIndex);
    if (speechWords(asrBest) < minSpeech && otherAudio.length && !cancelled) {
      for (const st of otherAudio) {
        log(`▶ Track audio #${audioStreamIndex} hampir tanpa ucapan — mencoba track audio #${st.index}…`, 'lime');
        const alt = await transcribeAudio(cfg, inputPath, sessionDir, {
          onLog: log, onProgress: prog, lang: asrLang, binPaths, secretsLocked, onConfirmDownload,
          sourceDurationSec: duration, audioStreamIndex: st.index,
        });
        if (cancelled) throw new Error('cancelled');
        const altClean = dropNonSpeech({ cues: alt.cues || [], words: alt.words || [] });
        if (speechWords(altClean) > speechWords(asrBest)) {
          asrBest = altClean; asrBestLang = alt.language || null;
          audioStreamIndex = st.index;
          log(`▶ Ucapan ada di track audio #${st.index} — transkrip & audio klip memakai track ini`, 'lime');
        }
        if (speechWords(asrBest) >= minSpeech) break;
      }
    }
    cues = asrBest.cues;
    words = asrBest.words;
    asrDetectedLang = asrBestLang;
    // [ASR-CANCEL] transcribeAudio is non-fatal by design, so a Cancel that
    // landed mid-ASR used to return here as an ordinary empty result and the
    // run continued through the AI stages before dying. Stop immediately.
    if (cancelled) throw new Error('cancelled');
    if (!cues.length) log('⚠ Transkrip otomatis tidak tersedia — AI analisa tanpa transkrip', 'yellow');
  }
  // [BURN-PREFLIGHT] Burning captions is gated on cueWords, which are derived
  // from `cues`/`words` — so no transcript means the burn pass is skipped for
  // EVERY clip, silently, while the run still succeeds and still fills the
  // output folder. That reads to the user as "Burn subtitles ON but the burned
  // file never appears", and it lands almost exclusively on LOCAL IMPORTS: a
  // YouTube URL gets a transcript free from yt-dlp's own captions, whereas an
  // imported file has only a sidecar .srt or ASR — and ASR needs an API key,
  // or the offline engine the user may have declined at the consent prompt.
  // Say so HERE, before 10+ minutes of rendering, instead of leaving them to
  // infer it from a folder of caption-less clips.
  if (cfg.burnSubtitles && !cues.length) {
    log('⚠ Burn subtitles AKTIF tapi tidak ada transkrip — caption TIDAK akan dibakar ke klip manapun.', 'yellow');
    log('⚠ Perbaiki dengan salah satu: lampirkan file .srt lewat "Attach transcript", isi Groq API key (gratis) di Settings, atau izinkan unduh mesin transkrip offline saat ditanya.', 'yellow');
  }
  // Build a compact transcript text for the LLM
  const transcriptText = cues.length
    ? cues.map(c => `[${tcAss(c.start)}-${tcAss(c.end)}] ${c.text}`).join('\n')
    : `(Transcript tidak tersedia. Buat highlight berdasarkan judul/deskripsi saja. Durasi total: ${duration.toFixed(0)}s)`;
  await tidyTranscriptFiles(sessionDir, transcriptText, { cues, words });
  // [AI-TRANSCRIPT-COMPACT] Compact copy for the AI calls; transcript.txt above
  // keeps the per-cue stamps. Line length follows the duration preset so the
  // 15 s preset still has ~5 s anchors to cut on.
  const _aiLineMax = Math.min(20, Math.max(5, resolveDuration(cfg.clipDuration).min / 2));
  // [PROMO-DENSITY] Sponsor reads never reach the AI: it picked a ShopBack read
  // woven into the talk as 2 of 3 clips despite the prompt's ad rule. Less text
  // is also fewer tokens. (filterByWindow still blocks them for local picks.)
  const _aiPromo = detectPromoRanges(cues);
  const _aiCues = _aiPromo.length ? cues.filter((c) => !rangeOverlapsBlocked(Number(c.start), Number(c.end), _aiPromo, 0.01)) : cues;
  if (_aiPromo.length) log(`▶ ${_aiPromo.length} segmen iklan/promo dikeluarkan dari analisa AI (${_aiPromo.map((r) => `${aiStamp(r.start)}–${aiStamp(r.end)}`).join(', ')})`, 'gray');
  const aiTx = cues.length
    ? buildAiTranscript(_aiCues, { minLineSec: Math.min(6, _aiLineMax), maxLineSec: _aiLineMax })
    : { text: transcriptText, lines: [] };
  const aiText = aiTx.text;

  // [TRACKER-PREWARM] Measured on a real Windows machine (no dGPU): the
  // FIRST tracker job pays ~12.2s of model load (SCRFD + MediaPipe +
  // onnxruntime/DirectML init) on top of ~0.3s process spawn — a job on an
  // already-warm worker is ~13.4s vs ~25.6s cold, same clip. The render stage
  // below only creates its TrackerWorker once highlight detection AND hook/
  // title generation have both already run serially, so that ~12s currently
  // sits 100% on the critical path, dead last.
  //
  // Firing a tiny real job now — right after transcript.txt, before the AI
  // stages — lets the model load happen WHILE those stages await their HTTP
  // responses, which is idle time for the CPU either way. Deliberately NOT
  // placed any earlier: the ASR stage above uses every logical thread
  // (buildWhisperArgs' `-t`), and MediaPipe's landmark pass is CPU-only, so
  // overlapping the two would trade dead time for real contention on exactly
  // the hardware this is meant to help.
  //
  // Only fires when the render stage is GUARANTEED to want exactly one
  // tracker worker — cfg.smartTrack and trackerAccelCapFor(...) === 1, the same
  // condition that pins CLIP_CONCURRENCY to 1 below — and only when the
  // runtime bundle is already installed, so pre-warming can never trigger the
  // ~350MB first-run download (that has its own UI progress tied to the
  // Render stage; doing it silently here would hide it from the user).
  //
  // A failed or slow pre-warm is never worse than not pre-warming: the render
  // stage awaits the SAME promise instead of spawning fresh, so it inherits
  // whatever head start already happened (zero, in the worst case) rather
  // than losing anything. Any error is swallowed here and surfaces (if it
  // still can) inside the render stage's own try/catch around tracker use,
  // exactly as if pre-warming had never been attempted.
  let prewarmedTracker = null;
  // [TRACKER-ACCEL-CAP] The numeric cap drives both render parallelism and
  // whether it is useful/safe to hide the first model load behind AI stages.
  const prewarmCap = trackerAccelCapFor({
    platform: process.platform, hw: detectHwEncoder(), dmlAvailable: detectTrackerAccel().dmlAvailable,
    totalMemBytes: os.totalmem(),
  });
  const prewarmAllowed = trackerPrewarmAllowedFor({
    platform: process.platform,
    totalMemBytes: os.totalmem(),
    cap: prewarmCap,
  });
  if (cfg.smartTrack && !prewarmAllowed && process.platform === 'win32') {
    log('⏵ Windows 8 GB: Smart Track dimulai saat tahap tracking agar RAM tidak menumpuk di Hook Title.');
  }
  if (cfg.smartTrack && prewarmAllowed && trackerAvailable()) {
    try {
      const tw = new TrackerWorker();
      prewarmedTracker = tw.run({ video: inputPath, clipStart: 0, clipEnd: 1, format: cfg.format, asdMode: cfg.trackerAsdMode })
        .then(() => tw, (e) => { tw.kill(); throw e; });
      prewarmedTracker.catch(() => {});   // observed here so it never becomes an unhandled rejection
    } catch { prewarmedTracker = null; }
  }

  // ── 4) Highlight detection ──
  stages.begin('Cari momen (AI)');
  // [MANUAL-SEGMENTS] Three modes, chosen by the user in Clip Options:
  //   'auto'   → highlight detection only (unchanged behaviour)
  //   'manual' → ONLY the ranges the user typed; no AI/local detection at all
  //   'hybrid' → the manual ranges are guaranteed, detection fills the rest
  // `numClips` from here on is the AUTO target, so it drops to 0 in manual mode
  // and shrinks by the seed count in hybrid. Every existing count-guarantee and
  // top-up block below is written against numClips, so they no-op correctly at
  // 0 instead of needing their own mode checks.
  const clipMode = ['manual', 'hybrid'].includes(String(cfg.clipMode || '').toLowerCase())
    ? String(cfg.clipMode).toLowerCase() : 'auto';
  // [CLIP-HISTORY] Moments earlier runs of this same source already cut — the
  // pipeline looks for other moments first (see clip-history.js).
  const clipHistory = require('./clip-history');
  let seenRanges = [];
  if (clipMode !== 'manual') {
    try {
      seenRanges = await clipHistory.pastPickRanges({
        roots: [path.dirname(sessionDir), ...(Array.isArray(cfg.workRoots) ? cfg.workRoots : [])],
        key: clipHistory.sourceKeyFor({ ytInfo, source, isUrl, duration }),
        excludeDir: sessionDir,
      });
    } catch { seenRanges = []; }
    if (seenRanges.length) log(`▶ Video ini sudah pernah diproses (${seenRanges.length} klip lama) — dicari momen lain dulu, klip lama hanya dipakai kalau tidak ada lagi`, 'lime');
  }
  const wantClips = Math.max(1, Number(cfg.clipCount) || 5);
  const manualParse = clipMode === 'auto'
    ? { clips: [], rejected: [] }
    : parseManualSegments(cfg.manualSegments, duration);
  const manualClips = manualParse.clips;
  if (clipMode !== 'auto') {
    for (const r of manualParse.rejected) log(`⚠ Segmen manual #${r.row} dilewati — ${r.reason}`, 'yellow');
    for (const c of manualClips.filter(c => c.clamped)) log(`▶ Segmen manual #${c.row} dipotong di akhir video (${tcAss(c.end)})`, 'yellow');
    if (!manualClips.length && clipMode === 'manual') {
      // Say what was actually received — the bare message used to leave the user
      // guessing whether nothing arrived or everything was rejected.
      const filled = (Array.isArray(cfg.manualSegments) ? cfg.manualSegments : [])
        .filter((g) => normTimecode(g?.start) || normTimecode(g?.end)).length;
      const detail = filled
        ? `${filled} baris diisi, semuanya ditolak: ${manualParse.rejected.slice(0, 3).map((r) => `#${r.row} ${r.reason}`).join('; ')}`
        : 'belum ada baris MULAI/SELESAI yang terisi';
      throw new Error(`Tidak ada segmen manual yang valid (${detail}). Isi waktu sebagai MM:SS (mis. 12:30), pastikan SELESAI > MULAI dan minimal 3 detik, atau ganti Mode Klip ke Auto.`);
    }
    log(`▶ Mode ${clipMode === 'manual' ? 'Manual' : 'Manual + AI'}: ${manualClips.length} segmen manual`, 'lime');
  }
  prog('Detect', clipMode === 'manual' ? 'segmen manual…' : 'AI viral highlight…', 52);
  const numClips = clipMode === 'manual' ? 0 : Math.max(0, wantClips - manualClips.length);
  let clips = [];
  let topicSummary = '';
  // [AUTO-COVER] Decided BEFORE highlight detection, not after. Coverage uses
  // every second of the source, so there is nothing for detection to select —
  // running it anyway wasted the AI round-trips AND, worse, filled `clips`, so
  // the coverage branch (which only fired on an empty list) never ran: a 73.7s
  // source still came back as a single 31.1s tf-idf clip.
  const autoDur = resolveDuration(cfg.clipDuration);
  const autoCover = numClips > 0 && autoDur.flex && clipMode === 'auto'
    && duration > 0 && duration <= AUTO_COVER_MAX_SEC;
  // Detect video language — trusts the ASR engine's OWN detection
  // (asrDetectedLang) when a transcription pass ran, since that already
  // covers ~100 languages; otherwise falls back to script/stopword
  // detection on the transcript text (see detectLanguage()). The result
  // drives the AI hook/title prompts (so a Japanese/Spanish/… source gets
  // hooks written in THAT language instead of being defaulted to
  // Indonesian) as well as the local fallback's filler/hot-word
  // dictionaries.
  const detectedLang = detectLanguage(cues.map(c => c.text).join(' '), ytInfo, asrDetectedLang || subtitleTrackLang);
  // [CTX-MODEL] No AI key → the optional offline context reader (if the user
  // installed it in Clip Options) picks moments from the MEANING of the
  // transcript; the TF-IDF/topic picker below only fills what it leaves.
  // Any failure here (missing bundle, worker crash, timeout) is logged and the
  // run continues exactly as before.
  let ctxClips = [];
  if (numClips > 0 && (cues.length || words.length) && !aiAvailable(cfg) && cfg.localContextModel !== false) {
    let ctxBundle = null;
    try { ctxBundle = require('./context-model/bundle'); if (!ctxBundle.isInstalled()) ctxBundle = null; } catch { ctxBundle = null; }
    if (ctxBundle) {
      try {
        const t0 = Date.now();
        prog('Detect', 'membaca konteks transkrip…', 52);
        const r = await require('./context-model').pickContextMoments({
          bundleDir: ctxBundle.bundleDir(), words, cues, numClips: numClips + 3,
          dur: resolveDuration(cfg.clipDuration), promo: detectPromoRanges(cues), seen: seenRanges,
          heatmap: ytInfo?.heatmap || null,
        });
        const avoid = new Set();
        ctxClips = r.picks.map((p, k) => {
          const title = localContextTitle(p.text, k, detectedLang, avoid);
          avoid.add(_normPhrase(title));
          return { start: p.start, end: p.end, title, hook: '', score: Math.max(6, 9 - k * 0.5), why: '',
            origin: 'konteks lokal', category: normalizeCategory('', p.text),
            // edges are exact only with real per-word timing; from cue text alone
            // the usual sentence/breath snapping still refines them
            _ctx: words.length > 0 };
        });
        const st = r.stats || {};
        log(`▶ Pembaca konteks lokal: ${ctxClips.length} momen dari makna transkrip (${st.sentences || 0} kalimat · ${((Date.now() - t0) / 1000).toFixed(1)} s · RAM ${st.peakRssMb || '?'} MB)`, 'lime');
      } catch (e) {
        ctxClips = [];
        log(`⚠ Pembaca konteks lokal dilewati (${e?.message || e}) — memakai deteksi momen biasa`, 'yellow');
      }
    }
  }
  log(`▶ Bahasa video terdeteksi: ${languageDisplayName(detectedLang)}`, 'lime');
  if (numClips > 0 && !aiAvailable(cfg)) {
    // No key saved, or saved but unreadable — the rest of this function
    // silently jumps to the local heuristic fallback with zero explanation
    // otherwise, which looks identical to "the key does nothing" from the
    // user's side. Say so plainly, once (auto-cover runs too: their titles
    // are AI as well).
    log(noAiMessage({ secretsLocked }), 'yellow');
  }
  // [AUTO-COVER] Coverage still wants the topic brief: highlight SELECTION is
  // skipped, but every clip still gets an AI title/hook afterwards, and those
  // read far better with the video's context than without it.
  if (autoCover && numClips > 0 && aiAvailable(cfg)) {
    try {
      topicSummary = await generateTopicSummary(cfg, aiText, ytInfo, log, detectedLang, numClips);
    } catch (e) {
      log(`⚠ Ringkasan konteks gagal (${e.message}) — judul tetap dibuat tanpa brief`, 'yellow');
    }
  }
  if (numClips > 0 && !autoCover && aiAvailable(cfg)) {
    const eff = effectiveAI(cfg);
    const providerLabel = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', custom: 'Custom AI', free: 'Free AI' }[eff.provider] || eff.provider;
    log(`▶ Otak AI: ${providerLabel}`, 'lime');
    // Cheap pre-pass: 2-3 sentence brief of the video, used as semantic
    // anchor for both highlight selection and per-clip hook rewriting.
    prog('Detect', 'topic summary…', 49);
    topicSummary = await generateTopicSummary(cfg, aiText, ytInfo, log, detectedLang, numClips);
    const toClip = c => ({
      start: toSeconds(c.start_time ?? c.start),
      end:   toSeconds(c.end_time   ?? c.end),
      title: String(c.title || '').trim(),
      hook:  String(c.hook_text || c.hook || '').trim(),
      score: rubricScore(c),   // [CLIP-RUBRIC]
      why:   String(c.description || c.reason || '').trim(),
      category: normalizeCategory(c.category),
      // [HOOK-TEASER] the model's pick for the cold-open line (absolute seconds)
      ...(c.teaser_start != null && c.teaser_end != null
        ? { teaserAbs: { start: toSeconds(c.teaser_start), end: toSeconds(c.teaser_end) } } : {}),
    });
    // [HIGHLIGHT-MAPREDUCE] A single-shot call embeds the WHOLE transcript —
    // fine for short/medium videos, but confirmed (real Groq calls) to blow
    // past free-tier per-minute token caps (6,000-12,000 TPM) on anything
    // long, even after rolling-caption dedup cuts transcript size ~65%. No
    // amount of trimming makes an arbitrarily long transcript fit in one
    // call. Past this size, split into TPM-safe chunks, analyze each
    // independently (map), then merge/dedupe/rank into the final N (reduce).
    // [REQ-TOO-LARGE] One highlight request; when the model says the prompt is
    // too large for it (Groq free tier: ~10k tokens is already over), halve the
    // transcript on a line boundary and ask for each half instead of failing
    // over to local detection. Each half keeps the same rubric and brief.
    // ── [HL-ROBUST] highlight stage ───────────────────────────────────────
    // Measured on a real 33-min video with a free Groq key (2026-10-10): 247 s,
    // 4/4 chunks 413-halved, 11 per-minute waits, and one half answered "I'm
    // sorry" by gpt-oss-20b — that half (16:14–20:13) held 2 of the 3 best
    // moments and the other half was never even asked. Now:
    //  • [HL-SIZE]   Groq requests are sized to a token budget up front (8K/min
    //                per model on the free plan) instead of 413-then-halve.
    //  • [GROQ-SPREAD] chunks are spread over the per-model free buckets.
    //  • [BAD-AI-OUTPUT] a refusal / empty / non-JSON answer moves to another
    //                model inside the call, then gets one safe-prompt retry.
    //  • a failed half keeps the other half; a range the AI never covered is
    //    named in the log and filled from local TF-IDF for that range only.
    const effHL = effectiveAI(cfg);
    const groqHL = effHL.baseUrl === GROQ_BASE_URL && !!effHL.apiKey;
    const HL_GROQ_REQ_CAP = 7600;   // tokens per request (prompt + max_tokens), under the 8K/min bucket
    const hlMaxTokens = (n, def) => groqHL
      ? Math.min(4096, n * 160 + (isGroqReasoningModel(effHL.model) ? 450 : 200))
      : def;
    const rangeOfText = (text) => {
      const ls = String(text || '').split('\n');
      const a = /^\[([\d:.,]+)-/.exec(ls[0] || ''), b = /-([\d:.,]+)\]/.exec(ls[ls.length - 1] || '');
      return a && b ? [toSeconds(a[1]), toSeconds(b[1])] : null;
    };
    const lostRanges = [];
    // `lost` collects the ranges THIS attempt could not cover; the caller commits
    // them only if the attempt is the final one (a later retry may cover them).
    const runHighlightPrompt = async (text, n, maxTokens, depth = 0, { safe = false, modelOverride, lost = lostRanges } = {}) => {
      try {
        const raw = await aiComplete(cfg, buildHighlightPrompt(cfg, text, ytInfo, n, topicSummary, detectedLang, { safe }), {
          json: isGemini(cfg), temperature: 0.45, maxTokens, onLog: log,
          accept: acceptJsonArray, taskClass: 'highlight', modelOverride,
        });
        return parseJsonLoose(raw).map(toClip).map((c) => snapToAiLines(aiTx.lines, c));   // [AI-TRANSCRIPT-COMPACT]
      } catch (e) {
        if (!isRequestTooLarge(e) || depth >= 3 || text.length < 2500) throw e;
        const lines = text.split('\n');
        const mid = Math.floor(lines.length / 2);
        log(`▶ Transkrip terlalu panjang untuk satu permintaan ke model AI ini — dibagi dua (${Math.round(text.length / 1000)}k karakter)`, 'gray');
        const nHalf = Math.max(2, Math.ceil(n / 2) + 1);
        const halfTokens = groqHL ? hlMaxTokens(nHalf, 0) : Math.max(1024, Math.round(maxTokens * 0.6));
        // one half failing must not throw away the other (it used to: half B was never asked)
        const halves = [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
        const got = [];
        let lastErr = null;
        for (const h of halves) {
          try { got.push(await runHighlightPrompt(h, nHalf, halfTokens, depth + 1, { safe, modelOverride, lost })); }
          catch (he) { lastErr = he; const r = rangeOfText(h); if (r) lost.push(r); }
        }
        if (!got.length) throw lastErr || e;
        return mergeHighlightCandidates(got, n, Math.max(20, resolveDuration(cfg.clipDuration).ideal * 0.5), ytInfo?.heatmap);
      }
    };
    // [BAD-AI-OUTPUT] one more go with the safe prompt after a short wait, so
    // models benched for a per-minute burst can come back (one was serving
    // again 38 s after the refusal in the analysed run).
    const withSafeRetry = async (label, fn) => {
      try { return await fn(false); } catch (e) {
        if (!isBadAiOutput(e)) throw e;
        log(`⚠ ${label}: jawaban AI tak terpakai (${e.kind}) — mencoba lagi dengan prompt netral…`, 'yellow');
        await new Promise((r) => setTimeout(r, 15000));
        return await fn(true);
      }
    };
    const fmtRange = ([a, b]) => `${tcAss(a).replace(/\.\d+$/, '')}–${tcAss(b).replace(/\.\d+$/, '')}`;
    // [HL-SIZE] token budget per request on Groq; other providers keep the
    // historic char constants (their limits are an order of magnitude larger).
    const MAPREDUCE_THRESHOLD_CHARS = 16000;
    const CHUNK_CHARS = 12000;
    let singleShot, chunks;
    if (groqHL) {
      const perReqClips = numClips + 2;
      const instr = estimateTokens(buildHighlightPrompt(cfg, '', ytInfo, perReqClips, topicSummary, detectedLang));
      const need = estimateTokens(aiText);
      singleShot = need <= Math.max(800, HL_GROQ_REQ_CAP - instr - hlMaxTokens(perReqClips, 0));
      if (!singleShot) {
        // grow the part count until EVERY request (its text + the clips it is
        // asked for) fits — with 20 clips the old "4 clips/part" guess overflowed
        let nChunks = 2;
        for (; nChunks < 40; nChunks++) {
          const parts = chunkTranscriptBalanced(aiText, nChunks);
          const per = Math.max(2, Math.ceil((numClips + 2) / parts.length) + 1);
          if (Math.max(...parts.map(estimateTokens)) + instr + hlMaxTokens(per, 0) <= HL_GROQ_REQ_CAP) { chunks = parts; break; }
        }
        if (!chunks) chunks = chunkTranscriptBalanced(aiText, nChunks);
      }
    } else {
      singleShot = aiText.length <= MAPREDUCE_THRESHOLD_CHARS;
      if (!singleShot) chunks = chunkTranscriptText(aiText, CHUNK_CHARS);
    }
    // [HL-RESCUE] local TF-IDF candidates for ranges the AI never covered, from
    // THAT range only and capped below AI rubric scores.
    const rescueLostRanges = () => {
      if (!lostRanges.length) return [];
      const promo = detectPromoRanges(cues);
      const dur = resolveDuration(cfg.clipDuration);
      const rescue = [];
      for (const [a, b] of lostRanges) {
        // by cue START so the last cue of the range (its end runs past the rounded stamp) is kept
        const ws = buildTfidfWindows(cues.filter((c) => c.start >= a - 0.5 && c.start <= b + 0.5), duration, detectedLang);
        normalizeTfidfScores(ws);
        ws.sort((x, y) => y.score10 - x.score10 || y.tfidf - x.tfidf);
        const picked = [];
        for (const w of ws) {
          if (picked.length >= 2) break;
          if (picked.some((q) => Math.abs(q.start - w.start) < dur.ideal * 0.8)) continue;
          const st = Math.max(0, w.start - 2);
          const en = Math.min(duration, Math.max(st + dur.ideal, w.end));
          if (rangeOverlapsBlocked(st, en, promo)) continue;
          picked.push({ start: st, end: en, title: localContextTitle(w.text, picked.length, detectedLang), hook: '', score: Math.min(w.score10 || 6, 6.5), why: '', origin: `tf-idf rescue (${fmtRange([a, b])})`, category: normalizeCategory('', w.text) });
        }
        if (picked.length) rescue.push(picked);
      }
      if (rescue.length) log(`▶ ${rescue.flat().length} kandidat lokal ditambahkan untuk rentang yang tidak teranalisa AI`, 'gray');
      return rescue;
    };
    if (singleShot) {
      try {
        const clipTokenBudget = groqHL ? hlMaxTokens(numClips + 2, 0) : Math.min(32768, Math.max(2048, (numClips + 2) * 220 + 1024));
        let attemptLost = [];
        clips = await withSafeRetry('Analisa AI', (safe) => { attemptLost = []; return runHighlightPrompt(aiText, numClips + 2, clipTokenBudget, 0, { safe, lost: attemptLost }); });   // [REQ-TOO-LARGE]
        log(`▶ AI menemukan ${clips.length} kandidat momen viral`, 'lime');
        if (attemptLost.length) {
          lostRanges.push(...attemptLost);
          const rescue = rescueLostRanges();
          if (rescue.length) clips = mergeHighlightCandidates([clips, ...rescue], numClips + 2, Math.max(20, resolveDuration(cfg.clipDuration).ideal * 0.5), ytInfo?.heatmap);
        }
      } catch (e) {
        log(`⚠ AI gagal menganalisa (${e.message}) — memakai deteksi otomatis lokal`, 'yellow');
      }
    } else {
      log(`▶ Transkrip panjang (${aiText.length} char) — dianalisis ${chunks.length} bagian`, 'lime');
      const perChunkClips = Math.max(2, Math.ceil((numClips + 2) / chunks.length) + 1);
      const perChunkTokenBudget = groqHL ? hlMaxTokens(perChunkClips, 0) : Math.min(8192, Math.max(1024, perChunkClips * 220 + 512));
      const CHUNK_PACING_MS = 12000;
      const RATE_LIMIT_RETRY_MS = 20000;
      const candidateArrays = [];
      let anyChunkSucceeded = false;
      let ratePacing = false;   // flipped on once any chunk hits a real 429
      // [GROQ-SPREAD] Each Groq model has its own 8K-tokens/min bucket on the
      // free plan: give each worker its own model. gpt-oss-20b is kept out of
      // the spread (it refused a benign chunk) — it stays a fallback only.
      const liveGroq = (m) => { const pk = providerKey({ ...effHL, model: m }); return !aiProviderDead(cfg, pk) && !aiProviderDead(cfg, unsuitableKey(pk, 'highlight')); };
      let spreadModels = groqHL
        ? [...new Set([effHL.model, ...GROQ_CHAT_ROTATION])]
          .filter((m) => m !== 'openai/gpt-oss-20b' || effHL.model === m)
          .filter(liveGroq)
        : [];
      // With only one healthy model left (e.g. gpt-oss-120b out for the day),
      // gpt-oss-20b becomes the second lane — its refusals are now caught and
      // retried elsewhere, and serialising everything on one 8K/min bucket
      // took 110 s on a 27-min video.
      if (groqHL && spreadModels.length < 2 && liveGroq('openai/gpt-oss-20b') && !spreadModels.includes('openai/gpt-oss-20b')) {
        spreadModels = [...spreadModels, 'openai/gpt-oss-20b'];
      }
      const HIGHLIGHT_CHUNK_CONCURRENCY = groqHL
        ? Math.max(1, spreadModels.length)
        : Math.max(1, Math.floor(Number(process.env.SOCL_HIGHLIGHT_CONCURRENCY) || 2));
      if (groqHL && spreadModels.length > 1) log(`▶ Bagian dibagi ke ${spreadModels.length} model Groq sekaligus (jatah per model terpisah): ${spreadModels.join(', ')}`, 'gray');
      let nextIdx = 0;
      let inflight = 0;
      let serialOwner = -1;   // once ratePacing flips, exactly one worker id finishes the rest
      const runOneChunk = async (i, wid) => {
        prog('Detect', `AI viral highlight… bagian ${i + 1}/${chunks.length}`, 52);
        const modelOverride = spreadModels.length ? spreadModels[wid % spreadModels.length] : undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          let attemptLost = [];
          try {
            const arr = await withSafeRetry(`Bagian ${i + 1}/${chunks.length}`,
              (safe) => { attemptLost = []; return runHighlightPrompt(chunks[i], perChunkClips, perChunkTokenBudget, 0, { safe, modelOverride, lost: attemptLost }); });   // [REQ-TOO-LARGE]
            lostRanges.push(...attemptLost);   // half-ranges of the attempt that finally succeeded
            return arr;
          } catch (e) {
            // Only a genuine rate limit is worth retrying (transient — a few
            // seconds' wait usually clears it). ANY other failure (bad key,
            // network error, …) retrying immediately would just repeat it.
            if (attempt === 0 && isQuotaError(e)) {
              if (!spreadModels.length) ratePacing = true;   // from here on the pool drains and serialises
              log(`⚠ Bagian ${i + 1}/${chunks.length} kena rate limit — coba lagi dalam ${RATE_LIMIT_RETRY_MS / 1000}s…`, 'yellow');
              await new Promise(r => setTimeout(r, RATE_LIMIT_RETRY_MS));
              continue;
            }
            const r = rangeOfText(chunks[i]);
            if (r) lostRanges.push(r);
            log(`⚠ Bagian ${i + 1}/${chunks.length}${r ? ` (${fmtRange(r)})` : ''} gagal dianalisa AI (${e.message}) — rentang ini diisi deteksi lokal`, 'yellow');
            return null;
          }
        }
        return null;
      };
      const worker = async (wid) => {
        while (nextIdx < chunks.length) {
          // Once a real 429 has been seen, revert to exactly the proven-safe
          // serial shape (one worker, paced). Not used while spreading over
          // per-model buckets — each worker already has its own bucket.
          if (ratePacing) {
            if (serialOwner === -1) serialOwner = wid;
            if (serialOwner !== wid) return;                 // non-owner steps aside
            while (inflight > 0) await new Promise(r => setTimeout(r, 200)); // let the owner run alone
            if (nextIdx > 0) await new Promise(r => setTimeout(r, CHUNK_PACING_MS));
          }
          const i = nextIdx++;
          if (i >= chunks.length) break;
          inflight++;
          let arr = null;
          try {
            arr = await runOneChunk(i, wid);
          } finally {
            inflight--;
          }
          if (arr) {
            candidateArrays.push(arr);
            anyChunkSucceeded = true;
            log(`▶ Bagian ${i + 1}/${chunks.length}: ${arr.length} kandidat`, 'lime');
          }
        }
      };
      const poolWidth = Math.min(HIGHLIGHT_CHUNK_CONCURRENCY, chunks.length);
      await Promise.all(Array.from({ length: poolWidth }, (_, wid) => worker(wid)));
      const aiChunksOk = anyChunkSucceeded;
      const rescue = rescueLostRanges();
      if (rescue.length) { candidateArrays.push(...rescue); anyChunkSucceeded = true; }
      if (anyChunkSucceeded) {
        const dur = resolveDuration(cfg.clipDuration);
        // [CLIP-HISTORY] same preference on the AI path: unseen candidates when
        // there are enough of them, the full set otherwise.
        let arrays = candidateArrays;
        if (seenRanges.length) {
          const fresh = candidateArrays.map((a) => a.filter((c) => !clipHistory.isSeen(c, seenRanges)));
          if (fresh.reduce((n, a) => n + a.length, 0) >= numClips) arrays = fresh;
        }
        clips = mergeHighlightCandidates(arrays, numClips, dur.ideal * 0.8, ytInfo?.heatmap);
        log(aiChunksOk
          ? `▶ AI menemukan ${clips.length} kandidat momen viral (dari ${chunks.length} bagian)`
          : `⚠ AI tidak menghasilkan kandidat — ${clips.length} kandidat dari deteksi lokal`, aiChunksOk ? 'lime' : 'yellow');
      } else {
        log('⚠ Semua bagian gagal dianalisa — memakai deteksi otomatis lokal', 'yellow');
      }
    }
  }
  // Local fallback generator — used when AI failed/unconfigured, AND as a
  // second chance when every AI candidate is dropped by the duration filter
  // (bad timestamps, clips shorter than the window, …). Previously the
  // fallback only ran when the AI returned zero candidates, so a full set of
  // unusable AI clips aborted the whole import.
  // [TFIDF-MEMO] buildLocalClips() is called from up to four places below
  // (AI produced nothing / too few, then again after the duration filter drops
  // some), and each call re-ran the whole TF-IDF pass — tokenising the entire
  // transcript, rebuilding every sliding window and re-scoring them — to
  // produce the exact same deterministic list every time. Nothing it reads
  // (cues, duration, detectedLang, cfg) changes between those calls, so
  // compute it at most once per run and hand back a fresh shallow copy of the
  // clip objects, since callers mutate start/end in place via filterByWindow.
  let _localClipsCache = null;
  const promoRanges = detectPromoRanges(cues);
  const buildLocalClips = () => {
    if (!_localClipsCache) {
      if (!seenRanges.length) _localClipsCache = _buildLocalClipsUncached(promoRanges);
      else {
        // [CLIP-HISTORY] new moments first; old moments before even-spaced filler.
        const isFiller = (c) => /even-spacing/.test(String(c.origin || ''));
        const fresh = _buildLocalClipsUncached(promoRanges.concat(seenRanges));
        const out = fresh.filter((c) => !isFiller(c));
        if (out.length < numClips) {
          for (const c of _buildLocalClipsUncached(promoRanges)) {
            if (isFiller(c) || out.some((p) => c.start < p.end && c.end > p.start)) continue;
            out.push(c);
          }
        }
        for (const c of fresh.filter(isFiller)) if (!out.some((p) => c.start < p.end && c.end > p.start)) out.push(c);
        _localClipsCache = out;
      }
    }
    if (ctxClips.length && !_localClipsCache._ctx) {   // [CTX-MODEL] context picks first, the rest only fills
      const rest = _localClipsCache.filter((c) => !ctxClips.some((p) => c.start < p.end && c.end > p.start));
      _localClipsCache = ctxClips.map((c) => ({ ...c })).concat(rest);
      _localClipsCache._ctx = true;
    }
    return _localClipsCache.map(c => ({ ...c }));
  };
  const _buildLocalClipsUncached = (blocked = promoRanges) => {
    const out = [];
    const dur = resolveDuration(cfg.clipDuration);
    if (cues.length) {
      // TF-IDF over sliding 15-20s transcript windows (see buildTfidfWindows):
      // scores which windows are actually hook-worthy RELATIVE TO THIS VIDEO's
      // own vocabulary, then feeds that same window text into localHookTitle
      // for the title and normalizeCategory for the category — so score,
      // title, and clip boundaries all come from the same grounded context
      // instead of a flat guessed score and a separately-sliced text window.
      // [TOPIC-SELECT] Topics first: whole subjects, start to finish (see
      // topic-select.js). The keyword-window picker below only fills what the
      // topic pass could not (very short videos, monologues with no topic
      // shifts).
      const used = [];
      const pickedWindows = [];
      const avoidTitles = new Set();
      for (const t of require('./topic-select').selectTopics(cues, duration, { lang: detectedLang, dur, numClips, blocked })) {
        if (rangeOverlapsBlocked(t.start, t.end, blocked)) continue;
        const title = localContextTitle(t.text, out.length, detectedLang, avoidTitles);
        avoidTitles.add(_normPhrase(title));
        out.push({ start: t.start, end: t.end, title, hook: '', score: t.score10, why: '', origin: `topik (${Math.round(t.end - t.start)}s)`, category: normalizeCategory('', t.text) });
        used.push(t.start);
        pickedWindows.push({ terms: t.terms, start: t.start, end: t.end });
      }
      if (out.length) log(`▶ ${out.length} klip dipilih per topik (tanpa AI)`, 'gray');
      const windows = out.length >= numClips ? [] : buildTfidfWindows(cues, duration, detectedLang);
      normalizeTfidfScores(windows);
      // [NO-HARDCODE] Ranked by the TF-IDF/hook score itself. The previous
      // primary key, contextSignalScore, was a list of story keywords from ONE
      // benchmark video (Mr Beast, Kim Kardashian, "followers", a stolen car,
      // "first kid at 29") that outranked TF-IDF for every other video — it
      // put a ShopBack sponsor read into a real Indonesian session's picks.
      windows.sort((a, b) => b.score10 - a.score10 || b.tfidf - a.tfidf);
      for (const w of windows) {
        if (out.some((o) => w.start < o.end && w.end > o.start)) continue;
        if (pickedWindows.some((p) => sameTopic(p, w))) continue;   // [TOPIC-DIVERSITY]
        // Lead-in before the scored hook window, capped so short presets stay
        // aligned: a flat -8s on a 15s-ideal clip pushed the cut so far ahead
        // that it only covered the window's first ~7s (title from text the clip
        // barely showed). Scale the lead to the clip length instead.
        const lead = Math.min(8, Math.max(2, dur.ideal * 0.2));
        let start = Math.max(0, w.start - lead);
        // Cover the whole scored/titled window: on the SHORT preset dur.ideal
        // (15s) is smaller than the window (15-20s), so start+dur.ideal used to
        // END before the titled hook was even spoken. Extend to at least w.end
        // (filterByWindow later clamps to the preset's max, 20s for SHORT — still
        // enough to cover it). Longer presets already exceed w.end, so no change.
        // [AUTO-FLEX] For 'auto' the end is transcript-aware and VARIES per
        // moment (30–180s) instead of a fixed start+ideal — the reason auto no
        // longer clamps every clip to ~75s. Fixed presets keep exact behaviour.
        let end = dur.flex
          ? Math.min(duration, Math.max(flexClipEnd(cues, start, dur.min, dur.max, duration), w.end))
          : Math.min(duration, Math.max(start + dur.ideal, w.end));
        // [CLIP-DURATION-GUARANTEE] If the window sits near the end of the
        // video and end-start < requested duration, SHIFT start earlier so we
        // still deliver a full-length clip — the previous filterByWindow clamp
        // path let a truncated clip through (e.g. 34.88s for a 60s request when
        // a hook sat 34s from the video end). Only shifts when the video is long
        // enough to fit. For 'auto' the floor is dur.min (a short clip is valid),
        // for fixed presets it stays dur.ideal.
        const minKeep = dur.flex ? dur.min : dur.ideal;
        if (end - start < minKeep && duration >= minKeep) {
          start = Math.max(0, end - minKeep);
        }
        // Vet the delivered range, not only the short scoring window. This is
        // what prevents a legitimate hook immediately before an ad from
        // dragging the sponsor read into a 60/90/120-second clip.
        if (rangeOverlapsBlocked(start, end, blocked)) continue;
        if (used.some(u => Math.abs(u - start) < dur.ideal * 0.8)) continue;
        // [TITLE-LONG] Prefer the long viral-hook builder (10–15 words, reads
        // as a sentence lifted straight from the actual transcript); only fall
        // back to the short condense path if the window is too thin to
        // sustain that. Both stay 100% grounded in the window text.
        const title = localContextTitle(w.text, out.length, detectedLang, avoidTitles);
        avoidTitles.add(_normPhrase(title));
        out.push({ start, end, title, hook: '', score: w.score10 || 6, why: '', origin: `tf-idf hook (${Math.round(w.end - w.start)}s window)`, category: normalizeCategory('', w.text) });
        used.push(start);
        pickedWindows.push(w);
        if (out.length >= numClips) break;
      }
      // [CLIP-COUNT-GUARANTEE pass 2] The score-greedy pass above can genuinely
      // exhaust itself below numClips even when the video has more room: the
      // best-scoring cues often cluster in time (one hot topic, one part of
      // the video), so the anti-overlap gap check rejects most of the
      // REMAINING scored cues once that cluster is used up — even though
      // unrelated stretches of the video were never touched. This is exactly
      // what produced "requested 30, got 25": the generator hit a real
      // ceiling of ITS OWN packing strategy, not a ceiling on the video's
      // actual capacity. Reported live: clip count set to 30, only 25 clips
      // came out with no error/warning — the count guarantee looked like it
      // held (this function called once, capped at numClips) but the
      // function itself silently returned fewer.
      // Fix: if still short, sweep the FULL timeline chronologically at a
      // fixed, even spacing (like the no-transcript branch below) and fill
      // remaining slots wherever they don't collide with an already-used
      // start — packing density relaxes from dur.ideal*0.8 to *0.5 so we
      // can physically fit more before giving up and returning fewer than
      // requested (which is still fine for a genuinely too-short video).
      if (out.length < numClips && duration > 0) {
        const relaxedGap = dur.ideal * 0.5;
        // Walking exactly `numClips` fixed grid slots (one try each, no
        // retry) still undershot: any slot that happened to land within
        // relaxedGap of a pass-1 pick was dropped PERMANENTLY, so every such
        // collision subtracted straight from the final count (confirmed:
        // "requested 30 (auto duration), got 28" — a ~30min video, clip
        // duration ideal=75s, only 2 of the 30 fixed slots collided, and both
        // were lost with no backfill). Use a denser grid — more candidate
        // slots than needed — so a collision just skips to the next nearby
        // slot instead of eating into the final count. Caps at the same
        // physical density (duration / relaxedGap) so a genuinely too-short
        // video still falls short honestly rather than overfilling.
        const maxTries = Math.max(numClips * 3, Math.ceil(duration / Math.max(relaxedGap, 1)));
        const step = duration / (maxTries + 1);
        for (let i = 0; i < maxTries && out.length < numClips; i++) {
          const start = Math.max(0, step * (i + 0.5) - dur.ideal / 2);
          if (used.some(u => Math.abs(u - start) < relaxedGap)) continue;
          const end = Math.min(duration, start + dur.ideal);
          if (end - start < dur.ideal * 0.5) continue;   // too close to video end
          if (rangeOverlapsBlocked(start, end, blocked)) continue;
          out.push({ start, end, title: `Momen #${out.length + 1}`, hook: '', score: 5, why: '', origin: 'even-spacing top-up', category: 'EDUCATIONAL' });
          used.push(start);
        }
      }
    } else {
      // No transcript: chunk evenly
      const step = duration / (numClips + 1);
      for (let i = 0; i < numClips; i++) {
        const start = step * (i + 0.5);
        out.push({ start, end: Math.min(duration, start + dur.ideal), title: `Momen #${i+1}`, hook: '', score: 5, why: '', origin: 'no-transcript fallback', category: 'EDUCATIONAL' });
      }
    }
    return out;
  };
  // [AUTO-COVER] Short source + auto duration = cover the whole thing, split
  // into exactly the clips asked for. Runs BEFORE highlight detection's local
  // fallback because there is nothing to select: every second is used either
  // way, so the only question is where the cuts land.
  if (autoCover) {
    clips = buildCoverageClips(cues, duration, numClips);
    log(`▶ Video ${Math.round(duration)}s dibagi habis jadi ${clips.length} clip (${clips.map(c => Math.round(c.end - c.start) + 's').join(' + ')})`, 'lime');
  }
  if (numClips > 0 && !clips.length) {
    log('▶ Menggunakan deteksi momen otomatis…', 'lime');
    clips = buildLocalClips();
  }
  // [CLIP-COUNT-GUARANTEE] Long videos on rate-limited providers (Groq free-
  // tier TPM caps) commonly return only 1–2 usable candidates because most
  // map-reduce chunks 429'd. Previously the local fallback only ran when the
  // AI returned ZERO — a partial return (1 clip) short-circuited the guarantee
  // and the user asked for 4 but got 1. Top up with local heuristic candidates
  // so the count the user set on the slider is the count they actually get.
  // Overlap gap = 0.8 × ideal (matches mergeHighlightCandidates' dedup rule).
  if (clips.length < numClips) {
    const gap = resolveDuration(cfg.clipDuration).ideal * 0.8;
    const extras = buildLocalClips().filter(lc =>
      !clips.some(kc => Math.abs(Number(kc.start) - Number(lc.start)) < gap));
    if (extras.length) {
      const need = numClips - clips.length;
      log(`▶ AI memberi ${clips.length}/${numClips} clip — top up ${Math.min(need, extras.length)} dari deteksi lokal`, 'lime');
      clips = clips.concat(extras.slice(0, need));
      clips.sort((a, b) => Number(a.start) - Number(b.start));
    }
    // Honest signal instead of a silent shortfall: with buildLocalClips' own
    // even-spacing top-up pass (above), this should now only fire when the
    // video is genuinely too short/short on content for numClips non-trivial
    // clips at the chosen duration — not from a fixable packing bug.
    if (clips.length < numClips) {
      log(`⚠ Video/konten tidak cukup untuk ${numClips} clip @ ${resolveDuration(cfg.clipDuration).label} — hanya ${clips.length} clip valid ditemukan. Coba durasi clip lebih pendek atau clip count lebih kecil.`, 'yellow');
    }
  }

  // Filter by duration window — clamped to the real video timeline. A video
  // shorter than the preset minimum (e.g. 34s import on a 50s-min preset)
  // shrinks the effective minimum to 60% of the video; without this every
  // candidate was dropped and the whole import aborted.
  const window = resolveDuration(cfg.clipDuration);
  const vidDur = Number(duration) > 0 ? Number(duration) : Infinity;
  const effMin = Number.isFinite(vidDur) ? Math.min(window.min, Math.max(3, vidDur * 0.6)) : window.min;
  // [DEAD-AIR] once per video: real silences + speech timeline.
  // [DEAD-AIR-TOGGLE] cfg.deadAirCut === false (Clip settings → "Potong dead
  // air") skips it: gameplay, music and no-voice clips are not dead air.
  let deadAirOn = cfg.deadAirCut !== false;
  if (!deadAirOn) log('▶ Potong dead air: OFF — jeda bicara tidak dipotong (gaming / klip tanpa suara)', 'lime');
  const deadSpeech = deadAirOn ? speechIntervals(words, cues) : [];
  const deadSilences = deadAirOn && inputPath ? await detectSilence(inputPath) : [];
  let deadDropped = 0, deadTrimmed = 0;
  const filterByWindow = (list) => list.filter(c => {
    // [AUTO-COVER] Coverage clips are not candidates to be vetted — their
    // length IS the answer (source ÷ clip count). Clamping them to the auto
    // preset's 180s ceiling, or nudging a short one up to `ideal`, would throw
    // away exactly the material this mode exists to keep.
    if (c.coverage) return true;
    c.start = Math.max(0, Number(c.start) || 0);
    const rawEnd = Number(c.end);
    // AI sometimes returns end:0/missing — treat as "unknown", let the clamp path
    // below extend to c.start + ideal instead of collapsing the clip to zero length.
    c.end = (Number.isFinite(rawEnd) && rawEnd > c.start)
      ? Math.min(rawEnd, vidDur)
      : Math.min(c.start + window.ideal, vidDur);
    // [SENTENCE-SNAP] Open on a whole sentence, close on a finished one —
    // within the same duration window this filter enforces. Manual segments
    // never reach here (merged after), coverage clips returned above.
    // [CTX-MODEL] context picks already start and end on whole sentences; re-snapping
    // them dropped their opening sentence (measured: clean endings 23/25 → 8/25).
    if (cues.length && !c.manual && !c._ctx) {
      const sn = snapClipToSentences(cues, c, { min: effMin, max: window.max });
      c.start = Math.max(0, sn.start);
      c.end = Math.min(sn.end, vidDur);
    }
    if (rangeOverlapsBlocked(c.start, c.end, promoRanges)) return false;
    // [DEAD-AIR] Strict: cut to the longest stretch of real speech; a clip
    // whose speech run is too short is dropped (the top-up refills it), never
    // padded back out into the silence. Manual segments are the user's call.
    if (deadAirOn && !c.manual && !c._ctx && (deadSpeech.length || deadSilences.length)) {
      const t = trimDeadAir(c, deadSpeech, deadSilences);
      if (!t) { deadDropped++; return false; }
      if (t.cut) { c.start = t.start; c.end = t.end; c._deadAirCut = true; deadTrimmed++; }
    }
    const d = c.end - c.start;
    if (d >= effMin && d <= window.max) return true;
    if (c._deadAirCut && d < effMin) { deadDropped++; return false; }
    // clamp slightly if close (never past the end of the video)
    if (d < effMin && d > effMin * 0.6) { c.end = Math.min(c.start + window.ideal, vidDur); return (c.end - c.start) > 3; }
    if (d > window.max) { c.end = c.start + window.max; return true; }
    return false;
  }).slice(0, numClips);
  // [HEATMAP] Most-replayed peaks compete with the picked clips: a rewatched
  // stretch the transcript ranking missed can displace the weakest pick.
  if (ytInfo?.heatmap && numClips > 0 && !clips.some((c) => c.coverage) && !clips.some((c) => c.origin === 'konteks lokal')) try {
    const hc = heatCandidates(ytInfo.heatmap, window.ideal, vidDur).map((c) => ({
      ...c,
      title: localContextTitle(cues.length ? segmentsInRange(cues, c.start, c.end).map((x) => x.text).join(' ') : '', 0, detectedLang),
      category: normalizeCategory('', cues.length ? segmentsInRange(cues, c.start, c.end).map((x) => x.text).join(' ') : ''),
    }));
    // [CLIP-HISTORY] Most Replayed peaks never change between runs; an already
    // clipped peak must not keep displacing a new pick.
    const hcUse = seenRanges.length ? hc.filter((c) => !clipHistory.isSeen(c, seenRanges)) : hc;
    hc.length = 0; hc.push(...hcUse);
    if (hc.length) {
      const nonManual = clips.filter((c) => !c.manual);
      const merged = mergeHighlightCandidates([nonManual, hc], Math.max(numClips, nonManual.length), window.ideal * 0.8, ytInfo.heatmap);
      const added = merged.filter((c) => hc.includes(c)).length;
      clips = clips.filter((c) => c.manual).concat(merged);
      if (added) log(`▶ Most Replayed YouTube: ${added} momen yang paling sering diputar ulang ikut dipilih`, 'lime');
    }
  } catch (e) { log(`⚠ Most Replayed dilewati (${e?.message || e}) ${String(e?.stack || '').split('\n').slice(1, 4).map((x) => x.trim()).join(' | ')}`, 'yellow'); }
  // filterByWindow edits clips in place; [DEAD-AIR-SAFE] needs them unedited.
  const firstPicks = clips.map((c) => ({ ...c }));
  clips = filterByWindow(clips);
  if (deadTrimmed || deadDropped) log(`▶ Dead air: ${deadTrimmed} klip dipangkas, ${deadDropped} kandidat dibuang (jeda hening ≥ ${DEAD_AIR_GAP}s)`, 'lime');
  if (numClips > 0 && !clips.length) {
    // Every AI candidate was unusable (broken/short timestamps) → try local detection.
    log('⚠ Semua kandidat gugur di filter durasi — memakai deteksi momen lokal', 'yellow');
    clips = filterByWindow(buildLocalClips());
  }
  // [CLIP-COUNT-GUARANTEE] Filter can also drop a subset (bad timestamps on
  // some AI clips, none on the rest). Same top-up here so the final count
  // matches the user's slider even after the filter runs.
  // [TOP-UP-SAFE] Refilling dropped picks is a bonus: if it throws, keep the clips we have.
  // [DEAD-AIR] Dropped candidates must be REPLACED: buildLocalClips() holds
  // only numClips picks (the same ones that may have just been dropped), so
  // also draw from a deeper ranked pool of topics.
  const reserveTopics = () => {
    let reserve = [];
    try {
      reserve = require('./topic-select').selectTopics(cues, vidDur, { lang: detectedLang, dur: resolveDuration(cfg.clipDuration), numClips: numClips * 4, promoRanges })
        .map((t) => ({ start: t.start, end: t.end, title: localContextTitle(t.text, 0, detectedLang), hook: '', score: t.score10, why: '', origin: `topik cadangan (${Math.round(t.end - t.start)}s)`, category: normalizeCategory('', t.text) }));
    } catch { reserve = []; }
    // [HEATMAP] rewatched stretches first among the reserve topics too.
    if (ytInfo?.heatmap) {
      for (const r of reserve) { const h = heatScore(ytInfo.heatmap, r.start, r.end); if (h) { r._heat = +h.rel.toFixed(2); r.score = (Number(r.score) || 0) + h.bonus; } }
      reserve.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    }
    return clipHistory.preferUnseen(reserve, seenRanges);   // [CLIP-HISTORY]
  };
  // One by one: filterByWindow() ends in .slice(0, numClips), so a combined
  // list never got past the first numClips (the same dropped picks).
  const pickExtras = (pool) => {
    const gap = resolveDuration(cfg.clipDuration).ideal * 0.8;
    const overlapsKept = (lc) => clips.some(kc => Math.abs(Number(kc.start) - Number(lc.start)) < gap || (lc.start < kc.end && lc.end > kc.start));
    const extras = [];
    for (const cand of pool) {
      const ok = filterByWindow([cand]);
      if (!ok.length) continue;
      const lc = ok[0];
      if (overlapsKept(lc) || extras.some((e) => lc.start < e.end && lc.end > e.start)) continue;
      extras.push(lc);
      if (clips.length + extras.length >= numClips) break;
    }
    return extras;
  };
  if (clips.length < numClips) try {
    const extras = pickExtras(buildLocalClips().concat(reserveTopics()));
    if (extras.length) {
      const need = numClips - clips.length;
      log(`▶ Filter durasi menyisakan ${clips.length}/${numClips} — top up ${Math.min(need, extras.length)} dari deteksi lokal`, 'lime');
      clips = clips.concat(extras.slice(0, need));
      clips.sort((a, b) => Number(a.start) - Number(b.start));
    }
  } catch (e) { log(`⚠ Tambah klip pengganti dilewati (${e?.message || e}) ${String(e?.stack || '').split('\n').slice(1, 4).map((x) => x.trim()).join(' | ')}`, 'yellow'); }
  // [DEAD-AIR-SAFE] Dead air is polish, never a reason to lose clips. Gaming
  // talks in short bursts between long stretches of game sound, so every
  // candidate's longest speech run fell under the preset minimum, all were
  // dropped, and the run fell through to the short-video fallback: one
  // 1792.6 s "clip" of a 30-min gameplay video (user report 2026-10-19).
  // Whatever dead air left unfilled is filled again with it off, best picks
  // first; those clips also keep their pauses (no in-clip pause cuts).
  if (deadAirOn && deadDropped && clips.length < numClips) try {
    deadAirOn = false;
    const extras = pickExtras(firstPicks.map((c) => ({ ...c })).concat(buildLocalClips(), reserveTopics()));
    if (extras.length) {
      const need = numClips - clips.length;
      for (const c of extras) c._keepAir = true;
      log(`⚠ Dead air menggugurkan ${deadDropped} kandidat (gaming / jarang bicara?) — ${Math.min(need, extras.length)} klip diisi tanpa potong dead air. Matikan "Potong dead air" untuk video seperti ini.`, 'yellow');
      clips = clips.concat(extras.slice(0, need));
      clips.sort((a, b) => Number(a.start) - Number(b.start));
    }
  } catch (e) { log(`⚠ Isi ulang tanpa dead air dilewati (${e?.message || e}) ${String(e?.stack || '').split('\n').slice(1, 4).map((x) => x.trim()).join(' | ')}`, 'yellow'); }
  // [MANUAL-SEGMENTS] Merge the user's ranges back in AFTER filterByWindow.
  // They deliberately bypass it: the duration preset (15s/30s/60s/auto) governs
  // clips the app CHOSE, not ones the user typed by hand. Running a 01:12→01:48
  // manual segment through the 30s preset would silently clamp it to 30s — the
  // exact "I asked for 36 seconds and got 30" surprise this mode exists to avoid.
  if (manualClips.length) {
    // Hybrid: a detected clip that lands on top of a manual segment is a
    // duplicate of a moment the user already claimed. Manual wins.
    const overlaps = (a, b) => a.start < b.end && b.start < a.end;
    const before = clips.length;
    clips = clips.filter(c => !manualClips.some(m => overlaps(c, m)));
    if (before !== clips.length) log(`▶ ${before - clips.length} kandidat AI dibuang (tumpang tindih segmen manual)`, 'lime');
    clips = manualClips.concat(clips).sort((a, b) => a.start - b.start);
  }
  if (!clips.length && !manualClips.length && Number.isFinite(vidDur) && vidDur > 3) {
    // Last resort for short videos: one clip spanning the whole video.
    // [DEAD-AIR-SAFE] A long video lands here only when every filter failed;
    // it still gets ONE clip the preset allows, not the whole source.
    const len = Math.min(vidDur, window.max);
    log(len < vidDur
      ? `⚠ Tidak ada kandidat yang lolos filter — memakai 1 clip ${Math.round(len)} detik dari awal video`
      : '⚠ Video terlalu pendek untuk preset durasi — memakai 1 clip sepanjang video', 'yellow');
    clips = [{ start: 0, end: len, title: 'Momen #1', hook: '', score: 5, why: '', origin: 'short-video fallback', category: 'EDUCATIONAL' }];
  }
  if (!clips.length) throw new Error('Tidak ada clip valid setelah filter durasi.');
  // [EDGE-SNAP] Non-manual clips open on a full thought and cut on a breath.
  if (inputPath) {
    const maxDur = resolveDuration(cfg.clipDuration).max * 1.1;
    let moved = 0;
    for (let i = 0; i < clips.length; i++) {
      if (clips[i].manual || clips[i].coverage) continue;
      const before = [clips[i].start, clips[i].end];
      if (clips[i]._ctx) {   // [CTX-MODEL] whole-sentence edges: only pad into the silence around them
        const prevEnd = words.filter((w) => +w.end <= before[0] + 0.01).reduce((m, w) => Math.max(m, +w.end), 0);
        const nextStart = words.filter((w) => +w.start >= before[1] - 0.01).reduce((m, w) => Math.min(m, +w.start), Infinity);
        clips[i] = { ...clips[i], start: Math.max(0, prevEnd, before[0] - 0.15), end: Math.min(vidDur, nextStart, before[1] + 0.25) };
        continue;
      }
      // [EDGE-SNAP-SAFE] a refinement: on any failure keep the clip's own edges.
      try { clips[i] = await snapClipEdges(inputPath, clips[i], { words, minDur: effMin, maxDur }); }
      catch (e) { log(`⚠ Rapikan batas klip ${i + 1} dilewati (${e?.message || e}) ${String(e?.stack || '').split('\n').slice(1, 4).map((x) => x.trim()).join(' | ')}`, 'yellow'); }
      if (Math.abs(clips[i].start - before[0]) > 0.02 || Math.abs(clips[i].end - before[1]) > 0.02) moved++;
    }
    if (moved) log(`▶ Batas klip dirapikan ke jeda napas/awal kalimat: ${moved} klip`, 'lime');
  }

  // ── 5) Hook title rewrite (batched 2nd pass) ──
  stages.begin('Judul & hook (AI)');
  prog('Title', `rewriting ${clips.length} titles…`, 60);
  const usedTitles = new Set();   // deterministic dedup across all title paths
  // BYOK safety: a real cloud key (Groq/Gemini/…) is trusted — cloud models
  // obey "don't copy" and paraphrase legitimately (synonyms not literally in
  // the transcript), so we must NOT strip their titles on the grounding check.
  // The no-key transcript path is grounded by construction. The cheap
  // echo-check remains for cloud output as a guard against prompt parroting.
  const hasCloudKey = (() => { const e = effectiveAI(cfg); return e.provider !== 'free' && !!e.apiKey; })();
  const clipTexts = clips.map(c =>
    cues.length ? segmentsInRange(cues, c.start, c.end).map(x => x.text).join(' ') : (c.hook || c.title));

  // One compact request rewrites up to 12 titles. The former per-clip calls
  // multiplied both cost and request count without adding video coverage.
  // [AIDA-FREE] Gate on aiAvailable(), matching every other AI stage here
  // (topic brief, clip detection, the drift repair below). `hasCloudKey` stays
  // in use just below, where it belongs: deciding whether the generated title
  // is TRUSTED (paid) or has to pass the grounding check (free).
  // [NO-TEXT-TITLE] A clip with no spoken words gave the AI nothing but its
  // placeholder ("Momen #1"); a trusted cloud key then passed whatever it
  // invented — measured on a video with no audio: "Tidak Ada Konten Untuk
  // Dibuat Judul". Such clips keep the neutral label instead.
  const clipHasSpeech = clipTexts.map((t) => cues.length > 0 && _contentWords(t).length >= 2);
  let aiTitles = aiAvailable(cfg)
    ? await rewriteHookTitlesBatch(cfg, clips, clipTexts.map((t, i) => (clipHasSpeech[i] ? t : '')), ytInfo, topicSummary, log, detectedLang)
    : Array(clips.length).fill(null);
  // [CLOUD-TITLES] No AI key (or it returned nothing) → SOCL Cloud writes the
  // titles and hooks; transcript extraction stays the last resort.
  if (!aiTitles.some(Boolean) && clipHasSpeech.some(Boolean) && soclAsrKey().length >= 32 && cfg.cloudAsr !== false) {
    try {
      const t0 = Date.now();
      aiTitles = await soclCloudTitles(clipTexts.map((t, i) => (clipHasSpeech[i] ? t : '')),
        { lang: detectedLang, topic: ytInfo && ytInfo.title || '' });
      if (aiTitles.some(Boolean)) log(`▶ Judul & hook dibuat SOCL Cloud (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      log(`⚠ Judul SOCL Cloud tidak tersedia (${String(e && e.message || e).slice(0, 120)}) — memakai deteksi lokal`, 'yellow');
      aiTitles = Array(clips.length).fill(null);
    }
  }
  // [AIDA-SILENT] When no AI title comes back, every clip silently falls to
  // transcript extraction — and because the output filename is
  // `${NN}-${slugify(title)}.mp4`, the user's first sight of it is a file named
  // after a raw sentence fragment ("02-Orang Tahu Ya Kita Enggak Harus Terlalu
  // Yap Tentang Kita Nih") or a bare "Momen #N". Nothing said why. Verified in
  // a real session log: "▶ Otak AI: Free AI" followed by
  // "⏱ Judul & hook (AI): 0.0s" and nothing else — the stage had not run at
  // all, and the only clue was a topic-summary warning many lines earlier.
  // Say it plainly, once, at the point where it actually costs the user
  // something, and name the fix.
  if (!clipHasSpeech.some(Boolean)) {
    // [NO-TEXT-TITLE] Nothing spoken to title — not a key problem, don't send
    // the user to Settings for it.
    log('▶ Tidak ada ucapan di klip — judul memakai label "Momen #N"', 'gray');
  } else if (!aiTitles.some(Boolean)) {
    // [KEYLESS-RETIRED] With no callable AI the reason was already logged
    // once by noAiMessage() at the Detect stage; this names the cost.
    log(
      aiAvailable(cfg)
        ? '⚠ Judul AI tidak tersedia — judul & nama file diambil dari kutipan transkrip. Cek API key di Settings → AI.'
        : `⚠ Judul AI tidak tersedia — judul & nama file diambil dari kutipan transkrip. ${secretsLocked ? 'API key kamu tersimpan tapi terkunci — lihat pesan Keychain di atas, tidak perlu isi ulang.' : 'Isi Groq API key (gratis) di Settings → AI.'}`,
      'yellow',
    );
  }
  prog('Title', `judul ${clips.length}/${clips.length}…`, 72);

  // [SOCL-HOOK-V2] Whole-video text for IDF, and the session's used hook leads (variety).
  const hookCorpus = cues.length ? cues.map((x) => x.text).join(' ') : clipTexts.join(' ');
  const hookUsed = { leads: new Set(), types: new Map() };
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const clipText = clipTexts[i];
    const aiPack = clipHasSpeech[i] ? aiTitles[i] : null;   // [NO-TEXT-TITLE]
    let newTitle = aiPack ? aiPack.title : null;
    // [HOOK-GROUND] Reject a generated title that parrots a prompt example
    // or one not grounded in THIS clip's words. The latter is defensive for a
    // no-key path; current no-key generation already returns null immediately.
    // Cloud BYOK titles skip the grounding gate (trusted).
    if (newTitle && echoesExampleHook(newTitle)) {
      log(`⚠ Judul AI "${newTitle}" menyalin contoh prompt — memakai ekstraksi transkrip`, 'yellow');
      newTitle = null;
    } else if (newTitle && !hasCloudKey && !titleGroundedInText(newTitle, `${clipText} ${ytInfo && ytInfo.title || ''}`)) {   // a speaker named only in the video title ("dr. Tirta") is still grounded
      log(`⚠ Judul AI "${newTitle}" tak nyambung isi klip — memakai ekstraksi transkrip`, 'yellow');
      newTitle = null;
    }
    if (!newTitle) newTitle = localContextTitle(clipText, i, detectedLang);
    // Dedup: if this title was already used, re-extract from the clip while
    // avoiding the taken phrase; last resort append a numeric suffix.
    if (usedTitles.has(_normPhrase(newTitle))) {
      const alt = localContextTitle(clipText, i, detectedLang, usedTitles);
      newTitle = (alt && !usedTitles.has(_normPhrase(alt))) ? alt : `${newTitle} #${i + 1}`;
    }
    newTitle = titleCaseHeadline(newTitle);
    usedTitles.add(_normPhrase(newTitle));
    c.title = newTitle;
    c.hook = titleCaseHeadline(c.hook || newTitle);
    // [CLIP-HOOK] The on-video hook: the AI's own 2-4 word hook when it gave
    // one for a title we kept, else one built from the clip's words.
    const CH = require('./clip-hook');
    // [HOOK-GATE] Whatever model wrote it (user key, SOCL Cloud, any free
    // model), the hook must pass the same gate; else the clip's own words.
    const topicTxt = ytInfo && ytInfo.title || '';
    const aiHook = aiPack && newTitle === titleCaseHeadline(aiPack.title) && aiPack.hookText;
    const aiHookWhy = aiHook ? CH.hookQuality({ hook: aiHook, title: newTitle }, clipText, topicTxt) : 'none';
    if (aiHook && aiHookWhy) log(`▶ Clip ${i+1}: hook AI "${aiHook}" ditolak (${aiHookWhy}) — memakai hook dari ucapan klip`, 'gray');
    // [SOCL-HOOK-V2] Offline formula (already gated inside viralHook); weak → no hook text, the title is shown.
    const localHook = aiHookWhy ? ((CH.viralHook(clipText, { lang: detectedLang, corpus: hookCorpus, topic: topicTxt, used: hookUsed }) || {}).hook || '') : '';
    c.hookText = (!aiHookWhy && aiHook) || localHook || '';
    if (aiPack && aiPack.virality && !(c.score > 0)) c.score = aiPack.virality;
    log(`▶ Clip ${i+1}: "${newTitle}" · ${(c.end - c.start).toFixed(1)} detik`, 'lime');
  }
  // [LANG-DRIFT] Repair pass. The prompt now forbids answering in the wrong
  // language, but a real run still produced English title+hook+description on
  // 2 of 4 clips while the siblings were fine — so the output is verified, not
  // trusted. One targeted regeneration per offending clip (not a whole-chunk
  // redo), run through the same bounded pool as the titles above.
  const driftIdx = clips
    .map((c, i) => i)
    .filter(i => {
      const c = clips[i];
      const wrong = detectedLang === 'id'
        ? (t) => looksEnglishText(t)
        : (t) => false;   // an EN run drifting to ID is not something we have seen
      return wrong(c.title) || wrong(c.hook) || wrong(c.why);
    });
  // Guard against fighting a wrong language call: if MOST clips read as
  // English, the likelier explanation is that detectLanguage() misjudged an
  // English (or heavily mixed) video, not that the model drifted on every
  // single clip. Rewriting them all would burn one AI call per clip to
  // produce worse, translated-sounding titles than the transcript's own
  // words. A genuine drift shows up on a minority of clips.
  const driftTooBroad = clips.length >= 3 && driftIdx.length > clips.length / 2;
  if (driftTooBroad) {
    log(`⚠ Sebagian besar clip terbaca Bahasa Inggris — kemungkinan videonya memang berbahasa Inggris, judul dibiarkan apa adanya`, 'yellow');
  } else if (driftIdx.length && aiAvailable(cfg)) {
    log(`⚠ ${driftIdx.length} clip ditulis dalam Bahasa Inggris — menulis ulang…`, 'yellow');
    // Small fixed pool: these are serial LLM round-trips, and the AI circuit
    // breaker already serialises around a dead provider — 2 is enough to
    // overlap network latency without multiplying per-minute token pressure.
    const titleConcurrency = 2;
    await mapLimit(driftIdx, titleConcurrency, async (i) => {
      const c = clips[i];
      const res = await regenerateClipMeta(cfg, {
        clipText: clipTexts[i], category: c.category, ytInfo, topicSummary, lang: detectedLang,
      });
      if (res?.error) return;
      // Only accept a replacement that is actually in the right language —
      // otherwise keep what we had rather than burning a second call's output
      // that drifted the same way.
      if (res.title && !looksEnglishText(res.title)) c.title = res.title;
      if (res.hook && !looksEnglishText(res.hook)) c.hook = res.hook;
      if (res.description && !looksEnglishText(res.description)) c.why = res.description;
      log(`▶ Clip ${i + 1} ditulis ulang: "${c.title}"`, 'lime');
    });
  }

  fs.writeFileSync(SF.dataPath(sessionDir, 'highlights.json'), JSON.stringify(clips, null, 2));

  // Surface every detected candidate before Smart Track/render begins. Poster
  // extraction is deliberately best-effort: a failed seek reuses the source
  // thumbnail and never fails the pipeline.
  const clipCandidates = await extractCandidatePosters({
    clips,
    sourceThumbnail: fs.existsSync(thumbPath) ? thumbPath : (remotePoster(ytInfo) || null),
    sessionDir: SF.dataPath(sessionDir),
    format: cfg.format,
    limit: 2,
    extract: async ({ time, output, posterSpec }) => {
      await spawnLines(FFMPEG, [
        '-y', '-ss', String(time), '-i', inputPath,
        '-frames:v', '1', '-vf', posterSpec.filter, '-q:v', '4', output,
      ], { onLine: () => {}, timeoutMs: 60000 });
      return output;
    },
  });
  clipCandidates.forEach((candidate, i) => {
    clips[i].candidateId = candidate.candidateId;
    clips[i].thumbnail = candidate.thumbnail;
    clips[i].srcVideo = inputPath;
    candidate.srcVideo = inputPath;
  });
  try { onClipsDetected?.(clipCandidates); } catch {}

  // ── 6+7) Cut + caption per clip ──
  stages.begin('Render clip');
  // [HW-DECODE] Decide ONCE per run whether GPU decode is actually faster on
  // this machine for this source, then reuse the verdict for every clip. See
  // src/hw-accel.js for why this is measured rather than assumed — `-hwaccel`
  // measured 2-4x SLOWER on a Mac with a confirmed-working GPU, because every
  // filter here is CPU-side and forces a per-frame readback out of VRAM.
  // Calibration costs a few seconds once per machine and is then cached.
  // Announce it BEFORE probing: on a cache miss this is several seconds of
  // total silence, and the only other output is a single line after it ends.
  // 72 = just past the Title stage (which ends at 60+12) and before the
  // per-clip Export band begins.
  if (!_decodeCalibrated) prog('Export', 'mengukur akselerasi GPU…', 72);
  await calibrateDecodeOnce({
    src: inputPath,
    vf: vfFor(cfg.format, cfg.resolution),
    resolution: cfg.resolution || '1080p',
    // Must be the app's userData dir, passed in by main.js. Deriving it from
    // sessionDir was WRONG and shipped a visible bug: sessions live under
    // ~/Movies/<AppName>/<session> (main.js OUTPUT_ROOT), not under userData, so
    // `sessionDir/../..` resolved to the user's ~/Movies folder and dropped a
    // stray hw-calibration.json in it. Confirmed on a real run.
    cacheDir: calibrationCacheDir(userDataDir),
    log: (m) => log(`▶ ${m}`, 'lime'),
  });

  // Analysis (smart-track sidecar) and ffmpeg cutting are both CPU-bound and
  // independent per clip, so a bounded worker pool runs several clips at once
  // instead of one-at-a-time. Cap = min(6 hard ceiling, cores-1, clip count) —
  // leaves a core free for the OS/UI and never over-subscribes a small machine.
  const renderedFiles = new Array(clips.length);
  const clipExporter = createClipExporter(cfg, sessionDir, log);
  const vf = vfFor(cfg.format, cfg.resolution);
  // [SMART-TRACK CONTENTION] With Smart Track ON, each concurrency slot below
  // gets its OWN persistent TrackerWorker running SCRFD face detection. On a
  // dedicated GPU (or Apple Neural Engine) several of those run fine side by
  // side because the accelerator has real parallel capacity and the CPU stays
  // free for orchestration. On a laptop with only an integrated GPU (no dGPU,
  // common on Windows), DirectML calls from concurrent processes serialize on
  // the one shared device instead of overlapping, while each process ALSO
  // fights the others for CPU on MediaPipe's landmark pass (always CPU) — so
  // total time for N clips at concurrency N can end up close to N× a single
  // clip's time rather than ~1× it. Profiled live: one 15s clip end-to-end
  // (subprocess, matching production) took ~140s in isolation; user reports
  // matched multi-clip runs taking far longer than that per clip, consistent
  // with this contention rather than any single clip being newly slow.
  // [2026-07-19] `detectHwEncoder()` already does a REAL encode probe (not
  // just a codec-name grep) for NVENC/VideoToolbox/QSV, which doubles as a
  // decent dGPU-vs-iGPU signal:
  //   • darwin: EVERY Mac reports videotoolbox, but Apple Silicon's Neural
  //     Engine (used by CoreML, which our tracker's onnxruntime already gets
  //     for free — see windows-mac-directml-parity note) genuinely handles
  //     concurrent inference without the contention DirectML has. No reports
  //     of the 20-min bug on Mac. Safe to allow real concurrency.
  //   • win32 + nvenc confirmed: a REAL discrete Nvidia GPU passed a live
  //     encode test — DirectML tracking gets its own device, not a shared
  //     integrated one. Safe to allow real concurrency.
  //   • win32 + qsv/software/anything else with NO measured DirectML evidence:
  //     stay serialized — see [TRACKER-ACCEL-CAP] below for the case this
  //     used to lump in here that turned out to be wrong: an AMD iGPU whose
  //     ENCODER lost its race (hw === 'software') but whose TRACKER's
  //     DirectML session works fine.
  // [2026-07-19] Cap MEASURED, not guessed: real subprocess benchmark on a
  // 10-core M-series Mac (6 clips, real TrackerWorker-equivalent subprocess
  // pool, CoreML/ANE active) —
  //   concurrency 1: 144.1s (1.00x)   2: 85.9s (1.68x)   3: 77.7s (1.85x)
  //   4: 73.5s (1.96x, PEAK)          6: 82.0s (1.76x, REGRESSES past 4)
  // The earlier cap of 3 was an untested guess; 4 measurably wins, and going
  // past 4 makes things WORSE (shared ANE/CoreML device + MediaPipe's
  // CPU-only landmark pass both saturate before the core count does) rather
  // than just plateauing. Cap at 4, not cpus-1, on the accelerator-safe path.
  //
  // [TRACKER-ACCEL-CAP, 2026-07-30] The gate above conflated "the ENCODER has
  // a fast hardware path" with "the TRACKER has a usable accelerator" — two
  // unrelated questions. Measured on a real reporting machine (Ryzen 3 7320U,
  // Radeon 610M): the encoder lost its own race against libx264 and got
  // demoted to hw === 'software', while DirectML for the SCRFD detector was
  // present, bound, and 1.7-1.9x faster than CPU — so this used to serialize a
  // machine that could run 2 at a time. 12 clips at 60s each took 20-30
  // minutes as a direct result. See trackerAccelCapFor for the full matrix and
  // detectTrackerAccel for the cached probe that supplies dmlAvailable.
  const hw = detectHwEncoder();
  const trackerCap = trackerAccelCapFor({
    platform: process.platform, hw, dmlAvailable: detectTrackerAccel().dmlAvailable,
    totalMemBytes: os.totalmem(),
  });
  // [SW-ENCODE-BUDGET] The non-Smart-Track limit used to be a flat 6 with no
  // platform or encoder gate, while the Smart Track branch beside it had a
  // carefully measured one. On the software encode path 6 asks for ~13 cores and
  // ~3.6 GB of encoder RSS — see the measurements at clipConcurrencyFor.
  const renderPlan = renderPlanFor({
    smartTrack: !!cfg.smartTrack,
    trackerCap,
    hw,
    cpus: os.cpus().length,
    freeMemBytes: availableMemBytes(),   // [LOW-SPEC-2026-07-30] what's ACTUALLY free, not installed RAM — [MAC-FREEMEM]
    clips: clips.length,
    resolution: cfg.resolution || '1080p',   // [RES-RSS-BUDGET]
  });
  const CLIP_CONCURRENCY = renderPlan.workers;
  // Only bites on the software path; videoEncodeArgs ignores it for every
  // hardware encoder (which are not CPU-bound).
  const ENCODE_THREADS = hw === 'software'
    ? softwareEncodeThreads(os.cpus().length, CLIP_CONCURRENCY)
    : undefined;
  if (hw === 'software') {
    log(`⏵ Encode: software x264, ${CLIP_CONCURRENCY} clip(s) at a time, ${ENCODE_THREADS} threads each`);
  }
  // [LOW-SPEC-MAC-2026-07-30] Say WHY the render is going one clip at a time.
  // Without this the machine just feels slow and the user has no idea a memory
  // budget throttled it — the alternative to being slow here is being killed.
  {
    const unthrottled = clipConcurrencyFor({
      smartTrack: !!cfg.smartTrack, trackerCap, hw,
      cpus: os.cpus().length, freeMemBytes: 0, clips: clips.length,
      resolution: cfg.resolution || '1080p',
    });
    if (CLIP_CONCURRENCY < unthrottled) {
      const freeGb = (availableMemBytes() / 1024 ** 3).toFixed(1);
      log(`⚠ RAM bebas tinggal ${freeGb} GB — render dibatasi ${CLIP_CONCURRENCY} klip sekaligus ` +
          `(biasanya ${unthrottled}). Lebih lambat, tapi tidak bikin app mati. Tutup app lain untuk mempercepat.`, 'yellow');
    }
  }
  // [TRACKER-ACCEL-CAP] _providers() in detect.py picks an accelerator SILENTLY
  // — without this, there was no way to know from the app which path a user's
  // machine actually took. Logged once per run, not per clip, using the cap
  // decision (cheap, already computed) rather than waiting on a real analyze()
  // result.
  if (cfg.smartTrack) {
    const accelLabel = trackerCap >= 4 && process.platform === 'darwin' ? 'CoreML/ANE'
      : trackerCap >= 4 ? 'NVENC-class dGPU'
      : trackerCap === 2 ? 'DirectML (iGPU)'
      : 'CPU (no accelerator detected)';
    log(`⏵ Smart Track: ${accelLabel}, ${CLIP_CONCURRENCY} clip(s) at a time`);
  }
  // [TRACKER-ACCEL-CAP] Ground truth, not prediction: the line above is what
  // the CACHED PROBE said before any clip ran. This is what the sidecar
  // ACTUALLY reports building its first detector (detect.py sets
  // Detector.providers after a real inference survives) — logged once, since
  // every clip in a run shares the sidecar's cached detector per aspect ratio.
  let _loggedTrackerProvider = false;
  // One circuit breaker per run. A native/process failure may recycle the
  // worker once; a second disables Smart Track for the remaining clips while
  // FFmpeg rendering continues with centre crop.
  const trackerFailurePolicy = new TrackerFailurePolicy();
  // [BURN-PREFLIGHT] Second half of the burn-skip net. The pre-flight above
  // catches "no transcript at all"; this catches the case the pre-flight
  // cannot see — a transcript exists, but THIS clip's slice of it came back
  // empty (a silent stretch, or cues that all fell outside the cut), which
  // also skips the burn for that clip alone.
  //
  // [BURN-WARN-LATCH] This used to be a one-shot boolean, so only the FIRST
  // caption-less clip was ever mentioned. In a real run
  // (socl-2026-08-04T07-10-17) the per-clip cue counts were [1,0,0,0,0] and
  // the log carried exactly ONE warning for FOUR silently caption-less clips
  // — that mismatch is precisely the reported "beberapa subtitle tidak
  // keluar". The 300-line renderer buffer that motivated the latch is still a
  // real constraint, so instead of shouting once per clip this collects every
  // index and prints ONE accurate summary after the render loop, plus the
  // first few inline so the problem is visible while the run is still going.
  const burnSkippedClips = [];
  const BURN_WARN_INLINE_MAX = 3;
  let completedClips = 0;
  const rawDir = path.join(sessionDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const renderOneClip = async (i, trackerWorker) => {
    if (cancelled) throw new Error('cancelled');
    const c = clips[i];
    const emitClipState = (state, detail = '') => {
      try { onClipState?.({ candidateId: c.candidateId, index: i + 1, state, detail }); } catch {}
    };
    const pctBase = 65 + Math.floor((completedClips / clips.length) * 32);
    prog('Export', `clip ${i+1}/${clips.length}: ${c.title}`, pctBase);

    const slug = slugify(c.title);
    const fname = `${String(i+1).padStart(2,'0')}-${slug}.mp4`;
    const outPath = path.join(rawDir, fname);
    const dur = (c.end - c.start).toFixed(2);
    // [RENDER-WATCHDOG] Absolute last-resort ceiling. The REAL watchdog is
    // RENDER_STALL_MS (silence-based) — this only catches the pathological case
    // of a child that chatters forever without finishing.
    //
    // The old budget was floor 5 min + 20s per clip-second and claimed "a legit
    // slow software encode is never killed; only a true hang is". That claim was
    // wrong on the reported 8 GB Windows machine: a 60s clip gets exactly
    // 1,200,000 ms, and the user hit it mid-render — "ffmpeg.exe timed out after
    // 1200s", which aborted the whole pipeline at clip 4 of 5. Elapsed time
    // cannot distinguish slow from wedged, so the ceiling is now far out of the
    // way of real work and stall detection does the actual job.
    const RENDER_TIMEOUT_MS = Math.max(1800000, Math.round((c.end - c.start) * 60000));

    // Build this clip's word-chunked cues (clip-relative timing) up-front so we
    // can optionally burn them into the cut. Empty when no transcript exists.
    let cueWords = [];
    // [WORD-TIMING] When the ASR gave real word times, chunk on those (tight sync).
    // Slice words in-range, remap to clip-relative seconds, then chunkWordsToCues.
    if (words.length) {
      const clipDurCW = parseFloat(dur);
      const sliceW = words
        // [EDGE-WORD] Keep a word only when most of it is inside the clip. A bare
        // overlap test let the tail of the previous sentence in: "anything."
        // ending 0.03 s after the cut flashed as the clip's first caption, and a
        // half-spoken "Yes." sat on the last frame — read as captions out of order.
        .filter(w => wordMostlyInClip(w, c.start, c.end))
        .map(w => ({
          text: w.text,
          start: Math.max(0, w.start - c.start),
          end: Math.min(clipDurCW, Math.max(w.start - c.start + 0.05, w.end - c.start)),
        }))
        .filter(w => w.end > w.start && w.text.trim().length > 0);
      cueWords = chunkWordsToCues(sliceW, wpcMode(cfg));   // [WPC-AUTO]
      // Store the per-word list on the clip so the editor's rechunk uses real times.
      c.words = sliceW;
    } else if (cues.length) {
      const slice = segmentsInRange(cues, c.start, c.end, 0);
      const clipDurCW = parseFloat(dur);
      cueWords = chunkWordsToCues(dedupeAndSplitCues(slice, 1), wpcMode(cfg))
        .filter(x => (x.end - c.start) > 0.05)           // drop cues entirely before clip start
        .map(x => ({
          start: Math.max(0, x.start - c.start),
          end:   Math.min(clipDurCW, Math.max(x.start - c.start + 0.25, x.end - c.start)),
          text:  x.text,
        }))
        .filter(x => x.end > x.start + 0.05 && x.text.trim().length > 0);
      // Sequential dedup — same guarantee as the ASS burn pass
      for (let j = 1; j < cueWords.length; j++) {
        if (cueWords[j].start < cueWords[j-1].end) cueWords[j].start = cueWords[j-1].end;
        if (cueWords[j].end <= cueWords[j].start)  cueWords[j].end   = cueWords[j].start + 0.25;
      }
      cueWords = cueWords.filter(x => x.end > x.start + 0.05 && x.start < clipDurCW);
    }
    c.cueWords = cueWords;

    // Smart face tracking (Phase 3a): analyse this clip once, get a trackPlan,
    // then segment-render + concat instead of a single ffmpeg call. When the
    // sidecar isn't available (venv missing) or analysis fails, fall back to
    // the default center crop so the pipeline still completes.
    let trackPlan = null;
    if (cfg.smartTrack && trackerWorker && !trackerFailurePolicy.disabled) {
      emitClipState('tracking');
      prog('Export', `clip ${i+1}/${clips.length}: analyzing faces…`, pctBase);
      try {
        const res = await trackerWorker.run({
          video: inputPath, clipStart: c.start, clipEnd: c.end, format: cfg.format,
          asdMode: cfg.trackerAsdMode,
        }, (p) => {
          const inner = Math.min(1, p.pct || 0);
          prog('Export', `clip ${i+1}/${clips.length}: analyzing ${Math.round(inner*100)}%`,
               pctBase + Math.floor(inner * (16 / clips.length)));
        });
        if (res && Array.isArray(res.keyframes) && res.keyframes.length) {
          trackPlan = { keyframes: res.keyframes };
          const frameDiag = res.frames
            ? ` · scout ${res.frames.scout || 0}, refine ${res.frames.refine || 0}, total ${res.frames.total || 0}`
            : '';
          log(`✓ Clip ${i+1} tracked (${res.keyframes.length} keyframes · ${res.mode || 'full'}${frameDiag})`, 'ok');
          // [TRACKER-ACCEL-CAP] detect.py's _providers() picks an accelerator
          // SILENTLY — this is the one place that provider was already being
          // reported (res.detector.providers) and never read on this side.
          if (!_loggedTrackerProvider && res.detector && Array.isArray(res.detector.providers)) {
            _loggedTrackerProvider = true;
            log(`⏵ Face tracker device: ${res.detector.providers[0]} (det ${res.detector.det_size?.join('x') || '?'})`);
          }
          // [SILENT-FALLBACK-FIX] motion_vad is an opt-in "experimental,
          // faster" toggle (f_asdModeQ in renderer.js) — if the sidecar's
          // motion_vad setup throws (missing VAD model, ONNX runtime issue,
          // a real bug), it silently downgrades to the old blendshape/
          // MediaPipe path with the SAME on-screen result, so a user testing
          // the toggle would see normal tracking and have no idea the fast
          // path never ran. pipeline.py rides the fallback reason on
          // res.detector (same "unknown fields ignored" channel providers
          // uses above); surface it once per clip so it's visible instead of
          // silently eating the point of the toggle.
          if (res.detector && res.detector.asd_fallback_reason) {
            log(`⚠ Clip ${i+1}: motion_vad gagal (${res.detector.asd_fallback_reason}) — pakai blendshape (MediaPipe) sebagai gantinya`, 'warn');
          }
        }
      } catch (e) {
        const action = trackerFailurePolicy.record(e);
        const suffix = action.disableRemaining
          ? 'Smart Track dinonaktifkan untuk sisa klip agar aplikasi tetap stabil.'
          : action.restart
            ? 'Worker akan dimulai ulang sekali untuk klip berikutnya.'
            : 'Klip ini memakai centre crop.';
        log(`⚠ smart tracking failed on clip ${i+1}: ${e?.message || e} — ${suffix}`, 'warn');
        emitClipState('standard', e?.message || String(e));
      }
    } else if (cfg.smartTrack && trackerFailurePolicy.disabled) {
      log(`⚠ Smart Track dilewati untuk clip ${i+1} setelah crash berulang — memakai centre crop`, 'warn');
      emitClipState('standard', 'Smart Track disabled after repeated worker crashes');
    } else if (cfg.smartTrack && !trackerAvailable()) {
      log('⚠ Smart Face Tracking ON but sidecar Python venv missing — install per docs. Falling back to centre crop.', 'warn');
      emitClipState('standard', 'Smart Track runtime unavailable');
    }
    if (trackPlan || !cfg.smartTrack) emitClipState('rendering');

    // Clips are cut RAW (framed to format only, NO burned captions). Captions
    // live in the tunable preview/editor overlay and are burned ONLY on an
    // explicit Apply (Editor) / batch render, which call renderClipEdit and
    // re-cut from source. Burning here would bake an immutable caption into
    // clip.file and break realtime style/font tuning.
    if (trackPlan) {
      // Segment-render + concat path (mirrors the renderClipEdit smart-track
      // block). Each segment gets its own ffmpeg call with a filter matching
      // the trackPlan; concat demuxer joins them, then the final file is
      // copied out to outPath.
      // [XFADE-REMOVED-2026-08-06] A layout-transition crossfade (single face
      // <-> split-screen) was tried here — it worked (verified) but made the
      // rendered clip xfadeDur seconds SHORTER than (c.end - c.start) per
      // transition, which required remapping cueWords to match. That remap
      // only ran in THIS function; renderClipEdit()'s OWN segment-render path
      // (the Editor "Apply" re-render) re-cuts from source at the ORIGINAL
      // nominal duration with no xfade at all, but reuses the SAME (already
      // remapped, now-shortened-timeline) cueWords — a real user report
      // ("miss jauh sekali antara voice dan subtitle") traced to exactly this
      // duration mismatch between the two render paths. Simplest fix: removed
      // the crossfade outright rather than teaching renderClipEdit's separate
      // path the same trick — a hard cut at a layout change is a smaller
      // problem than captions drifting seconds off in the Editor.
      const { buildSegmentJobs } = require('./track-plan');
      const jobs = snapSegmentJobs(buildSegmentJobs(trackPlan, {
        clipDur: Math.max(1, c.end - c.start),
        resolution: cfg.resolution || '1080p',
        format: cfg.format || 'face',
      }), fpsFromStream(vstream));
      const segFiles = [];
      const clipDur = Math.max(1, c.end - c.start);

      // [CONTINUOUS-AUDIO] Step 1: Extract the ENTIRE clip's audio as one
      // continuous stream.  This completely bypasses segment-boundary slicing
      // so there are zero AAC priming gaps and zero PTS discontinuities.
      const clipAudioPath = path.join(sessionDir, `_clipaudio-${process.pid}-${i}.m4a`);
      if (sourceHasAudio) {   // [NO-AUDIO-SOURCE]
        const audioExtractArgs = ['-y', ...decodeArgs(),
          '-ss', String(c.start.toFixed(3)),
          '-i', inputPath,
          '-t', String(clipDur.toFixed(3)),
          '-vn'];
        if (Number.isInteger(audioStreamIndex)) {
          audioExtractArgs.push('-map', `0:${audioStreamIndex}`);
        }
        audioExtractArgs.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', clipAudioPath);
        await spawnLines(FFMPEG, audioExtractArgs,
          { cwd: sessionDir, onLine: () => {}, timeoutMs: RENDER_TIMEOUT_MS, stallMs: RENDER_STALL_MS });
      }

      // [CONTINUOUS-AUDIO] Step 2: Render each segment VIDEO-ONLY (-an).
      // Use -t (output duration) instead of -to (input stop-time) so the
      // video stream is never truncated by packet-interleave timing.
      for (let s = 0; s < jobs.length; s++) {
        const j = jobs[s];
        const segOut = path.join(sessionDir, `_seg-${process.pid}-${i}-${s}.mp4`);
        const segArgs = ['-y', ...decodeArgs(),
          '-ss', String((c.start + j.ss).toFixed(3)),
          '-i', inputPath,
          '-t', String((j.to - j.ss).toFixed(3)),
          '-an'];
        segArgs.push(...segmentFilterArgs(j));
        const encodeArgs = videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS);
        const fallbackEncodeArgs = videoEncodeArgsFor('software', 'final', cfg.resolution || '1080p', ENCODE_THREADS);
        segArgs.push(...encodeArgs,
                     '-pix_fmt', 'yuv420p',
                     '-movflags', '+faststart',
                     segOut);
        await spawnFfmpegWithDecodeFallback(segArgs, { cwd: sessionDir, timeoutMs: RENDER_TIMEOUT_MS, stallMs: RENDER_STALL_MS,
          onLine: (_k, line) => {
            const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
            if (!m) return;
            const t = (+m[1])*3600 + (+m[2])*60 + parseFloat(m[3]);
            const inner = Math.max(0, Math.min(1, (j.ss + t) / clipDur));
            prog('Export', `clip ${i+1}/${clips.length}: ${Math.round(inner*100)}%`, pctBase + Math.floor(inner * (32 / clips.length)));
          },
          ...(hw === 'software' ? {} : { encodeArgs, fallbackEncodeArgs }) });
        segFiles.push(segOut);
      }

      // [CONTINUOUS-AUDIO] Step 3: Concat video-only segments.
      const listPath = path.join(sessionDir, `_seglist-${process.pid}-${i}.txt`);
      fs.writeFileSync(listPath, segFiles.map(f => `file '${path.basename(f)}'`).join('\n'));
      const trackedVideoPath = path.join(sessionDir, `_tracked-${process.pid}-${i}.mp4`);
      await spawnLines(FFMPEG,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'copy', '-an', '-movflags', '+faststart', trackedVideoPath],
        { cwd: sessionDir, onLine: () => {}, timeoutMs: RENDER_TIMEOUT_MS, stallMs: RENDER_STALL_MS });

      // [CONTINUOUS-AUDIO] Step 4: Mux continuous audio + tracked video.
      await spawnLines(FFMPEG, muxTrackedArgs(trackedVideoPath, sourceHasAudio ? clipAudioPath : null, outPath),
        { cwd: sessionDir, onLine: () => {}, timeoutMs: RENDER_TIMEOUT_MS, stallMs: RENDER_STALL_MS });

      // Clean up intermediates so the session dir stays tidy.
      for (const f of segFiles) { try { fs.unlinkSync(f); } catch {} }
      try { fs.unlinkSync(listPath); } catch {}
      try { fs.unlinkSync(trackedVideoPath); } catch {}
      try { fs.unlinkSync(clipAudioPath); } catch {}
    } else {
      const assArg = ['-vf', vf];
      const encodeArgs = videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS);
      const fallbackEncodeArgs = videoEncodeArgsFor('software', 'final', cfg.resolution || '1080p', ENCODE_THREADS);
      const args = ['-y', ...decodeArgs(),
        '-ss', String(c.start.toFixed(2)),
        '-i', inputPath,
        '-t', dur,
      ];
      if (Number.isInteger(audioStreamIndex)) {
        args.push('-map', '0:v:0', '-map', `0:${audioStreamIndex}`);
      }
      args.push(
        ...assArg,
        ...encodeArgs,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
        outPath,
      );
      await spawnFfmpegWithDecodeFallback(args, {
        cwd: sessionDir,
        timeoutMs: RENDER_TIMEOUT_MS,
        stallMs: RENDER_STALL_MS,
        ...(hw === 'software' ? {} : { encodeArgs, fallbackEncodeArgs }),
        onLine: (_k, line) => {
          const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
          if (m) {
            const t = (+m[1])*3600 + (+m[2])*60 + parseFloat(m[3]);
            const inner = Math.min(1, t / (c.end - c.start));
            prog('Export', `clip ${i+1}/${clips.length}: ${Math.round(inner*100)}%`, pctBase + Math.floor(inner * (32 / clips.length)));
          }
        },
      });
    }
    // [PIPELINE-BURN] With Burn subtitles ON, Run-Pipeline should deliver an
    // already-baked clip WITHOUT a follow-up "Render all" click — but raw/ must
    // stay CLEAN (unburned). So: keep raw/ as the crop-only, re-editable plate,
    // and write the baked version ONLY to the sibling burn-edited/ folder. The
    // clip the app surfaces (clip.file) points at the burned deliverable so the
    // gallery shows captions, while clip.rawFile points at the clean raw/ cut
    // (the caption editor recuts from there so re-edits never double-stack).
    // One ffmpeg pass covers both branches (trackPlan concat + single-pass).
    const shouldBurnSubs = !!cfg.burnSubtitles && cueWords.length > 0;
    if (!!cfg.burnSubtitles && !cueWords.length) {
      burnSkippedClips.push(i + 1);
      if (burnSkippedClips.length <= BURN_WARN_INLINE_MAX) {
        log(`⚠ Clip ${i+1}: burn caption dilewati — tidak ada teks pada rentang klip ini. Klip tetap dibuat, tapi TANPA subtitle terbakar.`, 'yellow');
      }
    }
    // [AUTO-TITLE-REMOVED] The pipeline briefly generated a persistent title
    // from each clip's hook text (2.3.72-beta, driven by a Clip Options
    // toggle). Pulled at the user's request after a real Windows run: the
    // generated title landed on top of the opening captions and the first
    // seconds read as overlapping text. The clearance rule it used — put the
    // title in whichever half of the frame cfg.subtitleY leaves free — is not
    // enough on its own, because a caption block's real height depends on the
    // cue's own wrapping, which the pipeline does not know when it places the
    // title. Titles are back to being Caption-Editor-only, where the user can
    // see exactly where they land before committing.
    //
    // Deliberately kept: the auto LAYOUT of a title once one exists (multi-line
    // shaping, hook-word accent, fit sizing — src/title-layout.js). That was
    // verified working and only ever applies to titles the user adds by hand.
    const style = cfg.subtitleStyle || 'neon_green';
    const fsz   = cfg.subtitleFontSize || 64;
    const yP    = cfg.subtitleY || 540;
    const xP    = cfg.subtitleX;   // buildAss treats null/undefined as centre; `|| 540` would also collapse a real X=0
    const anm   = cfg.subtitleAnim || 'pop';
    const glw   = cfg.subtitleGlow !== false;
    // [CASE-V1] Same transform renderClipEdit applies. Without it the clip the
    // pipeline hands over ignores the caption-case setting until the user
    // re-renders from the editor.
    const pipeCues = applyCueCase(cueWords, cfg.subtitleCase);
    const box1 = cfg.subtitleBoxColor
      ? { boxColor: cfg.subtitleBoxColor, rotation: cfg.subtitleBoxRotation, fontsDir: assFontsDirFs() }
      : null;
    // [MANUAL-CAPTION] Inline manual captions splice into the cue list
    // exactly like an ASR cue; layer-mode ones ride as extra Dialogue lines
    // via buildAss's layerCaptions param.
    const { mergeInlineManualCaptions, layerManualCaptions } = require('./manual-caption');
    const mergedPipeCues = mergeInlineManualCaptions(
      shiftCues(pipeCues, cfg.subtitleOffsetMs, c.end - c.start),
      c.manualCaptions || []);
    const assFmt = cfg.format || 'face';
    const capLayers = layerManualCaptions(c.manualCaptions || []);
    // [HOOK-AUTOBURN] Opt-in (Clip Options → "Hook judul di video"). The
    // hook is placed by MEASURING this clip's own caption events in the
    // ASS buildAss writes, not by guessing a half of the frame (the
    // 2.3.72-beta mistake, see [AUTO-TITLE-REMOVED] above). No room
    // anywhere → the clip simply gets no hook, never an overlap.
    // Computed OUTSIDE the burn gate: with Burn subtitle OFF (or a clip with
    // no transcript) the hook still becomes the clip's headline layer, shown
    // live in the preview and burned by the next render — exactly how the
    // captions themselves behave. A real import run with Burn OFF showed
    // nothing at all when this lived inside the gate.
    let hookTitle = null;
    let fxOnlyTitle = null;   // [TITLE-VIDEO-FX] effect without text when the hook had no room
    if (cfg.hookAutoBurn && String(c.title || '').trim()) {
      const HA = require('./hook-autoburn');
      const preset = cfg.hookPreset || HA.DEFAULT_PRESET;
      try {
        // [HOOK-CENTER] User rule (2026-10-11): no face/caption avoidance — the
        // hook sits centred (movable later in the Caption Editor) and the
        // captions wait until it ends. Face avoidance skipped 3 of 4 hooks.
        const placed = HA.placeHook({
          center: true,
          // [CLIP-HOOK] the 2-4 word hook, not the title cut to fit.
          text: HA.hookTextWithSub(c.hookText, c.title, preset, cfg.hookCase || ''),   // [HOOK-SUB]
          clipDur: c.end - c.start,
          presetId: preset,
          captionsAss: buildAss(mergedPipeCues, fsz, style, yP, xP, anm, glw, [], assFmt, cfg.subtitleFont || '', box1, capLayers, kinCapParam(cfg)),
          buildHookAss: (T) => buildAss([], fsz, style, yP, xP, anm, glw, [T], assFmt, cfg.subtitleFont || '', null, []),
        });
        hookTitle = placed.title;
        if (hookTitle) log(`▶ Clip ${i+1}: hook di tengah, caption mulai setelah hook (${HA.HOOK_DUR}s).`);
        if (!hookTitle) {
          log(`⚠ Clip ${i+1}: hook judul dilewati — ${placed.reason}.`, 'yellow');
          // [TITLE-VIDEO-FX] The preset's video effect (cut-out / duotone) is
          // part of the look and must not depend on whether the TEXT fit —
          // otherwise only the clips with short titles turned pink.
          const fxId = (require('./hook-presets').byId(preset) || {}).title?.videoFx;
          if (fxId) fxOnlyTitle = { videoFx: fxId, start: 0, end: Math.max(0.5, Math.min(HA.HOOK_DUR, c.end - c.start)) };
        }
      } catch (e) {
        log(`⚠ Clip ${i+1}: hook judul gagal dibuat (${e.message}) — klip tetap dibuat tanpa hook.`, 'yellow');
      }
    }
    let burnedOut = null;   // set to the burn-edited/ path once a burn succeeds
    let captionsBurned = false;
    if (shouldBurnSubs) {
      prog('Export', `clip ${i+1}/${clips.length}: burning captions`, pctBase + Math.floor(30 / clips.length));
      const assName = `_subs-pipe-${process.pid}-${i}.ass`;
      const assPath = path.join(sessionDir, assName);
      // [SUBTRACT-SPLIT] Subtract (inverse_auto) flips the pixels under the
      // CAPTIONS only. One ASS through the difference blend also flipped the
      // hook; renderClipEdit already split the two. Captions (kinetic or not)
      // go through the blend, the hook rides a normal pass on top. The
      // hook-window trim happens here because the caption file no longer
      // carries the hook title buildAss reads it from.
      const splitInv = style === 'inverse_auto' && !!hookTitle;
      const titleAssName = splitInv ? `_subs-pipe-${process.pid}-${i}-t.ass` : null;
      if (splitInv) {
        fs.writeFileSync(assPath, buildAss(trimCuesUnderHook(mergedPipeCues, [hookTitle]),
          fsz, style, yP, xP, anm, glw, [], assFmt, cfg.subtitleFont || '', box1,
          capLayers, kinCapParam(cfg)));
        fs.writeFileSync(path.join(sessionDir, titleAssName), buildAss([],
          fsz, 'white_clean', yP, xP, anm, glw, [hookTitle], assFmt, cfg.subtitleFont || '', null, [], ''));
      } else {
        fs.writeFileSync(assPath, buildAss(mergedPipeCues,
          fsz, style, yP, xP, anm, glw, hookTitle ? [hookTitle] : [], assFmt, cfg.subtitleFont || '', box1,
          capLayers, kinCapParam(cfg)));
      }
      const fdir = assFontsDir();
      const burnedPath = outPath.replace(/\.mp4$/, `.burn-${process.pid}.mp4`);
      // [WM-V1] Compose the project watermark under the caption layer, exactly
      // like renderClipEdit's legacy path. This call was missing entirely, so a
      // configured watermark never reached ANY clip the pipeline delivered —
      // while the dashboard preview drew it live, making preview and file
      // disagree. There are no per-clip overrides at pipeline time, so only the
      // project-level descriptor applies. With the watermark inactive,
      // filterArgs collapses to ['-vf', …] and this is the previous command.
      // [EMOJI-STICKER] Planned from the SAME cues that were just burned, so a
      // sticker's window always matches the caption that triggered it.
      // [AI-STICKER-CACHE] c.aiStickerCache starts undefined on a clip's
      // first pipeline run; stickerJobs treats that the same as an empty
      // cache. The (possibly updated) cache is written back below so a
      // later re-render of this exact clip — Preview, Apply, batch — reuses
      // whatever the AI already resolved instead of asking again.
      const { jobs: pipeStickers, aiCache: pipeAiCache } = await stickerJobs({
        enabled: !!cfg.emojiStickers, cues: pipeCues,
        fontSize: fsz, captionY: yP, subtitleX: xP, format: cfg.format, resolution: cfg.resolution,
        cfg, onLog: log, aiCache: c.aiStickerCache,
      });
      c.aiStickerCache = pipeAiCache;
      const pipeDims = await getStreamDims(outPath);
      // [CUTOUT-FX] Composite the person cut-out into the UNBURNED clip first,
      // so captions and the hook land on top of it untinted.
      // [VIDEO-FX] Clip setting → Efek video wins over a preset's own effect.
      const fxTitle = (cfg.videoFx && VFX.get(cfg.videoFx))
        ? { videoFx: cfg.videoFx, start: 0, end: Math.max(0.5, Math.min(VFX.WINDOW_SEC, c.end - c.start)) }
        : (hookTitle || fxOnlyTitle);
      const cutFile = (fxTitle && VFX.isCutout(fxTitle.videoFx))
        ? await applyCutoutFx(outPath, fxTitle, { cwd: sessionDir, log,
            encArgs: videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS) })
        : null;
      const burnInput = cutFile || outPath;
      const pipeWm = buildWatermarkFilter('', withVideoFx(withVideoFx(dimVf(cfg), titleVideoFxVf(fxTitle && !cutFile ? [fxTitle] : [])) || '', captionBurnVf(assName, fdir, style) + (titleAssName ? `,subtitles=filename='${titleAssName}':fontsdir='${fdir}'` : '')),
        wmModule.resolveWatermark(cfg.watermark, null),
        pipeDims.w || outputWidthPx(cfg.format || 'face', cfg.resolution || '1080p'),
        { sessionDir, nameSuffix: `pipe-${i}`,
          outputH: pipeDims.h || outputHeightPx(cfg.format || 'face', cfg.resolution || '1080p') },
        pipeStickers);
      try {
        await spawnLines(FFMPEG, [
          '-y', '-i', burnInput,
          ...pipeWm.extraInputs,
          ...pipeWm.filterArgs,
          ...videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-movflags', '+faststart',
          burnedPath,
        ], { cwd: sessionDir, timeoutMs: RENDER_TIMEOUT_MS, stallMs: RENDER_STALL_MS, onLine: (_k, line) => {
          const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
          if (m) {
            const t = (+m[1])*3600 + (+m[2])*60 + parseFloat(m[3]);
            const inner = Math.min(1, t / (c.end - c.start));
            prog('Export', `clip ${i+1}/${clips.length}: burning ${Math.round(inner*100)}%`,
                 pctBase + Math.floor((0.7 + inner * 0.3) * (32 / clips.length)));
          }
        }});
        // [RAW-CLEAN] Keep raw/ UNBURNED. The burned result lands ONLY in the
        // sibling burn-edited/ folder; raw/ stays the clean, re-editable cut.
        // (Previously this swapped the burned file OVER raw/, so raw/ ended up
        // burned too — the "raw folder isinya burned subtitle juga" bug.)
        // [TIDY-SESSION] subtitle/ (was burn-edited/): the burned deliverable.
        const burnEditedDir = path.join(sessionDir, 'subtitle');
        fs.mkdirSync(burnEditedDir, { recursive: true });
        if (cutFile) { try { fs.unlinkSync(cutFile); } catch {} }
        burnedOut = path.join(burnEditedDir, fname);
        fs.renameSync(burnedPath, burnedOut);
        captionsBurned = true;
      } catch (e) {
        // If the burn fails for any reason (bad font, corrupt cues, disk full),
        // keep the raw file and log. Don't fail the whole pipeline for one clip.
        log(`⚠ burn captions failed for clip ${i+1}: ${e?.message || e} — keeping raw output`, 'warn');
        try { fs.unlinkSync(burnedPath); } catch {}
      }
      try { fs.unlinkSync(assPath); } catch {}
      if (titleAssName) { try { fs.unlinkSync(path.join(sessionDir, titleAssName)); } catch {} }
      // [WM-V1] The drawtext sidecar is written per clip; remove it on both the
      // success and failure paths, same as the .ass above.
      for (const f of pipeWm.writtenFiles || []) { try { fs.unlinkSync(f); } catch {} }
    }
    // [FX-NO-BURN] Efek video is a look, not a caption: with Burn subtitle OFF
    // the whole burn pass above is skipped, so a chosen effect (cut-out or
    // duotone) never reached the file — the dashboard only tinted the preview.
    // Apply it on its own pass; raw/ stays the clean plate.
    let fxBurned = !!(burnedOut && ((cfg.videoFx && VFX.get(cfg.videoFx)) || (hookTitle && hookTitle.videoFx) || fxOnlyTitle));
    const fxOnly = !shouldBurnSubs && ((cfg.videoFx && VFX.get(cfg.videoFx))
      ? { videoFx: cfg.videoFx, start: 0, end: Math.max(0.5, Math.min(VFX.WINDOW_SEC, c.end - c.start)) }
      : (hookTitle && hookTitle.videoFx ? { videoFx: hookTitle.videoFx, start: hookTitle.start, end: hookTitle.end } : fxOnlyTitle));
    if (fxOnly && VFX.get(fxOnly.videoFx)) {
      prog('Export', `clip ${i+1}/${clips.length}: efek video`, pctBase + Math.floor(30 / clips.length));
      const encA = videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS);
      const fxDir = path.join(sessionDir, 'efek');
      let tmp = null;
      try {
        if (VFX.isCutout(fxOnly.videoFx)) tmp = await applyCutoutFx(outPath, fxOnly, { cwd: sessionDir, log, encArgs: encA });
        if (!tmp) {
          tmp = outPath.replace(/\.mp4$/, `.fx-${process.pid}.mp4`);
          await spawnLines(FFMPEG, ['-y', '-i', outPath, '-vf', titleVideoFxVf([fxOnly]) || 'null', ...encA,
            '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp],
          { cwd: sessionDir, timeoutMs: RENDER_TIMEOUT_MS, stallMs: RENDER_STALL_MS });
        }
        fs.mkdirSync(fxDir, { recursive: true });
        burnedOut = path.join(fxDir, fname);
        fs.renameSync(tmp, burnedOut);
        fxBurned = true;
      } catch (e) {
        log(`⚠ Clip ${i+1}: efek video gagal (${e?.message || e}) — klip tetap dibuat tanpa efek.`, 'warn');
        if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
      }
    }
    // [COLLAGE-BROLL] After captions/effect: B-roll goes over the finished look.
    // Burn OFF → the result lands in efek/ like the effect-only pass; raw/ stays clean.
    let brollBurned = false;
    const broll = cfg.collageBroll ? pickBrollMoments(cueWords, c.end - c.start, `${c.title || ''} ${c.hook || ''} ${c.why || ''}`) : [];   // [BROLL-MULTI]
    for (const b of broll) if (b.kind === 'full' && cfg.collageStyle && cfg.collageStyle !== 'auto') b.styleOverride = cfg.collageStyle;   // [BROLL-STYLES]
    applyBrollSec(broll, insertSec(cfg.brollSec), c.end - c.start);   // [INSERT-SEC]
    if (broll.length) {
      prog('Export', `clip ${i+1}/${clips.length}: b-roll kolase`, pctBase + Math.floor(32 / clips.length));
      const encA = videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS);
      const base = burnedOut || outPath;
      const tmp = await applyCollageBrolls(base, broll, { portraitSrc: outPath, cwd: sessionDir, log, encArgs: encA,
        avoid: shouldBurnSubs ? [captionBand(cfg.subtitleY, cfg.subtitleFontSize)] : [] });
      if (tmp) {
        try {
          if (burnedOut) fs.renameSync(tmp, burnedOut);
          else {
            const fxDir = path.join(sessionDir, 'efek');
            fs.mkdirSync(fxDir, { recursive: true });
            burnedOut = path.join(fxDir, fname);
            fs.renameSync(tmp, burnedOut);
          }
          brollBurned = true;
        } catch (e) {
          log(`⚠ Clip ${i+1}: b-roll kolase gagal disimpan (${e?.message || e})`, 'warn');
          try { fs.unlinkSync(tmp); } catch {}
        }
      }
    }
    c.broll = broll;
    // [CLIP-TIMELINE] Pick the cold-open teaser + quiet pauses on the clean
    // plate; burn them into the captioned deliverable now, or let the next
    // Render apply them (a caption overlay on a re-timed file would drift).
    let timeline = null, timelineBurned = false;
    {   // pause trim follows "Potong dead air"; the teaser is opt-in
      const clipLen = c.end - c.start;
      const relWords = Array.isArray(c.words) ? c.words : [];
      const heatAt = ytInfo?.heatmap ? (t) => (heatScore(ytInfo.heatmap, c.start + t - 2, c.start + t + 2)?.rel ?? 1) : null;
      const aiRel = c.teaserAbs ? { start: c.teaserAbs.start - c.start, end: c.teaserAbs.end - c.start } : null;
      const teaser = cfg.hookTeaser === true   // opt-in: default keeps the effect + title opening
        ? pickHookTeaser(relWords, clipLen, { ctxText: `${c.title || ''} ${c.hook || ''}`, aiRel, heatAt, sec: insertSec(cfg.hookTeaserSec) }) : null;
      let cuts = [];
      // [DEAD-AIR-TOGGLE] quiet pauses stay when dead air is off for this clip.
      if (relWords.length && cfg.deadAirCut !== false && !c._keepAir) {
        const env = await audioEnvelope(outPath, 0, clipLen + 0.5);
        cuts = pickPauseCuts(relWords, clipLen, env);
      }
      if (teaser || cuts.length) timeline = { teaser, cuts };
    }
    if (timeline && burnedOut && captionsBurned) {
      prog('Export', `clip ${i+1}/${clips.length}: hook pembuka`, pctBase + Math.floor(32 / clips.length));
      const t = await applyClipTimeline(burnedOut, timeline, { cwd: sessionDir, log,
        encArgs: videoEncodeArgs('final', cfg.resolution || '1080p', ENCODE_THREADS) });
      if (t) { try { fs.renameSync(t, burnedOut); timelineBurned = true; } catch { try { fs.unlinkSync(t); } catch {} } }
    }
    if (timeline) {
      const cutSec = timeline.cuts.reduce((a, [x, y]) => a + (y - x), 0);
      log(`▶ Clip ${i+1}: ${timeline.teaser ? `hook pembuka "${String(timeline.teaser.text).slice(0, 50)}" (${(timeline.teaser.end - timeline.teaser.start).toFixed(1)}s)` : 'tanpa hook pembuka'}${timeline.cuts.length ? ` · ${timeline.cuts.length} jeda dipangkas (−${cutSec.toFixed(1)}s)` : ''}${timelineBurned ? '' : ' — dipasang saat Render'}`);
    }
    c.timeline = timeline;
    c.timelineBurned = timelineBurned;
    // The app surfaces the burned deliverable (burn-edited/) when a burn
    // succeeded, else the clean raw cut. rawFile always points at the clean
    // raw/ cut so the caption editor recuts from unburned pixels. subsBurned is
    // true only when a burn actually produced a file (a failed burn falls back
    // to the clean raw and must NOT claim to be burned).
    const deliverable = burnedOut || outPath;
    const renderedThumbnail = await createRenderedPoster(
      deliverable,
      parseFloat(dur),
      cfg.format,
      c.thumbnail || thumbPath,
    );
    if (renderedThumbnail) c.thumbnail = renderedThumbnail;
    renderedFiles[i] = deliverable;
    // [HASIL-SUBTITLED] hasil/ holds only captioned clips (user's rule): the
    // burned version when Burn subtitle is ON. With it OFF — or a clip whose
    // range had no transcript — the clip stays in raw/ only, unless an Efek
    // video was applied ([FX-NO-BURN]): that file is the finished look.
    // [HASIL-RENDERED] hasil/ = clips that were actually RENDERED with their
    // captions (burn here, or the Caption Editor / batch render later). An
    // effect-only pass ([FX-NO-BURN], efek/) is not a finished clip — users saw
    // those caption-less files in hasil/ and read them as raw.
    if (burnedOut && shouldBurnSubs) await clipExporter.exportOne(burnedOut);
    // [HOOK-AUTOBURN] titles/titlesBurned only when a hook really went into
    // a burned file — claiming them otherwise would make the dashboard
    // suppress a live overlay for pixels that do not exist. The hook is kept
    // as the clip's headline layer, so the editor shows it and a later
    // re-render burns the same thing.
    const hookBurned = !!(captionsBurned && hookTitle);
    if (hookTitle) { c.titles = [hookTitle]; c.titlesBurned = hookBurned; }
    // [LANG-HINT] `lang` rides along so the renderer's "✨ Regenerate" button
    // can reuse the pipeline's OWN language detection (detectedLang above —
    // ASR-hinted, script/stopword-checked) instead of re-guessing per clip
    // from a 10-word English-stopword list (clipReviewLang() in renderer.js).
    onClip?.({ candidateId: c.candidateId, index: i+1, total: clips.length, title: c.title, hook: c.hook, score: c.score, why: c.why, category: c.category, start: c.start, end: c.end, dur: parseFloat(dur), file: deliverable, rawFile: outPath, srcVideo: inputPath, thumbnail: c.thumbnail || thumbPath, cueWords, words: c.words || [], smartTracked: !!trackPlan, trackPlan: trackPlan || null, subsBurned: captionsBurned, fxBurned, broll, brollBurned, timeline, timelineBurned, aiStickerCache: c.aiStickerCache || {}, lang: detectedLang, ...(hookTitle ? { titles: c.titles, titlesBurned: hookBurned } : {}) });
    // Persist per-clip trackPlan so Editor Apply / batch re-render can reuse
    // the same tracked framing on subsequent re-cuts from source.
    if (trackPlan) c.trackPlan = trackPlan;
    // [HISTORY-REUSE] rawFile and subsBurned ride the live onClip emit above
    // but used to stop there: report.json spreads `c`, and neither was ever
    // written onto it. Every clip reopened from the History gallery therefore
    // came back with subsBurned undefined — loadPreview treats that as "not
    // burned" and draws the JS caption overlay over a file that already has
    // captions baked in, so the captions render twice. The missing rawFile
    // cost the clean re-cut plate at the same time.
    c.rawFile = outPath;
    c.subsBurned = captionsBurned;
    c.fxBurned = fxBurned;
    completedClips++;
    log(`✓ Clip ${i+1} selesai dirender${trackPlan ? ' (smart tracked)' : ''} (${completedClips}/${clips.length})`, 'ok');
  };

  // Bounded worker pool: CLIP_CONCURRENCY workers each pull the next clip
  // index off a shared cursor until all clips are done (or one throws). When
  // smart tracking is on, each worker gets its OWN persistent TrackerWorker
  // (one sidecar process, model loaded once) reused for every clip that
  // worker slot processes — not respawned per clip.
  // [TRACKER-ENSURE] Make sure the runtime bundle is actually installed BEFORE
  // deciding smart tracking is unavailable. The per-version bundle dir changes
  // on every runtime bump (…/tracker-runtime/<manifest.version>), and the UI's
  // one-time download only fires when the user manually toggles Smart Track —
  // so an upgraded user whose toggle was already ON would silently centre-crop
  // every clip (runPipeline used to just read trackerAvailable() and skip).
  // Block on the download here, with progress, and only fall back to centre
  // crop if it genuinely can't be fetched.
  if (cfg.smartTrack && !trackerAvailable()) {
    try {
      const bundle = require('./tracker-bundle');
      prog('Export', 'menyiapkan Smart Face Tracking (unduh sekali)…', 64);
      log('▶ Menyiapkan runtime Smart Face Tracking (unduh sekali ~350MB)…', 'lime');
      let lastPct = -1;
      const installed = await bundle.ensureInstalled((p) => {
        if (p.phase === 'download' && p.percent != null) {
          const pct = Math.floor(p.percent * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            prog('Export', `unduh Smart Track: ${pct}%`, 64);
            log(`▶ Unduh Smart Track runtime: ${pct}%`, 'lime');
            lastPct = pct;
          }
        } else if (p.phase === 'extract') {
          prog('Export', 'mengekstrak Smart Track runtime…', 64);
        }
      });
      if (installed && installed.fallback) {
        log(`⚠ Runtime Smart Face Tracking terbaru gagal dipasang (${installed.fallback.error}) — memakai versi ${installed.fallback.version} yang sudah terpasang. Pemasangan dicoba lagi saat aplikasi dibuka berikutnya.`, 'yellow');
      }
      log('✓ Runtime Smart Face Tracking siap', 'ok');
    } catch (e) {
      log(`⚠ Gagal menyiapkan Smart Track (${e?.message || e}) — memakai centre crop`, 'warn');
    }
  }

  let failedClipIdx = [];   // [RENDER-SKIP-FAILED] dropped from the report below
  {
    let nextIdx = 0;
    const smartTrackOn = !!(cfg.smartTrack && trackerAvailable());
    if (cfg.smartTrack && !smartTrackOn) {
      log('⚠ Smart Face Tracking ON tapi runtime belum tersedia — semua clip memakai centre crop.', 'warn');
    }
    // Claimed synchronously (before any `await`, inside resolveTrackerWorker)
    // so exactly one worker() slot consumes the pre-warmed instance even if a
    // future change lets multiple render workers start while a pre-warm is in
    // flight. Windows DirectML intentionally uses this: one warmed worker is
    // claimed, and the other slot spawns fresh instead of sharing a sidecar.
    const prewarmClaim = { claimed: false };
    // [RENDER-STOP] Promise.all rejected on the first failed clip but never
    // stopped the OTHER worker, which kept pulling new clips — a real run
    // rendered and exported clip 4 seconds after reporting failure, while
    // main.js had already let a new job start. Every worker now returns
    // through its own loop, so the run only ends once all of them have.
    // [RENDER-SKIP-FAILED] One bad clip used to abort the whole run: a user
    // asked for 10 clips and got 5 — the ones finished before clip 6 threw.
    // A failed clip is now logged and skipped; the others still render. The
    // run fails only when cancelled or when NO clip came out at all.
    let renderFailure = null;
    const failedClips = [];
    const worker = async () => {
      let tw = null;
      try {
        while (true) {
          if (cancelled) return;
          const i = nextIdx++;
          if (i >= clips.length) return;
          try {
            if (!tw && smartTrackOn) tw = await resolveTrackerWorker(prewarmedTracker, prewarmClaim, () => new TrackerWorker());
            await renderOneClip(i, tw);
          } catch (e) {
            if (cancelled) return;
            if (!renderFailure) renderFailure = e;
            failedClips.push(i);
            renderedFiles[i] = undefined;
            const msg = String(e?.message || e).slice(0, 200);
            log(`⚠ Clip ${i+1} gagal dirender (${msg}) — dilewati, klip lain tetap dibuat.`, 'yellow');
            try { onClipState?.({ candidateId: clips[i]?.candidateId, index: i + 1, state: 'failed', detail: msg }); } catch {}
            // A tracker sidecar that was mid-job may be wedged — start clean.
            if (tw) { try { tw.kill(); } catch {} tw = null; }
          }
        }
      } catch (e) {
        if (!renderFailure) renderFailure = e;
      } finally {
        if (tw) tw.kill();
      }
    };
    await Promise.all(Array.from({ length: CLIP_CONCURRENCY }, worker));
    if (cancelled && !renderFailure) renderFailure = new Error('cancelled');
    if (renderFailure && (cancelled || failedClips.length >= clips.length)) {
      // The clips that did finish are already in the export folder — say so,
      // or a failed/cancelled run reads as "nothing came out".
      const s = clipExporter.summary();
      if (s.copied) log(`▶ ${s.copied} klip yang sudah selesai sudah disalin ke folder hasil: ${s.dir}`, 'lime');
      throw renderFailure;
    }
    if (failedClips.length) {
      const nums = failedClips.slice().sort((x, y) => x - y).map((x) => x + 1);
      log(`⚠ RINGKASAN: ${clips.length - failedClips.length} dari ${clips.length} klip berhasil — klip ${nums.join(', ')} gagal dirender (error pertama: ${String(renderFailure?.message || renderFailure).slice(0, 200)}).`, 'yellow');
      failedClipIdx = failedClips;
    }
  }

  // [BURN-WARN-LATCH] One accurate account of every clip that came out without
  // burned captions. The inline warnings above stop after the first few to
  // protect the renderer's 300-line buffer, so without this a run where most
  // clips were skipped would still LOOK like it only affected the first three.
  if (burnSkippedClips.length) {
    // Clips render CONCURRENTLY (CLIP_CONCURRENCY workers over Promise.all), so
    // completion order is not clip order — without the sort a run could report
    // "klip 3, 1, 5" and read like a different, randomised bug.
    burnSkippedClips.sort((a, b) => a - b);
    const list = burnSkippedClips.join(', ');
    log(`⚠ RINGKASAN: ${burnSkippedClips.length} dari ${clips.length} klip TANPA subtitle terbakar (klip ${list}) — rentang waktunya tidak punya teks di transkrip.`, 'yellow');
    if (burnSkippedClips.length === clips.length) {
      log('⚠ SEMUA klip tanpa caption — transkripnya kemungkinan besar gagal, bukan klipnya yang hening. Cek baris ASR di atas.', 'yellow');
    }
  }

  // [RENDER-SKIP-FAILED] The report and History only list clips that have a
  // file. Done after the burn summary so its "N dari M" counts every clip.
  if (failedClipIdx.length) {
    const kept = renderedFiles.filter((_, i) => !failedClipIdx.includes(i));
    clips = clips.filter((_, i) => !failedClipIdx.includes(i));
    renderedFiles.length = 0;
    renderedFiles.push(...kept);
  }

  // ── Report ──
  // [STAGE-TIMING] Closed before the report is built so `timings` covers every
  // stage above; the export copy below is deliberately outside the measurement.
  const timings = stages.finish();
  // [CFG-REDACT] readCfg() hydrates real API keys (from safeStorage) into cfg
  // before handing it to runPipeline. Never persist those into report.json —
  // that file sits in a user-browsable output folder and gets zipped into
  // bug reports. writeCfg() already refuses to persist keys to config.json;
  // mirror that guarantee here.
  const REPORT_SECRET_FIELDS = ['geminiKey', 'groqKey', 'openrouterKey', 'openaiKey', 'sumopodKey', 'apiKey'];
  const safeCfg = { ...cfg };
  for (const k of REPORT_SECRET_FIELDS) delete safeCfg[k];
  const report = {
    app: 'SOCL Visuals Studio',
    jobId: path.basename(sessionDir),
    sessionDir,
    source, isUrl,
    inputPath,
    ytInfo: ytInfo ? { id: ytInfo.id, title: ytInfo.title, uploader: ytInfo.uploader, webpage_url: ytInfo.webpage_url } : null,
    duration,
    video: { width: vstream.width, height: vstream.height, codec: vstream.codec_name },
    cfg: safeCfg,
    detectedLang,
    topicSummary,
    // [HISTORY-REUSE] Persist srcVideo (=inputPath), thumbnail, cueWords,
    // words, and trackPlan on every clip so re-edit / crop studio from the
    // History gallery has the exact same fields as a fresh runPipeline emit.
    // Without srcVideo, resolveEditInput falls back to `legacy` mode and every
    // subsequent crop/edit re-crops the already-cropped clip file.
    clips: clips.map((c, i) => ({
      ...c,
      file: renderedFiles[i],
      srcVideo: inputPath,
      thumbnail: c.thumbnail || thumbPath,
    })),
    thumbnail: thumbPath,
    createdAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    timings,
  };
  fs.writeFileSync(SF.dataPath(sessionDir, 'report.json'), JSON.stringify(report, null, 2));

  // ── Default Export Path ──
  // [EXPORT-PER-CLIP] Already copied clip by clip inside renderOneClip.
  const exported = clipExporter.summary();
  if (exported.copied) log(`▶ ${exported.copied} file disalin ke folder hasil: ${exported.dir}`, 'lime');
  if (exported.dir) {
    report.exportedTo = exported.dir;
    // Persist the updated report — the copy happens AFTER the first write, so
    // without this exportedTo never reached report.json (History showed the
    // session as un-exported even when the files were there).
    try { fs.writeFileSync(SF.dataPath(sessionDir, 'report.json'), JSON.stringify(report, null, 2)); } catch {}
  }

  prog('Done', `${clips.length} clips ready`, 100);
  return report;
}

// [APPLY-PERF] Reported live (screenshot): Apply on a 3-panel split-screen
// smart-tracked 60s clip "terasa lama sekali dan berat banget" for a
// caption-STYLE-only change (font size/glow/words-per-chunk — no crop or
// tracking touched). Root cause: resolveEditInput() always prefers
// re-cutting from the FULL ORIGINAL SOURCE VIDEO over reusing clip.rawFile
// (the clean plate the initial pipeline run ALREADY produced with this exact
// trackPlan) — so renderClipEdit's smart-track branch fully re-runs the
// entire segment-render + concat + mux pipeline (N serial per-segment ffmpeg
// encodes) from scratch on EVERY Apply, even when nothing crop/tracking-
// related changed.
//
// Deliberately NOT fixed by parallelizing the segment loop or by a renderer-
// side "did anything change?" flag: this codebase has repeatedly measured
// that blind concurrency changes on ffmpeg encode work risk OOM on low-spec
// hardware (see clipConcurrencyFor's own RAM-budget comments), and a flag
// that's wrong in some edge case would silently resurrect the exact "crop
// falls back to centre" regression class resolveEditInput's own docstring
// warns about. Caching the tracked intermediate on disk, keyed by a
// deterministic hash of EXACTLY the inputs that determine its content, has
// neither risk: a matching key is PROVABLY what the segment pipeline would
// produce again (no heuristic to get wrong), and any change to source
// identity/timing/format/resolution/trackPlan changes the key, which
// naturally falls back to a full recompute — today's exact, already-correct
// behavior.
function trackedIntermediateCacheKey({ srcPath, srcSize, srcMtimeMs, clipStart, clipEnd, format, resolution, trackPlan }) {
  const payload = JSON.stringify({
    srcPath: String(srcPath || ''),
    srcSize: Number(srcSize) || 0,
    srcMtimeMs: Math.round(Number(srcMtimeMs) || 0),
    clipStart: Number(clipStart || 0).toFixed(3),
    clipEnd: Number(clipEnd || 0).toFixed(3),
    format: String(format || 'face'),
    resolution: String(resolution || '1080p'),
    trackPlan: trackPlan || null,
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 20);
}

// Re-render a single existing clip with a new caption style — writes a NEW
// file alongside the raw one so the user can iterate without losing the
// original. Returns the new absolute path.
// Re-renders one clip with new caption styling.
// When srcVideo + clipStart/clipEnd are provided, re-cuts from the original
// source so subtitles never stack on a previously-burned file.
// [NO-AUDIO-SOURCE] Smart Track renders video-only segments and muxes the
// clip's continuous audio back in. A source with no audio track has nothing to
// mux, so the video is copied through on its own.
function muxTrackedArgs(videoPath, audioPath, outPath) {
  return audioPath
    ? ['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', outPath]
    : ['-y', '-i', videoPath, '-c:v', 'copy', '-movflags', '+faststart', outPath];
}
// Probe failure keeps the old behaviour (assume audio) — never a new way to fail.
async function inputHasAudio(file) {
  try {
    const { stdout } = await spawnLines(FFPROBE,
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { onLine: () => {}, timeoutMs: SOURCE_PROBE_TIMEOUT_MS });
    return String(stdout || '').trim().length > 0;
  } catch { return true; }
}

async function renderClipEdit({ srcFile, srcVideo, clipStart, clipEnd, clipFormat, clipResolution, cropX, cropY, cropScale, cropKeyframes, cropAspect, cropRect, cueWords, style, binPaths, preview, titles /* [TITLE-V1] */, manualCaptions /* [MANUAL-CAPTION] */, trackPlan, watermark /* [WM-V1] */, cfg /* [EMOJI-STICKER] AI-provider config; renderClipEdit runs outside runPipeline's closure, so the caller (main.js) must pass its own readCfg() for the sticker AI fallback to have anything to read */, broll /* [COLLAGE-BROLL] the clip's picked moment, re-laid on every edit render */, timeline /* [CLIP-TIMELINE] hook teaser + pause trim, re-applied last */, aiStickerCache /* [AI-STICKER-CACHE] this clip's persisted { cueText: emoji } resolution cache — per-clip data like trackPlan, not a style setting */, onLog /* [FFMPEG-FILTERS] the Caption Editor has no pipeline run behind it, so main.js hands over its own sender — without this the ffmpeg check has nowhere to speak */ , onProgress /* [RENDER-PROGRESS] (fraction 0..1, stage) — the gallery/editor had no live percent at all */ }) {
  // [CANCEL-LEAK] `cancelled` is a module-level flag set by cancelPipeline()
  // (the batch-render Cancel button) and only cleared at the start of the
  // main runPipeline. Without a reset here, cancelling ANY prior render
  // leaves spawnLines() rejecting every future Caption Editor Preview/Apply
  // with "cancelled" for the rest of the session, even on a brand-new clip
  // that was never cancelled.
  cancelled = false;
  // [RENDER-PROGRESS] ffmpeg's own `time=` against the clip length, mapped onto
  // the render's stages (smart-track segments, caption burn, B-roll/timeline).
  // A Render all / editor Apply used to show nothing until the clip finished.
  const progLen = Math.max(1, Number(clipEnd) - Number(clipStart)) || 1;
  let progLast = 0;
  const reportProgress = (f, stage) => {
    if (typeof onProgress !== 'function') return;
    const v = Math.max(progLast, Math.max(0, Math.min(1, f)));   // never runs backwards
    progLast = v;
    try { onProgress(v, stage); } catch {}
  };
  const timeProgress = (from, to, stage, offsetSec = 0, lenSec = progLen) => (line) => {
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
    if (!m) return;
    const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    reportProgress(from + (to - from) * Math.min(1, (offsetSec + t) / lenSec), stage);
  };
  reportProgress(0, 'start');
  if (binPaths?.ffmpeg) FFMPEG = binPaths.ffmpeg;
  if (binPaths?.ffprobe) FFPROBE = binPaths.ffprobe;
  // Fail-fast guards: an unreachable ffmpeg or one without libass would
  // otherwise hang the renderer ("Rendering…" forever) on Windows because the
  // child process never reaches a stable state. Surface a clear error instead.
  if (!FFMPEG || (FFMPEG !== 'ffmpeg' && !fs.existsSync(FFMPEG))) {
    throw new Error(`ffmpeg binary not found at: ${FFMPEG || '(unset)'}`);
  }
  // [FFMPEG-FILTERS] This used to spawn its OWN `ffmpeg -filters` on every
  // Preview and every Apply, and look at one filter name. It now shares the
  // memoised check (one spawn per binary for the whole session) and looks at
  // all of them — Caption Editor Apply is its own entry point, never goes
  // through runPipeline, and is exactly where the missing-drawtext bug
  // surfaced. `subtitles` stays a hard stop: without libass there is no
  // caption to burn at all, and the renderer would otherwise sit on
  // "Rendering…" forever while the child never reaches a stable state.
  //
  // A probe that will not RUN no longer throws here, though. The old inline
  // version had a 7s budget and turned any failure into `Tidak bisa
  // menjalankan ffmpeg untuk verifikasi` — which on Windows fires on a cold
  // Defender scan of the ~82MB unsigned ffmpeg.exe, i.e. a false failure on
  // the user's very first Apply. bootstrap.js documents that exact
  // cold-start cost for its own -filters probe and budgets 30s for it; this
  // one now shares that budget and warns instead of failing, so a slow scan
  // costs a ⚠ line and the render continues to ffmpeg's own (much better)
  // error if the binary really is broken — spawnFailureHint names the
  // antivirus case by hand.
  const missingFx = checkFfmpegFilters(FFMPEG, onLog);
  if (missingFx.includes('subtitles')) {
    throw new Error('ffmpeg ditemukan tetapi TIDAK mendukung filter `subtitles` (libass). Caption tidak bisa di-burn.');
  }
  if (!srcFile || !fs.existsSync(srcFile)) throw new Error(`Source clip not found: ${srcFile}`);
  const dir = path.dirname(srcFile);
  const ext = path.extname(srcFile);
  const base = path.basename(srcFile, ext);
  // [BATCH-CONCURRENCY] Render-intermediate filenames below used to be keyed
  // ONLY by process.pid — safe while the app enforced "one renderClipEdit
  // call in flight at a time" (Caption Editor Apply is single-clip; the old
  // gallery batch-render loop was serial), unsafe now that a batch can run
  // several clips concurrently in the SAME Electron main process (one pid
  // for the whole app) — clips from the same session share the same
  // raw/edited directory, so two concurrent calls would silently clobber
  // each other's `_subs-<pid>.ass` / `_tracked-<pid>.mp4` / etc. mid-render.
  // A fresh random token per CALL (not per process) makes every one of
  // those paths collision-proof regardless of how many calls run at once.
  const callId = crypto.randomBytes(6).toString('hex');

  // ── Preview mode (accurate "Preview Export" proxy) ──
  // Renders the ACTUAL burned result — same crop + per-word captions + format —
  // but at a low resolution with a fast preset, into the OS temp dir, so the
  // user can play back the real output before committing to a full render.
  // Old proxies are swept so temp doesn't accumulate.
  let outName, outPath, encArgs;
  const effRes = preview ? '480p' : (clipResolution || '1080p');
  if (preview) {
    const tdir = path.join(os.tmpdir(), 'socl-visuals-preview');
    fs.mkdirSync(tdir, { recursive: true });
    try {
      for (const f of fs.readdirSync(tdir)) {
        if (Date.now() - fs.statSync(path.join(tdir, f)).mtimeMs > 30 * 60 * 1000)
          fs.unlinkSync(path.join(tdir, f));
      }
    } catch {}
    outName = `preview-${Date.now()}.mp4`;
    outPath = path.join(tdir, outName);
    encArgs = [...videoEncodeArgs('preview', '480p'),
               '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  } else {
    // [RAW-EDITED-SPLIT] Applied edits go to a sibling edited/ folder, not
    // next to the raw clip — keeps the session folder from mixing raw cuts
    // with their edited versions (and re-editing an already-edited file
    // still lands back in the SAME edited/, not a nested edited/edited/).
    const editedDir = path.join(sessionRootFor(dir), 'edited');
    fs.mkdirSync(editedDir, { recursive: true });
    // Versioned output name so raw clip is never overwritten
    let n = 1;
    do { outName = `${base}-edit-${n}${ext}`; n++; } while (fs.existsSync(path.join(editedDir, outName)) && n < 100);
    outPath = path.join(editedDir, outName);
    encArgs = [...videoEncodeArgs('final', clipResolution || '1080p'),
               '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  }
  // 480p maps to '720p' tier downscaled; reuse a real tier the resolver knows.
  const resForVf = preview ? '720p' : effRes;

  // [INVERSE-V1 + TITLE-V1] start — DUAL-PASS caption compositing.
  // Bug fixed: previously a SINGLE `isInverseAuto` flag routed the WHOLE ASS
  // (subtitles + titles) through the blend=difference chain. So the moment ANY
  // element used inverse_auto, every solid/neon/mix caption also got XOR'd and
  // its colour broke. The fix: partition captions into two independent buckets,
  // each with its own ASS sidecar and its own compositing path:
  //   • INVERSE bucket → black-canvas mask + blend=difference (auto-inverting)
  //   • NORMAL  bucket → straight `subtitles` overlay (keeps its real colours)
  // A solid subtitle now keeps its colour even alongside an inverse_auto title,
  // and vice-versa. Filenames are per-process so concurrent renders don't clash.
  const titlesArr0   = Array.isArray(titles) ? titles : [];
  // [VIDEO-FX] Clip setting → Efek video: a text-less entry that only carries
  // the effect (it replaces any preset's own). buildAss skips empty titles.
  const cfgFx = cfg && cfg.videoFx && VFX.get(cfg.videoFx) ? cfg.videoFx : '';
  const titlesArr    = cfgFx
    ? titlesArr0.map((t) => (t && t.videoFx ? Object.assign({}, t, { videoFx: undefined }) : t))
      .concat([{ id: '__vfx', text: '', videoFx: cfgFx, start: 0, end: Math.min(VFX.WINDOW_SEC, Math.max(0.5, clipEnd - clipStart)) }])
    : titlesArr0;
  let cutoutDone = false;   // [CUTOUT-FX] set once the editor render composited the cut-out
  const subIsInverse = (style?.subtitleStyle === 'inverse_auto');
  const invTitles    = titlesArr.filter(t => t?.style === 'inverse_auto');
  const normTitles   = titlesArr.filter(t => t?.style !== 'inverse_auto');
  const cueList      = applyCueCase(cueWords, style?.subtitleCase);
  // [MANUAL-CAPTION] Inline manual captions splice into the same cue list an
  // ASR transcript would produce, BEFORE the normal/inverse bucket split below
  // reads cueList's length — so a manual-only clip (no ASR cues at all) still
  // flips normalHasContent/inverseHasContent to true for whichever bucket the
  // active caption style belongs to. There is no independent per-entry style
  // here (unlike titles' normTitles/invTitles): the whole mergedCueList goes
  // to one bucket, mirroring cueList's own all-or-nothing subIsInverse split.
  const { mergeInlineManualCaptions, layerManualCaptions } = require('./manual-caption');
  const shiftedCueList = shiftCues(cueList, style?.subtitleOffsetMs, clipEnd - clipStart);
  // [HOOK-OVER-CAPTIONS] trimmed here too: the inverse bucket's buildAss call
  // never sees the (normal-style) hook title.
  const mergedCueList = trimCuesUnderHook(mergeInlineManualCaptions(shiftedCueList, manualCaptions || []), titles);
  const fsz = style?.subtitleFontSize || 64;
  const yP  = style?.subtitleY || 540;
  const xP  = style?.subtitleX;
  const anm = style?.subtitleAnim || 'pop';
  const glw = style?.subtitleGlow !== false;
  // [EMOJI-STICKER] Same helper the pipeline's own burn calls, from the same
  // case-transformed cues, so Preview / Apply / Render all and the delivered
  // clip cannot disagree about which words got a sticker.
  //
  // resolution MUST be resForVf, not effRes: '480p' isn't a real RES_MAP tier
  // (see the comment on resForVf above — "480p maps to '720p' tier
  // downscaled"), so passing effRes made outputWidthPx/outputHeightPx fall
  // through to the 1080p numbers while the ACTUAL preview frame vfFor built
  // was 720p. Every sticker (row AND inline) was computed for a canvas 1.5x
  // larger than the one ffmpeg actually encoded, landing well off the
  // caption during Preview specifically — Apply/batch render never hit this,
  // since effRes and resForVf are identical outside preview mode. Caught by
  // running the real Caption Editor end to end, not by calling renderClipEdit
  // directly with preview left at its default (false).
  // [MANUAL-CAPTION] Deliberately the pre-merge `cueList`, not `mergedCueList`:
  // emoji-sticker resolution is scoped to ASR/AI cues only for now, so a
  // manual caption's text is never sent to the sticker AI. Revisit if manual
  // captions are ever meant to carry stickers too.
  const editStickers = await stickerJobs({
    enabled: !!style?.emojiStickers, cues: cueList,
    fontSize: fsz, captionY: yP, subtitleX: xP, format: clipFormat, resolution: resForVf,
    cfg,
    // [AI-STICKER-CACHE] The clip's persisted resolution cache — PER-CLIP
    // data like trackPlan/titles, not a style/cfg setting, so it rides its
    // own top-level payload field rather than `style`. Threaded down from the
    // renderer via the render-edit/render-preview payload: Preview clicked
    // repeatedly, then Apply, then a batch re-render all pass the SAME
    // clip's cache forward — the first render to hit an uncovered cue pays
    // the AI call, everything after reuses its answer.
    aiCache: aiStickerCache,
    // renderClipEdit has never streamed logs to the UI (see [IPC-ERROR-
    // ENVELOPE] — onLog/onProgress are only wired for run-pipeline), so the
    // AI fallback's log lines land in the main-process console instead of
    // being silently swallowed by a missing callback.
    onLog: (line) => console.log('[renderClipEdit/sticker-ai]', line),
  });
  // What each bucket actually contains (subtitle cues go to whichever bucket the
  // subtitle style belongs to; titles are split by their own per-title style).
  const normalHasContent  = (!subIsInverse && mergedCueList.length > 0) || normTitles.length > 0;
  const inverseHasContent = ( subIsInverse && mergedCueList.length > 0) || invTitles.length > 0;

  const assNormalName = `_subs-${process.pid}-${callId}.ass`;
  const assInvName    = `_subsinv-${process.pid}-${callId}.ass`;
  const assNormalPath = path.join(dir, assNormalName);
  const assInvPath    = path.join(dir, assInvName);
  const writtenAss = [];
  // [SMART-TRACK] Segment + concat intermediates (_seg-*, _seglist-*,
  // _tracked-*) written below when a trackPlan is present — collected here
  // so the `finally` block can always remove them, mirroring writtenAss.
  // These never had a cleanup step before, so every Preview/Apply on a
  // smart-tracked clip left its segments behind permanently, cluttering the
  // session folder and making it hard to tell RAW/EDITED output apart from
  // internal render intermediates.
  const smartTrackTemp = [];
  const box2 = style?.subtitleBoxColor
    ? { boxColor: style.subtitleBoxColor, rotation: style.subtitleBoxRotation, fontsDir: assFontsDirFs() }
    : null;
  // [MANUAL-CAPTION] Layer-mode manual captions have no independent per-entry
  // style (unlike titles), so they mirror cueList's own subIsInverse split
  // rather than being filtered per-entry like normTitles/invTitles are.
  const layerMC = layerManualCaptions(manualCaptions || []);
  if (normalHasContent) {
    fs.writeFileSync(assNormalPath, buildAss(
      subIsInverse ? [] : mergedCueList, fsz, style?.subtitleStyle || 'neon_green',
      yP, xP, anm, glw, normTitles, clipFormat || 'face', style?.subtitleFont || '', box2,
      subIsInverse ? [] : layerMC, kinCapParam(cfg)));   // [AR-BURN] format-aware PlayRes
    writtenAss.push(assNormalPath);
  }
  if (inverseHasContent) {
    // Inverse bucket always renders with the inverse_auto style key so cues in
    // it use the auto-invert font/spacing; titles carry their own inverse style.
    fs.writeFileSync(assInvPath, buildAss(
      subIsInverse ? mergedCueList : [], fsz, 'inverse_auto',
      yP, xP, anm, glw, invTitles, clipFormat || 'face', style?.subtitleFont || '', box2,
      subIsInverse ? layerMC : [],
      // [SUBTRACT-SPLIT] a Caption animasi template keeps its own lines when
      // Subtract is on (this bucket dropped it and burned plain cues).
      subIsInverse ? (kinCapParam(cfg)) : ''));   // [AR-BURN] format-aware PlayRes
    writtenAss.push(assInvPath);
  }
  const fdir = assFontsDir();
  // Build the caption filter chain on top of an optional base (format/crop) vf.
  //   • inverse pass: format=gbrp (RGB so difference doesn't green-shift) →
  //     split → black canvas + inverse ASS → blend=difference → back to yuv420p
  //   • normal pass: a plain `subtitles` overlay appended AFTER the inverse pass
  //     so solid captions sit on top of the (already-inverted) video untouched.
  // [WM-V1] captionSuffixOnly() returns just the caption chain (subtitles /
  // inverse-blend, WITHOUT any base crop prefix) so a watermark layer can be
  // inserted between the base and the captions. Legacy buildCaptionVf keeps
  // the "base + suffix" composition, unchanged, for the non-watermark path.
  function captionSuffixOnly() {
    const invChain =
        `format=gbrp,split=2[__vBg][__vSub];`
      + `[__vSub]drawbox=x=0:y=0:w=iw:h=ih:c=black@1.0:t=fill,`
      + `subtitles=filename='${assInvName}':fontsdir='${fdir}',format=gbrp[__mask];`
      + `[__vBg][__mask]blend=all_mode=difference,format=yuv420p`;
    const normSub = `subtitles=filename='${assNormalName}':fontsdir='${fdir}'`;
    // [TITLE-VIDEO-FX] under the captions. A cut-out already composited in
    // (cutoutDone) carries its own effect and flash.
    const fxVf = withVideoFx(dimVf(cfg), titleVideoFxVf(cutoutDone ? titlesArr.filter((t) => !(t && VFX.isCutout(t.videoFx))) : titlesArr)) || '';   // [CAP-DIM]
    if (inverseHasContent && normalHasContent) return withVideoFx(fxVf, `${invChain},${normSub}`);
    if (inverseHasContent)                     return withVideoFx(fxVf, invChain);
    if (normalHasContent)                      return withVideoFx(fxVf, normSub);
    return fxVf || null;
  }
  function buildCaptionVf(baseVf) {
    const suffix = captionSuffixOnly();
    if (!suffix) return baseVf || 'null';
    return baseVf ? `${baseVf},${suffix}` : suffix;
  }
  // [INVERSE-V1 + TITLE-V1] end

  // Prefer re-cutting from the original source video (no subtitle stacking).
  // Fall back to srcFile only when source info is missing.
  // IMPORTANT: pass the ABSOLUTE source path to `-i`. The ASS subtitles filter
  // is resolved relative to cwd (so we keep `cwd: dir` + a relative .ass name),
  // but the input video may live ANYWHERE — e.g. a locally-imported file in
  // ~/Downloads while the clip + .ass live in the session dir. Using
  // basename(srcVideo) here was the cause of "source.mp4: No such file or
  // directory" for local imports / moved sessions.
  const { mode: editInputMode, input: editInput } = resolveEditInput({ srcVideo, clipStart, clipEnd, srcFile });
  const canRecutFromSource = editInputMode === 'recut';
  let args;
  try {
    if (canRecutFromSource) {
      const dur = Math.max(1, clipEnd - clipStart).toFixed(2);
      // Single-quote filter values so stray characters in the path (spaces,
      // commas) are treated as data, not filter-graph syntax. Quotes do NOT
      // protect colons across ffmpeg's two parse levels — assFontsDir()
      // double-escapes the Windows drive-letter colon (C\\:/…/fonts) itself.
      // [SMART-TRACK] When a trackPlan is present, pre-render the moving/ split-screen
      // crop as a concat intermediate, then burn captions on top of it with NO extra
      // base crop (the crop is already baked). trackPlan absent → unchanged behavior.
      let captionSourceInput = editInput;
      let captionSs = parseFloat(clipStart).toFixed(2);
      let captionBaseVf = vfFor(clipFormat || 'face', resForVf, cropX, cropY, cropKeyframes, cropScale, cropAspect, cropRect);
      if (trackPlan && Array.isArray(trackPlan.keyframes) && trackPlan.keyframes.length) {
        // [APPLY-PERF] Cache lookup — see trackedIntermediateCacheKey's own
        // comment. A hit means the segment/concat/mux pipeline below is
        // SKIPPED ENTIRELY: this is the fast path for the common case of a
        // caption/title/watermark-only re-Apply on a smart-tracked clip.
        const trackResolution = preview ? resForVf : (clipResolution || '1080p');
        let cacheKey = null, cachePath = null;
        try {
          const srcStat = fs.statSync(editInput);
          cacheKey = trackedIntermediateCacheKey({
            srcPath: editInput, srcSize: srcStat.size, srcMtimeMs: srcStat.mtimeMs,
            clipStart, clipEnd, format: clipFormat || 'face', resolution: trackResolution,
            trackPlan,
          });
          cachePath = path.join(dir, `_trackcache-${base}-${cacheKey}.mp4`);
        } catch { /* stat failure just disables caching for this render */ }

        if (cachePath && fs.existsSync(cachePath)) {
          captionSourceInput = cachePath;
          captionSs = '0.00';
          captionBaseVf = '';   // crop already baked; do not crop again
        } else {
        const { buildSegmentJobs } = require('./track-plan');
        // [SEG-DRIFT] One cheap probe so the boundaries can be snapped to this
        // input's frame grid; without it every segment rounds up to a whole
        // frame and the clip stretches away from the caption timeline.
        let segFps = null;
        try {
          const { stdout } = await spawnLines(FFPROBE,
            ['-v','error','-select_streams','v:0','-show_entries','stream=avg_frame_rate,r_frame_rate',
             '-print_format','json', editInput], { onLine: () => {} });
          segFps = fpsFromStream(JSON.parse(stdout).streams?.[0]);
        } catch {}
        // [EMOJI-STICKER] Must match the resolution editStickers was computed
        // at (resForVf) — in preview mode that's the 720p-tier proxy, not
        // clipResolution's full 1080p. Passing the wrong tier here means the
        // segments/concat are built full-res while stickers are placed for a
        // canvas 1.5x smaller, same class of bug the comment above documents.
        const jobs = snapSegmentJobs(buildSegmentJobs(trackPlan, {
          clipDur: Math.max(1, clipEnd - clipStart),
          resolution: preview ? resForVf : (clipResolution || '1080p'),
          format: clipFormat || 'face',
        }), segFps);
        const segFiles = [];
        const clipDur = Math.max(1, clipEnd - clipStart);

        // [CONTINUOUS-AUDIO] Step 1: Extract full audio
        const clipAudioPath = path.join(dir, `_clipaudio-${process.pid}-${callId}.m4a`);
        smartTrackTemp.push(clipAudioPath);
        // [NO-AUDIO-SOURCE] Same trap as the pipeline's Smart Track path.
        const editHasAudio = await inputHasAudio(editInput);
        if (editHasAudio) {
          const audioExtractArgs = ['-y', ...decodeArgs(),
            '-ss', String(parseFloat(clipStart).toFixed(3)),
            '-i', editInput,
            '-t', String(clipDur.toFixed(3)),
            '-vn'];
          // Note: For edited clips, editInput is the already-demuxed or original file.
          // We let ffmpeg pick the default audio stream since we don't have audioStreamIndex here,
          // which matches the previous behavior (which didn't map either).
          audioExtractArgs.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', clipAudioPath);
          await spawnLines(FFMPEG, audioExtractArgs,
            { cwd: dir, onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg/audio]', l); } });
        }
        reportProgress(0.05, 'track');   // [RENDER-PROGRESS]

        // Extract video-only encode args from encArgs
        const vEncArgs = encArgs.slice(0, encArgs.indexOf('-c:a'));
        vEncArgs.push('-movflags', '+faststart');

        // [CONTINUOUS-AUDIO] Step 2: Render video-only segments
        for (let i = 0; i < jobs.length; i++) {
          const j = jobs[i];
          const segOut = path.join(dir, `_seg-${process.pid}-${callId}-${i}.mp4`);
          const segArgs = ['-y', ...decodeArgs(),
            '-ss', String((clipStart + j.ss).toFixed(3)),
            '-i', editInput,
            '-t', String((j.to - j.ss).toFixed(3)),
            '-an'];
          segArgs.push(...segmentFilterArgs(j));
          segArgs.push(...vEncArgs, segOut);
          const segProg = timeProgress(0.05, 0.5, 'track', j.ss, clipDur);
          await spawnFfmpegWithDecodeFallback(segArgs, { cwd: dir, onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg/seg]', l); segProg(l); } });
          segFiles.push(segOut);
          smartTrackTemp.push(segOut);
        }

        // [CONTINUOUS-AUDIO] Step 3: Concat video-only segments
        const listPath = path.join(dir, `_seglist-${process.pid}-${callId}.txt`);
        fs.writeFileSync(listPath, segFiles.map(f => `file '${path.basename(f)}'`).join('\n'));
        smartTrackTemp.push(listPath);
        const trackedVideoPath = path.join(dir, `_tracked_v-${process.pid}-${callId}.mp4`);
        smartTrackTemp.push(trackedVideoPath);
        await spawnLines(FFMPEG,
          ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'copy', '-an', '-movflags', '+faststart', trackedVideoPath],
          { cwd: dir, onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg/concat_v]', l); } });

        // [CONTINUOUS-AUDIO] Step 4: Mux audio + video
        const trackedPath = path.join(dir, `_tracked-${process.pid}-${callId}.mp4`);
        smartTrackTemp.push(trackedPath);
        await spawnLines(FFMPEG, muxTrackedArgs(trackedVideoPath, editHasAudio ? clipAudioPath : null, trackedPath),
          { cwd: dir, onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg/mux]', l); } });

        // [APPLY-PERF] Persist a copy under the cache key for the NEXT Apply/
        // Preview to reuse — trackedPath itself still goes through smartTrackTemp
        // cleanup below like today, this is a separate, deliberately-kept file.
        // Prune any OTHER cached state for this same clip first (a stale entry
        // from a since-changed trackPlan/format/resolution must not linger
        // forever — the exact disk-clutter class already fixed once for
        // smartTrackTemp itself, see the comment above its declaration).
        if (cachePath) {
          try {
            const prefix = `_trackcache-${base}-`;
            for (const f of fs.readdirSync(dir)) {
              if (f.startsWith(prefix) && f !== path.basename(cachePath)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch {}
              }
            }
            fs.copyFileSync(trackedPath, cachePath);
          } catch { /* caching is an optimization, never fatal to the render */ }
        }

        reportProgress(0.5, 'track');
        // Burn captions over the already-cropped, full-length intermediate.
        captionSourceInput = trackedPath;
        captionSs = '0.00';
        captionBaseVf = '';   // crop already baked; do not crop again
        }
      }
      // [CUTOUT-FX] A title asking for the person cut-out needs UNBURNED,
      // already-cropped frames to segment. Render them once (fast x264, the
      // same crop), composite the cut-out in, then burn captions on top of
      // that file exactly like the pipeline does. Any failure keeps the
      // original input and the burn falls back to the full-frame duotone.
      const cutTitle = titlesArr.find((t) => t && VFX.isCutout(t.videoFx));
      if (cutTitle) {
        const plainPath = path.join(dir, `_cutsrc-${process.pid}-${callId}.mp4`);
        try {
          await spawnFfmpegWithDecodeFallback(['-y', ...decodeArgs(), '-ss', captionSs, '-i', captionSourceInput, '-t', dur,
            ...(captionBaseVf ? ['-vf', captionBaseVf] : []),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', plainPath],
          { cwd: dir, onLine: () => {} });
          const cut = await applyCutoutFx(plainPath, cutTitle, { cwd: dir, log: (m) => { console.log('[renderClipEdit]', m); onLog && onLog(m); },
            encArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14'] });
          if (cut) {
            cutoutDone = true;
            captionSourceInput = cut; captionSs = '0.00'; captionBaseVf = '';
            writtenAss.push(cut);
          }
        } catch (err) {
          console.warn('[renderClipEdit] cutout pre-pass failed, using full duotone:', err && err.message);
        } finally {
          try { fs.unlinkSync(plainPath); } catch {}
        }
      }
      // [WM-V1] Layered chain: crop base → watermark → captions. When the
      // watermark is inactive, filterArgs reduces to ['-vf', flatVf] and the
      // resulting command is bit-identical to the pre-watermark path.
      // [WM-CANVAS] captionSourceInput is only worth probing when there is no
      // base filter to change the frame — see watermarkCanvas.
      const outW = outputWidthPx(clipFormat || 'face', resForVf);
      const outH = outputHeightPx(clipFormat || 'face', resForVf);
      const canvas = watermarkCanvas({
        baseVf: captionBaseVf,
        probed: captionBaseVf ? null : await getStreamDims(captionSourceInput),
        outW, outH,
      });
      const wmChain = buildWatermarkFilter(captionBaseVf, captionSuffixOnly(),
        watermark, canvas.w, { sessionDir: dir, outputH: canvas.h },
        editStickers.jobs);
      if (wmChain.writtenFiles?.length) writtenAss.push(...wmChain.writtenFiles);
      // decodeArgs() lands before the FIRST -i, so it applies to the video
      // input; the watermark's extraInputs are stills and stay CPU-decoded.
      args = ['-y', ...decodeArgs(),
        '-ss', captionSs,
        '-i',  captionSourceInput,
        ...wmChain.extraInputs,
        '-t',  dur,
        ...wmChain.filterArgs,
        ...encArgs,
        outPath,
      ];
      console.log('[renderClipEdit] FFMPEG=%s', FFMPEG);
      console.log('[renderClipEdit] cwd=%s', dir);
      console.log('[renderClipEdit] buckets: inverse=%s normal=%s', inverseHasContent, normalHasContent);
      console.log('[renderClipEdit] args=', args);
      const burnProg = timeProgress(progLast, 0.9, 'burn');
      await spawnFfmpegWithDecodeFallback(args, { cwd: dir, onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg]', l); burnProg(l); } });
    } else {
      // Legacy path: burn onto existing clip (may stack if already burned).
      // Audio is copied (no re-cut), so swap the aac encode for a stream copy.
      console.warn('[renderClipEdit] no srcVideo/clipStart/clipEnd to re-cut from — ' +
        'burning captions onto srcFile directly. If srcFile was already burned ' +
        '(e.g. from a prior "Render edit"), this WILL stack a second caption pass on top.');
      const vEnc = encArgs.slice(0, encArgs.indexOf('-c:a'));
      // [WM-V1] Legacy path also picks up the watermark chain. Audio is
      // stream-copied here (no re-cut), so we swap -map 0:a? for -c:a copy
      // downstream — the map still works because ffmpeg keeps the container's
      // original audio track when we don't specify audio codec re-encoding.
      const legacyDims = await getStreamDims(editInput);
      const wmChain = buildWatermarkFilter('', captionSuffixOnly(),
        watermark, legacyDims.w || outputWidthPx(clipFormat || 'face', resForVf),
        { sessionDir: dir, outputH: legacyDims.h || outputHeightPx(clipFormat || 'face', resForVf) },
        editStickers.jobs);
      if (wmChain.writtenFiles?.length) writtenAss.push(...wmChain.writtenFiles);
      args = ['-y',
        '-i',  editInput,
        ...wmChain.extraInputs,
        ...wmChain.filterArgs,
        ...vEnc,
        '-c:a', 'copy', '-movflags', '+faststart',
        outPath,
      ];
      console.log('[renderClipEdit/legacy] FFMPEG=%s args=', FFMPEG, args);
      const legProg = timeProgress(0, 0.9, 'burn');
      await spawnLines(FFMPEG, args, { cwd: dir, onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg]', l); legProg(l); } });
    }
  } finally {
    // Always remove the sidecar .ass files — even when ffmpeg fails — so a
    // failed render never leaves a stray .ass behind.
    for (const p of writtenAss) { try { fs.unlinkSync(p); } catch {} }
    // Same guarantee for smart-track segment/concat intermediates — these
    // are internal render plumbing, never a real output, and must not
    // survive the call (success OR failure) so the session folder only ever
    // shows the user's actual raw/edited clips.
    for (const p of smartTrackTemp) { try { fs.unlinkSync(p); } catch {} }
  }
  // Guard: a successful exit must have actually produced the video file.
  if (!fs.existsSync(outPath)) throw new Error('Render finished but no output file was created.');
  reportProgress(0.9, 'finish');
  // [COLLAGE-BROLL] An editor Apply / gallery Render re-cuts from the clean
  // plate, so the clip's B-roll must be laid over again or it would vanish.
  if (!preview && brollNorm(broll).length && cfg && cfg.collageBroll) {
    const list = brollNorm(broll).map((b) => Object.assign({}, b, b.kind === 'overlay' ? {} : { styleOverride: cfg.collageStyle && cfg.collageStyle !== 'auto' ? cfg.collageStyle : b.styleOverride }));
    applyBrollSec(list, insertSec(cfg && cfg.brollSec), Number(clipEnd) - Number(clipStart));   // [INSERT-SEC]
    const b = await applyCollageBrolls(outPath, list, { portraitSrc: srcFile, cwd: dir,
      avoid: Array.isArray(cueWords) && cueWords.length ? [captionBand(style && style.subtitleY, style && style.subtitleFontSize)] : [],
      log: (m) => { console.log('[renderClipEdit]', m); onLog && onLog(m); } });
    if (b) { try { fs.renameSync(b, outPath); } catch (e) { try { fs.unlinkSync(b); } catch {} } }
  }
  // [CLIP-TIMELINE] Same teaser / pause trim the pipeline delivered, applied
  // last so the burned captions move with the picture. Toggles honoured.
  if (!preview && timelineIsEdit(timeline)) {
    const tl = { teaser: cfg && cfg.hookTeaser === true ? timeline.teaser : null, cuts: cfg && cfg.deadAirCut === false ? [] : timeline.cuts };
    const t = await applyClipTimeline(outPath, tl, { cwd: dir, log: (m) => { console.log('[renderClipEdit]', m); onLog && onLog(m); } });
    if (t) { try { fs.renameSync(t, outPath); } catch (e) { try { fs.unlinkSync(t); } catch {} } }
  }
  const thumbnail = preview
    ? null
    : await createRenderedPoster(
      outPath,
      Math.max(1, Number(clipEnd) - Number(clipStart)),
      clipFormat || 'face',
    );
  // [AI-STICKER-CACHE] Hand the (maybe updated) resolution cache back so the
  // caller — main.js's render-edit/render-preview handlers — can persist it
  // onto the clip, same as it already does for exportedTo/exportWarning.
  reportProgress(1, 'done');
  return { file: outPath, fileName: outName, thumbnail, aiStickerCache: editStickers.aiCache };
}

// ─── AI caption typo fix (caption editor) ─────────────────
// Embedded preferred-spellings / brand dictionary. Extend in code as needed —
// these are handed to the model as terms to keep/prefer so brand names and
// domain words aren't "corrected" into something wrong.
const TYPO_DICT = ['minyak tawon', 'sponsor', 'koreografi', 'magic oil', 'introduce'];
// Tolerantly parse a JSON object/array out of a model response string.
// NOTE: named parseJsonLooseTypoFix (not parseJsonLoose) — a same-named
// `function parseJsonLoose` already exists above (line ~1731, used by the
// highlight-detection path, which needs its stricter array-only + throwing
// behavior). Two top-level `function` declarations with the same name
// silently collide in non-strict/CommonJS scope (the later one wins for
// ALL call sites, including the earlier one's) — that bug had the
// highlight-detection call site unknowingly running THIS null-returning,
// object-or-array parser instead of its own, turning JSON parse failures
// into a confusing downstream "Cannot read properties of null" instead of
// a clear parse error. Keep these two parsers named distinctly.
function parseJsonLooseTypoFix(s) {
  if (!s) return null;
  const t = String(s).replace(/```json\s*|```/gi, '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
// Correct typos in caption text. Pass `words` (selection) OR `lines` (all cues).
// Returns { words:[...] } / { lines:[...] } with the SAME length/order, or
// { error }. Never throws. Spelling only — word counts must be preserved.
async function fixCaptionTypos(cfg, { lines, words, lang = 'id' } = {}) {
  if (!aiAvailable(cfg)) return { error: 'AI belum diatur. Isi API key di Settings.' };
  const dict = TYPO_DICT.join(', ');
  const isWords = Array.isArray(words) && words.length > 0;
  const items = isWords ? words : (Array.isArray(lines) ? lines : []);
  if (!items.length) return { error: 'Tidak ada teks untuk diperbaiki.' };
  const key = isWords ? 'words' : 'lines';
  const unit = isWords ? 'kata' : 'kata per baris';
  const unitEn = isWords ? 'words' : 'words per line';
  const idP = `Kamu korektor ejaan caption Bahasa Indonesia. Perbaiki HANYA typo/ejaan.
ATURAN KETAT:
- JANGAN menambah, menghapus, menggabung, memecah, atau mengubah urutan kata.
- Jumlah ${unit} HARUS SAMA persis.
- Pertahankan tanda baca dan tag seperti [tertawa].
- Pertahankan/prioritaskan istilah ini bila relevan: ${dict}.
Kembalikan JSON: {"${key}": [...]} dengan jumlah elemen SAMA dan urutan SAMA.

INPUT (${key}):
${JSON.stringify(items)}`;
  const enP = `You are an English caption spell-checker. Fix ONLY typos/spelling.
STRICT RULES:
- DO NOT add, remove, merge, split, or reorder words.
- The number of ${unitEn} MUST stay EXACTLY the same.
- Keep punctuation and tags like [laughs].
- Keep/prefer these terms when relevant: ${dict}.
Return JSON: {"${key}": [...]} with the SAME element count and SAME order.

INPUT (${key}):
${JSON.stringify(items)}`;
  try {
    const out = await aiComplete(cfg, lang === 'en' ? enP : idP, {
      system: lang === 'en' ? 'Spell-checker. Output JSON only.' : 'Korektor ejaan. Output JSON saja.',
      maxTokens: 1500, temperature: 0.1, json: true,
    });
    const parsed = parseJsonLooseTypoFix(out);
    const arr = parsed && Array.isArray(parsed[key]) ? parsed[key]
      : (Array.isArray(parsed) ? parsed : null);
    if (!arr || arr.length !== items.length) return { error: 'Respons AI tidak sesuai — dibatalkan.' };
    return { [key]: arr.map(x => String(x == null ? '' : x)) };
  } catch (e) {
    return { error: e?.message || 'AI gagal.' };
  }
}

// [HOOK-REGEN] Regenerate the viral metadata (headline title + on-screen hook +
// description teaser) for ONE clip, on demand from the hook-review UI. Grounded
// in that clip's OWN transcript so the copy actually matches the moment. Returns
// { title, hook, description } (any field may be '' if the model omits it) or
// { error }. Never throws. Mirrors the fixCaptionTypos IPC pattern.
async function regenerateClipMeta(cfg, { clipText = '', category = '', ytInfo = null, topicSummary = '', lang = 'id' } = {}) {
  // [HOOK-PROVIDER] Must resolve the user's chosen hookProvider (e.g. Groq)
  // the same way rewriteHookTitleBatch/rewriteHookTitle already do — without
  // this, aiAvailable/aiComplete below fall through to AUTO_PROVIDER_ORDER
  // and can silently pick a different, broken/keyless provider even though
  // the Settings "Test" button (which scopes aiProvider explicitly) passes.
  cfg = resolveHookProviderCfg(cfg);
  if (!aiAvailable(cfg)) return { error: 'AI belum diatur. Isi API key di Settings (Bring Your Own Key).' };
  const snippet = String(clipText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!snippet) return { error: 'Tidak ada transcript untuk clip ini.' };
  const cat = String(category || '').toUpperCase() || 'EDUCATIONAL';
  // [LANG-GENERIC] Was a hard binary: lang==='en' got an English prompt,
  // anything else (including a correctly-detected Japanese/Spanish/…
  // source) fell into the Indonesian prompt, which carried an explicit
  // "WAJIB Bahasa Indonesia — dilarang Bahasa Inggris" rule — actively
  // FORCING Indonesian output regardless of what language the clip was
  // actually in. Reported live: "Regenerate" on a non-English, non-
  // Indonesian clip should keep that clip's own language, not fall back to
  // Indonesian. One English-authored prompt (the model follows English
  // instructions fine regardless of the target OUTPUT language) with a
  // LANGUAGE directive — same pattern already proven in
  // rewriteHookTitlesBatch — replaces both hardcoded variants and reaches
  // every language languageDisplayName() can name, not just two.
  const language = languageDisplayName(lang);
  const vinfo = ytInfo ? `VIDEO: ${ytInfo.title || ''} — ${ytInfo.uploader || ''}\n` : '';
  const topic = topicSummary ? `CONTENT BRIEF:\n${topicSummary}\n` : '';
  const prompt = `You are a SENIOR short-form viral editor (TikTok/Reels/Shorts). From this ONE clip's transcript, write FRESH viral metadata.
${vinfo}${topic}CATEGORY: ${cat}

Return JSON ONLY (no markdown), exactly these keys:
{"title": "viral hook headline, max ~60 chars, Title Case, no emoji/hashtag/quotes/clip-number", "hook_text": "on-screen overlay, max 15 words", "description": "1-sentence curiosity teaser, max ~110 chars"}

Rules:
- LANGUAGE: ${language} — title, hook_text and description must ALL be in this language, matching the transcript's own language. Do not code-switch into another language even if the transcript itself mixes in foreign loanwords/terms — keep the surrounding sentence in ${language}.
- TITLE is a scroll-stopping headline — NOT a summary, NOT a raw transcript quote.
- Everything must be grounded in the transcript below (invent no facts).

TRANSCRIPT:
"""${snippet}"""`;
  try {
    const raw = await aiComplete(cfg, prompt, {
      system: 'Viral short-form editor. Output JSON only.',
      maxTokens: 320, temperature: 0.7, json: isGemini(cfg),
    });
    const parsed = parseJsonLooseTypoFix(raw);
    const rec = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!rec || typeof rec !== 'object') return { error: 'Respons AI tidak terbaca — coba lagi.' };
    const rawTitle = String(rec.title || '').replace(/\s+/g, ' ').trim();
    // maxWords=12 so a full headline isn't chopped to the 6-word hook limit.
    const title = cleanApiTitle(rawTitle, lang, 12) || rawTitle.slice(0, 80);
    const hook = String(rec.hook_text || rec.hook || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const description = String(rec.description || rec.why || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!title && !hook && !description) return { error: 'AI tidak menghasilkan teks — coba lagi.' };
    return { title, hook, description };
  } catch (e) {
    return { error: e?.message || 'AI gagal.' };
  }
}

// [APPLY-CROP] Crop-only re-encode. Same input resolution + vfFor() crop chain
// as renderClipEdit, but skips ALL caption/subtitle burning. Result is a clean
// plate ready to feed the caption editor without stacking any prior burn.
const util = require('util');
const execFileAsync = util.promisify(require('child_process').execFile);
async function checkAudio(file, ffprobeBin) {
  try {
    const { stdout } = await execFileAsync(ffprobeBin || 'ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file
    ]);
    return stdout.trim().includes('audio');
  } catch (e) {
    return false;
  }
}

async function applyClipCrop({ srcFile, srcVideo, clipStart, clipEnd, clipFormat, clipResolution, cropX, cropY, cropScale, cropKeyframes, cropAspect, cropRect, splitCrop, binPaths, onLog /* [FFMPEG-FILTERS] see renderClipEdit */ }) {
  if (binPaths?.ffmpeg) FFMPEG = binPaths.ffmpeg;
  if (binPaths?.ffprobe) FFPROBE = binPaths.ffprobe;
  if (!FFMPEG || (FFMPEG !== 'ffmpeg' && !fs.existsSync(FFMPEG))) {
    throw new Error(`ffmpeg binary not found at: ${FFMPEG || '(unset)'}`);
  }
  // [FFMPEG-FILTERS] Crop Studio is the third way into ffmpeg and still builds
  // scale/crop/pad/setsar (and the split-screen hstack). Free of charge — the
  // check is memoised per binary, so this only ever spawns if neither
  // runPipeline nor renderClipEdit has run yet this session.
  checkFfmpegFilters(FFMPEG, onLog);
  if (!srcFile || !fs.existsSync(srcFile)) throw new Error(`Source clip not found: ${srcFile}`);
  const dir  = path.dirname(srcFile);
  const ext  = path.extname(srcFile);
  const base = path.basename(srcFile, ext);
  // [TIDY-SESSION] crop-gaming/ for a split-screen (game + face) crop,
  // crop-biasa/ for a plain one (both were _clean/).
  const hasSplit = !!(splitCrop && splitCrop.faceRect && splitCrop.gameRect);
  const cleanDir = path.join(sessionRootFor(dir), hasSplit ? 'crop-gaming' : 'crop-biasa');
  fs.mkdirSync(cleanDir, { recursive: true });
  let outName, n = 1;
  do { outName = `${base}-crop-${n}${ext}`; n++; } while (fs.existsSync(path.join(cleanDir, outName)) && n < 100);
  const outPath = path.join(cleanDir, outName);
  const encArgs = [...videoEncodeArgs('final', clipResolution || '1080p'),
                   '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  
  const { mode, input } = resolveEditInput({ srcVideo, clipStart, clipEnd, srcFile });
  // [SPLIT-GATE] hasFile2 used to be derived from file2 alone, while the split
  // filtergraph is only built when both rects exist. With file2 set but a rect
  // missing, the code took the plain -vf branch AND still spliced a second
  // input in with no -map — so ffmpeg auto-selected the highest-resolution
  // video across all inputs and rendered the BACKGROUND file as the whole clip.
  const isSplit = !!(splitCrop && splitCrop.faceRect && splitCrop.gameRect);
  const hasFile2 = !!(isSplit && splitCrop.file2);
  if (hasFile2 && !fs.existsSync(splitCrop.file2)) {
    throw new Error(`Split source 2 not found: ${splitCrop.file2}`);
  }
  let vfArgs;
  if (isSplit) {
    vfArgs = ['-filter_complex', vfForSplitScreen(splitCrop, clipResolution || '1080p', hasFile2)];
    let hasA1 = true, hasA2 = false;
    if (hasFile2) {
      // [SPLIT-AUDIO] checkAudio swallows every error as "no audio", so a
      // missing/failed ffprobe silently produced a completely SILENT clip with
      // exit code 0. Fail loudly instead — same class as the ASR silent chain.
      if (!FFPROBE || (FFPROBE !== 'ffprobe' && !fs.existsSync(FFPROBE))) {
        throw new Error(`ffprobe binary not found at: ${FFPROBE || '(unset)'} — cannot mix split-screen audio`);
      }
      hasA1 = await checkAudio(input, FFPROBE);
      hasA2 = await checkAudio(splitCrop.file2, FFPROBE);
    }
    // [SPLIT-MUTE] The whole decision — including the user's per-source mute —
    // lives in splitAudioArgs so it can be unit-tested; see split-audio-mute.test.js.
    const audio = splitAudioArgs({
      hasFile2, hasAudio1: hasA1, hasAudio2: hasA2,
      mute1: !!splitCrop.mute1, mute2: !!splitCrop.mute2,
    });
    if (audio.graph) vfArgs[1] += audio.graph;
    vfArgs.push(...audio.maps);
  } else {
    vfArgs = ['-vf', vfFor(clipFormat || 'face', clipResolution || '1080p', cropX, cropY, cropKeyframes, cropScale, cropAspect, cropRect)];
  }
  let args = [];
  
  const getFile2Args = () => {
    const ext2 = path.extname(splitCrop.file2).toLowerCase();
    const isImg = ['.jpg','.jpeg','.png','.webp'].includes(ext2);
    // If it's an image, loop it infinitely (-loop 1). If it's a video, loop it infinitely (-stream_loop -1).
    // This allows arbitrary length background videos without running out of frames.
    if (isImg) return ['-loop', '1', '-i', splitCrop.file2];
    return ['-stream_loop', '-1', '-i', splitCrop.file2];
  };

  if (mode === 'recut') {
    const dur = Math.max(1, clipEnd - clipStart).toFixed(2);
    args.push('-y', '-ss', parseFloat(clipStart).toFixed(2), '-i', input);
    if (hasFile2) args.push(...getFile2Args());
    args.push('-t', dur, ...vfArgs, ...encArgs, outPath);
  } else {
    args.push('-y', '-i', input);
    if (hasFile2) args.push(...getFile2Args());
    args.push(...vfArgs, ...encArgs, outPath);
  }
  
  console.log('[applyClipCrop] FFMPEG=%s mode=%s args=', FFMPEG, mode, args);
  // This was the only render call site with no watchdog at all. The graph is
  // now bounded by the video itself, but keep the same guards every other
  // render path uses so a future unbounded filter can't hang the app silently.
  const APPLY_TIMEOUT_MS = Math.max(1800000, Math.round(Math.max(1, Number(clipEnd) - Number(clipStart)) * 60000));
  await spawnLines(FFMPEG, args, {
    cwd: dir,
    onLine: (k, l) => { if (k === 'err') console.log('[ffmpeg]', l); },
    timeoutMs: APPLY_TIMEOUT_MS,
    stallMs: RENDER_STALL_MS,
  });
  if (!fs.existsSync(outPath)) throw new Error('Crop apply finished but no output file was created.');
  const thumbnail = await createRenderedPoster(
    outPath,
    Math.max(1, Number(clipEnd) - Number(clipStart)),
    clipFormat || 'face',
  );
  return { file: outPath, fileName: outName, thumbnail, cleanPlate: mode === 'recut' };
}
module.exports = { hasilDirFor, sessionRootFor, runPipeline, cancelPipeline, flushRunLog, renderClipEdit, applyClipCrop, fixCaptionTypos, regenerateClipMeta, exportToUserFolder, deliveredClipFor, createClipExporter, trackerAvailable, killTree, renderPlanFor, detectHwEncoder, __test: { driveLabel, copyFileAtomic, withTimeout, __setMacClone, tidyTranscriptFiles, spawnLines, splitAudioArgs, watermarkCanvas, RENDER_STALL_MS, REQUIRED_FILTERS, parseFilterNames, missingFilters, checkFfmpegFilters, __resetFilterCheck, assFontsDir, assFontsDirFs, pickErrorLines, tcAss, chunkTranscriptText, mergeHighlightCandidates, dedupeRollingCaptions, parseSrt, buildHighlightPrompt, parseVtt, buildCuesFromPlainText, toSeconds, chunkWordsToCues, dedupeAndSplitCues, loadSessionWords, transcriptLooksUsable, asrEtaSeconds, humanDuration, isCancelError, transcribeAudio, detectLanguage, whisperLangNameToCode, languageDisplayName, ASR_LOCAL_REALTIME_RATIO, MIN_WORDS_PER_MINUTE, ASR_SANITY_GRACE_SEC, captionBurnVf, dimVf, kinCapParam, pickBrollMoment, pickBrollMoments, brollWordScore, brollOverlayPlace, probeFaceBoxes, brollCardFor, captionBand, BROLL_OVERLAYS, BROLL_PALETTES, BROLL_STYLES, brollStyleFor, applyCollageBroll, applyCollageBrolls, wpcMode, wpcNum, soclAsrChunk, soclTranscribe, soclAsrAvailable, soclCloudFull, silentChunk, soclCloudTitles, SOCL_ASR_URL, speechIntervals, detectSilence, deadAirIn, trimDeadAir, DEAD_AIR_GAP, trimCuesUnderHook, titleVideoFxVf, withVideoFx, VIDEO_FX, applyCutoutFx, probeFaceBands, applyCueCase, trackedIntermediateCacheKey, buildWatermarkFilter, outputWidthPx, outputHeightPx, vfFor, stickerJobs, resolveAiStickers, emojiAssetsDir, assPlayRes, buildAss, boxCueLines, boxDrawing, boxDrawAnchor, titleLineTops, titleLinePitch, titleInkLineTops, titleLineInkPx, titleInkGapEm, titleInkLeadEm, titleSizesMixed, tokenSizePx, boxWordLayoutPx, textWidthEmSafe, titleBoxRects, backdropGeometry, BACKDROP, ANIM_TIMING_HOOK: ANIM_TIMING, titleWordAnchors, splitTitleLines, resolveEditInput, resolveDuration, buildManualPreset, MANUAL_DURATION_MAX_SEC, MANUAL_DURATION_MIN_SEC, shiftCues, flexClipEnd, buildCoverageClips, AUTO_COVER_MAX_SEC, parseManualSegments, normTimecode, stripSpeakerMarkers, wordMostlyInClip, effectiveAI, aiAvailable, noAiMessage, keylessNode, freeChain, pinnedProviderHasKey, smartModelFor, cloudAsrTiers, cleanKey, keyLooksReal, autoProvider, isQuotaError, parseGeminiQuota, quotaMessage, markAiProviderDead, aiProviderDead, AI_DEAD_TTL_MS, segmentFilterArgs, SEG_AUDIO_ARGS, snapSegmentJobs, fpsFromStream, aiComplete, adaptOpenAiBody, parseModelList, looksEnglishText, findSidecarSubtitle, findEmbeddedSubtitleStream, extractEmbeddedSubtitle, openaiChat, rewriteHookTitle, localHookTitle, localContextTitle, condenseToHookPhrase, parseJsonLoose, parseJsonLooseTypoFix, echoesExampleHook, titleGroundedInText, validateGeneratedTitle, tokenizeForTfidf, buildTfidfWindows, normalizeTfidfScores, detectPromoRanges, rangeOverlapsBlocked, looksLikeStaleYtdlp, looksLikeSslCertError, platformLabel, looksLikeTransientExtractFailure, isGoogleDriveFolderUrl, looksLikeDriveAccessProblem, slugify, cleanApiTitle, localHookTitle, trimTitleEdges, titleWordCount, TITLE_MAX_WORDS, looksLikeBotCheck, looksLikeAgeRestricted, looksLikeVideoUnavailable, dropFadeOutIfContiguous, applyCueContinuity, CONTIGUOUS_CUE_GAP_SEC, videoUnavailableMessage, looksLikeYoutubePoToken403, looksLikeYoutubeFormatGate, youtubeGateMessage, ytdlpStallMessage, youtubeEmbeddedFallbackArgs, youtubeEmbeddedFallbackSelector, looksLikeBrowserCookieBlocked, blockedCookieKind, describeBlockedCookieBrowsers, buildViralHookTitle, isClassicGeminiApiKey, resolveHookProviderCfg, spawnFailureHint, sessionRootFor, mapLimit, regenerateClipMeta, exportToUserFolder, spawnFfmpegWithDecodeFallback, decodeArgs, calibrationCacheDir, __setDecodeArgs, __setFfmpeg, pickHwEncoder, chunkTranscriptBalanced, generateTopicSummary, estimateTokens, markUnsuitable, unsuitableKey, badAiOutput, isBadAiOutput, looksLikeRefusal, acceptJsonArray, buildAiTranscript, snapToAiLines, aiStamp, isDailyLimit, isModelGone, isModelRotatable, GROQ_CHAT_ROTATION, isRequestTooLarge, rateLimitWaitMs, rubricScore, snapClipToSentences, muxTrackedArgs, inputHasAudio, isNonSpeechText, dropNonSpeech, dropHallucinatedSegments, sameTopic, subtitleCoverage, localUnreadableMessage, videoEncodeArgs, videoEncodeArgsFor, encoderProbeArgs, encoderRaceArgs, raceEncoders, encCacheKey, __setHwEncoder, __setEncoderCacheDir, ENC_CACHE_FILE, PROBE_FRAME, HW_ENCODER_CANDIDATES, TIER_MBPS, buildWhisperArgs, whisperThreads, asrModelSlowdown, ASR_MODEL_SLOWDOWN, ASR_EXTRACT_TIMEOUT_MS, ASR_WHISPER_TIMEOUT_MS, fontTrackEm, SUB_STYLES, clipConcurrencyFor, renderPlanFor, softwareEncodeThreads, WHISPER_BEAM_SIZE, WHISPER_MAX_THREADS, trackerAccelCapFor, trackerPrewarmAllowedFor, probeDmlAvailable, trkAccelCacheKey, detectTrackerAccel, __setTrackerAccelCacheDir, __setTrackerAccelDml, trackerAvailable, resolveTrackerWorker, __setTrackerPaths, TrackerWorker, TrackerProcessError, TrackerFailurePolicy } };
module.exports.__test.sampleTranscriptForSummary = sampleTranscriptForSummary;
module.exports.__test.rewriteHookTitlesBatch = rewriteHookTitlesBatch;
module.exports.__test.testProviderConnection = testProviderConnection;
module.exports.testProviderConnection = testProviderConnection;
module.exports.__test.replaceVideoEncodeArgs = replaceVideoEncodeArgs;
module.exports.__test.titleCaseHeadline = titleCaseHeadline;
module.exports.__test.isEncoderError = isEncoderError;
module.exports.__test.validateDownloadedSource = validateDownloadedSource;
module.exports.__test.SOURCE_PROBE_TIMEOUT_MS = SOURCE_PROBE_TIMEOUT_MS;
module.exports.__test.downloadSingleSubtitleTrack = downloadSingleSubtitleTrack;
module.exports.__test.SUB_RATE_LIMIT_RETRY_MS = SUB_RATE_LIMIT_RETRY_MS;
module.exports.__test.SUBTITLE_DOWNLOAD_TIMEOUT_MS = SUBTITLE_DOWNLOAD_TIMEOUT_MS;
module.exports.__test.waitForSubtitleRetry = waitForSubtitleRetry;
module.exports.__test.cleanCueText = cleanCueText;
module.exports.__test.parseTranscriptText = parseTranscriptText;
module.exports.__test.moveLongFiltersToFiles = moveLongFiltersToFiles;
module.exports.__test.cmdLineLength = cmdLineLength;
module.exports.__test.snapClipEdges = snapClipEdges;
module.exports.__test.sentenceBounds = sentenceBounds;
module.exports.__test.wordSentences = wordSentences;
module.exports.__test.heatScore = heatScore;
module.exports.__test.heatCandidates = heatCandidates;
module.exports.__test.pickHookTeaser = pickHookTeaser;
module.exports.__test.insertSec = insertSec;
module.exports.__test.applyBrollSec = applyBrollSec;
module.exports.__test.pickPauseCuts = pickPauseCuts;
module.exports.__test.timelineParts = timelineParts;
module.exports.__test.applyClipTimeline = applyClipTimeline;
module.exports.__test.audioEnvelope = audioEnvelope;
module.exports.__test.mergeHighlightCandidates = mergeHighlightCandidates;
module.exports.__test.selectTranscriptSource = selectTranscriptSource;
module.exports.__test.persistAcquiredSubtitleWords = persistAcquiredSubtitleWords;
module.exports.__test.subtitleWordsForSource = subtitleWordsForSource;
module.exports.__test.parseTranscriptText = parseTranscriptText;
