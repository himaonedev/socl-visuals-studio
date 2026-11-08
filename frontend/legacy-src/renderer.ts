// SOCL Visuals Studio v03 — renderer
// State, panel routing, IPC wiring, live gallery.

// [FILE-URL-ENCODE] Local imports keep the user's original path, which can
// contain spaces, `#`, `?`, or unicode — bare `file://${path}` breaks silently
// (empty video, no `loadedmetadata`, drag/play dead). Encode every path
// segment; keep the leading slash so `file:///Users/...` stays valid.
function toFileURL(p) { return window.__soclMediaUrl(p); }

// User-facing step labels. Kept short & elegant — no tool names, no jargon.
// Second element is the default subtitle; live updates overwrite it via
// setStepDetail(name, text).
const PIPELINE_STEPS = [
  ['Fetch',       'menunggu'],
  ['Transcribe',  'menunggu'],
  ['Detect hooks','menunggu'],
  ['Titles',      'menunggu'],
  ['Render',      'menunggu'],
];
// Legacy pipeline event step names → user-facing step index. New event names
// can be added here without touching the pipeline code.
const STEP_MAP = {
  Download: 0, Fetch: 0,
  Analyze: 1, Transcribe: 1,
  Detect: 2, 'Detect hooks': 2,
  Title: 3, Titles: 3,
  Export: 4, Render: 4,
};
// Each step owns a slice of the global 0–100 scale. The pipeline emits a single
// global percent; we map it back into a per-step 0–100 so every card shows its
// own progress instead of a bare "menunggu".
const STEP_BANDS = [
  [0, 25],   // Fetch
  [25, 45],  // Transcribe
  [45, 58],  // Detect hooks
  [58, 65],  // Titles
  [65, 100], // Render
];
// Given a global percent + the active step index, return that step's local 0–100.
function stepLocalPct(idx, globalPct) {
  const band = STEP_BANDS[idx];
  if (!band) return 0;
  const [bs, be] = band;
  if (be <= bs) return 100;
  return Math.max(0, Math.min(100, ((globalPct - bs) / (be - bs)) * 100));
}

const state = {
  cfg: null,
  source: null,
  selectedFile: null,
  subtitleFile: null,
  noTranscript: false,
  running: false,
  sourcePreview: null,
  clips: [],
  history: [],
  historyClips: [],
  historyFilter: 'all',
  historyQuery: '',
  historyPage: 0,
  filter: 'all',
  activeClip: -1,
  activePanel: 'clip',
  currentPreviewIdx: -1,
  cueWords: [],
  cropMode: false,
  selectMode: false,
  selection: window.ClipSelect.createSelection(),
};
// A frontend dev reload must not erase clips while the native engine is rendering.
const LivePreviewState = window.LivePreviewState;
let restoredClippingSession = false;
try {
  let restored = LivePreviewState.restoreSnapshot(sessionStorage.getItem('socl-clipping-session-v1'));
  if (!restored?.clips?.length) {
    const backup = JSON.parse(sessionStorage.getItem('socl-effects-return-v1') || 'null');
    const previous = backup && LivePreviewState.restoreSnapshot(backup.snapshot);
    if (previous?.clips?.length) restored=previous;
  }
  if (restored) { Object.assign(state,restored); restoredClippingSession=true; }
} catch {}
function persistClippingSession() {
  try { sessionStorage.setItem('socl-clipping-session-v1',LivePreviewState.snapshot(state)); } catch {}
}
window.addEventListener('pagehide', persistClippingSession);

// [WM-V1] Pure state module — same file is required by main + pipeline for
// a single source of truth on defaults, geometry, and merge semantics.
// Project-level watermark lives on state.cfg.watermark (persisted via
// settings); per-clip overrides ride on state.clips[i].watermarkOverride.
// The UMD wrapper in watermark.js attaches its API to `window.wmMod` — we
// alias it locally so the rest of renderer.js can keep using `wmMod.foo`
// without going through `window.`.
const wmMod = window.wmMod;
// [SPLIT-BAKED] Which input a caption burn reads, and on which canvas — the
// one rule that keeps a baked Split Screen clip from being re-cut back to its
// pre-split master. Same UMD/alias pattern as wmMod; see render-source.js.
const { renderSourceFor } = window.RenderSource;
// [GALLERY-RENDER] Pure batch-render decisions (zone visibility + reading the
// render-edit result envelope) live in batch-render.js so node tests can cover
// them. `batchRunning` guards the status-bar slot while a batch is in flight so
// renderGallery() doesn't repaint the "N edit" note over the progress line.
const BatchRender = window.BatchRender;
const ClipCard = window.ClipCard;
const MediaLifecycle = window.MediaLifecycle;
const StatusDisclosure = window.StatusDisclosure;
let batchRunning = false;
// [FX-FREEZE] Caption Editor Apply/Preview and crop Apply render too, but
// have no flag like state.running / batchRunning. ui-fx.js reads this to hold
// the background still while any of them run.
let rendersInFlight = 0;
async function trackRender(p) {
  rendersInFlight++;
  try { return await p; } finally { rendersInFlight--; }
}
// [BATCH-CANCEL] Set to a function while a batch render is in flight; the
// shared pipeCancel button calls it instead of (or in addition to) the
// pipeline-cancel path. null when no batch is running, so pipeCancel's click
// handler can tell "batch" and "pipeline" apart and do the right thing for
// whichever actually owns the status bar right now.
let batchCancelRequest = null;
let batchPrevStatus = null;   // [RENDER-PROGRESS] status bar text to hand back after back-to-back batches
function currentWatermark(clip) {
  return wmMod.resolveWatermark(state.cfg?.watermark, clip?.watermarkOverride);
}

// [SUBS-SELFHEAL] v2.3.20 shipped a regression where users reported "burn
// subtitles ON but the render has no subs". Root cause under investigation
// was that Apply Crop / Caption Editor Render / Batch Render all gate on
// clip.cueWords being non-empty, and various flows leave it empty even
// though the per-word list (clip.words) is populated:
//   - Older history reports predating cueWords persistence
//   - Local imports where cueWords generation raced with the render click
//   - State that was mutated in the editor and lost the chunked cues
// This helper rebuilds cueWords from clip.words on demand. Cheap
// client-side chunk into groups of N words (default 3, matching the
// pipeline default). Mutates the clip in place so subsequent renders
// keep the recovered cues. No-op when cueWords is already populated or
// no word timing data is available at all.
function ensureCueWords(clip, wordsPerChunk) {
  if (!clip || typeof clip !== 'object') return false;
  const cur = Array.isArray(clip.cueWords) ? clip.cueWords : null;
  if (cur && cur.length > 0) return true;
  const words = Array.isArray(clip.words) ? clip.words : null;
  if (!words || !words.length) return false;
  const N = Math.max(1, Math.min(8, +wordsPerChunk || +state.cfg?.subtitleWordsPerChunk || 3));   // [WPC-AUTO] 'auto' -> mixChunks below
  // [SPEAKER-MARKER] same stripping as stripSpeakerMarkers() in the pipeline:
  // ">>" (YouTube's speaker-change mark) is not a word to show.
  const flat = words
    .filter(w => w && w.text && isFinite(+w.start) && isFinite(+w.end))
    .map(w => ({ text: String(w.text).replace(/(^|\s)(?:>{2,}|&gt;&gt;)/g, '$1').replace(/\s{2,}/g, ' ').trim(), start: +w.start, end: +w.end }))
    .filter(w => w.text);
  if (!flat.length) return false;
  const out = [];
  // [SAUCE-MIX] the Sauce campur look chunks 1–3 words, same as the pipeline.
  const groups = ((autoChunkKin(state.cfg?.captionKinetic) || (wordsPerChunk || state.cfg?.subtitleWordsPerChunk) === 'auto') && window.KineticTitle && window.KineticTitle.mixChunks) ? kinChunksR(flat) : null;
  for (let i = 0, g = 0; groups ? g < groups.length : i < flat.length; i += N, g++) {
    const chunk = groups ? groups[g] : flat.slice(i, i + N);
    out.push({
      start:  chunk[0].start,
      end:    chunk[chunk.length - 1].end,
      text:   chunk.map(w => w.text).join(' '),
      tokens: chunk.map(w => ({ text: w.text })),
      // [BOX-HIGHLIGHT] No `.words` field — box highlight derives per-word
      // timing fresh from tokens+cue bounds at use time.
    });
  }
  clip.cueWords = out;
  console.log('[subs-selfheal] rebuilt cueWords from words[] — clip:',
              clip.title || clip.file, 'words:', flat.length, 'chunks:', out.length);
  return true;
}
function prepareClipCaptionPreview(clip) {
  ensureCueWords(clip);
  const cues = Array.isArray(clip?.cueWords) ? clip.cueWords : [];
  for (const cue of cues) if (cue) ensureTokens(cue);
  return cues;
}

// [WIN-FIT] Platform class, set before anything paints. Windows spends real
// vertical space macOS does not: a native title bar plus the File/Edit/View
// menu bar, where mac uses titleBarStyle:'hiddenInset' and puts its menu in the
// system bar. That is ~55-60 CSS px of content height gone on the same monitor,
// which is why the short-viewport ladder in styles.css — already labelled
// [WIN-FIT] — kept missing: a maximised 1080p window still reports ~950 CSS px,
// above every breakpoint, while the usable area feels like a much shorter
// screen. Keyed on the platform rather than lowering the breakpoints for
// everyone, so a mac on the same monitor is untouched.
try {
  const plat = (window.socl && window.socl.platform) || '';
  if (plat) document.documentElement.classList.add(`os-${plat}`);
} catch {}

// ─── DOM refs ──────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const els = {
  rail:       document.querySelectorAll('.rail-btn[data-panel]'),
  panelBody:  $('#panelBody'),
  panelTitle: $('#panelTitle'),
  panelEyebrow: $('#panelEyebrow'),
  urlInput:   $('#urlInput'),
  pickBtn:    $('#pickVideo'),
  importMeta: $('#importMeta'),
  runBtn:     $('#runPipeline'),
  openOutput: $('#openOutputBtn'),
  pipeDot:    $('#pipeDot'),
  pipeStep:   $('#pipeStepLabel'),
  pipePct:    $('#pipePct'),
  statusLine: $('#statusLine'),
  progressFill: $('#progressFill'),
  log:        $('#log'),
  gallery:    $('#galleryGrid'),
  clipCountBadge: $('#clipCountBadge'),
  cntAll:     $('#cntAll'),
  cntHot:     $('#cntHot'),
  cntSaved:   $('#cntSaved'),
  chips:      document.querySelectorAll('#galleryChips button'),
  preview:    $('#previewVideo'),
  sourceBackdrop: $('#sourcePreviewBackdrop'),
  sourcePoster: $('#sourcePreviewPoster'),
  stage:      $('#previewStage'),
  captionOv:  $('#captionOverlay'),
  captionTx:  $('#captionText'),
  stickerOv:  $('#stickerOverlay'),   // [EMOJI-STICKER] preview twin of the burned layer
  sceneTag:   $('#sceneTag'),
  transportTime: $('#transportTime'),
  playBtn:    $('#playBtn'),
  transport:  $('#transport'),
  prevClip:   $('#prevClip'),
  nextClip:   $('#nextClip'),
  cropBtn:    $('#cropBtn'),
  toast:      $('#toast'),
  historyOverlay: $('#historyOverlay'),
  hgGrid:  $('#hgGrid'),
  hgCount: $('#hgCount'),
  hgSearch:$('#hgSearch'),
  hgChips: $('#hgChips'),
  hgClose: $('#hgClose'),
  hgPager: $('#hgPager'),
  hgPrev:  $('#hgPrev'),
  hgNext:  $('#hgNext'),
  hgPageInfo: $('#hgPageInfo'),
};

// ─── Toast ────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind = '') {
  els.toast.textContent = msg;
  els.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.className = 'toast'; }, 3800);
}

// ─── Pipeline strip: minimalist step cards ───────────────
// state.stepDetail[stepName] holds the freshest subtitle text (e.g. "18k words · id").
state.stepDetail = {};
// state.stepPct[idx] holds the freshest local 0–100 for each step card.
state.stepPct = {};

// ─── Animated progress engine ────────────────────────────
// The pipeline emits coarse, jumpy percents and can sit on one value for many
// seconds (e.g. yt-dlp spinning up before the first "%"). To keep the bar alive
// and honest we ease a *shown* value toward the real *target*, and gently creep
// toward — but never reaching — the active step's band end while the target
// stalls. Real updates always win. Everything here is best-effort; a thrown
// error must never touch the pipeline.
const prog = {
  target: 0,      // real global percent from pipeline events
  shown: 0,       // animated global percent actually rendered
  activeIdx: -1,  // active step index (-1 = idle)
  timer: null,
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch {} }, 120);
  },
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },
  reset() {
    this.stop();
    this.target = 0; this.shown = 0; this.activeIdx = -1;
  },
  // Snap immediately (used on done/error so the bar lands exactly).
  set(pct, activeIdx) {
    if (typeof activeIdx === 'number') this.activeIdx = activeIdx;
    this.target = Math.max(this.target, Math.min(100, pct));
    this.shown = Math.min(100, pct);
    this.paint();
  },
  // Feed a real event: advance the target (monotonic — never goes backward).
  feed(pct, activeIdx) {
    if (typeof activeIdx === 'number') this.activeIdx = activeIdx;
    if (typeof pct === 'number') this.target = Math.max(this.target, Math.min(100, pct));
    this.start();
  },
  tick() {
    let goal = this.target;
    // Creep toward the active step's band end while the real target is stalled,
    // so a long wait still reads as motion. Decelerates, never reaches the end.
    const band = STEP_BANDS[this.activeIdx];
    if (band) {
      const ceil = band[1] - 1;               // stay just under the boundary
      if (this.target < ceil && this.shown < ceil) {
        goal = Math.max(this.target, this.shown + (ceil - this.shown) * 0.03);
      }
    }
    const next = this.shown + (goal - this.shown) * 0.18;
    // Stop churning once we've essentially arrived and there's nothing to creep.
    if (Math.abs(next - this.shown) < 0.05 && this.target >= goal) { this.shown = goal; }
    else this.shown = next;
    this.paint();
  },
  paint() {
    const pct = Math.max(0, Math.min(100, this.shown));
    if (els.progressFill) els.progressFill.style.width = pct + '%';
    if (els.pipePct) els.pipePct.textContent = `${Math.round(pct)}%`;
    // Per-step local percents: earlier steps are complete, active is derived,
    // later steps stay at 0 until reached.
    if (this.activeIdx >= 0) {
      for (let i = 0; i < PIPELINE_STEPS.length; i++) {
        if (i < this.activeIdx) state.stepPct[i] = 100;
        else if (i === this.activeIdx) state.stepPct[i] = Math.round(stepLocalPct(i, pct));
        else if (state.stepPct[i] == null) state.stepPct[i] = 0;
      }
      paintSteps(this.activeIdx, this.activeIdx >= PIPELINE_STEPS.length ? 'done' : 'active');
    }
  },
};
function paintSteps(activeIdx, status) {
  const host = document.getElementById('pipeSteps');
  if (!host) return;
  const total = PIPELINE_STEPS.length;
  host.innerHTML = PIPELINE_STEPS.map(([name, defaultSub], i) => {
    let cls = 'ps-card';
    let mark = '';
    if (activeIdx < 0) {
      cls += ' ps-idle'; mark = `${i+1}`;
    } else if (i < activeIdx) {
      cls += ' ps-done'; mark = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    } else if (i === activeIdx) {
      cls += status === 'error' ? ' ps-error' : status === 'done' ? ' ps-done' : ' ps-active';
      mark = status === 'done'
        ? '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : `${i+1}`;
    } else {
      cls += ' ps-idle'; mark = `${i+1}`;
    }
    const sub = state.stepDetail[name] || defaultSub;
    // Per-step percent badge: done = 100%, active = live local %, idle = blank.
    let pctBadge = '';
    if (activeIdx >= 0) {
      if (i < activeIdx || (i === activeIdx && status === 'done')) pctBadge = '100%';
      else if (i === activeIdx && status !== 'error') {
        const p = state.stepPct[i];
        if (typeof p === 'number') pctBadge = `${Math.max(0, Math.min(100, Math.round(p)))}%`;
      }
    }
    const pctHtml = pctBadge ? `<span class="ps-pct">${pctBadge}</span>` : '';
    return `<div class="${cls}"><span class="ps-mark">${mark}</span><div class="ps-body"><b>${name}</b><span>${sub}</span></div>${pctHtml}</div>`;
  }).join('');
}
// [CANCEL-STUCK-DISABLED] Hiding Cancel used to leave `disabled` and the
// "Cancelling…" label exactly as the last cancellation left them. Nothing
// clears them on the way out of a run — only the START of the next pipeline
// run (see [SBAR-CANCEL-FEEDBACK]) or the start of the next batch does — so a
// cancelled run followed by anything that re-showed the button without going
// through those two entry points handed the user a button that was already
// disabled. It looked live (`.sbar-btn.danger` had no `:disabled` style) and
// its handler returned silently, which is the "Cancel tidak berfungsi sama
// sekali" report. A hidden Cancel owns no in-flight cancellation, so resetting
// here makes "hidden" and "armed and clickable" the same state, always.
// Deliberately only on HIDE: resetting on show would re-enable the button
// mid-cancellation while the run is still winding down.
function hidePipeCancel() {
  const btn = document.getElementById('pipeCancel');
  if (!btn) return;
  btn.hidden = true;
  btn.disabled = false;
  btn.textContent = 'Cancel';
}
function renderSteps(activeIdx = -1, status = 'active') {
  if (!els.pipeDot) return;
  const total = PIPELINE_STEPS.length;
  if (activeIdx < 0) {
    // [GALLERY-RENDER] `sbar-dot` carries the dot's entire box (10×10 + colour);
    // the status-bar consolidation renamed the element's class but left these
    // writes on the old `pipe-spinner`, which no linked stylesheet defines — so
    // the status dot collapsed to 0×0 and never lit up for any run.
    els.pipeDot.className = 'sbar-dot';
    els.pipeStep.textContent = 'Idle';
    els.pipePct.textContent = '';
    hidePipeCancel();
    paintSteps(-1, status);
    return;
  }
  const cls = status === 'error' ? 'error' : activeIdx >= total || status === 'done' ? 'done' : 'active';
  els.pipeDot.className = `sbar-dot ${cls}`;
  const name = PIPELINE_STEPS[Math.min(activeIdx, total-1)]?.[0] || 'Selesai';
  els.pipeStep.textContent = status === 'error' ? `Error — ${name}` : name;
  // Big percent is written elsewhere (pipeline event); keep this empty when idle.
  const cancel = document.getElementById('pipeCancel');
  if (cancel) {
    if (activeIdx >= 0 && activeIdx < total && cls === 'active') cancel.hidden = false;
    else hidePipeCancel();
  }
  paintSteps(Math.min(activeIdx, total - 1), status);
}
renderSteps();

// Hide low-level yt-dlp / ffmpeg / ffprobe / deno noise from the visible log.
// We only surface human-readable milestones (lines starting with ▶ ✓ ✗ ⚠), our
// own colored markers, and warnings/errors. The progress bar carries the
// per-percent updates so users still see motion.
const LOG_NOISE_RE = /\[(youtube|info|download|generic|hlsnative|youtube:tab|merger|extractor|debug|generic|hls|dashsegments)\]/i;
const TOOL_PROGRESS_RE = /\b(MiB\/s|KiB\/s|GiB\/s|B\/s|ETA\s+\d|frag\s+\d+\/\d+|of\s+~?\d+(\.\d+)?\s?[KMG]i?B)\b/i;
const FF_INTERNALS_RE = /^\s*(frame=|fps=|size=|time=|bitrate=|speed=|Stream\s+#|Input\s+#\d|Output\s+#\d|Duration:|Metadata:|\s{2,}|encoder\s*:|Press\s+\[|\[(libx264|aac|h264|mp4|matroska|swscaler|libpostproc|Parsed_|info|debug)\])/i;
function shouldShowLog(line, kind) {
  if (kind === 'err') return true;                     // never hide errors
  if (!line) return false;
  // Allowed: our own milestone markers and explicitly-colored statuses.
  if (/^[▶✓✗⚠⏵►•⏱]/.test(line)) return true;
  if (kind === 'ok' || kind === 'lime' || kind === 'yellow') return true;
  // Suppressed: anything that smells like raw tool output.
  if (LOG_NOISE_RE.test(line)) return false;
  if (TOOL_PROGRESS_RE.test(line)) return false;
  if (FF_INTERNALS_RE.test(line)) return false;
  if (/^\s*$/.test(line)) return false;
  // Default: keep, but unstyled tool lines without a marker still get hidden
  // — too easy to leak random noise. Only ▶/✓/colored kind survives.
  return false;
}

// ─── Log ──────────────────────────────────────────────────
function logLine(line, kind = '') {
  if (!shouldShowLog(line, kind)) return;
  const el = document.createElement('div');
  if (kind) el.className = kind;
  el.textContent = line;
  els.log.appendChild(el);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.children.length > 300) els.log.removeChild(els.log.firstChild);
}

// [ERR-VISIBLE] Until now the renderer had NO global error handler, so an
// exception anywhere outside an explicit try/catch vanished completely: no log
// line, no toast, nothing. That is not a theoretical gap — it is how a dead
// Apply button in the Caption Editor reached users. openCaptionEditor() wires
// ~1700 lines of controls in sequence with Apply wired LAST, so one throw
// halfway through leaves the tail of the editor unwired and perfectly silent.
//
// console.error is not a substitute: DevTools is not open on a packaged build,
// and main-process stdout is discarded when the app is launched from Finder or
// a desktop shortcut, which is the normal case.
//
// Deliberately reports rather than recovers — the app is already in an unknown
// state; the point is that the user (and a screenshot from them) can SEE it.
function reportRendererCrash(what, err) {
  const msg = (err && (err.message || err.reason?.message || err.reason)) || err || 'unknown error';
  const where = (err && err.filename)
    ? ` [${String(err.filename).split(/[/\\]/).pop()}:${err.lineno || '?'}]`
    : '';
  // Leading ✗ is load-bearing: shouldShowLog() drops any line without a marker.
  try { logLine(`✗ ${what}: ${msg}${where}`, 'err'); } catch {}
  try { toast(`${what} — lihat log`, 'err'); } catch {}
}
window.addEventListener('error', (e) => {
  const err = e.error || e;
  const msg = String(err?.message || err || '');
  if (/play\(\) request was interrupted|interrupted by a (?:call to pause|new load request)|AbortError/i.test(msg) || err?.name === 'AbortError') {
    try { e.preventDefault(); } catch {}
    return;
  }
  reportRendererCrash('Terjadi error di dalam aplikasi', err);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason || e;
  const msg = String(reason?.message || reason?.reason?.message || reason || '');
  if (/play\(\) request was interrupted|interrupted by a (?:call to pause|new load request)|AbortError/i.test(msg) || reason?.name === 'AbortError') {
    try { e.preventDefault(); } catch {}
    return;
  }
  reportRendererCrash('Operasi gagal tanpa tertangani', reason);
});

// ─── License badge ─────────────────────────────────────────



// ─── Settings (persisted via IPC) ─────────────────────────
// Fallback defaults so panels still render when running as plain HTML in a
// regular browser (no `window.socl` IPC bridge). Real app overrides via
// getSettings() below. This lets us preview UI at http://127.0.0.1:8792/src/index.html.
// [FS-DEFAULT] ONE fallback caption size. This used to be written out three
// times with three different numbers — 64 in the config defaults, 81 in the
// timeline chip's stepper base, 96 in the pinch-to-resize seed — so whenever
// cfg.subtitleFontSize was missing, the number the chip showed, the number a
// step moved from, and the size actually painted all disagreed, and the value
// appeared to change on its own as the user moved between controls.
const DEFAULT_SUB_FS = 64;

// [MANUAL-DURATION] Mirrors MANUAL_DURATION_MIN/MAX_SEC in pipeline-inverse-v1.
// Kept in sync by test/manual-duration.test.js rather than by hand.
// [EVENT-WINDOW] Durasi minimum untuk nilai yang DIKETIK di panel judul dan
// manual caption. Beda peran dengan dua angka lain, dan itu disengaja:
//   0,05s  lantai terakhir di eventWindow (title-layout.js) — jaring data rusak
//   0,1s   ini: minimum yang boleh dihasilkan input angka (cocok dgn min="0.1")
//   0,3s   lantai drag di lane timeline — ergonomi, supaya barnya bisa dipegang
const MIN_EVENT_DUR = 0.1;
const MANUAL_DUR_MIN = 10;
const MANUAL_DUR_MAX = 300;
// A stored clipDuration is "manual" when it is a bare number that is NOT one of
// the named preset keys — that is exactly the set of values the pipeline's
// buildManualPreset() claims, so the UI and the pipeline agree on which control
// owns the value.
const PRESET_DURATIONS = ['15', '30', '60', '90', '120', '180'];
function isManualDuration(v) {
  const k = String(v ?? '').trim();
  return /^[0-9]+$/.test(k) && !PRESET_DURATIONS.includes(k)
    && Number(k) >= MANUAL_DUR_MIN && Number(k) <= MANUAL_DUR_MAX;
}

const CFG_FALLBACK = {
  clipCount:5, clipDuration:'60', clipMode:'auto', manualSegments:[], deadAirCut:true,
  format:'face', resolution:'1080p',
  burnSubtitles:true, smartTrack:false, trackerAsdMode:'blendshape', subtitleLang:'auto',
  subtitleStyle:'neon_green', subtitleGlow:true, subtitleBoxColor:'', subtitleFontSize:DEFAULT_SUB_FS, subtitleFont:'', subtitleOffsetMs:0,
  subtitleY:540, subtitleX:540, subtitleAnim:'pop', collageBroll:false, hookTeaser:false, hookProvider:'groq',
  aiProvider:'', apiKey:'', geminiKey:'', groqKey:'', freeModel:'',
  openaiKey:'', openaiModel:'gpt-4o-mini',
  anthropicKey:'', anthropicModel:'claude-haiku-4-5',
  openrouterKey:'', openrouterModel:'openrouter/free', openrouterFallbacks:'',
  sumopodKey:'', sumopodModel:'deepseek-v4-pro',
  localAsr:'ask', whisperModelSize:'small',
  model:'', baseUrl:'', cookiesPath:'', exportPath:'', lastUrl:'',
};
async function loadSettings() {
  try {
    state.cfg = await window.socl.getSettings();
  } catch (e) {
    console.warn('[browser-preview] window.socl unavailable — using fallback settings');
    state.cfg = { ...CFG_FALLBACK };
  }
  if (!state.cfg) state.cfg = { ...CFG_FALLBACK };
  // Old settings allowed two competing caption renderers to remain enabled.
  // An enabled SOCL box takes priority; choosing a kinetic preset clears it.
  if (state.cfg.subtitleBoxColor && state.cfg.captionKinetic) {
    state.cfg.captionKinetic = '';
    Promise.resolve().then(() => saveCfg({ captionKinetic: '' })).catch(() => {});
  }
  // [CAP-QUOTE] Tegas + Lirik became Quote (2026-10-12): carry a saved pick over.
  if (state.cfg.captionKinetic === 'cap_acak_sauce' || state.cfg.captionKinetic === 'cap_sauce_mix') { state.cfg.captionKinetic = 'cap_quote'; Promise.resolve().then(() => saveCfg({ captionKinetic: 'cap_quote' })).catch(() => {}); }
  if (state.cfg.format === 'original') state.cfg.format = 'face';
  els.urlInput.value = state.cfg.lastUrl || '';
  refreshOutputPill();
  // Rail Output button — opens the last-used output folder (delegates to main).
  if (els.openOutput) els.openOutput.addEventListener('click', () => {
    window.socl.openOutput?.();
  });
  renderPanel('clip');
  initHistoryGalleryControls();
  if (restoredClippingSession) {
    const files = [...state.clips,...(state.pendingClips || []),state.sourcePreview || {}]
      .flatMap(clip => [clip.file,clip.rawFile,clip.srcVideo,clip.thumbnail])
      .filter(file => typeof file==='string' && /\.(mp4|mov|mkv|webm|jpg|jpeg|png)$/i.test(file));
    try { await window.__soclIpc?.invoke('engine:grant-dropped',files); } catch {}
    renderGallery();
    const index = state.clips[state.currentPreviewIdx] ? state.currentPreviewIdx : state.clips.findIndex(c=>c.file || c.srcVideo);
    if (index >= 0) loadPreview(index,{autoplay:false});
    else if (state.sourcePreview) showPosterPreview(state.sourcePreview,'Menyiapkan render…');
    if (state.running) { els.runBtn.disabled=false;els.runBtn.textContent='Cancel';els.runBtn.dataset.mode='cancel'; }
    restoredClippingSession=false;
  }
  // Defer so browser completes layout before we read clientWidth/clientHeight
  requestAnimationFrame(() => applyStageAspect(state.cfg.format));
}
// [CFG-GEN] Generation counter + per-key ownership map for saveCfg.
//
// Every saveCfg call takes a monotonically increasing generation number and
// records, for each key it patches, that it is the newest writer of that key.
// cfgPatchGen therefore always holds the HIGHEST generation that has ever set
// a given key. Entries are never deleted: the map is bounded by the number of
// distinct settings keys (tens), and deleting on completion would reopen the
// very race this fixes — an older, slower save finishing last would find the
// key unclaimed and hydrate its stale value over the newer one.
let cfgSaveGen = 0;
const cfgPatchGen = new Map();

async function saveCfg(patch) {
  const gen = ++cfgSaveGen;
  // [REALTIME-FIX] Apply the patch to the LIVE cfg object synchronously first so
  // any preview repaint (applyCE/applyCaptionStyle) that fires before the async
  // IPC resolves already sees the new value. Then MUTATE the same object in place
  // instead of REASSIGNING state.cfg — reassigning orphaned the caption editor's
  // captured `const c = state.cfg`, so after the first save the editor previewed
  // a stale style/font (the last-chosen style wouldn't stick). Object.assign keeps
  // the identity, so `c` stays live and the preview is truly realtime.
  Object.assign(state.cfg, patch);
  for (const k of Object.keys(patch)) cfgPatchGen.set(k, gen);
  const saved = await window.socl.setSettings({ ...state.cfg });
  // Hydrate back ONLY the keys that NO saveCfg at or after this one has set
  // (e.g. secret fields the main process rewrites).
  //
  // The guard used to be `!(k in patch)`, which only protected this call's OWN
  // keys. That is not enough: a later saveCfg for a DIFFERENT key can be issued
  // after this one and still resolve first, and this reply — snapshotted before
  // that change existed — would then write the pre-change value back over it.
  // Reproduced by picking a clip duration and immediately typing a clip count:
  // the DOM and the persisted settings both showed the new count while
  // state.cfg still held the old one, so every UI reading state.cfg (the clip
  // duration warning, for one) disagreed with the screen.
  //
  // Comparing generations fixes it for real: skip the key if its newest writer
  // is this call or anything newer, hydrate only if it is strictly older.
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(saved)) {
      const owner = cfgPatchGen.get(k);
      if (owner !== undefined && owner >= gen) continue;
      state.cfg[k] = saved[k];
    }
  }
  return state.cfg;
}

// ─── Panel routing ────────────────────────────────────────
function setActiveRail(panel) {
  els.rail.forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
}

function renderPanel(name) {
  // Pindah tab/fitur lain → tutup galeri history (pause klip grid) & pause preview utama
  if (name !== 'history' && els.historyOverlay && !els.historyOverlay.hidden) closeHistoryGallery();
  if (name !== 'history' && els.preview && !els.preview.paused) { try { els.preview.pause(); } catch {} }
  const leavingCrop = state.activePanel === 'crop' && name !== 'crop';
  state.activePanel = name;
  setActiveRail(name);
  // When leaving crop mode, restore normal framing + reload the clip preview
  if (name !== 'crop') {
    els.preview.style.objectPosition = '';
    els.preview.style.objectFit = '';
    if (leavingCrop && state.activeClip >= 0) loadPreview(state.activeClip);
  }
  if (name === 'clip')       return renderClipPanel();
  if (name === 'api')        return renderApiPanel();
  if (name === 'history')    return renderHistoryPanel();
  if (name === 'crop')       return renderCropPanel();
  if (name === 'watermark')  return renderWatermarkPanel();
  // 'style' panel removed 2026-07-14 — burn toggle moved to Clip Options, batch
  // render buttons moved under the Detected Clips grid, Caption Editor is now
  // the sole styling surface.
}

// [AP-HELP] What Burn subtitles does to the output, for the state it is in.
// Static markup only (no user data), so it is safe as innerHTML.
// [SUBS-TOGGLE] One switch, one meaning: cfg.burnSubtitles. OFF = no transcript
// captions anywhere — not in the preview, the Caption Editor, Apply, Render or
// Run pipeline (hook titles + manual captions stay). Users saw captions in the
// preview with the switch OFF and assumed it was broken.
function subsOn() { return !state.cfg || state.cfg.burnSubtitles !== false; }
function burnHelpHtml(on) {
  return on
    ? '<b>ON</b> — subtitle tampil di preview dan ikut tertempel di video hasil (folder <b>hasil/</b>).'
    : '<b>OFF</b> — video tanpa subtitle (preview, Apply &amp; Render), klip polos di folder <b>raw/</b>. Transkrip tetap tersimpan; nyalakan lagi kapan saja di sini atau di Caption Editor.';
}

function renderClipPanel() {
  els.panelEyebrow.textContent = 'Instant style';
  els.panelTitle.textContent = 'Clip setting';
  const c = state.cfg;
  const CPR = window.CaptionPlacement.RANGE;
  const CPV = window.CaptionPlacement.clampValue;   // numbers only into the markup below
  els.panelBody.innerHTML = `
    <p class="panel-desc">Define style instanmu sebelum run pipeline.
      <button type="button" class="panel-desc-cue" id="f_styleCue">Scroll ke bawah untuk define gaya clip sesuai preferensimu <span class="panel-desc-arrow" aria-hidden="true">↓</span></button>
    </p>
    <!-- v3: auto-processing quick toggles hoisted to TOP of Clip Options.
         Burn subs + Smart Face Tracking + Subtitle language sit here so
         they're visible without scrolling before Run pipeline. -->
    <div class="ap-block">
      <div class="ap-block-head">AUTO-PROCESSING</div>
      <label class="ap-toggle-card" for="f_burnQ">
        <div class="ap-ico">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M7 12h10"/><path d="M7 15h6"/></svg>
        </div>
        <div class="ap-txt">
          <span class="ap-title">Subtitle di video</span>
          <span class="ap-sub" id="f_burnHelp">${burnHelpHtml(c.burnSubtitles)}</span>
        </div>
        <span class="ap-switch"><input type="checkbox" id="f_burnQ" ${c.burnSubtitles?'checked':''}><i></i></span>
      </label>
      <!-- [EMOJI-OFF] The emoji-sticker toggle lived here, disabled while the
           feature is reworked. It still mirrored a stored emojiStickers:true,
           which kept stickers in the burn with no way to switch them off; the
           card is gone and readCfg() retires that value. Feature code is kept. -->
      <!-- [AUTO-TITLE-REMOVED] A "Judul otomatis di video" toggle lived here in
           2.3.72-beta. Pulled after a real Windows run: the title the pipeline
           generated landed over the opening captions. Titles are Caption-Editor
           only again, where their position is visible before committing. The
           automatic LAYOUT of a title (multi-line shaping, hook-word accent,
           fit sizing) is unchanged and still applies there. -->
      <label class="ap-toggle-card" for="f_smartQ">
        <div class="ap-ico">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="4"/><path d="M6 20c1.5-3 3.6-4 6-4s4.5 1 6 4"/></svg>
        </div>
        <div class="ap-txt">
          <span class="ap-title">Smart Face Tracking <span class="ap-badge">NEW</span></span>
          <span class="ap-sub">Auto-frame speaker · +⅓ waktu render</span>
          <span class="ap-sub ap-req" id="f_trackerHelp">Wajib download sekali (±600 MB): nyalakan saklar ini → klik <b>Install</b> di jendela yang muncul → tunggu selesai. Butuh internet sekali saja.</span>
        </div>
        <span class="ap-switch"><input type="checkbox" id="f_smartQ" ${c.smartTrack?'checked':''}><i></i></span>
      </label>
      <!-- [ASD-MODE-CHOICE] Opt-in only, never a silent default. Only shown
           when Smart Face Tracking itself is on — this picks its ENGINE, not
           a standalone feature. Unchecked = 'blendshape' (MediaPipe, the
           shipped engine); checked = 'motion_vad' (experimental, faster on
           multi-face clips, skips the MediaPipe landmark pass entirely). -->
      <label class="ap-toggle-card ap-toggle-sub" for="f_asdModeQ" id="f_asdModeRow" style="${c.smartTrack?'':'display:none'}">
        <div class="ap-ico">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
        </div>
        <div class="ap-txt">
          <span class="ap-title">Motion+VAD Engine <span class="ap-badge">EXPERIMENTAL</span></span>
          <span class="ap-sub">Lebih cepat di klip multi-orang · deteksi berbasis gerak mulut + suara, bukan MediaPipe</span>
        </div>
        <span class="ap-switch"><input type="checkbox" id="f_asdModeQ" ${c.trackerAsdMode==='motion_vad'?'checked':''}><i></i></span>
      </label>
      <div class="field ap-lang-field">
        <label>Subtitle language</label>
        <select id="f_subtitleLang">
          ${[
            ['auto','🌐 Auto-detect (disarankan)'],
            ['id','🇮🇩 Indonesia'],
            ['ms','🇲🇾 Melayu / Malaysia'],
            ['en','🇬🇧 English'],
            ['ar','🇸🇦 Arab / Arabic'],
            ['zh','🇨🇳 Mandarin (Chinese)'],
            ['hi','🇮🇳 Hindi'],
            ['ja','🇯🇵 Japanese / 日本語'],
            ['ko','🇰🇷 Korean / 한국어'],
            ['th','🇹🇭 Thai / ภาษาไทย'],
            ['vi','🇻🇳 Vietnamese / Tiếng Việt'],
            ['tl','🇵🇭 Filipino / Tagalog'],
            ['pt','🇧🇷 Portuguese / Português'],
            ['es','🇪🇸 Spanish / Español'],
            ['fr','🇫🇷 French / Français'],
            ['de','🇩🇪 German / Deutsch'],
            ['it','🇮🇹 Italian / Italiano'],
            ['nl','🇳🇱 Dutch / Nederlands'],
            ['tr','🇹🇷 Turkish / Türkçe'],
            ['ru','🇷🇺 Russian / Русский'],
            ['uk','🇺🇦 Ukrainian / Українська'],
          ].map(([v,l]) => `<option value="${v}" ${(c.subtitleLang||'auto')===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <!-- [BURN-FONT] Font + look for the BURNED caption. Every entry is a face
         bundled in assets/fonts whose value was probed with ffmpeg fontselect —
         libass does not error on an unresolvable name, it silently renders
         Helvetica, so a plausible-looking guess here is invisible until the
         user watches the finished video. Each option previews in its own face. -->
    <div class="field" id="f_styleStart">
      <label>Font caption (burn)</label>
      <div class="font-specimens" id="f_burnFont">
        ${BURN_FONTS.map(f => `<button type="button" data-v="${esc(f.value)}" class="fspec${(c.subtitleFont || '') === f.value ? ' on' : ''}" title="${esc(f.label)}"><span class="fspec-word" style="font-family:${f.css};font-size:${f.size}px;letter-spacing:${f.track}">${esc(f.sample)}</span><span class="fspec-name">${esc(f.label)}</span></button>`).join('')}
      </div>
      <div id="f_burnFontPreview" style="margin-top:8px;padding:12px;border-radius:8px;background:#000;color:#fff;text-align:center;font-size:22px;line-height:1.3;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Contoh Caption</div>
    </div>
    <div class="field">
      <label>Gaya caption</label>
      <div class="chip-grid" id="f_burnLook">
        ${/* [CHIP-STATE] `.active` — styles.css defines .chip-grid button.active
              (like the sibling #f_format / #f_resolution grids). The old `.on`
              matched no rule, so the selected caption look never highlighted. */''}
        ${BURN_LOOKS.map(l => `<button data-v="${l.id}" class="${burnLookOf(c) === l.id ? 'active' : ''}" title="${esc(l.hint)}">${esc(l.label)}</button>`).join('')}
      </div>
    </div>
    <!-- [BOX-HIGHLIGHT-CLIPOPT] Same toggle as the Caption Editor's Style tab
         (#ce_box) — both write the SAME state.cfg.subtitleBoxColor, so this is
         a second surface for one setting, not a separate feature. Users open
         Clip Options far more than the deep Caption Editor, and the box
         highlight is exactly the kind of "pick a look before running" choice
         that belongs at this level, next to Gaya caption. -->
    <div class="field">
      <label>Box highlight <span style="color:var(--muted);font-weight:500;font-size:11px">· kotak mengikuti kata aktif</span></label>
      <div class="chip-grid" id="f_box">
        <button data-v="on"  class="${c.subtitleBoxColor?'active':''}">ON</button>
        <button data-v="off" class="${!c.subtitleBoxColor?'active':''}">OFF</button>
      </div>
      <div class="slider-row" id="f_boxColorRow" style="margin-top:8px" ${c.subtitleBoxColor?'':'hidden'}>
        <input id="f_boxColor" type="color" value="${c.subtitleBoxColor || '#F1FF00'}" style="width:44px;height:32px;padding:0;border-radius:8px;cursor:pointer">
        <span class="val" style="margin-left:8px">Warna kotak</span>
      </div>
      <!-- [BOX-HIGHLIGHT-PREVIEW] Static values here are only the FIRST-PAINT
           fallback — paintBoxPreview() (below) overwrites them from
           window.CaptionBox's PAD_EM/VPAD_EM/RADIUS_EM on every render, same
           source burn (buildAss) reads. Kept numerically identical to that
           source so even this fallback never lies before JS runs. -->
      <div id="f_boxPreview" style="margin-top:8px;padding:12px;border-radius:8px;background:#000;text-align:center;font-size:22px;font-weight:700;line-height:1.6;overflow:hidden" ${c.subtitleBoxColor?'':'hidden'}>
        <span style="color:#fff">Contoh</span> <span id="f_boxPreviewWord" style="border-radius:0.09em;padding:0.12em 0.25em;box-decoration-break:clone;-webkit-box-decoration-break:clone">Caption</span>
      </div>
    </div>
    <!-- [HOOK-AUTOBURN] The clip's AI headline as an on-video hook for its
         first seconds, in a preset picked here — so a user gets a hook without
         ever opening the Caption Editor. Pipeline side: src/hook-autoburn.js
         places it by MEASURING the clip's own caption events and skips the
         clip rather than overlap (the 2.3.72-beta auto-title guessed and was
         pulled for landing on the captions). The cards are the same
         hookPresetSample() miniatures the Titles panel shows. -->
    <div class="field">
      <label>Hook judul di video <span style="color:var(--muted);font-weight:500;font-size:11px">· judul AI tampil 3,5 detik pertama</span></label>
      <div class="chip-grid" id="f_hook">
        <button data-v="on"  class="${c.hookAutoBurn?'active':''}">ON</button>
        <button data-v="off" class="${!c.hookAutoBurn?'active':''}">OFF</button>
      </div>
      <div id="f_hookPick" ${c.hookAutoBurn?'':'hidden'}>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px">
          ${(window.HookPresets ? window.HookPresets.HOOK_PRESETS : []).map(p => `
            <button type="button" class="f_hookPreset" data-preset="${p.id}" title="Pakai gaya ${esc(p.label)}"
              style="display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid ${(c.hookPreset || 'blok_neon') === p.id ? 'var(--lime)' : 'rgba(255,255,255,.12)'};border-radius:8px;background:#0b0b0b;cursor:pointer;text-align:center;min-width:0">
              <span style="display:flex;align-items:center;justify-content:center;height:70px;overflow:hidden;width:100%">${hookPresetSample(p)}</span>
              <span style="font-size:10px;color:var(--muted)">${esc(p.label)}</span>
            </button>`).join('')}
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--muted)">Huruf hook</div>
        <div class="chip-grid" id="f_hookCase" style="margin-top:4px">
          ${[['', 'Ikut gaya'], ['upper', 'KAPITAL'], ['title', 'Judul'], ['lower', 'kecil']].map(([v, l]) => `<button type="button" data-case="${v}" class="${(c.hookCase || '') === v ? 'active' : ''}">${l}</button>`).join('')}
        </div>
        <div style="margin-top:6px;font-size:11px;color:var(--muted);line-height:1.5">Posisi otomatis menjauhi caption. Burn subtitle ON: langsung terbakar ke video. OFF: tampil di preview dan ikut terbakar saat klip dirender. Teks &amp; gaya bisa diubah per klip di Caption Editor → Titles.</div>
      </div>
    </div>
    <!-- [KINETIC-CAPTION] Caption template: each phrase builds up word by
         word with one big key word (kinetic-title.js CAP templates). Off =
         the regular caption style above. -->
    <div class="field">
      <label>Caption animasi <span style="color:var(--muted);font-weight:500;font-size:11px">· kata kunci besar, muncul per kata</span></label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px" id="f_capKin">
        ${[{ id: '', label: 'Mati (caption biasa)' }].concat(window.KineticTitle ? window.KineticTitle.CAPTION_LIST : []).map(p => `
          <button type="button" class="f_capKin" data-kin="${p.id}" title="${esc(p.label)}"
            style="display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid ${(c.captionKinetic || '') === p.id ? 'var(--lime)' : 'rgba(255,255,255,.12)'};border-radius:8px;background:#0b0b0b;cursor:pointer;text-align:center;min-width:0">
            <span style="display:flex;align-items:center;justify-content:center;height:70px;overflow:hidden;width:100%">${p.id ? kineticCardSample({ id: p.id, title: { kinetic: p.id } }) : '<span style="font-size:12px;color:var(--muted)">Aa</span>'}</span>
            <span style="font-size:10px;color:var(--muted)">${esc(p.label)}</span>
          </button>`).join('')}
      </div>
      <!-- [CAP-DIM] (Rata caption dicabut 2026-10-12: tak dipahami pengguna) -->
      <label style="margin-top:10px">Gelapkan background <span style="float:right;color:var(--lime);font-weight:600" id="f_capDimVal">${Math.round((+c.captionDim || 0) * 100)}%</span></label>
      <div class="slider-row"><input id="f_capDim" type="range" min="0" max="60" step="5" value="${Math.round((+c.captionDim || 0) * 100)}"></div>
      <div class="field-hint">Lapisan hitam tipis di atas video, di bawah teks — caption lebih terbaca. Ikut terbakar saat render.</div>
    </div>
    <!-- [WORD-STATE-CAPTION] 20 caption looks where the spoken word lights up
         (colour / box / pop). Same cfg.captionKinetic as Caption animasi, so
         only one caption template is ever on. -->
    <div class="field">
      <label>Gaya kata <span style="color:var(--muted);font-weight:500;font-size:11px">· kata yang diucapkan menyala</span></label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px" id="f_capCc">
        ${(window.KineticTitle ? window.KineticTitle.CC_LIST : []).map(p => `
          <button type="button" class="f_capKin" data-kin="${p.id}" title="${esc(p.label)}"
            style="display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid ${(c.captionKinetic || '') === p.id ? 'var(--lime)' : 'rgba(255,255,255,.12)'};border-radius:8px;background:#0b0b0b;cursor:pointer;text-align:center;min-width:0">
            <span style="display:flex;align-items:center;justify-content:center;height:70px;overflow:hidden;width:100%">${kineticCardSample({ id: p.id, title: { kinetic: p.id } })}</span>
            <span style="font-size:10px;color:var(--muted)">${esc(p.label)}</span>
          </button>`).join('')}
      </div>
    </div>
    <!-- [VIDEO-FX] Effect on the video itself for the hook window (first
         3.5 s): speaker cut-out over a colour, or a two-colour duotone.
         Cards: ONE licensed sample photo (eyes barred) tinted live by the same
         SVG filter the preview uses, the B/W cut-out on top for cutout
         effects — so catalog effects get a real card too. -->
    <div class="field">
      <label>Efek video <span style="color:var(--muted);font-weight:500;font-size:11px">· 3,5 detik pertama, terbakar saat Burn subtitle ON</span></label>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px" id="f_vfx">
        ${[{ id: '', label: 'Mati' }].concat(window.VideoFx ? window.VideoFx.FX : []).map(f => `
          <button type="button" class="f_vfx" data-fx="${f.id}" title="${esc(f.label)}"
            style="display:flex;flex-direction:column;gap:4px;padding:4px;border:1px solid ${(c.videoFx || '') === f.id ? 'var(--lime)' : 'rgba(255,255,255,.12)'};border-radius:8px;background:#0b0b0b;cursor:pointer;text-align:center;min-width:0">
            ${f.id && f.tint ? `<span style="position:relative;width:100%;aspect-ratio:3/4;display:block;border-radius:5px;overflow:hidden">${(ensureVideoFxFilter(`soclfx-${f.id}`, f), '')}<img src="../assets/fx/person.jpg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:url(#soclfx-${f.id})">${f.kind === 'cutout' ? '<img src="../assets/fx/person-subject.png" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">' : ''}</span>`
              : '<span style="width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;border-radius:5px;background:#151515;color:var(--muted);font-size:11px">Tanpa efek</span>'}
            <span style="font-size:10px;color:var(--muted)">${esc(f.label)}</span>
          </button>`).join('')}
      </div>
      <!-- [CLIP-TIMELINE] -->
      <label class="ap-toggle-card" for="f_hookTeaser" style="margin-top:10px">
        <div class="ap-txt">
          <span class="ap-title">Hook pembuka (cut video highlight)</span>
          <span class="ap-sub">Opsional. Potongan video highlight — kalimat paling kuat di klip — diputar beberapa detik di awal (durasi diatur di bawah), lalu kilat putih, lalu klip dengan efek &amp; judul seperti biasa. Mati = klip langsung dibuka efek &amp; judul.</span>
        </div>
        <span class="ap-switch"><input type="checkbox" id="f_hookTeaser" ${c.hookTeaser === true ? 'checked' : ''}><i></i></span>
      </label>
      <div class="field-hint" style="margin-top:6px">Durasi hook pembuka (Auto = 1–4 detik, kalimat utuh)</div>
      <div class="chip-grid" id="f_hookTeaserSec" style="margin-top:4px" title="Durasi hook pembuka (Auto = 1–4 detik, kalimat utuh)">
        ${[['auto','Auto'],['2','2 dtk'],['3','3 dtk'],['4','4 dtk'],['5','5 dtk']].map(([v,l]) => `<button type="button" data-v="${v}" class="${String(c.hookTeaserSec ?? 'auto')===v?'active':''}">${l}</button>`).join('')}
      </div>
      <!-- [COLLAGE-BROLL] -->
      <label class="ap-toggle-card" for="f_broll" style="margin-top:10px">
        <div class="ap-txt">
          <span class="ap-title">B-roll kolase</span>
          <span class="ap-sub">Sisipan bergaya kolase kertas (durasi diatur di bawah) di kata kunci terkuat tiap klip (setelah hook). Hanya format 9:16, dibuat lokal & gratis.</span>
        </div>
        <span class="ap-switch"><input type="checkbox" id="f_broll" ${c.collageBroll ? 'checked' : ''}><i></i></span>
      </label>
      <div class="chip-grid" id="f_brollStyle" style="margin-top:8px" title="Gaya B-roll">
        ${[['auto','Acak'],['kolase','Kolase'],['poster','Poster'],['partikel','Partikel'],['impact','Impact'],['glitch','Glitch'],['stiker','Stiker']].map(([v,l]) => `<button type="button" data-v="${v}" class="${(c.collageStyle||'auto')===v?'active':''}">${l}</button>`).join('')}
      </div>
      <div class="field-hint" style="margin-top:6px">Durasi tiap B-roll (Auto = 4 detik layar penuh, 2,6 detik overlay)</div>
      <div class="chip-grid" id="f_brollSec" style="margin-top:4px" title="Durasi tiap B-roll (Auto = 4 detik layar penuh, 2,6 detik overlay)">
        ${[['auto','Auto'],['2','2 dtk'],['3','3 dtk'],['4','4 dtk'],['5','5 dtk']].map(([v,l]) => `<button type="button" data-v="${v}" class="${String(c.brollSec ?? 'auto')===v?'active':''}">${l}</button>`).join('')}
      </div>
      <div class="field-hint">Kolase = potongan kertas · Poster = tipografi besar · Partikel = titik membentuk kata · Impact = garis manga + lingkaran merah di wajah · Glitch = efek kamera rusak · Stiker = stiker memantul. Acak = beda tiap klip.</div>
    </div>
    <!-- [CAPTION-PLACEMENT] Caption X / Y / size for people who never open
         the Caption Editor. Writes the SAME cfg.subtitleX / subtitleY /
         subtitleFontSize as the editor's Position + Typography sliders, so
         the two surfaces stay in step and the burn reads whichever was set
         last. Values are canvas pixels (1080×1920), Y is the text's top edge.
         The caption in the mini frame can be dragged. -->
    <div class="field cp-field">
      <label>Posisi &amp; ukuran caption <span class="cp-hint">· tanpa buka editor</span></label>
      <div class="cp-frame" id="f_cpFrame" title="Geser caption untuk memindahkannya">
        <div class="cp-zone cp-zone--top"></div>
        <div class="cp-zone cp-zone--bottom"><span>zona tombol TikTok / Reels</span></div>
        <div class="caption-overlay" id="f_cpOv"><span id="f_cpTx">Contoh caption kamu</span></div>
      </div>
      <div class="cp-nums">
        <label class="cp-num"><span>X</span><input id="f_cpX" type="number" min="${CPR.x.min}" max="${CPR.x.max}" step="1" value="${CPV('x', c.subtitleX)}"><button type="button" class="mini-btn" id="f_cpXc" title="Tengah horizontal (540)">⌖</button></label>
        <label class="cp-num"><span>Y</span><input id="f_cpY" type="number" min="${CPR.y.min}" max="${CPR.y.max}" step="1" value="${CPV('y', c.subtitleY)}"><button type="button" class="mini-btn" id="f_cpYc" title="Tengah vertikal (960)">⌖</button></label>
        <label class="cp-num"><span>Size</span><input id="f_cpFs" type="number" min="${CPR.fs.min}" max="${CPR.fs.max}" step="1" value="${CPV('fs', c.subtitleFontSize)}"></label>
      </div>
      <div class="segment cp-preset" id="f_cpPreset">
        ${Object.entries(window.CaptionPlacement.PRESET_Y).map(([k, y]) => `<button type="button" data-y="${y}">${k}</button>`).join('')}
      </div>
      <div class="slider-row"><input id="f_cpFsRange" type="range" min="${CPR.fs.min}" max="${CPR.fs.max}" value="${CPV('fs', c.subtitleFontSize)}"><span class="val" id="f_cpFsVal">${CPV('fs', c.subtitleFontSize)}px</span></div>
      <div class="field-hint">Piksel kanvas 1080×1920 — sama dengan Caption Editor, langsung dipakai saat render.</div>
    </div>
    <!-- [CLIPOPT-ANIM-WPC] Text animation + words per cue BEFORE the run:
         the same cfg.subtitleAnim / cfg.subtitleWordsPerChunk the Caption
         Editor's Animation and 2w/3w chips write, which runPipeline reads
         when it chunks and burns the captions. -->
    <div class="field">
      <label>Animasi teks caption</label>
      <div class="chip-grid" id="f_anim">
        ${[['pop','Pop'],['fade','Fade'],['rise','Rise'],['drop','Drop'],['zoom','Zoom'],['blur','Blur'],['type','Type'],['none','Off']].map(([v,l]) => `<button type="button" data-v="${v}" class="${(c.subtitleAnim||'pop')===v?'active':''}">${l}</button>`).join('')}
      </div>
      <label style="margin-top:10px">Kata per caption</label>
      <div class="chip-grid" id="f_wpc">
        <button type="button" data-v="auto" class="${c.subtitleWordsPerChunk==='auto'?'active':''}" title="1–3 kata mengikuti ucapan">Auto</button>
        ${[1,2,3,4,5].map(n => `<button type="button" data-v="${n}" class="${(c.subtitleWordsPerChunk||3)===n?'active':''}">${n}w</button>`).join('')}
      </div>
      <div class="field-hint" id="f_animHint">Dipakai saat Run pipeline${c.captionKinetic ? ' · <b>Caption animasi aktif</b>: animasi teks diganti animasinya' : ''}. Klip yang sudah jadi: ubah di Caption Editor.</div>
    </div>
    <div class="field">
      <label>Kalibrasi waktu caption
        <span style="float:right;color:var(--lime);font-weight:600" id="f_capOffVal">${(c.subtitleOffsetMs||0)>0?'+':''}${c.subtitleOffsetMs||0} ms</span>
      </label>
      <div class="slider-row">
        <input id="f_capOff" type="range" min="-600" max="600" step="20" value="${c.subtitleOffsetMs||0}">
      </div>
      <div style="color:var(--muted);font-size:11px;line-height:1.5;margin-top:2px">
        Geser ke kanan kalau teks muncul <b>mendahului</b> suara, ke kiri kalau ketinggalan. Berlaku di preview dan hasil render.
      </div>
    </div>
    <!-- [WHISPER-UI] Offline transcription lives here, next to the subtitle
         controls it affects, so it can be installed BEFORE a job needs it
         rather than only being offered mid-run when work has already stalled. -->
    <div class="field" id="f_asrBox">
      <label>Caption offline (tanpa API key)</label>
      <div id="f_asrStatus" style="font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:8px">Memeriksa…</div>
      <select id="f_whisperModel" style="width:100%;margin-bottom:8px"></select>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="f_asrInstall" class="mini-btn">⬇ Download</button>
        <button id="f_asrRemove" class="mini-btn" hidden>🗑 Hapus</button>
      </div>
      <div id="f_asrProg" style="margin-top:10px;display:none">
        <div style="height:6px;background:#222;border-radius:3px;overflow:hidden">
          <div id="f_asrBar" style="height:100%;width:0;background:var(--lime);transition:width .2s"></div>
        </div>
        <div id="f_asrMsg" style="margin-top:6px;font-size:11px;opacity:.75">Menyiapkan…</div>
      </div>
    </div>
    <!-- [CTX-MODEL] Optional offline "context reader" for picking moments when
         no AI key is set. Installed by hand here; never downloaded mid-run. -->
    <div class="field" id="f_ctxBox">
      <label>Pembaca konteks lokal (tanpa API key)</label>
      <div id="f_ctxStatus" style="font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:8px">Memeriksa…</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="f_ctxInstall" class="mini-btn">⬇ Download</button>
        <button id="f_ctxRemove" class="mini-btn" hidden>🗑 Hapus</button>
      </div>
      <div id="f_ctxProg" style="margin-top:10px;display:none">
        <div style="height:6px;background:#222;border-radius:3px;overflow:hidden">
          <div id="f_ctxBar" style="height:100%;width:0;background:var(--lime);transition:width .2s"></div>
        </div>
        <div id="f_ctxMsg" style="margin-top:6px;font-size:11px;opacity:.75">Menyiapkan…</div>
      </div>
    </div>
    <!-- [MANUAL-SEGMENTS] Mode picker. 'manual' hides clip count + duration
         entirely (neither applies when the user types the ranges), 'hybrid'
         keeps both since detection still fills the remaining slots. -->
    <div class="field">
      <label>Sumber potongan</label>
      <div class="segment seg-tight" id="f_clipMode">
        ${[['auto','AI Otomatis','AI memilih momen viral sendiri'],
           ['manual','Manual','Hanya menit yang kamu tentukan'],
           ['hybrid','Manual + AI','Segmen manual dijamin ikut, AI mengisi sisanya']]
          .map(([v,t,tip]) => `<button data-v="${v}" class="${(c.clipMode||'auto')===v?'active':''}" title="${tip}">${t}</button>`).join('')}
      </div>
    </div>
    <div class="field" id="f_manualWrap" hidden>
      <label>Segmen manual <span class="ms-count" id="f_msCount"></span></label>
      <div id="f_msRows" class="ms-rows"></div>
      <button type="button" id="f_msAdd" class="ms-add">+ Tambah segmen</button>
      <div class="ms-hint">Format <b>MM:SS</b> atau <b>HH:MM:SS</b>. Durasi bebas — preset durasi clip tidak berlaku di sini.</div>
    </div>
    <div class="field" id="f_clipCountField">
      <label>Clip count</label>
      <div class="stepper" id="f_clipCountStep">
        <button type="button" data-d="-1" aria-label="Kurangi">−</button>
        <input id="f_clipCountVal" type="number" min="1" inputmode="numeric" value="${c.clipCount}" aria-label="Jumlah clip">
        <button type="button" data-d="1" aria-label="Tambah">+</button>
      </div>
    </div>
    <div class="field" id="f_clipDurationField">
      <label>Clip duration</label>
      <!-- [MANUAL-DURATION] Two pill rows, not one: eight buttons on a single
           row overflowed the panel - "2-3 min" wrapped onto two lines and
           Auto/Manual were clipped to "A". Row 1 keeps the five fixed presets
           in their original order; row 2 holds the longer-form options. Both
           rows live inside #f_clipDuration, so bindSegment (which queries
           '#f_clipDuration button') still sees every button as one control. -->
      <div class="segment-stack" id="f_clipDuration">
        <div class="segment seg-tight">
          ${[['15','15s',''],['30','30s',''],['60','60s',''],['90','90s',''],['120','120s','']]
            .map(([v,t,tip]) => `<button data-v="${v}" class="${(isManualDuration(c.clipDuration) ? false : c.clipDuration === v) ? 'active' : ''}"${tip?` title="${tip}"`:''}>${t}</button>`).join('')}
        </div>
        <div class="segment seg-tight">
          ${[['180','2–3 min','Clip panjang 2–3 menit — cerita/argumen utuh'],['auto','Auto','Panjang menyesuaikan momen (30 dtk – 3 mnt)'],['manual','Manual','Tentukan sendiri, 10–300 detik']]
            .map(([v,t,tip]) => `<button data-v="${v}" class="${(isManualDuration(c.clipDuration) ? v === 'manual' : c.clipDuration === v) ? 'active' : ''}"${tip?` title="${tip}"`:''}>${t}</button>`).join('')}
        </div>
      </div>
      <div class="ms-row" id="f_clipDurationManual" ${isManualDuration(c.clipDuration)?'':'hidden'}>
        <input id="f_clipDurationSec" type="number" min="${MANUAL_DUR_MIN}" max="${MANUAL_DUR_MAX}" step="5"
               inputmode="numeric" value="${isManualDuration(c.clipDuration) ? Number(c.clipDuration) : 150}"
               aria-label="Durasi clip manual (detik)">
        <span class="ms-hint">detik (${MANUAL_DUR_MIN}–${MANUAL_DUR_MAX})</span>
      </div>
      <div class="ms-hint" id="f_clipDurationWarn" hidden></div>
    </div>
    <!-- [DEAD-AIR-TOGGLE] Off for gaming / no-voice videos: their pauses are
         gameplay, and cutting them dropped every candidate. -->
    <div class="field">
      <label class="ap-toggle-card" for="f_deadAir">
        <div class="ap-txt">
          <span class="ap-title">Potong dead air</span>
          <span class="ap-sub">Jeda hening ≥ 1,6 detik dibuang dari klip. Matikan untuk video gaming atau klip tanpa suara supaya klip tidak hilang.</span>
        </div>
        <span class="ap-switch"><input type="checkbox" id="f_deadAir" ${c.deadAirCut !== false ? 'checked' : ''}><i></i></span>
      </label>
    </div>
    <div class="field">
      <label>Format</label>
      <div class="chip-grid" id="f_format">
        ${[['face','Face 9:16'],['blur','Blur BG 9:16'],['square','Square 1:1'],['landscape','Landscape 16:9']].map(([v,t]) => `<button data-v="${v}" class="${c.format===v?'active':''}"><span class="chip-check" aria-hidden="true"></span>${t}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Resolution</label>
      <div class="segment" id="f_resolution">
        ${['720p','1080p','2K','4K'].map(v => `<button data-v="${v}" class="${c.resolution===v?'active':''}">${v}</button>`).join('')}
      </div>
    </div>
    ${state.clips.length ? `
    <div class="field" style="margin-top:12px">
      <button id="f_reviewClips" class="ghost-btn" style="width:100%">Review ${state.clips.length} detected clip${state.clips.length>1?'s':''} ▸</button>
    </div>` : ''}
  `;
  // Stepper − [input] +  (buttons nudge, input allows manual entry). No
  // upper bound — user picks however many clips they want; buildHighlightPrompt's
  // maxTokens scales with clipCount so a large count doesn't get silently
  // truncated mid-JSON, and downstream duration-window filtering (filterByWindow
  // in pipeline-inverse-v1.js) naturally caps the REALISTIC yield to whatever
  // fits the source video.
  const cntInput = document.getElementById('f_clipCountVal');
  const clampCount = n => Math.max(1, n);
  // paintDurationWarn is a hoisted function declaration further down in this
  // same scope; the total-footage warning depends on clipCount too, so both
  // commit paths repaint it.
  const commitCount = n => { saveCfg({ clipCount: n }); cntInput.value = n; paintDurationWarn(); };
  document.querySelectorAll('#f_clipCountStep button').forEach(btn => {
    btn.addEventListener('click', () => {
      commitCount(clampCount((state.cfg.clipCount || 5) + parseInt(btn.dataset.d, 10)));
    });
  });
  cntInput.addEventListener('input', () => {
    const raw = parseInt(cntInput.value, 10);
    if (!Number.isNaN(raw)) { saveCfg({ clipCount: clampCount(raw) }); paintDurationWarn(); }
  });
  cntInput.addEventListener('blur', () => {
    commitCount(clampCount(parseInt(cntInput.value, 10) || 5));
  });
  cntInput.addEventListener('keydown', e => { if (e.key === 'Enter') cntInput.blur(); });
  // ── [MANUAL-SEGMENTS] mode + segment rows ──────────────────────────────
  // Validation here MIRRORS parseManualSegments() in pipeline-inverse-v1.js —
  // keep the two in sync. The one rule the UI can't check is "past the end of
  // the video": the source isn't probed until the pipeline runs, so an
  // out-of-range row shows as valid here and the pipeline clamps or rejects it
  // with a log line. Everything else (format, order, 3s floor) is checked live
  // so "N valid" is honest before the user hits Run.
  const MS_TC = /^\s*(?:\d+:)?(?:\d+:)?\d+(?:[.,]\d+)?\s*$/;
  const msToSec = t => {
    const s = String(t).trim();
    const m = /^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(s);
    if (!m) return parseFloat(s.replace(',', '.'));
    return (+m[1] || 0) * 3600 + (+m[2]) * 60 + parseFloat(String(m[3]).replace(',', '.'));
  };
  // Same normalisation as normTimecode() in pipeline-inverse-v1.js.
  const msNorm = v => String(v ?? '')
    .replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[\uFF1A\u2236\uFE55]/g, ':').replace(/[\uFF0E\u3002]/g, '.').trim();
  const msRowState = seg => {
    const a = msNorm(seg?.start), b = msNorm(seg?.end);
    if (!a && !b) return { state: 'blank' };
    if (/^\d{1,3}\.\d{2}$/.test(a) && /^\d{1,3}\.\d{2}$/.test(b)) return { state: 'bad', reason: 'Pakai titik dua (10:30), bukan titik (10.30)' };
    if (!MS_TC.test(a)) return { state: 'bad', reason: 'Waktu MULAI tidak terbaca' };
    if (!MS_TC.test(b)) return { state: 'bad', reason: 'Waktu SELESAI tidak terbaca' };
    const s = msToSec(a), e = msToSec(b);
    if (e <= s) return { state: 'bad', reason: 'SELESAI harus lebih besar dari MULAI' };
    if (e - s < 3) return { state: 'bad', reason: 'Durasi minimal 3 detik' };
    return { state: 'ok', len: e - s };
  };
  const msFmtLen = n => n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`;
  const msSegs = () => Array.isArray(state.cfg.manualSegments) ? state.cfg.manualSegments : [];
  const msSave = segs => saveCfg({ manualSegments: segs });

  // Read by the Run handler so an all-invalid Manual list is caught BEFORE the
  // download + transcribe of a long video, not after it ([MANUAL-PREFLIGHT]).
  state.msValidCount = () => msSegs().filter(s => msRowState(s).state === 'ok').length;

  const msRowsEl  = document.getElementById('f_msRows');
  const msCountEl = document.getElementById('f_msCount');
  const msWrap    = document.getElementById('f_manualWrap');

  function renderManualRows() {
    // Always show at least one empty row to type into — without persisting a
    // phantom segment into settings.
    const segs = msSegs().length ? msSegs() : [{ start: '', end: '' }];
    msRowsEl.innerHTML = segs.map((seg, i) => {
      const r = msRowState(seg);
      return `
      <div class="ms-row ${r.state}" data-i="${i}">
        <div class="ms-fields">
          <label class="ms-f"><span>MULAI</span><input type="text" inputmode="numeric" placeholder="01:12" data-k="start" value="${(seg.start||'').replace(/"/g,'&quot;')}"></label>
          <label class="ms-f"><span>SELESAI</span><input type="text" inputmode="numeric" placeholder="01:48" data-k="end" value="${(seg.end||'').replace(/"/g,'&quot;')}"></label>
          <button type="button" class="ms-del" data-i="${i}" aria-label="Hapus segmen ${i+1}" ${segs.length===1?'disabled':''}>✕</button>
        </div>
        ${r.state === 'bad' ? `<div class="ms-err">${r.reason}</div>`
          : r.state === 'ok' ? `<div class="ms-ok">${msFmtLen(r.len)}</div>` : ''}
      </div>`;
    }).join('');
    const valid = segs.filter(s => msRowState(s).state === 'ok').length;
    const bad   = segs.filter(s => msRowState(s).state === 'bad').length;
    msCountEl.textContent = bad ? `· ${valid} valid, ${bad} error` : `· ${valid} valid`;
    msCountEl.className = 'ms-count' + (bad ? ' bad' : valid ? ' ok' : '');
    // Re-bind (innerHTML replaced the nodes). Input edits do NOT re-render the
    // whole list — that would kill focus mid-typing; only the row's own status
    // line is refreshed, and a full re-render happens on blur.
    msRowsEl.querySelectorAll('.ms-row input').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = +inp.closest('.ms-row').dataset.i;
        const segs2 = msSegs().slice();
        segs2[i] = { ...segs2[i], [inp.dataset.k]: inp.value };
        msSave(segs2);
        msRefreshStatus();
      });
      inp.addEventListener('blur', renderManualRows);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    });
    msRowsEl.querySelectorAll('.ms-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const segs2 = msSegs().slice();
        segs2.splice(+btn.dataset.i, 1);
        if (!segs2.length) segs2.push({ start: '', end: '' });
        msSave(segs2);
        renderManualRows();
      });
    });
  }
  // Cheap in-place status update while typing (no DOM rebuild → focus is safe).
  function msRefreshStatus() {
    const segs = msSegs();
    msRowsEl.querySelectorAll('.ms-row').forEach(row => {
      const r = msRowState(segs[+row.dataset.i]);
      row.className = 'ms-row ' + r.state;
    });
    const valid = segs.filter(s => msRowState(s).state === 'ok').length;
    const bad   = segs.filter(s => msRowState(s).state === 'bad').length;
    msCountEl.textContent = bad ? `· ${valid} valid, ${bad} error` : `· ${valid} valid`;
    msCountEl.className = 'ms-count' + (bad ? ' bad' : valid ? ' ok' : '');
  }
  function applyClipMode() {
    const m = state.cfg.clipMode || 'auto';
    msWrap.hidden = (m === 'auto');
    // Clip count / duration are AI-detection knobs. In pure manual mode the
    // pipeline ignores both, so showing them would promise something false.
    document.getElementById('f_clipCountField').hidden    = (m === 'manual');
    document.getElementById('f_clipDurationField').hidden = (m === 'manual');
    if (m !== 'auto') renderManualRows();
  }
  document.getElementById('f_msAdd').addEventListener('click', () => {
    msSave(msSegs().concat({ start: '', end: '' }));
    renderManualRows();
    msRowsEl.querySelector('.ms-row:last-child input')?.focus();
  });
  bindSegment('f_clipMode', v => { saveCfg({ clipMode: v }); applyClipMode(); });
  applyClipMode();

  // [MANUAL-DURATION] The duration segment is no longer a plain value picker:
  // 'manual' is a MODE that reveals a number input, and the stored cfg value is
  // the number itself (not the string 'manual'), so the pipeline's
  // resolveDuration() needs no knowledge of this UI at all.
  const durManualRow  = document.getElementById('f_clipDurationManual');
  const durManualSec  = document.getElementById('f_clipDurationSec');
  const durWarnEl     = document.getElementById('f_clipDurationWarn');

  const clampManualSec = (raw) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return MANUAL_DUR_MIN;
    return Math.max(MANUAL_DUR_MIN, Math.min(MANUAL_DUR_MAX, n));
  };
  const mmss = (sec) => {
    const m = Math.floor(sec / 60), r = Math.round(sec % 60);
    return m ? `${m} mnt${r ? ` ${r} dtk` : ''}` : `${r} dtk`;
  };
  // Rationality check on the numbers ALONE. The renderer never learns the
  // source video's real length (the URL is probed inside the pipeline, not
  // here), so this deliberately does not claim "won't fit" — it states the
  // amount of footage the request implies and lets the user judge. The
  // pipeline still emits its own honest shortfall warning once it knows the
  // real duration.
  function paintDurationWarn() {
    if (!durWarnEl) return;
    const secs = isManualDuration(state.cfg.clipDuration) ? Number(state.cfg.clipDuration)
      : state.cfg.clipDuration === 'auto' ? 90
      : Number(state.cfg.clipDuration) || 0;
    const count = Math.max(1, Number(state.cfg.clipCount) || 1);
    const needed = secs * count;
    const msgs = [];
    if (needed >= 600) {
      msgs.push(`⚠ ${count} clip × ${mmss(secs)} = butuh video minimal ~${mmss(needed)} bahan bicara. Kalau videonya lebih pendek, jumlah clip yang keluar akan kurang.`);
    }
    if (secs > 180) {
      msgs.push('⚠ Clip di atas 3 menit: render jauh lebih lama dan Smart Track jadi kurang halus pada bagian tanpa potongan scene.');
    }
    durWarnEl.innerHTML = msgs.join('<br>');
    durWarnEl.hidden = !msgs.length;
  }

  function applyDurationMode() {
    const manual = isManualDuration(state.cfg.clipDuration);
    if (durManualRow) durManualRow.hidden = !manual;
    paintDurationWarn();
  }

  bindSegment('f_clipDuration', v => {
    if (v === 'manual') {
      // Entering manual mode commits the number currently in the box, so the
      // stored value is always a real duration — never the literal 'manual',
      // which resolveDuration() would silently fall back to AUTO on.
      const sec = clampManualSec(durManualSec?.value ?? 150);
      if (durManualSec) durManualSec.value = String(sec);
      saveCfg({ clipDuration: String(sec) });
    } else {
      saveCfg({ clipDuration: v });
    }
    applyDurationMode();
    if (isManualDuration(state.cfg.clipDuration) || state.cfg.clipDuration === '180') {
      toast('⏳ Durasi panjang: pemrosesan bisa jauh lebih lama — tergantung CPU & RAM PC kamu.');
    }
  });
  if (durManualSec) {
    // Clamp on commit (change/blur), NOT on every keystroke: clamping while
    // typing turns an in-progress "300" into 3 the moment the first digit
    // lands, silently saving a 3-second clip length.
    durManualSec.addEventListener('change', () => {
      const sec = clampManualSec(durManualSec.value);
      durManualSec.value = String(sec);
      saveCfg({ clipDuration: String(sec) });
      paintDurationWarn();
    });
  }
  applyDurationMode();
  document.getElementById('f_deadAir')?.addEventListener('change', async (e) => {
    state.cfg.deadAirCut = !!e.target.checked;
    await saveCfg({ deadAirCut: !!e.target.checked });   // [DEAD-AIR-TOGGLE]
  });
  bindSegment('f_format',       v => { saveCfg({ format: v }); applyStageAspect(v); renderGallery(); });
  bindSegment('f_resolution',   v => saveCfg({ resolution: v }));
  $('#f_subtitleLang').addEventListener('change', e => saveCfg({ subtitleLang: e.target.value.trim() || 'auto' }));
  const capOff = document.getElementById('f_capOff');
  if (capOff) {
    const paint = () => { const v = +capOff.value || 0;
      document.getElementById('f_capOffVal').textContent = (v > 0 ? '+' : '') + v + ' ms'; };
    capOff.addEventListener('input', paint);
    capOff.addEventListener('change', async () => {
      await saveCfg({ subtitleOffsetMs: +capOff.value || 0 });
      paint();
      try { tickCaptionPreview(); } catch {}
    });
  }
  // [BOX-HIGHLIGHT-CLIPOPT] Mirrors the Caption Editor's #ce_box wiring
  // (src/renderer.js, openCaptionEditorInner) — same state.cfg.subtitleBoxColor,
  // same on/off + color-picker shape, just a second surface for it.
  const paintBoxPreview = (color) => {
    const wrap = document.getElementById('f_boxPreview');
    const word = document.getElementById('f_boxPreviewWord');
    if (!wrap || !word) return;
    if (!color) { wrap.hidden = true; return; }
    wrap.hidden = false;
    word.style.background = color;
    word.style.color = window.CaptionBox ? window.CaptionBox.contrastInk(color) : '#000';
    // [PREVIEW-BURN-DRIFT] Set here too, not just in the static markup —
    // the markup's inline value was a copy-typed number that could drift
    // from the real constant the same way the two live previews already
    // did. This is a demo swatch, but "honest simulation" only holds if it
    // actually reads the same source.
    if (window.CaptionBox) {
      const { PAD_EM, RADIUS_EM, BOX_H_EM } = window.CaptionBox;   // [BOX-H-FIXED]
      word.style.borderRadius = `${RADIUS_EM}em`;
      word.style.padding = `0 ${PAD_EM}em`;
      word.style.display = 'inline-block';
      word.style.lineHeight = `${BOX_H_EM}em`;
    }
  };
  paintBoxPreview(state.cfg.subtitleBoxColor || '');   // seed on first render of this panel
  document.querySelectorAll('#f_box button').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_box button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const on = b.dataset.v === 'on';
    const colorInput = document.getElementById('f_boxColor');
    const row = document.getElementById('f_boxColorRow');
    const color = on ? (colorInput?.value || '#F1FF00') : '';
    if (row) row.hidden = !on;
    paintBoxPreview(color);
    await saveCfg({ subtitleBoxColor: color });
    try { tickCaptionPreview(); } catch {}
  }));
  document.getElementById('f_boxColor')?.addEventListener('input', async (e) => {
    paintBoxPreview(e.target.value);
    await saveCfg({ subtitleBoxColor: e.target.value });
    try { tickCaptionPreview(); } catch {}
  });
  // [HOOK-AUTOBURN] On/off + preset for the pipeline's auto hook.
  document.querySelectorAll('#f_hook button').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_hook button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const on = b.dataset.v === 'on';
    const pick = document.getElementById('f_hookPick');
    if (pick) pick.hidden = !on;
    await saveCfg({ hookAutoBurn: on });
  }));
  document.querySelectorAll('#f_hookPick .f_hookPreset').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_hookPick .f_hookPreset').forEach(x => { x.style.borderColor = 'rgba(255,255,255,.12)'; });
    b.style.borderColor = 'var(--lime)';
    await saveCfg({ hookPreset: b.dataset.preset });
  }));
  document.querySelectorAll('#f_hookCase button').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_hookCase button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    await saveCfg({ hookCase: b.dataset.case || '' });   // [HOOK-CASE]
  }));
  document.getElementById('f_capDim')?.addEventListener('input', async (e) => {
    const d = Math.max(0, Math.min(0.6, (+e.target.value || 0) / 100));
    state.cfg.captionDim = d;
    const v = document.getElementById('f_capDimVal'); if (v) v.textContent = `${Math.round(d * 100)}%`;
    syncDimLayers();
    await saveCfg({ captionDim: d });   // [CAP-DIM]
  });
  document.querySelectorAll('#f_anim button').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_anim button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.cfg.subtitleAnim = b.dataset.v;
    await saveCfg({ subtitleAnim: b.dataset.v, captionKinetic: '' });
    previewApplyClipOpts();
  }));
  document.querySelectorAll('#f_wpc button').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_wpc button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const v = b.dataset.v === 'auto' ? 'auto' : +b.dataset.v;   // [WPC-AUTO]
    state.cfg.subtitleWordsPerChunk = v;
    await saveCfg({ subtitleWordsPerChunk: v });   // [CLIPOPT-ANIM-WPC]
    previewApplyClipOpts();
  }));
  document.querySelectorAll('#f_brollStyle button').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_brollStyle button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.cfg.collageStyle = b.dataset.v;
    await saveCfg({ collageStyle: b.dataset.v });   // [BROLL-STYLES]
  }));
  for (const [id, key] of [['f_hookTeaserSec', 'hookTeaserSec'], ['f_brollSec', 'brollSec']]) {   // [INSERT-SEC]
    document.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener('click', async () => {
      document.querySelectorAll(`#${id} button`).forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const v = b.dataset.v === 'auto' ? 'auto' : +b.dataset.v;
      state.cfg[key] = v;
      await saveCfg({ [key]: v });
    }));
  }
  for (const [id, key] of [['f_hookTeaser', 'hookTeaser']]) {   // [CLIP-TIMELINE]
    document.getElementById(id)?.addEventListener('change', async (e) => {
      state.cfg[key] = !!e.target.checked;
      await saveCfg({ [key]: !!e.target.checked });
    });
  }
  document.getElementById('f_broll')?.addEventListener('change', async (e) => {
    state.cfg.collageBroll = !!e.target.checked;
    await saveCfg({ collageBroll: !!e.target.checked });   // [COLLAGE-BROLL]
  });
  refreshKineticCards();   // [KINETIC-CARD] fonts may still be loading
  document.querySelectorAll('#f_vfx .f_vfx').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_vfx .f_vfx').forEach(x => { x.style.borderColor = 'rgba(255,255,255,.12)'; });
    b.style.borderColor = 'var(--lime)';
    await saveCfg({ videoFx: b.dataset.fx || '' });
  }));
  document.querySelectorAll('#f_capKin .f_capKin, #f_capCc .f_capKin').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#f_capKin .f_capKin, #f_capCc .f_capKin').forEach(x => { x.style.borderColor = 'rgba(255,255,255,.12)'; });
    b.style.borderColor = 'var(--lime)';
    const kinetic = b.dataset.kin || '';
    await saveCfg({ captionKinetic: kinetic, ...(kinetic ? { subtitleBoxColor: '' } : {}) });
    previewApplyClipOpts();
  }));
  wireBurnFontPanel();
  wireCaptionPlacementPanel();
  // The brief at the top doubles as a shortcut to the caption-style section.
  document.getElementById('f_styleCue')?.addEventListener('click', () => {
    document.getElementById('f_styleStart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  wireOfflineAsrPanel();
  wireContextModelPanel();
  // v3: iOS-style switches at the top of the panel (replaced ON/OFF segments).
  const burnQ  = document.getElementById('f_burnQ');
  const smartQ = document.getElementById('f_smartQ');
  if (burnQ) burnQ.addEventListener('change', () => {
    saveCfg({ burnSubtitles: burnQ.checked });
    const help = document.getElementById('f_burnHelp');
    if (help) help.innerHTML = burnHelpHtml(burnQ.checked);
    _lastPreviewCue = ''; try { tickCaptionPreview(); } catch {}   // [SUBS-TOGGLE] preview follows at once
  });
  // [AP-HELP] Once the tracker runtime is installed, the download note turns
  // into a ready line; until then it stays as the how-to.
  const trackerHelp = document.getElementById('f_trackerHelp');
  if (trackerHelp) window.socl.tracker.ready().then((ok) => {
    if (!ok || !trackerHelp.isConnected) return;
    trackerHelp.classList.add('is-ok');
    trackerHelp.textContent = '✓ Sudah terpasang di Mac/PC ini — siap dipakai.';
  }).catch(() => {});
  const asdModeQ = document.getElementById('f_asdModeQ');
  const asdModeRow = document.getElementById('f_asdModeRow');
  if (smartQ) smartQ.addEventListener('change', async () => {
    if (smartQ.checked && !(await window.socl.tracker.ready())) {
      const ok = await promptInstallTracker();
      if (!ok) { smartQ.checked = false; return; }
    }
    saveCfg({ smartTrack: smartQ.checked });
    // Engine choice only matters (and only shows) while Smart Face Tracking
    // itself is on — hide it rather than leave a dangling toggle for a
    // feature that is currently off.
    if (asdModeRow) asdModeRow.style.display = smartQ.checked ? '' : 'none';
  });
  if (asdModeQ) asdModeQ.addEventListener('change', () => {
    saveCfg({ trackerAsdMode: asdModeQ.checked ? 'motion_vad' : 'blendshape' });
  });
  document.getElementById('f_reviewClips')?.addEventListener('click', openClipReview);
}

function renderStylePanel() {
  // Style panel removed — kept as no-op for backward compatibility with any
  // old rail-click hooks. Batch render buttons live in the gallery batch bar
  // (index.html #galleryBatch) and per-clip styling lives in Caption Editor.
  els.panelEyebrow.textContent = '';
  els.panelTitle.textContent = '';
  els.panelBody.innerHTML = `<div class="empty">Buka klip di Editor untuk styling per-clip.</div>`;
  return;
  // eslint-disable-next-line no-unreachable
  $('#f_renderAll') && $('#f_renderAll').addEventListener('click', () => batchRenderClips(state.clips.map((_,i) => i)));
  $('#f_renderHot') && $('#f_renderHot').addEventListener('click', () => {
    const hotIdx = state.clips.map((c,i) => ({ c, i })).filter(({ c }) => isHot(c)).map(({ i }) => i);
    if (!hotIdx.length) { toast('No hot clips. Tap 🔥 on a clip to mark it hot.', 'err'); return; }
    batchRenderClips(hotIdx);
  });
  applyCaptionStyle();
}

// Stage aspect-ratio follows the selected output format.
// Pure CSS aspect-ratio + height:100% + max-width:100% breaks for landscape
// because max-width caps width but height stays full → ratio violated.
// Instead we compute pixel dimensions from the container so both axes are correct.
const FORMAT_AR = { face: '9/16', blur: '9/16', square: '1/1', landscape: '16/9' };
function applyStageAspect(fmt) {
  const ar = FORMAT_AR[fmt || (state.cfg && state.cfg.format) || 'face'] || '9/16';
  els.stage.style.setProperty('--stage-ar', ar);

  const [wR, hR] = ar.split('/').map(Number);
  const card = els.stage?.parentElement;
  if (card) {
    // Subtract card padding (18px each side = 36px) from available space
    const maxW = Math.max(60, card.clientWidth - 36);
    const maxH = Math.max(60, card.clientHeight - 36);
    // Find largest box with the right ratio that fits in maxW × maxH
    let sw = maxW, sh = maxW * hR / wR;
    if (sh > maxH) { sh = maxH; sw = maxH * wR / hR; }
    els.stage.style.width  = Math.floor(sw) + 'px';
    els.stage.style.height = Math.floor(sh) + 'px';
  }

  requestAnimationFrame(applyCaptionStyle);
}

// Position + style the live caption overlay to mirror what will be burned in.
// subtitleY is in ASS PlayResY units (1920) — map to overlay pixel height.
function applyCaptionStyle() {
  const c = state.cfg; if (!c || !els.captionOv) return;
  // [CAPTION-FIT-WIDTH-PREVIEW] className (which carries the CSS-driven font
  // for the "no burn-font override" case, via .caption-overlay.style-X rules)
  // must be current BEFORE the fit-width measurement further down reads
  // els.captionTx's rendered width — moved up from the end of this function
  // so a style change takes effect on the SAME frame it's cached under,
  // instead of caching a ratio measured against last frame's stale font.
  const anim = c.subtitleAnim || 'pop';
  const animCls = ['pop','fade','rise','drop','zoom','blur'].includes(anim) ? ` anim-${anim}` : '';
  const glowCls = c.subtitleGlow === false ? ' no-glow' : '';
  els.captionOv.className = `caption-overlay style-${c.subtitleStyle || 'neon_green'}${animCls}${glowCls}`;
  // Use the TARGET height applyStageAspect just set, not clientHeight: the
  // stage animates width/height over .22s (CSS transition), so clientHeight
  // mid-transition still reports the old size. Reading it right after a
  // maximize/restore froze the font at the previous stage size — captions
  // looked too small in full screen and too big back at default.
  const styleH = parseFloat(els.stage?.style.height);
  const stageH = (Number.isFinite(styleH) && styleH > 0) ? styleH : (els.stage?.clientHeight || 1);
  // Width twin of stageH — same explicit-style-first rule, needed by the
  // fit-width block below (mirrors the Caption Editor's own stageW()).
  const styleW = parseFloat(els.stage?.style.width);
  const stageW = (Number.isFinite(styleW) && styleW > 0) ? styleW : (els.stage?.clientWidth || 1);
  // ASS render uses Alignment 8 (top-center): the text's top edge sits at subtitleY.
  // Preview anchors the overlay's top edge at the same fraction to match exactly.
  const top = Math.round(Math.max(0, Math.min(stageH - 30, (c.subtitleY / 1920) * stageH)));
  els.captionOv.style.top = top + 'px';
  els.captionOv.style.bottom = 'auto';
  // X: position center of overlay at X% of stage width (ASS PlayResX=1080, center=540=50%)
  const xPct = ((c.subtitleX || 540) / 1080 * 100).toFixed(2);
  els.captionOv.style.left = xPct + '%';
  els.captionOv.style.transform = 'translateX(-50%)';
  // Font: 1:1 scale from ASS px (PlayResY=1920) to overlay px so preview matches render.
  const fs = Math.max(10, (c.subtitleFontSize / 1920) * stageH);
  els.captionTx.style.fontSize = fs.toFixed(2) + 'px';
  // [CASE-V1] Dashboard preview honours the same text-case setting.
  els.captionTx.style.textTransform = CASE_CSS[c.subtitleCase] || 'none';
  // [BURN-FONT] Mirror the burn's font override in the preview. Clearing it
  // hands control back to the per-style CSS rule, so switching back to
  // "Default (ikut gaya)" restores the style's own face instead of pinning
  // whatever was last chosen.
  // [BURN-FONT] Written with `important` priority on purpose. Two style rules
  // in styles.css pin the face with `!important` (.style-cinematic_white and
  // .style-inverse_auto, i.e. the "Subtract" look), and a normal inline style
  // LOSES to those — so picking any font while Subtract was selected changed
  // the burn and left the preview showing Open Sauce. Clearing it must remove
  // the property entirely, or "Default (ikut gaya)" would stay pinned to
  // whatever was chosen last.
  //
  // Tracking rides along with the face for the same reason the burn does it
  // (see [BURN-FONT-TRACK] in buildAss): a face carries its own optical
  // tightening, and showing the style's instead is a preview/burn mismatch in
  // the one place captions are judged. titleFontTracking mirrors the burn's
  // fontTrackEm; a face with no entry keeps the style's spacing.
  const bf = BURN_FONTS.find(f => f.value && f.value === (c.subtitleFont || ''));
  if (bf) {
    els.captionTx.style.setProperty('font-family', bf.css, 'important');
  } else {
    els.captionTx.style.removeProperty('font-family');
  }
  // [TRACK-UNIFORM] Letter-spacing used to be set ONLY inside the `if (bf)`
  // branch above and removed otherwise — "no font override" fell back to
  // whatever styles.css said for that .style-X, which is exactly the stale
  // per-font ladder (-0.02em … -0.10em, and 0 for neon) this app spent a
  // whole release unifying away from. Every burned caption now tracks at one
  // shared value (TRACK_EM in pipeline-inverse-v1.js) except Pinyon Script —
  // and no SUB_STYLES default font IS Pinyon Script, only the font PICKER
  // offers it — so the dashboard forces the shared value unconditionally when
  // there is no override, and defers to titleFontTracking (which knows the
  // Pinyon exemption) only when the picker chose a specific face.
  // `!important`: two style rules (.style-cinematic_white, .style-inverse_auto)
  // pin letter-spacing with `!important` themselves, and a plain inline value
  // loses to those.
  // [PINYON-TRACK] Always written: Pinyon gets an explicit 'normal' — see fontTrackCss.
  els.captionTx.style.setProperty('letter-spacing', fontTrackCss(bf && bf.value), 'important');
  // [CAPTION-FIT-WIDTH-PREVIEW] Mirrors buildAss's [CAPTION-FIT-WIDTH]
  // (pipeline-inverse-v1.js) — see the matching block in applyCE() (Caption
  // Editor preview) for the full rationale. That burn-only mechanism shrinks
  // the caption font size for the WHOLE CLIP the instant even one cue's text
  // would overflow the frame; the dashboard preview never applied the same
  // shrink. Reuses the real els.captionTx element (font/weight/tracking/case
  // already settled above) to measure each cue's flat text width, same
  // principle as [TITLE-FIT-WIDTH]'s live-DOM scrollWidth read. Cached on the
  // active clip object, keyed by a content/style signature, so the reflow-
  // forcing per-cue scan only runs when cues or caption style actually
  // changed — not on every rAF-driven call to this function.
  const fitClip = state.clips && state.clips[state.activeClip];
  if (fitClip) {
    const fitCues = state.cueWords || [];
    const fitSig = JSON.stringify([fitCues.map(w => w.text), c.subtitleFont, c.subtitleFontSize, c.subtitleStyle]);
    if (fitClip._capFitSig !== fitSig) {
      const savedHTML = els.captionTx.innerHTML;
      const fitMaxW = stageW * 0.9259;
      const fitTrim = captionFitTrimPx(els.captionTx);   // [FIT-WIDTH-PAD]
      let fitWidest = 0;
      for (const cue of fitCues) {
        els.captionTx.textContent = cue.text || '';
        const w = els.captionTx.scrollWidth - fitTrim;
        if (w > fitWidest) fitWidest = w;
      }
      els.captionTx.innerHTML = savedHTML;
      fitClip._capFitSig = fitSig;
      fitClip._capFitRatio = (fitWidest > fitMaxW && fitWidest > 0) ? fitMaxW / fitWidest : 1;
    }
    if (fitClip._capFitRatio < 1) {
      els.captionTx.style.fontSize = `${Math.max(10, fs * fitClip._capFitRatio).toFixed(2)}px`;
    }
  }
}

// [FIT-WIDTH-PAD] What a caption element's scrollWidth carries that the
// burn's [CAPTION-FIT-WIDTH] measurement does not: the span's own side padding
// (`padding:0 6px` in styles.css — fixed CSS px, so a bigger share of a SMALL
// stage) and the letter-spacing after the last glyph (libass's line ends at
// the glyph; textWidth + trk×(len−1) in the burn). With them counted, a cue
// within a few % of the limit shrank every caption of the clip in the Caption
// Editor (small stage) but not in the dashboard or the video — measured on a
// 5-word neon cue: burn and dashboard full size, editor 30% smaller.
function captionFitTrimPx(el) {
  try {
    const cs = getComputedStyle(el);
    return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.letterSpacing) || 0);
  } catch { return 0; }
}
// Restart a caption element's CSS intro animation (force reflow). Called each
// time the active cue text changes so every word "pops"/blurs in, matching the
// burned ASS per-cue animation.
function restartCaptionAnim(txEl) {
  if (!txEl) return;
  txEl.style.animation = 'none';
  void txEl.offsetWidth; // reflow — restarts container-level class animations
  txEl.style.animation = '';
  // Per-word inline `animation:` overrides live on descendant .pw-tok spans
  // (see baseStyle in paintCue). Reflow alone won't replay them — clear then
  // restore the exact value so the keyframe starts from frame 0 each cue.
  txEl.querySelectorAll('.pw-tok').forEach(sp => {
    const inl = sp.style.animation;
    if (!inl) return;
    sp.style.animation = 'none'; void sp.offsetWidth; sp.style.animation = inl;
  });
}
// [CAP-NO-REPLAY] Write caption markup only when it actually changed. A CSS
// intro animation starts over on every element that is (re)created, and the
// dashboard tick runs on every `timeupdate` (~4×/s) — rewriting the same
// innerHTML each time replayed the pop/rise/drop on every span inside the
// caption (the highlight word, the box word) four times a second: the
// "caption kedip-kedip" report. `_capSer` catches anything else having
// touched the element since (fit-width measuring, a clear), so a skipped
// write can never leave stale text on screen.
function paintCaptionHtml(el, html) {
  if (el._capHtml === html && el.innerHTML === el._capSer) return false;
  el.innerHTML = html;
  el._capHtml = html;
  el._capSer = el.innerHTML;
  return true;
}
// [CAP-NO-REPLAY] Jump every animation INSIDE a caption element (not the
// element's own) to its end state. Used when the same cue is repainted only
// because a style changed: the new spans should show the new look, not play
// their intro again.
function settleCaptionAnim(el) {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations({ subtree: true })) {
    if (a.effect && a.effect.target !== el) { try { a.finish(); } catch {} }
  }
}
// For highlight styles (bw_neon_*) the last word of each cue is wrapped in a
// neon-coloured span. Other styles fall back to plain textContent.
// [HL-PALETTE] Which styles tint the trailing word, and with what. Mirrors
// SUB_STYLES.highlight / .highlightCycle in pipeline-inverse-v1.js — the two
// tables live in different processes and cannot import each other, so only a
// test stops them drifting (see test/caption-highlight.test.js).
const HIGHLIGHT_ACCENT = { bw_neon_green: 'green', bw_neon_yellow: 'yellow',
  bw_hi_lime: 'lime', bw_hi_red: 'red', bw_hi_white: 'white', bw_hi_rainbow: 'cycle',
  white_hi_lime: 'limegreen' };
// The rotating palette, in the SAME order as SUB_STYLES.bw_hi_rainbow's
// highlightCycle. Index n is used by cue n — deterministic, so the preview can
// predict exactly what the burn is about to do.
const HIGHLIGHT_CYCLE_CSS = ['#d2f96f', '#ff3b30', '#f1ff00', '#ff9540'];
// Resolve a style + cue index to a `.cap-hi-*` suffix. The rotating accent maps
// to positional classes (c0…c3) rather than an inline colour on purpose: an
// inline `!important` colour would outrank the `.no-glow .cap-hi-*` rule that
// strips the halo when glow is off, so the glow-off variant would silently keep
// its halo. Classes let the existing cascade keep working untouched.
function hiAccentFor(style, cueIdx) {
  const a = HIGHLIGHT_ACCENT[style];
  if (!a) return null;
  if (a !== 'cycle') return a;
  const n = HIGHLIGHT_CYCLE_CSS.length;
  return `c${(((cueIdx | 0) % n) + n) % n}`;
}
// [CASE-V1] Map the subtitleCase setting to a CSS text-transform value.
const CASE_CSS = { none: 'none', upper: 'uppercase', lower: 'lowercase' };
function setCueText(el, txt, style, cueIdx = 0) {
  if (!el) return;
  // [CAP-NO-REPLAY] Every write goes through paintCaptionHtml — see there.
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (!txt) { paintCaptionHtml(el, ''); return; }
  const accent = hiAccentFor(style, cueIdx);   // [HL-PALETTE] may rotate per cue
  if (!accent) { paintCaptionHtml(el, esc(txt)); return; }
  const idx = txt.lastIndexOf(' ');
  const cls = `cap-hi cap-hi-${accent}`;
  paintCaptionHtml(el, idx <= 0
    ? `<span class="${cls}">${esc(txt)}</span>`
    : `${esc(txt.slice(0, idx))} <span class="${cls}">${esc(txt.slice(idx + 1))}</span>`);
}
// [BOX-HIGHLIGHT-CLIPOPT] Dashboard-level counterpart to the Caption Editor's
// updateBoxHighlightPreview(). The editor already renders every word as its
// own .pw-tok span (paintCue), so it only needs to flip a style on the right
// one. This preview does NOT — setCueText() above renders flat text (or one
// trailing-word span) — so box mode here builds its own per-word spans from
// scratch. Falls back to setCueText() unchanged whenever box is off or the
// cue has no per-word timing, so every existing caller/behaviour is untouched.
function applyBoxRotationPreview(span, color, rotation) {
  if (!span) return;
  const angle = window.CaptionBox?.boxRotation(rotation) || 0;
  if (!document.getElementById('caption-box-rotation-css')) {
    const sheet = document.createElement('style');
    sheet.id = 'caption-box-rotation-css';
    sheet.textContent = '.cap-box-rotated{position:relative!important;isolation:isolate}.cap-box-rotated::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:var(--cap-box-color);border-radius:inherit;transform:rotate(var(--cap-box-angle));transform-origin:50% 50%}';
    document.head.appendChild(sheet);
  }
  span.classList.toggle('cap-box-rotated', angle !== 0);
  span.style.setProperty('background', angle ? 'transparent' : color, 'important');
  span.style.setProperty('--cap-box-angle', `${angle}deg`);
  span.style.setProperty('--cap-box-color', color);
}
function setCueTextWithBox(el, cue, t, style, cueIdx, boxColor, baseFs) {
  // [BOX-RIGHT-EDGE] Horizontal padding for a caption box word whose glyphs
  // carry `lsPx` of letter-spacing. CSS adds that spacing after every glyph,
  // the last one too, so negative tracking pulls the span's right edge |ls|
  // inside the word while the burn draws the box from the word's visual edges
  // (boxWordLayoutPx widths). Measured at 70px, -0.07em: preview box 137px vs
  // burn 143px, all of it on the right. The right padding takes |ls| more and
  // the margin gives it back, so no word in the line moves.
  function boxPadCss(PAD_EM, lsPx) {
    if (!lsPx) return `padding:0 ${PAD_EM}em`;
    const ls = +lsPx.toFixed(3);
    return `padding:0 calc(${PAD_EM}em ${ls < 0 ? '+' : '-'} ${Math.abs(ls)}px) 0 ${PAD_EM}em;margin-right:${ls}px`;
  }
  if (!el) return;
  const txt = cue?.text || '';
  // [BOX-HIGHLIGHT] Derived fresh from tokens+cue bounds every call — not
  // read from a stored `.words` field. See deriveWordTiming in
  // src/caption-box.js for why: a stored parallel array is what silently
  // desynced from the burned text at 8 different edit sites.
  const words = (window.CaptionBox && Array.isArray(cue?.tokens))
    ? window.CaptionBox.deriveWordTiming(cue.tokens, cue.start, cue.end)
    : null;
  // [BOX-ELIGIBLE] Same rule as the burn and the editor preview.
  if (!txt || !boxColor || !words || !words.length || !window.CaptionBox
      || (window.CaptionBox.boxEligible && !window.CaptionBox.boxEligible(cue, style))) {
    setCueText(el, txt, style, cueIdx);
    return;
  }
  const idx = words.findIndex(w => t >= w.start && t < w.end);
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const ink = window.CaptionBox.contrastInk(boxColor);
  // [BOX-SPAN-FONT-LEAK] `.caption-overlay span` (styles.css) hardcodes
  // font-size:18px + a fixed font-family for the OLD trailing-word highlight
  // — any bare <span> here gets caught, including this one, so the box word
  // silently ignored both the font-size slider and the font picker. The
  // Caption Editor already hit this exact class of bug once (see [BURN-FONT]
  // and the [TITLE-STYLE-LEAK-FIX] comment on the editor's own span rule);
  // `inherit !important` here delegates back to whatever applyCaptionStyle()
  // already set correctly on the PARENT (#captionText), instead of hardcoding
  // a second copy of the font logic that could drift from the real one.
  // [PREVIEW-BURN-DRIFT] PAD_EM/VPAD_EM/RADIUS_EM dari window.CaptionBox —
  // sebelumnya di sini ditulis 0.25em/0.05em sendiri, beda dari angka yang
  // benar-benar dipakai buildAss (0.25em horizontal tapi 0.12em×2 vertikal,
  // radius 0.09em bukan 0.25em). Preview jadi terlihat lebih pipih dan
  // kurang membulat dari hasil burn sungguhan. Sekarang satu sumber angka.
  // [BOX-H-FIXED] Same explicit-height treatment as updateBoxHighlightPreview:
  // inline-block + line-height:BOX_H_EM is what makes the CSS background
  // exactly as tall as the burn's box, since an inline span's background is
  // the browser's font content-box and padding can only grow it, never shrink.
  const { PAD_EM, RADIUS_EM, BOX_H_EM } = window.CaptionBox;
  // The box word inherits the line's letter-spacing (`inherit !important`
  // below), so the parent's computed value is the one its glyphs carry.
  let lsPx = 0;
  try { lsPx = parseFloat(getComputedStyle(el).letterSpacing) || 0; } catch {}
  const boxSpanStyle = `background:${boxColor};color:${ink} !important;border-radius:${RADIUS_EM}em;${boxPadCss(PAD_EM, lsPx)};`
    + `line-height:${BOX_H_EM}em;`
    + `box-decoration-break:clone;-webkit-box-decoration-break:clone;`
    + `font-family:inherit !important;font-size:inherit !important;font-weight:inherit !important;`
    + `letter-spacing:inherit !important;text-shadow:none !important;display:inline-block !important`;
  // [MC-SIZE-PARITY] A word may carry its own size/face (Manual Caption's
  // SIZE/font, and per-word overrides generally). This painter used to emit
  // bare text plus one boxed span pinned to font-size:inherit, so every such
  // override vanished the instant box highlight was on — paintCue() honoured
  // them and this did not, which is one value rendering at two sizes.
  //
  // Size is expressed RELATIVE to the parent (em), not in px: the parent
  // already carries the style's size at the right scale for this surface, so
  // a ratio needs no second copy of the canonical-1920 maths and matches the
  // burn, where base and override go through the identical conversion.
  const _base = +baseFs || 0;
  // [DASH-BOX-WORD] Bold/italic/colour too: boxEligible() lets b/i/color
  // through and the burn's wordRichTag draws all three (colour on every word
  // except the boxed one, whose ink stays contrastInk). This painter used to
  // drop them, so a bold or coloured word looked plain here and only in the
  // dashboard. A span that does get emitted keeps the parent's face and
  // tracking explicitly: `.caption-overlay.style-X span` rules hit it directly
  // and would otherwise swap in the style's own font/letter-spacing — the
  // burn's box path stamps ONE line-level \fsp on every word.
  const wordCss = (w, active) => {
    const st = w.style || null;
    if (!st) return '';
    const out = [];
    if (st.fs && _base > 0) out.push(`font-size:${(st.fs / _base).toFixed(4)}em !important`);
    if (st.fn) out.push(`font-family:&quot;${st.fn}&quot; !important`);
    if (st.b != null) out.push(`font-weight:${st.b ? '700' : '400'} !important`);
    if (st.i) out.push('font-style:italic !important');
    if (st.color && !active) out.push(`color:${st.color} !important`);
    if (!out.length) return '';
    if (!st.fn) out.push('font-family:inherit !important');
    out.push('letter-spacing:inherit !important');
    return out.join(';');
  };
  paintCaptionHtml(el, words.map((w, i) => {
    const css = wordCss(w, i === idx);
    if (i === idx) {
      // The box span pins font-size:inherit so it tracks the parent; a word
      // with its own size must override that on the SAME span, after it.
      return `<span class="cap-box-word" style="${boxSpanStyle}${css ? ';' + css : ''}">${esc(w.text)}</span>`;
    }
    return css ? `<span style="${css}">${esc(w.text)}</span>` : esc(w.text);
  }).join(' '));
  applyBoxRotationPreview(el.querySelector('.cap-box-word'), boxColor, state.cfg.subtitleBoxRotation);
}
// Replay the main-preview caption intro (used when toggling the Animation mode).
function replayCaptionAnim() {
  if (!els.captionOv) return;
  applyCaptionStyle();
  restartCaptionAnim(els.captionTx);
}
let _lastPreviewCue = '';

// ── [TITLE-PARITY] Shared persistent-title painter ───────────────────
// Reported: "apply title tidak sesuai dari tab edit-nya dan preview dashboard-nya
// beda". Root cause: the title overlay existed ONLY inside the caption editor
// (#capTitleLayer). The dashboard preview drew subtitles and nothing else, so a
// title added via the editor or the hook tab was invisible there — and any later
// divergence between two copies of the paint code would show up as drift.
// Fix: ONE painter, called by both stages. The editor passes interactive opts
// (drag + word selection); the dashboard passes none. Identical DOM, identical
// CSS classes, identical ASS→px mapping ⇒ preview == editor == burn.

// Per-font optical tightening — mirrors FONT_EM on the burn side so the preview
// spacing matches libass. Kept in one place; both wordCss paths call it.
// [TRACK-UNIFORM] MUST stay identical to fontTrackEm()/TRACK_EM in
// pipeline-inverse-v1.js — this is the preview half of the same number, and the
// two drifting apart is exactly the bug this replaced. The old per-font ladder
// (-0.02 … -0.10) only ever shaped THIS side: libass silently discarded the
// negative Spacing the burn sent, so no ladder value ever reached a rendered
// caption. See the [FSP-NEGATIVE] note in buildAss for the measurements.
const TRACK_EM_CSS = '-0.07em';
// [TITLE-WORD-GAP] Doubles an em letter-spacing string (e.g. '-0.07em' →
// '-0.14em') for the title container's inter-word gap tracking — see the long
// note at the el.style.letterSpacing assignment in paintTitleLayer for why the
// gap needs 2× the per-word value to match libass's two-sided \fsp.
function emTrackTimes2(cssEm) {
  const n = parseFloat(cssEm);
  if (!isFinite(n) || n === 0) return 'normal';
  return `${+(n * 2).toFixed(4)}em`;
}
const TITLE_GAP_TRACK_CSS = emTrackTimes2(TRACK_EM_CSS);   // '-0.14em'
// [TITLE-CENTER] New-title defaults — shared by both creation sites (the
// gallery card's "Ke video" button and the Caption Editor's "+ Add title")
// so they can never drift apart again (see the [TITLE-PARITY] note at both
// call sites — they already had to be fixed once for landing at different Y).
// x:540 is centre-X on the CANONICAL 1080-wide authoring space, and buildAss
// scales it by PR.w/1080 for whichever aspect the clip actually renders at —
// so 540 is already dead-centre on every ratio (square/landscape/portrait),
// nothing ratio-specific needed there. Y previously started at 700 (upper-
// third, reads as "stuck at the top") and only ever grew downward; centred
// here on 960 (true vertical centre of the 1920-tall canonical space) and
// staggered OUTWARD in both directions so a 2nd/3rd title doesn't land
// exactly on top of the first.
const TITLE_DEFAULT_X = 540;
const TITLE_Y_OFFSETS = [0, 170, -170, 340, -340];
function titleDefaultY(existingCount) {
  return 960 + TITLE_Y_OFFSETS[existingCount % TITLE_Y_OFFSETS.length];
}
// A hook title only needs to be readable for a beat, not linger — 3.5s sits
// in the middle of the "3-4s" the title's own actual on-screen time should be.
const TITLE_DEFAULT_DUR = 3.5;
function titleFontTracking(fn) {
  if (!fn) return null;
  // Pinyon Script is a connected script — tightening breaks its letter joins.
  if (/Pinyon/i.test(fn)) return null;
  return TRACK_EM_CSS;
}
// [PINYON-TRACK] The letter-spacing the burn actually uses for text set in
// face `fn` (no face = the style default), as a value that can be WRITTEN.
// titleFontTracking's null for Pinyon means "do not tighten", but every caller
// that turned that null into "write nothing" / removeProperty handed control
// to a stylesheet rule (`.style-X span{letter-spacing:-0.07em}`), so Pinyon
// previewed tightened while the burn emits \fsp0 (fontTrackEm → 0).
// Measured: -73 px line width in the dashboard, -69 px in the editor.
function fontTrackCss(fn) {
  if (!fn) return TRACK_EM_CSS;
  return titleFontTracking(fn) || 'normal';
}

// Materialise a title's word tokens from its flat text, preserving existing
// per-word styles by index (module scope so both stages agree on tokenisation).
function ensureTitleTokens(T) {
  const words = String(T.text || '').trim().split(/\s+/).filter(Boolean);
  const cur = Array.isArray(T.tokens) ? T.tokens : [];
  const sameShape = cur.length === words.length && cur.every((tk, i) => tk.text === words[i]);
  if (!sameShape) {
    T.tokens = words.map((w, i) => ({ text: w, style: (cur[i] && cur[i].style) ? cur[i].style : undefined }));
  }
  return T.tokens;
}

// [TITLE-FONT] Inline per-word CSS. EVERY property is `!important` because the
// per-style rules in styles.css (`.cap-overlay.style-inverse_auto span`,
// `.style-cinematic_white span`) declare font-family/weight/colour with
// `!important` themselves and match this very span — without the flag a font
// change was written to the DOM but never rendered ("font tidak auto update
// kalau diganti"). Same gotcha the caption baseStyle path already handles.
// `titleFn` is the title-level font (T.fn); a per-word st.fn overrides it.
// [HOOK-WORD] Brand lime — matches buildAss's fallback (&H00FFF1 BGR = #F1FF00
// RGB) for the two title defaults (inverse_auto/white_clean), which carry no
// SUB_STYLES `.highlight` of their own. A title using one of the few styles
// that DO define one (bw_hi_lime, white_hi_lime, …) will preview this brand
// colour but burn that style's own — a small, accepted drift for a rare style
// choice rather than porting SUB_STYLES' highlight table into the renderer.
const HOOK_WORD_COLOR = '#F1FF00';
// [TITLE-BOX-H] Tinggi kotak judul, dalam em ukuran px kata itu sendiri —
// rumus yang SAMA dengan titleBoxRects di burn: BOX_H_EM ditala pada face
// bawaan (emScale 1,237), jadi artinya "0,97 x ukuran ASS", dan ukuran ASS =
// px x emScale face kata itu. Dulu pratinjau memakai BOX_H_EM mentah untuk
// semua face; untuk Anton kotaknya 40px di pratinjau lawan 56px di video.
// `m` = margin tegak yang mengembalikan selisihnya, supaya slot baris (dan
// baseline, dan semua baris di bawahnya) tidak bergeser. Metrik belum ada
// (IPC masih jalan) -> angka lama, tanpa geser.
const TITLE_BOX_REF_EMSCALE = 1.237;
//
// [TITLE-BOX-VCENTER] `dEm` menggeser KOTAK ke bawah (negatif: ke atas) relatif
// terhadap teksnya, lewat padding atas/bawah yang tak sama: tinggi latar tetap
// `h`, margin-box tetap `slot`, dan baseline tetap di tempat kata tanpa kotak.
// Hasil: lh = line-height dalam, pt/pb = padding, mt/mb = margin tegak.
function titleBoxVertEm(emScale, slotLh, dEm) {
  const { BOX_H_EM } = window.CaptionBox;
  const h = (+emScale > 0) ? (BOX_H_EM / TITLE_BOX_REF_EMSCALE) * emScale : BOX_H_EM;
  const slot = (+slotLh > 0) ? +slotLh : BOX_H_EM;
  const m = (slot - h) / 2;
  const d = (Number.isFinite(+dEm) && Math.abs(+dEm) < h / 4) ? +dEm : 0;
  return {
    h, m, d,
    lh: h - 2 * Math.abs(d),
    pt: Math.max(0, -2 * d), pb: Math.max(0, 2 * d),
    mt: m + d, mb: m - d,
  };
}

// [TITLE-BOX-VCENTER] Selisih pusat kotak pratinjau terhadap burn, dalam em.
// Burn memusatkan kotak pada tinta (fontInkCenterEm, [BOX-VCENTER-INK]) — titik
// `baselineEm - inkCenterEm` di atas baseline. Latar span CSS berpusat di
// (ascent - descent)/2 di atas baseline, angka kotak font Chrome. Untuk Anton
// keduanya beda ~0,09em: kotak di pratinjau 3px lebih tinggi dari video di
// panggung 540px. Hanya untuk face yang benar-benar dideklarasikan @font-face:
// untuk nama lain canvas jatuh ke font pengganti dan angkanya karangan.
const _declaredFaces = new Set();
function titleBoxShiftEm(m) {
  if (!m || !m.face || !Number.isFinite(+m.inkCenterEm) || !Number.isFinite(+m.baselineEm)) return 0;
  try {
    if (!_declaredFaces.size && typeof document !== 'undefined' && document.fonts) {
      document.fonts.forEach((f) => _declaredFaces.add(String(f.family).replace(/["']/g, '')));
    }
  } catch { return 0; }
  if (!_declaredFaces.has(m.face)) return 0;
  const css = titleInkMetricsCss(`"${m.face}"`);
  if (!css) return 0;
  const d = (css.ascEm - css.descEm) / 2 - (+m.baselineEm - +m.inkCenterEm);
  return Math.abs(d) <= 0.3 ? d : 0;
}

function titleWordCss(st, H, titleFn, isHook, boxColor, trackEm, glowColor, boxRun, boxGeom) {
  const s = [];
  const fn = st.fn || titleFn || '';
  if (fn) s.push(`font-family:&quot;${fn}&quot; !important`);
  // [TRACK-UNIFORM] Tracking used to be set ONLY inside `if (fn)` above — a
  // title word with no per-word AND no per-title font override (using the
  // style's own default face) got no inline letter-spacing at all, falling
  // back to whatever styles.css had for that .style-X span. That CSS is the
  // dashboard/editor's copy of the SAME stale per-font ladder the burn no
  // longer uses (see the styles.css [TRACK-UNIFORM] notes on the four
  // .style-* span rules) — so a plain, unstyled title word tracked at the
  // wrong amount even after the burn side was fixed, which is why titles kept
  // drifting from their own preview specifically for word-by-word rise/drop:
  // bakeCueWordOffsets() (captions only — titles have no equivalent baking,
  // they render inline, single-line, exactly like this) measures whatever is
  // ACTUALLY on screen, so a wrong on-screen tracking here means a wrong
  // measurement anywhere this preview is used as ground truth.
  // `fn ? titleFontTracking(fn) : TRACK_EM_CSS`: a real font may be Pinyon
  // Script (untracked, by design); the absence of any font override never is.
  // [TITLE-TRACK] A title's own letter spacing wins over the font/style
  // default, exactly as it does in the burn (T.track -> \fsp). Without this
  // the preview kept showing the caption default while the burn honoured the
  // override — the preview/burn split this file exists to avoid.
  const tr = (trackEm != null && Number.isFinite(+trackEm))
    ? `${Math.max(-0.2, Math.min(0.4, +trackEm))}em`
    : fontTrackCss(fn);
  // [PINYON-TRACK] Always written — a Pinyon word that wrote nothing picked up
  // the style rule's -0.07em, while the burn draws it untracked.
  s.push(`letter-spacing:${tr} !important`);
  if (st.an === 'none') s.push('animation:none');
  else if (st.an && ANIM_CSS[st.an]) s.push(`animation:${ANIM_CSS[st.an]}`);
  // [TITLE-OUTLINE] Hollow word: the fill goes transparent and the stroke
  // carries the colour, mirroring the burn's \1a&HFF& + \bord + \3c. Same
  // 0.055em stroke the burn computes from the word's own size, so the two
  // stay in step at any font size.
  // [TITLE-WORD-GLOW] Per-word halo. The container's own glow is switched off
  // whenever any word is marked (see paintTitleLayer), so the light comes from
  // here instead — 0.18em blur mirrors the burn's blur of fs/6.
  if (st.gl) {
    s.push(`text-shadow:0 0 0.18em ${glowColor || '#FFFFFF'} !important`);
  }
  // [TITLE-BOX-OL] Sama seperti burn: kata berkotak tidak menggambar stroke
  // dan tidak pernah transparan — box yang menang. Tanpa penjaga ini preview
  // menjanjikan stroke yang tidak pernah diburn.
  if (st.ol && !st.box) {
    // [TITLE-OUTLINE] Outline colour and FILL colour are separate settings.
    // `olc` paints the stroke; `color` still paints the inside. With no fill
    // colour the word stays hollow — the same look as before — so a word can
    // be outlined-and-filled, or outlined-and-hollow, from one toggle.
    s.push('-webkit-text-stroke:0.045em ' + (st.olc || '#FFFFFF') + ' !important');
    if (!st.color) s.push('color:transparent !important');
  }
  if (st.i) s.push('font-style:italic !important');
  if (st.b != null) s.push(`font-weight:${st.b ? '700' : '400'} !important`);
  // [TITLE-BOX] Box takes priority over both a hand-picked colour and the
  // hook-word accent — reuses the SAME geometry module the caption box
  // highlight already ships (window.CaptionBox), so a title box and a
  // caption box read identical padding/radius/height numbers. [BOX-H-FIXED]:
  // line-height is an explicit constant here for the same reason it is for
  // captions — this span's background is the browser's font content-box,
  // and padding can only grow it, never shrink it to a fixed height.
  if (st.box && window.CaptionBox) {
    const { PAD_EM, RADIUS_EM, BOX_H_EM } = window.CaptionBox;
    const bc = boxColor || '#F1FF00';
    const ink = window.CaptionBox.contrastInk(bc);
    s.push(`background:${bc}`);
    s.push(`color:${ink} !important`);
    // [BOX-MERGE] Round only the OUTER corners of a run of boxed neighbours,
    // so three chips read as one block — matching the burn, which now emits a
    // single rectangle for the run. Rounding every corner leaves pinched
    // notches where the words meet.
    const rl = (boxRun && boxRun.left) ? '0' : `${RADIUS_EM}em`;
    const rr = (boxRun && boxRun.right) ? '0' : `${RADIUS_EM}em`;
    s.push(`border-radius:${rl} ${rr} ${rr} ${rl}`);
    // [TITLE-BOX-NOFLOW] Margin negatif sebesar padding: kotak melebar ke spasi
    // di kiri-kanan TANPA mendorong kata lain. Di burn kotak adalah Dialogue
    // terpisah yang tidak pernah menggeser teks; tanpa ini tiap kata berkotak
    // melebarkan barisnya 0,3em dan seluruh baris bergeser (terukur 18px di
    // panggung 540px untuk 4 kata berkotak).
    // [TITLE-BOX-H] Tinggi dari face kata ini, slot baris tetap — lihat
    // titleBoxVertEm. BOX_H_EM dipakai hanya selama metriknya belum tiba.
    // [TITLE-BOX-VCENTER] Dan dipusatkan pada tinta seperti burn (dEm).
    const v = titleBoxVertEm(boxGeom && boxGeom.emScale, boxGeom && boxGeom.slotLh, boxGeom && boxGeom.dEm);
    const f4 = (x) => +x.toFixed(4);
    // [BOX-RIGHT-EDGE] letter-spacing is applied after EVERY glyph, the last
    // one included, so a negative tracking pulls the span's content box — and
    // with it the box's right edge — |tracking| inside the word's last letter.
    // The burn draws the box from the word's visual edges, so the preview box
    // was that much narrower on the right only (measured at 96px, -0.07em:
    // pad 21 left / 12 right vs the burn's 20/19). The extra padding is handed
    // back by the margin, so nothing in the line moves. Only an OUTER right
    // edge: inside a [BOX-MERGE] run the next word's box continues it.
    const lsEm = (typeof tr === 'string' && /em$/.test(tr)) ? (parseFloat(tr) || 0) : 0;
    const padR = (boxRun && boxRun.right) ? PAD_EM : +(PAD_EM - lsEm).toFixed(4);
    s.push(`padding:${f4(v.pt)}em ${padR}em ${f4(v.pb)}em ${PAD_EM}em`);
    s.push(`margin:${f4(v.mt)}em -${padR}em ${f4(v.mb)}em -${PAD_EM}em`);
    s.push(`line-height:${f4(v.lh)}em`);
    // [TITLE-BOX-EDGE] The burn draws a boxed word with \bord0\shad0 (see
    // [TITLE-BOX] in buildAss): contrastInk on the box, no outline. The
    // style's own edge (bw's black halo, a neon stroke) came through here via
    // the `.cap-overlay.style-X span` rules and smeared the boxed word into a
    // dark slab that never reached the video. A word's own glow (st.gl, set
    // above) is the one shadow it keeps. (No stroke to clear: the hollow
    // branch above already skips boxed words.)
    if (!st.gl) s.push('text-shadow:none !important');
  // [TITLE-OUTLINE] A hollow word's colour belongs on its STROKE, which the
  // `st.ol` branch above already set. Emitting the fill here as well put
  // `color:<colour>` AFTER `color:transparent` in the same declaration list,
  // so the fill won and the word rendered solid in the preview while the burn
  // drew it hollow — the two showed different letters for one setting.
  } else if (st.color) s.push(`color:${st.color} !important`);
  else if (isHook) s.push(`color:${HOOK_WORD_COLOR} !important`);
  if (st.fs) s.push(`font-size:${Math.max(11, ((st.fs) / 1920) * H).toFixed(2)}px !important`);
  return s.join(';');
}

// layerEl: the .cap-title-layer container. titles: clip.titles. tNow: playhead.
// W/H: the OUTPUT-frame stage size in px (ASS 1080×1920 maps into it).
// opts: { paused, interactive, selTitle:{id,wi}, onBuild(el) }.
// [TITLE-INK-LEADING] `line-height` yang benar-benar berlaku untuk baris judul.
// Duplikat dari styles.css (.title-el { line-height:1.2 }, unitless) dan dari
// angka 1.2 di titleCenterShift di bawah. Dinamai supaya jelas bahwa ketiganya
// adalah SATU angka; jangan ubah salah satu tanpa yang lain.
const TITLE_LINE_HEIGHT = 1.2;

// [TITLE-INK-LEADING] Metrik tinta satu face, DIUKUR langsung dengan canvas.
//
// Renderer tidak bisa membaca tabel font: font-metrics.js memakai fs/path, dan
// tidak ada IPC yang mengeksposnya. Tapi canvas bisa mengukur benda yang sama.
// Terverifikasi di Chrome terhadap tabel OS/2 untuk Open Sauce Two Bold:
//
//   measureText('H').actualBoundingBoxAscent / fs = 0.7630  <- OS/2 sCapHeight
//   fontBoundingBoxAscent  / fs                   = 1.0000  <- hhea ascender
//   fontBoundingBoxDescent / fs                   = 0.2400  <- hhea 0.2370
//
// Jadi kedua sisi memakai rumus yang sama dengan sumber angka masing-masing,
// bukan tabel 40-face yang dicerminkan — tabel seperti itu selalu melenceng.
//
// `leadEm` di sini adalah half-leading CSS, BUKAN angka libass: jarak atas
// kotak-baris ke atas kapital menurut model kotak CSS. Terukur 0.2170 lawan
// 0.2370 milik burn. Masing-masing sisi memakai angkanya sendiri — memaksa
// preview memakai angka burn justru MEMPERBESAR selisihnya (6,6px tetap,
// lawan 4,4px).
const _titleInkCache = new Map();
function titleInkMetricsCss(fontFamily, lineHeight = TITLE_LINE_HEIGHT) {
  const fam = String(fontFamily || '').trim();
  if (!fam) return null;
  const LHv = Number.isFinite(+lineHeight) ? +lineHeight : TITLE_LINE_HEIGHT;
  // line-height ikut jadi kunci: half-leading CSS bergantung padanya, dan
  // kartu preset memakai 1.15 sementara .title-el memakai 1.2.
  const key = `${LHv}|${fam}`;
  if (_titleInkCache.has(key)) return _titleInkCache.get(key);
  const FS = 100;
  let out = null;
  let loaded = true;
  try {
    // Font yang belum termuat membuat canvas jatuh ke face pengganti, dan
    // angkanya akan salah — DAN tersimpan selamanya. Jangan cache kalau begitu;
    // tick berikutnya akan mencoba lagi setelah font siap.
    loaded = !document.fonts || document.fonts.check(`${FS}px ${fam}`);
  } catch { loaded = true; }
  try {
    if (!titleInkMetricsCss._c) {
      titleInkMetricsCss._c = document.createElement('canvas').getContext('2d');
    }
    const c = titleInkMetricsCss._c;
    c.font = `${FS}px ${fam}`;
    const m = c.measureText('H');
    const capEm = m.actualBoundingBoxAscent / FS;
    const ascEm = m.fontBoundingBoxAscent / FS;
    const descEm = m.fontBoundingBoxDescent / FS;
    if ([capEm, ascEm, descEm].every(v => Number.isFinite(v) && v > 0)) {
      const LH = LHv;
      const leadEm = (LH - (ascEm + descEm)) / 2 + ascEm - capEm;
      const gapEm = LH - (capEm + descEm);
      // Sisi CSS ini hanya dipakai untuk MEMBATALKAN tata letak Chrome sendiri,
      // jadi leadEm negatif pun sah (dan memang terjadi: half-leading bisa
      // negatif kalau line-height lebih kecil dari kotak font). Yang perlu
      // dipercaya cuma capHeight-nya masuk akal. lead/gap untuk MODEL-nya datang
      // dari sisi burn lewat IPC, bukan dari sini.
      if (capEm > 0.3 && capEm <= ascEm + 0.05) out = { capEm, ascEm, descEm, leadEm, gapEm };
    }
  } catch { out = null; }
  if (loaded) _titleInkCache.set(key, out);
  return out;
}

// [TITLE-LINE-GEOM] Metrik face seperti yang dilihat LIBASS, lewat IPC.
//
// Canvas bisa mengukur hampir semuanya, tapi TIDAK usWinAscent/usWinDescent —
// dan itulah yang dipakai libass untuk memenuhi Fontsize, jadi itulah jarak
// antar baris yang benar-benar diburn. Terukur: preview memakai line-height 1.2
// mati sementara burn memakai emScale face-nya; untuk Anton (1,7334) itu ~42px
// selisih PER BARIS, dan tidak ada cara mengukurnya dari renderer.
//
// Dikunci pada `style|fn` karena face efektifnya `T.fn || style.font || bawaan`,
// dan aturan itu milik buildAss — main.js yang menerapkannya, memakai SUB_STYLES
// yang sama. styles.css menaruh font-family di span, bukan di kontainer, jadi
// getComputedStyle pun tidak bisa menjawab ini.
//
// Asinkron dan tidak memaksa repaint: pengisian `top` per baris berjalan di
// SETIAP tick (di luar penjaga `sig`), jadi tick berikutnya memakainya sendiri.
const _burnFaceCache = new Map();
// [HOOK-CARD] A preset chip that SHOWS the look instead of naming it, built
// from the same painter the live preview uses — titleWordCss for every word,
// autoTitleBreaks for the line shape, autoFitScale for the size. Rebuilding
// the look here with hand-written CSS is exactly how a swatch starts lying
// about what it applies.
const HOOK_SAMPLES = {
  blok_neon: 'ORANG NILAI KAMU DALAM 3 DETIK',
  aksen_miring: 'CONTEK 5 HOOK INI',
  kuning_tebal: 'CUMA PAKE CAPCUT',
  kotak_merah: 'TANPA HOOK NOL PENONTON',
  outline_tebal: 'JANGAN SCROLL',
  pastel_lembut: 'ini sebuah HOOK',
  stiker_pop: 'Rahasia Konten Viral',
  riot: 'Jangan Diam Saja',
  lakban: 'Fakta Yang Disembunyikan',
  mask_naik: 'Kenapa Dia Pergi',
  fokus_blur: 'Ternyata Ini Alasannya',
  sorotan: 'ORANG INI BIKIN KARPET YANG BISA SEMBUNYIKAN | SOROTAN',
  kertas_sobek: 'HALO WARGA SEMUA | INFO PENTING HARI INI',
  cap_susun: 'yang gayanya kayak Apple',
  cap_fokus_oranye: 'apakah kita nyaman?',
  cap_fokus_miring: 'karena yang akan jalani itu kita',
  cap_acak_bootzy: 'for sweating small',
  cap_acak_sauce: 'never explain',
  cap_sauce_mix: 'enter my',
  cap_quote: 'and what it means',
  cap_estetik: 'berapa lama tuh?',
  cap_glow: 'suaranya tetap Berkelas',
  cap_glow_lime: 'suaranya tetap Berkelas',
  cap_glow_putih: 'suaranya tetap Berkelas',
  cap_campur: 'kenapa banyak creator',
};
const HOOK_CARD_H = 300;   // virtual preview height the sample is scaled against
// [KINETIC-TITLE] Card miniature for a motion-graphic template: its FINAL
// frame (every key applied), from the same layout() the burn uses, scaled to
// fit the card. Static on purpose — six looping cards would be "alay".
function kineticCardSample(p) {
  const KT = window.KineticTitle;
  if (!KT) return '';
  // Measured with canvas: a face that has not loaded yet measures as the
  // fallback font, which squeezed words into each other ("kayakApple") and
  // pushed the lockup off the card. Draw nothing until every face is ready;
  // refreshKineticCards() fills the slot in once they are.
  const ready = KT.FONTS.every((f) => { try { return document.fonts.check(`20px "${f}"`); } catch { return true; } });
  if (!ready) return `<span data-kcard="${p.id}" style="font-size:11px;color:var(--muted)">…</span>`;
  const L = KT.layout(p.title.kinetic, HOOK_SAMPLES[p.id] || 'Ternyata Alasan Dia Gagal', { cx: 540, cy: 960, top: 800, dur: 1500 });
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const els = L.elements.filter((e) => !e.bleed).map((e) => {
    const w = e.kind === 'shape' ? e.w : KT.widthPx(e.text, e.font, e.px);
    const h = e.kind === 'shape' ? e.h : e.px * 1.2;
    l = Math.min(l, e.x - w / 2); r = Math.max(r, e.x + w / 2); t = Math.min(t, e.y - h / 2); b = Math.max(b, e.y + h / 2);
    return { e, w, h };
  });
  if (!els.length) return '';
  const BW = 140, BH = 62;   // the card slot is 70px tall
  const k = Math.min(BW / (r - l), BH / (b - t));
  // Word-state templates show the moment a middle word is being spoken, so
  // the card shows the CURRENT style (the whole point of those looks).
  const atMs = /^cc_/.test(p.title.kinetic) ? 1500 * 0.55 : Infinity;
  const parts = els.map(({ e, w, h }) => {
    const K = KT.resolvedKeys(e);
    const f = atMs === Infinity ? K[K.length - 1] : KT.stateAt(e, atMs);
    const tr = `translate(-50%,-50%) translate(${((f.x - e.x) * k).toFixed(1)}px,${((f.y - e.y) * k).toFixed(1)}px) rotate(${f.rot}deg) scale(${f.sx / 100},${f.sy / 100})`;
    if (!(f.a > 0)) return '';
    const pos = `position:absolute;left:${((e.x - l) * k).toFixed(1)}px;top:${((e.y - t) * k).toFixed(1)}px;transform:${tr};opacity:${f.a}`;
    if (e.kind === 'shape') {
      const fill = e.fillA === 0 ? 'none' : e.color;
      const stroke = e.fillA === 0 ? (e.oc || e.color) : (e.ow ? e.oc : 'none');
      return `<svg viewBox="0 0 ${w} ${h}" width="${(w * k).toFixed(1)}" height="${(h * k).toFixed(1)}" style="${pos};overflow:visible"><path d="${kineticSvgPath(e.path)}" fill="${fill}" stroke="${stroke}" stroke-width="${(e.ow || 0) * 2}" paint-order="stroke fill"/></svg>`;
    }
    const stroke = e.ow ? `-webkit-text-stroke:${(e.ow * 2 * k).toFixed(2)}px ${e.oc};paint-order:stroke fill;` : '';
    const glow = e.glow ? `text-shadow:0 0 ${(14 * k).toFixed(1)}px ${e.glow},0 0 ${(30 * k).toFixed(1)}px ${e.glow};` : '';
    return `<span style="${pos};font-family:'${String(e.font).replace(/'/g, "\\'")}';font-size:${(e.px * k).toFixed(2)}px;line-height:1;white-space:pre;color:${e.color};font-kerning:none;letter-spacing:${e.fsp ? (e.fsp * k).toFixed(2) : 0}px;${stroke}${glow}">${esc(e.text)}</span>`;
  }).join('');
  return `<span data-kcard="${p.id}" style="position:relative;display:inline-block;width:${((r - l) * k).toFixed(0)}px;height:${((b - t) * k).toFixed(0)}px">${parts}</span>`;
}
// [PRESET-CATALOG] Presets from Cloudflare (validated + signature-checked in
// the main process). Added to the same registries the built-ins live in, so
// cards, preview and burn treat them alike; the next Clip setting open shows
// them.
function applyRemoteCatalog(cat) {
  if (!cat || !window.PresetCatalog) return;
  window.PresetCatalog.applyCatalog(cat, { HookPresets: window.HookPresets, KineticTitle: window.KineticTitle, VideoFx: window.VideoFx });
}
try {
  window.socl?.catalogGet?.().then(applyRemoteCatalog).catch(() => {});
  window.socl?.onCatalogUpdated?.(applyRemoteCatalog);
} catch {}

// Re-draw every kinetic card once the template faces have loaded.
function refreshKineticCards() {
  const KT = window.KineticTitle;
  if (!KT) return;
  Promise.all(KT.FONTS.map((f) => document.fonts.load(`20px "${f}"`).catch(() => null))).then(() => {
    document.querySelectorAll('[data-kcard]').forEach((el) => {
      const id = el.dataset.kcard;
      const p = (window.HookPresets && window.HookPresets.byId && window.HookPresets.byId(id)) || { id, title: { kinetic: id } };
      const tmp = document.createElement('span');
      tmp.innerHTML = kineticCardSample(p);
      if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild);
    });
    requestAnimationFrame(() => fitCardSamples(document));
  });
}
// [CARD-FIT] A sample is laid out for a nominal 140×62 slot, but the real card
// is narrower in the Clip setting column (2 per row) — words ran off the edge
// ("suaranya teta", "DISEMBUNYIKA"). Shrink each sample to its slot's REAL
// size, centred, like the plain hook cards that already fit.
function fitCardSamples(root) {
  // Re-fit when the window (and so the panel) resizes — bound on first use,
  // not at load, so this file stays evaluable outside a browser.
  if (!fitCardSamples._bound) { fitCardSamples._bound = true; window.addEventListener('resize', () => { try { fitCardSamples(document); } catch {} }); }
  (root || document).querySelectorAll('[data-kcard]').forEach((el) => {
    const slot = el.parentElement;
    if (!slot) return;
    el.style.transform = '';
    const sw = slot.clientWidth * 0.84, sh = slot.clientHeight * 0.86;   // breathing room, like the plain cards
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!(sw > 0 && sh > 0 && w > 0 && h > 0)) return;
    const k = Math.min(1, sw / w, sh / h);
    if (k < 1) { el.style.transform = `scale(${k.toFixed(3)})`; el.style.transformOrigin = 'center center'; el.style.flex = '0 0 auto'; }
  });
}
function hookPresetSample(p) {
  if (p && p.title && p.title.kinetic) return kineticCardSample(p);
  if (!window.HookPresets || !window.TitleLayout) return '';
  const T = window.HookPresets.applyHookPreset(p, { text: HOOK_SAMPLES[p.id] || 'HOOK', fs: 96 });
  const words = String(T.text).trim().split(/\s+/).filter(Boolean);
  const breaks = window.TitleLayout.autoTitleBreaks(T.text, T.layout, T.lines) || [];
  const lines = [];
  let start = 0;
  for (const b of breaks) { lines.push(words.slice(start, b)); start = b; }
  lines.push(words.slice(start));
  const fit = window.TitleLayout.autoFitScale(lines.length) || 1;
  // Same canonical-1920 mapping the live preview uses, so the sample is a
  // true miniature rather than a look-alike.
  const basePx = ((+T.fs || 96) * fit / 1920) * HOOK_CARD_H;
  const boxedAt = (i) => !!(T.tokens && T.tokens[i] && T.tokens[i].style && T.tokens[i].style.box);
  // [TITLE-INK-LEADING] Kartu ini ikut dirapatkan, kalau tidak 3 dari 6 preset
  // bawaan (aksen_miring, kuning_tebal, pastel_lembut — semuanya punya baris
  // beda ukuran) akan tampil renggang di kartu tapi rapat di preview.
  // Memakai line-height KARTU (1.15), bukan 1.2 milik .title-el: half-leading
  // CSS tergantung angka itu, jadi pergeserannya harus dihitung dari geometri
  // kotak kartu itu sendiri.
  const CARD_LH = 1.15;
  const cardFace = T.fn ? `'${T.fn}',sans-serif` : "'Open Sauce Two Bold',sans-serif";
  const cardEffFs = (+T.fs || 96) * fit;
  // [TITLE-LINE-GEOM] Kartu memakai model yang SAMA dengan preview besar:
  // posisi baris libass, lalu tata letak kotak-baris CSS dibatalkan. Bukan
  // pilihan kosmetik — 5 dari 6 preset bawaan memakai Anton atau Poppins Bold,
  // dua face yang emScale-nya 1,73/1,76 lawan line-height 1,15 kartu ini.
  // Tanpa ini kartunya melenceng puluhan piksel per baris dari apa yang
  // sebenarnya diburn, untuk hampir semua presetnya.
  //
  // Metriknya asinkron: sebelum sampai, kartu digambar tanpa koreksi, lalu
  // renderTitlesList() dipanggil ulang sekali lewat _onBurnFaceResolved.
  const cardTops = (() => {
    if (!window.TitleLayout.titleLineTopsCss) return null;
    let j = 0;
    const per = lines.map((line) => {
      let sizePx = 0, wfn = T.fn || '';
      for (let k = 0; k < line.length; k++) {
        const st = (T.tokens && T.tokens[j + k] && T.tokens[j + k].style) || {};
        const sz = st.fs ? Math.max(24, Math.min(240, +st.fs)) : cardEffFs;
        if (sz > sizePx) { sizePx = sz; wfn = st.fn || T.fn || ''; }
      }
      j += line.length;
      const burn = burnFaceMetrics(T.style, wfn);
      const css = titleInkMetricsCss(wfn ? `'${wfn}',sans-serif` : cardFace, CARD_LH);
      return (burn && css) ? {
        sizePx, emScale: burn.emScale, baselineEm: burn.baselineEm,
        capEm: burn.capEm, descEm: burn.descEm, cssLeadEm: css.leadEm,
      } : null;
    });
    if (!per.length || per.some((x) => !x)) return null;
    return window.TitleLayout.titleLineTopsCss(per, CARD_LH);
  })();
  let li = 0;
  let wi = 0;
  const body = lines.map(line => {
    const first = wi;
    const parts = line.map((w, k) => {
      const i = first + k;
      const tk = (T.tokens && T.tokens[i]) || {};
      // [BOX-MERGE] Same run logic as the live layer: inner corners flat and
      // the gap filled, so the card shows one block exactly like the burn.
      const run = {
        left: boxedAt(i) && boxedAt(i - 1) && k > 0,
        right: boxedAt(i) && boxedAt(i + 1) && k < line.length - 1,
      };
      // [TITLE-BOX-H] Kotak setinggi yang diburn untuk face kata ini, di slot
      // baris KARTU (1,15). Metrik yang belum tiba memicu fetch; kartu lalu
      // dibangun ulang lewat _onBurnFaceResolved, sama seperti cardTops.
      const bm = boxedAt(i) ? burnFaceMetrics(T.style, (tk.style && tk.style.fn) || T.fn || '') : null;
      const css = titleWordCss(tk.style || {}, HOOK_CARD_H, T.fn, false, T.boxColor, T.track, T.glowColor, run,
        { emScale: bm && bm.emScale, slotLh: CARD_LH, dEm: titleBoxShiftEm(bm) });
      // [TITLE-BOX-GAP] Spasi di dalam run dibawa kata kirinya, di dalam
      // kotaknya sendiri — lihat catatan yang sama di paintTitleLayer.
      const sep = (k === 0 || run.left) ? '' : ' ';
      const trail = run.right ? ' ' : '';
      const ws = trail ? 'white-space:pre;' : '';
      return sep + `<span style="${ws}${css}">${w.replace(/</g, '&lt;')}${trail}</span>`;
    }).join('');
    wi += line.length;
    const off = cardTops ? cardTops[li] : 0;
    li++;
    // `em` di sini sah: div baris kartu tidak pernah membawa override
    // font-size, jadi 1em = ukuran dasar judul kartu. Dan kartu tidak punya
    // penyusutan lebar, jadi tidak ada masalah [TITLE-INK-LEADING-FIT].
    const shift = off ? `position:relative;top:${(off / cardEffFs).toFixed(4)}em;` : '';
    // Long samples must shrink to fit the card rather than spill out of it.
    return `<div style="${shift}line-height:${CARD_LH};white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:clip">${parts}</div>`;
  }).join('');
  const face = cardFace;
  return `<div style="font-family:${face};font-weight:700;font-size:${basePx.toFixed(1)}px;color:#fff;text-align:center;pointer-events:none;width:100%">${body}</div>`;
}

let _onBurnFaceResolved = null;
const _burnFacePending = new Set();
function burnFaceMetrics(style, fn) {
  const key = `${style || ''}|${fn || ''}`;
  if (_burnFaceCache.has(key)) return _burnFaceCache.get(key);
  const api = (typeof window !== 'undefined' && window.socl && window.socl.fontMetrics) || null;
  if (api && !_burnFacePending.has(key)) {
    _burnFacePending.add(key);
    Promise.resolve(api([{ style: style || '', fn: fn || '' }]))
      .then((m) => { _burnFaceCache.set(key, (m && m[key]) || null); })
      .catch(() => { _burnFaceCache.set(key, null); })
      .finally(() => {
        _burnFacePending.delete(key);
        // paintTitleLayer mengisi `top` tiap tick jadi ia tidak perlu diberi
        // tahu. Kartu preset lain ceritanya: HTML-nya dibangun sekali, jadi ia
        // harus dibangun ulang setelah metriknya sampai.
        if (typeof _onBurnFaceResolved === 'function') {
          try { _onBurnFaceResolved(); } catch { /* jangan jatuhkan rantai IPC */ }
        }
      });
  }
  return null;
}

// [HOOK-BACKDROP] Preview twin of buildAss's backdropGeometry: a card panel
// around every line, or a full-width band from just above the block to the
// bottom of the frame. Measured from the .ttl-line boxes (lines never animate,
// so the panel does not breathe with a word's pop) widened by the same em
// pads the burn uses: BACKDROP card pads + the box highlight's PAD_EM.
const PREVIEW_BACKDROP = { cardPadXEm: 0.30, cardPadYEm: 0.22, cardRadiusEm: 0.24, gradLeadEm: 1.6, boxPadEm: 0.15 };
function paintTitleBackdrop(el, T, show, W, H, effFs) {
  let bd = el.querySelector(':scope > .ttl-backdrop');
  const kind = T.backdrop === 'card' || T.backdrop === 'gradient' ? T.backdrop : '';
  if (!kind || !show) { if (bd) bd.style.display = 'none'; return; }
  if (!bd) { bd = document.createElement('div'); bd.className = 'ttl-backdrop'; el.prepend(bd); }
  const lines = el.querySelectorAll('.ttl-line');
  const er = el.getBoundingClientRect();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  (lines.length ? lines : [el]).forEach((ln) => {
    const q = ln.getBoundingClientRect();
    l = Math.min(l, q.left - er.left); t = Math.min(t, q.top - er.top);
    r = Math.max(r, q.right - er.left); b = Math.max(b, q.bottom - er.top);
  });
  if (!Number.isFinite(l)) { bd.style.display = 'none'; return; }
  const em = (effFs / 1920) * H;
  const hex = /^#[0-9a-fA-F]{6}$/.test(String(T.backdropColor || '')) ? T.backdropColor : (kind === 'gradient' ? '#000000' : '#FFFFFF');
  const op = Math.max(0, Math.min(1, T.backdropOpacity != null ? +T.backdropOpacity : (kind === 'gradient' ? 0.78 : 1)));
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
  bd.style.display = 'block';
  bd.style.animation = 'capFade .07s ease-out both';
  if (kind === 'card') {
    const px = em * (PREVIEW_BACKDROP.cardPadXEm + PREVIEW_BACKDROP.boxPadEm), py = em * PREVIEW_BACKDROP.cardPadYEm;
    Object.assign(bd.style, { left: `${l - px}px`, top: `${t - py}px`, width: `${r - l + 2 * px}px`, height: `${b - t + 2 * py}px`,
      borderRadius: `${em * PREVIEW_BACKDROP.cardRadiusEm * 2}px`, background: `rgba(${rgb},${op})` });
  } else {
    const lead = em * PREVIEW_BACKDROP.gradLeadEm;
    const top = t - lead;
    Object.assign(bd.style, { left: `${-er.left + el.parentElement.getBoundingClientRect().left}px`, top: `${top}px`, width: `${W}px`,
      height: `${Math.max(0, H - (er.top - el.parentElement.getBoundingClientRect().top) - top)}px`, borderRadius: '0',
      background: `linear-gradient(to bottom, rgba(${rgb},0) 0, rgba(${rgb},${op}) ${lead}px, rgba(${rgb},${op}) 100%)` });
  }
}

// [KINETIC-TITLE] Preview of a motion-graphic title. Same layout() as the
// burn (kinetic-title.js), drawn as absolutely positioned letters and SVG
// shapes; the keyframes become Web Animations whose clock is pinned to the
// video, so scrubbing shows exactly the frame the burn will have.
const KINETIC_EASE = 'cubic-bezier(0.25, 0.6, 0.4, 1)';   // ≈ libass \t accel 0.45
function kineticSvgPath(p) {
  // ASS drawing → SVG: m/l/b = M/L/C (b is a cubic Bézier, used by the
  // rounded boxes and the chat bubble).
  return String(p).replace(/\bm\b/g, 'M').replace(/\bl\b/g, 'L').replace(/\bb\b/g, 'C') + ' Z';
}
// [GLOW-READ] Preview twin of the burn's glow + dark shade passes; bright
// glows (white / lime) get a darker shade and a softer halo, like the burn.
function kinTextShadow(e, u) {
  const lum = (window.KineticTitle && window.KineticTitle.glowLum) ? window.KineticTitle.glowLum(e.glow || e.color) : 1;
  const dk = lum > 0.55 ? [0.88, 0.7] : [0.72, 0.55];
  const shade = `0 0 ${(10 * u).toFixed(1)}px rgba(0,0,0,${dk[0]}), 0 0 ${(18 * u).toFixed(1)}px rgba(0,0,0,${dk[1]})`;
  if (e.glow) {
    const g = e.glow, wideA = lum > 0.7 ? '80' : lum > 0.55 ? 'a0' : 'ff';
    return `0 0 ${(3 * u).toFixed(1)}px ${g}, 0 0 ${(8 * u).toFixed(1)}px ${g}, 0 0 ${(20 * u).toFixed(1)}px ${g}${wideA}, 0 0 ${(30 * u).toFixed(1)}px ${g}${wideA}, ${shade}`;
  }
  if (e.shade) return shade;
  return e.sd ? `${e.sd * u}px ${e.sd * u}px 0 ${e.sc || '#000'}` : ((e.shadowSoft || e.glowSoft) ? `0 ${4 * u}px ${8 * u}px rgba(0,0,0,.45)` : '');
}
function paintKineticTitle(el, T, tNow, W, H, show, paused) {
  const KT = window.KineticTitle;
  const tw = (T.capTop == null && window.TitleLayout && window.TitleLayout.eventWindow)
    ? window.TitleLayout.eventWindow(T.start, T.end)
    : { start: +T.start || 0, end: +T.end || 3.5 };
  el.style.display = show ? 'block' : 'none';
  if (!show) { el.dataset.vis = '0'; return; }
  const fontsReady = KT.FONTS.every((f) => { try { return document.fonts.check(`20px "${f}"`); } catch { return true; } });
  if (!fontsReady) {
    KT.FONTS.forEach((f) => { try { document.fonts.load(`20px "${f}"`); } catch {} });
  }
  const u = H / 1920;
  const cx = +T.x || 540, cy = +T.y || 960;
  const sig = [T.kinetic, T.text, cx, cy, T.fs, W, H, tw.start, tw.end, T.fadeOutMs, T.glow ? 1 : 0, fontsReady ? 1 : 0].join('|');
  if (el.dataset.ksig !== sig) {
    el.dataset.ksig = sig;
    el.className = 'title-el kinetic-title';
    el.innerHTML = '';
    const durMs = Math.max(1, (tw.end - tw.start) * 1000);
    // [KINETIC-CAPTION] A caption cue: top-anchored at the caption Y, sized off
    // the caption font size — the same arguments buildAss passes.
    const L = T.capTop != null
      ? KT.layout(T.kinetic, String(T.text || '').trim(), { cx, top: +T.capTop, k: (+T.fs || 64) / 64, dur: Math.max(200, durMs), glow: !!T.glow })
      : KT.layout(T.kinetic, String(T.text || '').trim(), { cx, cy, k: (+T.fs || 96) / 96 });
    // Stage coordinates: uniform scale u about the anchor, same as the burn.
    const X = (x) => (cx / 1080) * W + (x - cx) * u;
    const Y = (y) => cy * u + (y - cy) * u;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const items = [];
    for (const e of L.elements) {
      const w = e.kind === 'shape' ? e.w : KT.widthPx(e.text, e.font, e.px);
      const h = e.kind === 'shape' ? e.h : e.px * 1.2;
      l = Math.min(l, X(e.x) - (w * u) / 2); r = Math.max(r, X(e.x) + (w * u) / 2);
      t = Math.min(t, Y(e.y) - (h * u) / 2); b = Math.max(b, Y(e.y) + (h * u) / 2);
      items.push({ e, w, h });
    }
    if (!items.length) return;
    // The element box hugs the lockup so the editor can still select/drag it.
    Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px`, transform: 'none', fontSize: '' });
    const frag = document.createDocumentFragment();
    for (const { e, w, h } of items) {
      let node;
      if (e.kind === 'shape') {
        node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        node.setAttribute('viewBox', `0 0 ${w} ${h}`);
        node.setAttribute('width', w * u); node.setAttribute('height', h * u);
        node.style.overflow = 'visible';
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', kineticSvgPath(e.path));
        const stroke = e.oc && e.ow ? e.oc : 'none';
        path.setAttribute('fill', e.fillA === 0 ? 'none' : e.color);
        path.setAttribute('stroke', e.fillA === 0 ? (e.oc || e.color) : stroke);
        path.setAttribute('stroke-width', String((e.ow || 0) * 2));
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('paint-order', 'stroke fill');
        node.appendChild(path);
        if (e.sd) node.style.filter = `drop-shadow(${e.sd * u}px ${e.sd * u}px 0 ${e.sc || '#000'})`;
      } else {
        node = document.createElement('span');
        node.textContent = e.text;
        Object.assign(node.style, {
          fontFamily: `"${e.font}"`, fontSize: `${e.px * u}px`, lineHeight: '1', whiteSpace: 'pre', color: e.color,
          fontWeight: 'normal', fontStyle: 'normal', fontKerning: 'none', letterSpacing: e.fsp ? `${(e.fsp * u).toFixed(2)}px` : '0',   // metrics have no kerning; [CAP-FOKUS-TRACK]
          webkitTextStroke: e.ow ? `${e.ow * 2 * u}px ${e.oc}` : '', paintOrder: 'stroke fill',
          // [KINETIC-CAPTION] e.glow = the burn's blurred 10px outline halo.
          // [GLOW-VISIBLE] mirrors the burn's two glow passes (tight core + wide halo)
          // [GLOW-READ] + the burn's dark shade pass, listed last (painted underneath)
          textShadow: kinTextShadow(e, u)
        });
      }
      node.classList.add('kin-el');
      Object.assign(node.style, { position: 'absolute', left: `${X(e.x) - l}px`, top: `${Y(e.y) - t}px`, willChange: 'transform, opacity' });
      let host = node;
      if (e.clipAbs) {
        // Static frame-space mask (line reveal): the moving text lives in a
        // clipped box, like the burn's fixed \clip rectangle.
        host = document.createElement('div');
        const [c0, c1, c2, c3] = e.clipAbs;
        Object.assign(host.style, { position: 'absolute', left: `${X(c0) - l}px`, top: `${Y(c1) - t}px`, width: `${(c2 - c0) * u}px`, height: `${(c3 - c1) * u}px`, overflow: 'hidden' });
        node.style.left = `${X(e.x) - X(c0)}px`; node.style.top = `${Y(e.y) - Y(c1)}px`;
        host.appendChild(node);
      }
      frag.appendChild(host);
      const K = KT.resolvedKeys(e);
      const hasBlur = K.some((k) => k.blur);
      const frame = (k) => {
        const f = {
          transform: `translate(-50%,-50%) translate(${((k.x - e.x) * u).toFixed(2)}px,${((k.y - e.y) * u).toFixed(2)}px) rotate(${k.rot}deg) scale(${k.sx / 100},${k.sy / 100})`,
          opacity: k.a,
        };
        if (hasBlur) f.filter = `blur(${(k.blur * u).toFixed(2)}px)`;
        if (K.some((q) => q.clip)) {
          const c = k.clip || [-1e4, -1e4, 1e4, 1e4];
          f.clipPath = `inset(${(c[1] * u).toFixed(1)}px ${((w - c[2]) * u).toFixed(1)}px ${((h - c[3]) * u).toFixed(1)}px ${(c[0] * u).toFixed(1)}px)`;
        }
        return f;
      };
      const kfs = [];
      const push = (ms, k) => kfs.push(Object.assign(frame(k), { offset: Math.max(0, Math.min(1, ms / durMs)), easing: KINETIC_EASE }));
      if (K[0].t > 0) push(0, K[0]);
      K.forEach((k) => push(k.t, k));
      const last = K[K.length - 1];
      // [KIN-CAP-NO-BLINK] The fade-out the burn writes for this title (220 ms
      // for hook titles; 0/80 ms for caption cues). A hardcoded 220 here made
      // every 2-word caption dip to nothing before the next one — the blink.
      const fadeMs = T.fadeOutMs != null ? +T.fadeOutMs : 220;
      push(Math.max(last.t, durMs - fadeMs), last);
      if (fadeMs > 0) push(durMs, Object.assign({}, last, { a: 0 }));
      // Offsets must be non-decreasing for WAAPI.
      for (let i = 1; i < kfs.length; i++) if (kfs[i].offset < kfs[i - 1].offset) kfs[i].offset = kfs[i - 1].offset;
      try { node.animate(kfs, { duration: durMs, fill: 'both' }).pause(); } catch (err) { /* keep the static letter */ }
    }
    el.appendChild(frag);
  }
  // Pin every animation to the video clock.
  const local = Math.max(0, (tNow - tw.start) * 1000);
  el.querySelectorAll('.kin-el').forEach((n) => {
    for (const a of n.getAnimations()) {
      if (paused) { if (a.playState === 'running') a.pause(); a.currentTime = local; }
      else {
        if (a.playState !== 'running') { a.currentTime = local; a.play(); }
        else if (Math.abs((a.currentTime || 0) - local) > 80) a.currentTime = local;
      }
    }
  });
  el.dataset.vis = '1';
}

// [TITLE-VIDEO-FX] Preview of a title's video effect (riot -> pink duotone).
// An SVG feColorMatrix with EXACTLY the coefficients the burn hands to
// ffmpeg's colorchannelmixer (pipeline titleVideoFxVf), applied to the stage's
// own <video> only — captions and titles stay untinted, as in the burn.
// Same catalog as the burn (video-fx.js); a cut-out previews as its duotone
// (segmentation only runs in the render).
const PREVIEW_VIDEO_FX = new Proxy({}, { get: (_, id) => (window.VideoFx && window.VideoFx.get(String(id))) || undefined });
function ensureVideoFxFilter(id, fx) {
  if (document.getElementById(id)) return;
  const L = [0.299, 0.587, 0.114].map((v) => v * fx.gain);
  const row = (k) => `${L.map((v) => (v * k).toFixed(4)).join(' ')} 0 0`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${row(fx.tint[0])} ${row(fx.tint[1])} ${row(fx.tint[2])} 0 0 0 1 0"/></filter>`;
  document.body.appendChild(svg);
}
function applyTitleVideoFx(layerEl, list, tNow) {
  const off = list === null;
  list = list || [];
  const vid = layerEl && layerEl.parentElement && layerEl.parentElement.querySelector('video');
  if (!vid) return;
  // [VIDEO-FX] Clip setting → Efek video replaces any preset's own effect.
  const cfx = state.cfg && state.cfg.videoFx && PREVIEW_VIDEO_FX[state.cfg.videoFx] && !off ? state.cfg.videoFx : '';
  if (cfx) list = list.filter((T) => !T.videoFx).concat([{ videoFx: cfx, start: 0, end: window.VideoFx.WINDOW_SEC }]);
  let want = '';
  for (const T of list) {
    const fx = PREVIEW_VIDEO_FX[T.videoFx];
    if (!fx) continue;
    // [FX-FRONT] The effect is the HOOK's: the clip's first WINDOW_SEC only,
    // like the burn — a long title with its own effect no longer tints the
    // whole clip in the editor.
    const W = window.VideoFx.WINDOW_SEC;
    const s = Math.max(0, +T.start || 0), e = Math.min(W, Math.max(s + 0.05, +T.end || s + W));
    if (s >= W || tNow < s || tNow > e) continue;
    const id = `soclfx-${T.videoFx}`;
    ensureVideoFxFilter(id, fx);
    want = `url(#${id})${tNow - s < fx.flashMs / 1000 ? ' brightness(2.2)' : ''}`;
  }
  if (vid.style.filter !== want) vid.style.filter = want;
}

function paintTitleLayer(layerEl, titles, tNow, W, H, opts = {}) {
  if (!layerEl) return;
  const list = (Array.isArray(titles) ? titles : []).filter(t => t && t.id);
  const sel = opts.selTitle || { id: null, wi: -1 };
  const interactive = !!opts.interactive;
  // Rebuild children only when the titles array changes shape (add/remove/reorder);
  // otherwise mutate text/position/visibility so drag stays smooth and selection sticks.
  // `:scope > .title-el`, NOT `[data-tid]`. The per-word spans below also carry
  // data-tid, and querySelectorAll searches DESCENDANTS — so a bare attribute
  // match counted titles + every word, could never equal wanted.length, and
  // rebuilt the whole layer on EVERY tick (~4×/sec). That silently killed the
  // dataset.sig cache and re-triggered the entrance animation continuously,
  // which is the title flicker seen during playback; in the editor it also
  // re-bound the drag handler to a fresh element each tick.
  const current = Array.from(layerEl.querySelectorAll(':scope > .title-el')).map(el => el.dataset.tid);
  const wanted  = list.map(t => t.id);
  if (current.length !== wanted.length || current.some((x, i) => x !== wanted[i])) {
    layerEl.innerHTML = list.map(t =>
      `<div class="cap-overlay style-${t.style || 'inverse_auto'} title-el" data-tid="${t.id}" style="position:absolute;pointer-events:none;cursor:${interactive ? 'grab' : 'default'};user-select:none;display:none"></div>`
    ).join('');
    if (opts.onBuild) layerEl.querySelectorAll('.title-el').forEach(el => opts.onBuild(el));
  }
  for (const T of list) {
    const el = layerEl.querySelector(`[data-tid="${T.id}"]`);
    if (!el) continue;
    if (T.kinetic && window.KineticTitle && window.KineticTitle.TEMPLATES[T.kinetic]) {
      const twK = (window.TitleLayout && window.TitleLayout.eventWindow)
        ? window.TitleLayout.eventWindow(T.start, T.end) : { start: +T.start || 0, end: +T.end || 3.5 };
      const showK = (tNow >= twK.start && tNow < twK.end)
        || (!!opts.paused && Math.abs(tNow - ((twK.start + twK.end) / 2)) < ((twK.end - twK.start) / 2 + 2));
      paintKineticTitle(el, T, tNow, W, H, showK, !!opts.paused);
      continue;
    }
    // Leaving a kinetic template (preset switched) must drop its letters.
    if (el.dataset.ksig) { delete el.dataset.ksig; el.innerHTML = ''; el.style.width = ''; el.style.height = ''; delete el.dataset.sig; }
    const toks = ensureTitleTokens(T);
    const selWi = (sel.id === T.id) ? sel.wi : -1;
    // [TITLE-LAYOUT] Word-index positions where an auto-shaped title starts a
    // new centered line — mirrors buildAss's titleLineBreaks EXACTLY (same
    // pure module, same input: the tokens' own text joined with spaces) so
    // the editor/dashboard preview never disagrees with what gets burned.
    // [AUTO-TITLE-REMOVED] No cfg gate any more (the Clip Options toggle is
    // gone); a title's own T.layout === 'single' is the only opt-out.
    const autoLayoutOn = T.layout !== 'single';
    const titleWordsJoined = toks.map(tk => tk.text).join(' ');
    const lineBreaks = (autoLayoutOn && window.TitleLayout)
      // [HOOK-SHAPE] T.lines rides along, or the preview shapes the title
      // differently from the burn — the one thing this module exists to prevent.
      ? window.TitleLayout.autoTitleBreaks(titleWordsJoined, T.layout, T.lines)
      : [];
    // [HOOK-WORD] Same gate + input as buildAss's hookIdxSet, so the accented
    // words in the editor/dashboard are always the same ones that get burned.
    // [TITLE-BOX] A title with any manually-boxed word drops the automatic
    // hook-word accent entirely for that title — the two are mutually
    // exclusive by design (spec: 2026-09-04-title-word-box-highlight-design.md).
    const boxedIdx = new Set(toks.reduce((arr, tk, i) => {
      if (tk.style && tk.style.box) arr.push(i);
      return arr;
    }, []));
    const hookIdxSet = new Set((autoLayoutOn && boxedIdx.size === 0 && window.TitleLayout)
      ? window.TitleLayout.hookWordIndices(titleWordsJoined, 2)
      : []);
    // [TITLE-FIT] Mirrors buildAss's fitScale exactly — same line count, same
    // table — so a shaped title never renders bigger in preview than it
    // burns (or vice versa).
    const fitScale = (autoLayoutOn && window.TitleLayout)
      ? window.TitleLayout.autoFitScale(lineBreaks.length + 1)
      : 1;
    // T.fn is part of the signature — a title-level font swap must rebuild the
    // spans, otherwise the new font never reaches the DOM.
    // [TITLE-SIG-TRACK] T.track and T.glowColor reach the DOM only through the
    // span rebuild below (titleWordCss builds them into the inline style). Left
    // out of the signature, the letter-spacing slider and the glow colour moved
    // their numbers while the preview kept the OLD spans — verified live: the
    // readout swung -0.20..0.40 and the rendered title never budged. Exactly the
    // trap the T.fn note above describes, one field later.
    // [TITLE-INK-LEADING] Kata dikelompokkan per BARIS dulu, lalu tiap baris
    // boleh digeser tegak. Aturan penyambungannya sama persis dengan reduce
    // yang dulu ada di sini: baris disambung <br>, kata di dalam satu baris
    // disambung spasi — atau oleh pengisi celah berwarna kalau dua kata
    // berkotak bertetangga.
    //
    // Di LUAR penjaga `sig`, karena nilai pergeserannya harus dihitung ulang
    // setelah penyusutan lebar diketahui — lihat [TITLE-INK-LEADING-FIT].
    const wordGroups = [];
    toks.forEach((_tk, wi) => {
      if (wi === 0 || lineBreaks.includes(wi)) wordGroups.push([]);
      wordGroups[wordGroups.length - 1].push(wi);
    });
    // [TITLE-INK-LEADING] Pergeseran tiap baris, dalam satuan kanonik 1920.
    //
    // Ukuran per-kata mengikuti tokenSizePx di sisi burn: override per-kata
    // TIDAK ikut fitScale maupun penyusutan lebar, ukuran dasar judul ikut
    // keduanya. Asimetri itu sudah ada dan disengaja di kedua sisi.
    //
    // Lead/gap diambil per BARIS dari face kata TERBESAR baris itu, bukan dari
    // font judul: lead sifat face (Anton 0.545 lawan Open Sauce Two 0.237),
    // dan memakai satu lead untuk semua baris membuat baris ber-face lain
    // meleset puluhan piksel — terukur 61,5px di sisi burn sebelum diperbaiki.
    const containerFamily = getComputedStyle(el).fontFamily;
    const tokFamily = (wi) => {
      const st = (toks[wi] && toks[wi].style) || {};
      if (st.fn) return `"${st.fn}"`;
      return T.fn ? `"${T.fn}"` : containerFamily;
    };
    // [TITLE-LINE-GEOM] Posisi tegak tiap baris, dalam satuan kanonik 1920.
    //
    // Ini tidak lagi "koreksi kecil" — ia MENIRU model baris libass sepenuhnya,
    // lalu membatalkan tata letak kotak-baris CSS. Semua tiga langkahnya diukur:
    //
    //   burn, jarak antar baris = px x emScale face-nya.
    //     Terukur tepat pada 5 font (bawaan 98, Anton 137, Poppins 139,
    //     Hanken 103, Cooper 79 — semuanya sama dengan \fs yang diemisikan).
    //     CSS memakai line-height 1.2 mati; untuk Anton itu 44% lebih rapat.
    //
    //   burn, atas tinta dalam satu baris = (baselineEm - capEm) x px.
    //     Terukur dalam 1,4-3,1px pada 4 font; sisanya bentuk huruf (huruf bulat
    //     melewati garis kapital).
    //
    //   CSS, atas tinta dalam satu baris = ((LH - (asc+desc))/2 + asc - capEm) x px.
    //     Baseline-nya diukur langsung dengan penanda vertical-align:baseline —
    //     prediksi lawan terukur beda 0,08 / -0,48 / -0,05 px pada 3 font.
    //
    // Selisihnya jadi `top` pembungkus baris. Mengembalikan null kalau metrik
    // salah satu sisi belum ada; tick berikutnya mencoba lagi.
    const computeLineTops = (baseFsCanon) => {
      if (!(window.TitleLayout && window.TitleLayout.inkLeadOffsets)) return null;
      const per = wordGroups.map((g) => {
        // Kata TERBESAR baris ini yang menentukan baseline dan tinggi barisnya
        // di libass, jadi face dan ukurannyalah yang berlaku untuk baris itu.
        let sizePx = 0, wfn = '';
        for (const wi of g) {
          const st = (toks[wi] && toks[wi].style) || {};
          const sz = st.fs ? Math.max(24, Math.min(240, +st.fs)) : baseFsCanon;
          if (sz > sizePx) { sizePx = sz; wfn = st.fn || T.fn || ''; }
        }
        const burn = burnFaceMetrics(T.style, wfn);
        const css = titleInkMetricsCss(wfn ? `"${wfn}"` : containerFamily);
        return (burn && css) ? { sizePx, burn, css } : null;
      });
      if (!per.length || per.some((x) => !x)) return null;
      if (!window.TitleLayout.titleLineTopsCss) return null;
      // Aritmetikanya di modul BERSAMA, supaya test bisa membandingkannya
      // langsung dengan titleInkLineTops di sisi burn — bukan dengan salinan
      // rumus di dalam test.
      return window.TitleLayout.titleLineTopsCss(per.map((x) => ({
        sizePx: x.sizePx,
        emScale: x.burn.emScale,
        baselineEm: x.burn.baselineEm,
        capEm: x.burn.capEm,
        descEm: x.burn.descEm,
        cssLeadEm: x.css.leadEm,
      })), TITLE_LINE_HEIGHT);
    };
    const sig = JSON.stringify([toks, T.fs, T.fn, T.style, T.anim, selWi, lineBreaks, [...hookIdxSet], T.boxColor, T.track, T.glowColor]);
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      // [TITLE-FIT-WIDTH-PREVIEW] Pembungkus baris SELALU dibuat. Ia tidak lagi
      // sekadar tempat menaruh pergeseran tegak: ia juga yang melarang baris
      // soft-wrap (white-space:nowrap di styles.css) dan yang menangkap pointer,
      // karena kotak judulnya sendiri sekarang selebar anggaran penuh.
      // Nilai `top`-nya tetap diisi belakangan, saat metrik IPC tiba.
      const isType = T.anim === 'type';
      // [TITLE-ANIM-PARITY] Must equal buildAss's title `type` branch exactly
      // (pipeline-inverse-v1.js, the `cstep`/`TW` constants right after
      // `if (anim2 === 'type')`) — a fixed 32ms/char with no cap on line length
      // used to type noticeably slower in preview than the ~26ms/char the burn
      // actually produces, most visible on long titles where the fixed stagger
      // ran well past the burn's finish.
      let twIdx = 0, typeCstep = 0;
      if (isType) {
        // [EVENT-WINDOW] Jendela efektif, sama seperti sisi burn. Untuk judul
        // normal angkanya identik; yang berubah hanya rentang tak masuk akal.
        const _tw = (window.TitleLayout && window.TitleLayout.eventWindow)
          ? window.TitleLayout.eventWindow(T.start, T.end)
          : { start: Math.max(0, +T.start || 0), end: Math.max((+T.start || 0) + 0.05, +T.end || 1) };
        const durMs = Math.max(300, (_tw.end - _tw.start) * 1000);
        const charCount = toks.reduce((n, tk) => n + Array.from(String(tk.text || '')).length + 1, 0);
        typeCstep = charCount > 1 ? Math.min(55, (durMs * 0.55) / charCount) : 0;
      }
      // [BOX-MERGE] A word is "in a run" when the neighbour on that side is
      // boxed too AND no line break separates them.
      const boxedAt = (i) => !!(toks[i] && toks[i].style && toks[i].style.box);
      // [TITLE-DRAG-BOX] ...and only while the two are still SIDE BY SIDE.
      // Mirrors titleBoxRects' `prev.dxPx === dxPx && prev.dyPx === dyPx` on
      // the burn side, which was fixed there and never mirrored here: dragging
      // one word away left its neighbour's inner corners square and the gap
      // between them still filled, so a bar of box hung in mid-air where the
      // word used to be. Equal offsets still merge — words dragged together
      // stay together, and the burn allows exactly that too.
      const dispAt = (i) => {
        const st = (toks[i] && toks[i].style) || {};
        return `${+st.dx || 0},${+st.dy || 0}`;
      };
      // True when word i continues the run from word i-1. ONE rule, used by
      // both the corner rounding and the gap filler, so the two can never
      // drift apart and round the corners while still painting the gap.
      const boxMergesLeft = (i) => boxedAt(i) && boxedAt(i - 1)
        && !lineBreaks.includes(i) && dispAt(i) === dispAt(i - 1);
      const runAt = (i) => ({
        left: boxMergesLeft(i),
        right: boxMergesLeft(i + 1),
      });
      const spanFor = toks.map((tk, wi) => {
        const cls = (wi === selWi) ? 'ttl-word ttl-sel' : 'ttl-word';
        // [TITLE-BOX-H] Face kata berkotak ditandai `data-bfn`; tinggi kotaknya
        // diisi tiap tick di bawah (metriknya datang lewat IPC, dan membangun
        // ulang span demi angka itu akan memutar ulang animasi judul).
        const boxFn = (tk.style && tk.style.box) ? ((tk.style && tk.style.fn) || T.fn || '') : null;
        const boxM = (boxFn != null) ? burnFaceMetrics(T.style, boxFn) : null;
        const stCss = titleWordCss(tk.style || {}, H, T.fn, hookIdxSet.has(wi), T.boxColor, T.track, T.glowColor, runAt(wi),
          { emScale: boxM && boxM.emScale, slotLh: TITLE_LINE_HEIGHT, dEm: titleBoxShiftEm(boxM) });
        // [TITLE-BOX-GAP] Kata yang menyambung ke kanan membawa spasinya sendiri
        // di dalam span-nya, jadi latar kotak yang SAMA menutup celah itu — face,
        // tinggi, dan baseline-nya otomatis sama. Pengisi terpisah yang dulu
        // dipakai berupa span inline yang kena `.style-X span` (font gaya, bukan
        // face kata) dan latarnya turun 1-2px dari kotak di kiri-kanannya.
        const trail = boxMergesLeft(wi + 1) ? ' ' : '';
        let inner;
        if (isType) {
          inner = Array.from(String(tk.text || '')).map(ch => {
            const d = Math.round(twIdx * typeCstep); twIdx++;
            return `<span class="cap-tw-char" style="animation-delay:${d}ms">${esc(ch)}</span>`;
          }).join('');
          twIdx++;
        } else {
          inner = esc(tk.text || '');
        }
        inner += trail;
        // [TITLE-WORD-DRAG] The word keeps its slot in the flow and is moved
        // with a transform, so the line does not reflow — matching the burn,
        // which draws it invisible in place and redraws it at an offset.
        const wdx = +(tk.style && tk.style.dx) || 0;
        const wdy = +(tk.style && tk.style.dy) || 0;
        // Canonical ASS units -> stage px with the SAME factor the rest of this
        // painter uses (H/1920). For a portrait frame that factor is identical
        // on both axes, which is the case every hook is authored in.
        const uPx = H / 1920;
        // [TITLE-DRAG-VISIBLE] `translate`, NOT `transform:translate()`: the
        // title animation's keyframes (pop/rise/drop/zoom, fill-mode both) own
        // `transform`, so an inline transform was overridden and a dragged word
        // never moved in the editor — the user kept dragging and the offsets
        // piled up into the burn (reported dy −346). `translate` composes with
        // the animation, the same fix captions got in [POS-ANIM-FIX].
        const moveCss = (wdx || wdy)
          ? `display:inline-block;translate:${(wdx * uPx).toFixed(2)}px ${(wdy * uPx).toFixed(2)}px;`
          : '';
        // [TITLE-WORD-ANIM] Judul bermode 'type' memakai mesin per-KARAKTER,
        // dan burn mewariskan animasi judul ke setiap kata di sana. Preview
        // harus berhenti di tempat yang sama: tanpa ini ia menjanjikan gerak
        // per-kata yang tidak pernah diburn.
        const wordCss = isType ? stCss.replace(/animation:[^;]*;?/g, '') : stCss;
        const bfnAttr = (boxFn != null) ? ` data-bfn="${esc(boxFn)}"` : '';
        const wsCss = trail ? 'white-space:pre;' : '';
        return `<span class="${cls}" data-tid="${T.id}" data-wi="${wi}"${bfnAttr} style="${wsCss}${moveCss}${wordCss}">${inner}</span>`;
      });
      // [TITLE-GAP-FACE] Spasi antar kata adalah teks telanjang di dalam
      // `.ttl-line` — sebuah <span>, jadi `.style-X span` memberinya font GAYA
      // dan tracking gaya. Untuk judul ber-T.fn itu face yang SALAH: burn
      // mengukur spasi dengan face judul dan tracking-nya sendiri. Terukur
      // (Anton, panggung 540px): celah 9px di pratinjau lawan 12px di video.
      // Face judul dipasang di sini, tracking diwarisi dari kontainer
      // ([TITLE-WORD-GAP]; untuk Anton = normal, sama dengan \fsp0 burn).
      // Tanpa T.fn dibiarkan seperti semula: font gaya memang face yang
      // diburn, dan tracking 1x lawan 2x terukur sama jauhnya dari libass
      // (+1,1px lawan -1,2px per celah) — mengganti tidak memperbaiki apa pun.
      const lineFace = T.fn ? `;letter-spacing:inherit;font-family:&quot;${esc(T.fn)}&quot;` : '';
      // [TITLE-STRUT-FACE] Kontainernya juga: strut `.title-el` (font UI,
      // Hanken) ikut menentukan tinggi tiap baris, dan computeLineTops
      // menganggap baris setinggi TITLE_LINE_HEIGHT dalam face baris itu.
      // Terukur pada Anton: 42,8px per baris, bukan 40,32 — 2,5px lebih
      // renggang per baris daripada video. Tanpa T.fn dibiarkan (terukur
      // 0-2px dari burn).
      el.style.fontFamily = T.fn ? `"${T.fn}"` : '';
      el.innerHTML = wordGroups.map((g, li) => {
        const body = g.map((wi, k) => {
          if (k === 0) return spanFor[wi];
          // The gap between two boxed neighbours has to be filled, or the block
          // is cut in two by a stripe of video. [TITLE-BOX-GAP]: the word on
          // the left already carries that space inside its own box.
          const joined = boxMergesLeft(wi);
          const sep = joined ? '' : ' ';
          return sep + spanFor[wi];
        }).join('');

        // Pembungkus dibuat di sini, tapi nilai `top`-nya diisi SETELAH
        // penyusutan lebar diketahui (di bawah) — lihat [TITLE-INK-LEADING-FIT].
        //
        // Pergeseran ditempel ke pembungkus BARIS, bukan ke span kata: `em` dan
        // `%` pada span kata menyelesaikan terhadap font-size KATA ITU, jadi kata
        // terbesar akan dapat pergeseran terbesar — justru kebalikan dari satu
        // pergeseran per baris.
        //
        // position:relative itu visual saja: alur tidak berubah, jadi pengisi
        // celah berkotak dan kata yang digeser ikut bergerak bersama barisnya,
        // dan scrollWidth untuk penyusutan lebar tetap valid.
        // animation/text-shadow dinetralkan: selektor gaya judul menyasar
        // `.cap-overlay.anim-* span` dan `.cap-overlay.style-* span` sebagai
        // KETURUNAN, jadi pembungkus ini ikut kena. Animasi akan bertumpuk
        // dengan animasi kata (transform berlapis), dan text-shadow akan
        // menggambar lapisan pendar kedua untuk glyph yang sama.
        return `<span class="ttl-line" data-li="${li}" style="position:relative;animation:none;text-shadow:none${lineFace}">${body}</span>`;
      }).join('<br>');
      // [TITLE-LAYOUT] Explicit, defensive: .cap-overlay already sets
      // text-align:center in styles.css, but stamping it inline here too
      // guarantees each <br>-separated line centers under its own width the
      // same way libass centers each \N line under \an8, even somewhere this
      // element ends up outside the selector that CSS rule targets.
      el.style.textAlign = lineBreaks.length ? 'center' : '';
      // [TITLE-WORD-GAP] The space between words is a bare text node BETWEEN
      // the inline-block `.ttl-word` spans (the reduce join above), so it
      // never inherited the per-span letter-spacing and rendered at FULL
      // width — while the burn tightens every glyph boundary including around
      // spaces via the per-token \fsp (pipeline-inverse-v1.js tokOpen), making
      // burned word gaps tighter than the preview's. Verified by DOM
      // measurement: the inter-word gap was identical with and without the
      // per-span tracking. Track the CONTAINER so the whitespace tightens too;
      // the spans keep their own `!important` letter-spacing, so per-word
      // tracking is unchanged — only the previously-untracked gap is affected.
      //
      // The container value is DOUBLE the word tracking: libass applies \fsp
      // on BOTH sides of the space (prev-glyph→space and space→next-glyph, two
      // units), whereas CSS letter-spacing adds only one trailing unit to the
      // lone space text node. Measured in Chrome at 120px: untracked gap
      // 33.34px, one-unit 24.95px, two-unit 16.55px — and libass's own
      // 2×0.07×fss target is 16.8px, so 2× matches within 0.01px while 1× left
      // half the drift. Pinyon (connected script, no tracking) stays untracked.
      // [TITLE-TRACK] The title's own spacing overrides the font/style default
      // here too. Without it the glyphs tighten but the inter-word gaps keep
      // the default, so the line reads unevenly at any non-default track —
      // and the burn, whose per-token \fsp tightens the spaces as well, would
      // not match. Doubled for the same two-sided-\fsp reason as above.
      el.style.letterSpacing = (T.track != null && Number.isFinite(+T.track))
        ? emTrackTimes2(`${Math.max(-0.2, Math.min(0.4, +T.track))}em`)
        : (T.fn
          ? (titleFontTracking(T.fn) ? emTrackTimes2(titleFontTracking(T.fn)) : 'normal')
          : TITLE_GAP_TRACK_CSS);
    }
    // [TITLE-FIT-WIDTH-VIS] `show`/`display` must be resolved BEFORE the
    // scrollWidth read below — a hidden (`display:none`) element always
    // reports scrollWidth 0 in every browser, which silently skipped the
    // shrink check on the exact tick a title becomes visible (or gets
    // recreated by the innerHTML rebuild above, which leaves `display`
    // unset). Hoisted from further down in this function, unchanged.
    // [EVENT-WINDOW] Jendela yang SAMA dengan yang diburn. Dulu di sini
    // `T.end || 1e9`, jadi judul tanpa `end` tampil selamanya di preview
    // sementara burn cuma mengedipkannya 0,05s; dan rentang terbalik atau
    // berdurasi nol tidak tampil sama sekali di preview padahal burn tetap
    // mengedipkannya. Ketiganya terukur.
    const tw = (window.TitleLayout && window.TitleLayout.eventWindow)
      ? window.TitleLayout.eventWindow(T.start, T.end)
      : { start: Math.max(0, +T.start || 0), end: Math.max((+T.start || 0) + 0.05, +T.end || 1) };
    const inRange = tNow >= tw.start && tNow < tw.end;
    const nearRange = !!opts.paused
      && Math.abs(tNow - ((tw.start + tw.end) / 2)) < ((tw.end - tw.start) / 2 + 2);
    const show = inRange || nearRange;
    el.style.display = show ? 'block' : 'none';
    let effFs = (T.fs || 96) * fitScale;
    el.style.fontSize = `${Math.max(11, (effFs / 1920) * H).toFixed(2)}px`;
    // [TITLE-FIT-WIDTH] `fitScale` only reasons about LINE COUNT (see
    // title-layout.js) — it has no idea whether the text actually rendered in
    // THIS font (italic, condensed, per-word overrides) is wider than the
    // frame. Reported live with a screenshot: a 2-word title overflowed past
    // BOTH video edges — short titles always get fitScale=1 (no shrink at
    // all), so nothing ever caught this. The DOM itself is the most accurate
    // width measurement available here (no font-parsing needed in the
    // browser) — after laying the text out at the line-count-scaled size,
    // read back the ELEMENT'S OWN rendered width (scrollWidth already
    // reflects the widest hard-broken `<br>` line, since lines don't
    // soft-wrap) and shrink the font-size further if it exceeds the CSS
    // max-width budget (92.59% of the stage, matching `.title-el`'s own
    // max-width rule in styles.css so this never fights that constraint).
    // Mirrors the equivalent real-glyph-width fix on the burn side
    // (pipeline-inverse-v1.js, textWidthEmSafe) so preview and burn agree.
    // `effFs` itself is corrected (not just the CSS px value) so the
    // titleCenterShift math right below stays consistent with what's
    // actually on screen — otherwise a shrunk title would drift vertically
    // out of sync with its own centring offset.
    // [TITLE-FIT-WIDTH-CACHE] This block used to run — and force a
    // synchronous layout reflow via scrollWidth — on EVERY paint tick
    // (~4x/sec during playback per this function's own timeupdate wiring),
    // for every visible title, even when nothing about it changed since the
    // last tick. The shrink RATIO (titleMaxWidthPx/renderedWidthPx) is
    // stage-size-relative, not absolute, so it stays valid for as long as
    // the title's own content/style `sig` (line 1402) is unchanged — cache
    // it there and skip the reflow-forcing read entirely on repeat ticks.
    if (el.dataset.fitSig !== sig) {
      const titleMaxWidthPx = W * 0.9259;
      const renderedWidthPx = el.scrollWidth;
      const shrinkRatio = (renderedWidthPx > titleMaxWidthPx && renderedWidthPx > 0)
        ? titleMaxWidthPx / renderedWidthPx : 1;
      el.dataset.fitSig = sig;
      el.dataset.fitRatio = shrinkRatio;
    }
    const cachedRatio = +el.dataset.fitRatio || 1;
    if (cachedRatio < 1) {
      effFs = effFs * cachedRatio;
      el.style.fontSize = `${Math.max(9, (effFs / 1920) * H).toFixed(2)}px`;
    }
    // [TITLE-INK-LEADING-FIT] Nilai pergeseran baris diisi DI SINI, di luar
    // penjaga `sig`, dan dalam PIKSEL panggung.
    //
    // Dua sebabnya, dua-duanya memberi angka salah kalau dilanggar:
    //
    //   1. Penyusutan lebar ([TITLE-FIT-WIDTH]) baru diketahui setelah scrollWidth
    //      dibaca di atas. Di sisi burn `fs2` sudah termasuk penyusutan itu
    //      sementara `st.fs` per-kata tidak, jadi selisih ukuran yang benar
    //      adalah `st.fs - effFs SESUDAH susut`. Memakai ukuran pra-susut salah —
    //      dan menuliskannya sebagai `em` malah menskalakannya DUA kali, karena
    //      1em pembungkus sendiri sudah = font-size pasca-susut.
    //   2. `H` tidak ada di dalam `sig`, jadi span tidak dibangun ulang saat
    //      panggung berubah ukuran. Dihitung di sini, ia ikut tiap tick.
    // [TITLE-BOX-H] Tinggi kotak per face, di luar penjaga `sig` karena
    // metriknya bisa tiba setelah span dibangun. Hanya margin TEGAK yang
    // disentuh; margin datar (-PAD_EM, [TITLE-BOX-NOFLOW]) tetap dari CSS-nya.
    el.querySelectorAll('.ttl-word[data-bfn]').forEach((sp) => {
      const m = burnFaceMetrics(T.style, sp.dataset.bfn);
      if (!m || !(m.emScale > 0)) return;
      // [TITLE-BOX-VCENTER] Pusat kotak pada tinta, seperti burn.
      const v = titleBoxVertEm(m.emScale, TITLE_LINE_HEIGHT, titleBoxShiftEm(m));
      const key = `${v.h.toFixed(4)}|${v.d.toFixed(4)}`;
      if (sp.dataset.bh === key) return;
      sp.dataset.bh = key;
      sp.style.lineHeight = `${v.lh.toFixed(4)}em`;
      sp.style.paddingTop = `${v.pt.toFixed(4)}em`;
      sp.style.paddingBottom = `${v.pb.toFixed(4)}em`;
      sp.style.marginTop = `${v.mt.toFixed(4)}em`;
      sp.style.marginBottom = `${v.mb.toFixed(4)}em`;
    });
    const inkLines = el.querySelectorAll(':scope > .ttl-line');
    if (inkLines.length) {
      const offsFit = computeLineTops(effFs);
      const uPx = H / 1920;
      inkLines.forEach((w) => {
        const li = +w.dataset.li || 0;
        const off = offsFit ? (offsFit[li] || 0) : 0;
        w.style.top = off ? `${(off * uPx).toFixed(2)}px` : '';
      });
    }
    // ASS 1080×1920 units → stage px. Anchor an8 = top-center (matches \pos).
    el.style.left = `${((T.x || 540) / 1080) * W}px`;
    // [TITLE-CENTER] Mirrors buildAss's titleCenterShift exactly — an8 anchors
    // the block's TOP, so every title (1 line or many) must shift up by half
    // its OWN full height for T.y to land on the block's visual centre.
    const titleCenterShift = ((lineBreaks.length + 1) * effFs * 1.2) / 2;
    el.style.top  = `${(((T.y || 960) - titleCenterShift) / 1920) * H}px`;
    el.style.transform = 'translateX(-50%)';
    paintTitleBackdrop(el, T, show, W, H, effFs);   // [HOOK-BACKDROP]
    // inRange/nearRange/show/display already resolved above, before the
    // width-fit scrollWidth read.
    const wasShown = el.dataset.vis === '1';
    const a = ['pop','fade','rise','drop','zoom','blur','slam'].includes(T.anim) ? T.anim : '';
    // [TITLE-WORD-GLOW] A marked word lights itself, so the container's
    // all-or-nothing glow has to step aside — otherwise every word glows and
    // the per-word choice means nothing, which is exactly what the burn used
    // to do before it learned the same trick.
    const perWordGlow = Array.isArray(T.tokens) && T.tokens.some(tk => tk && tk.style && tk.style.gl);
    const wantCls = `cap-overlay style-${T.style || 'inverse_auto'} title-el${(show && a) ? ` anim-${a}` : ''}${(T.glow === false || perWordGlow) ? ' no-glow' : ''}`;
    if (el.className !== wantCls) el.className = wantCls;
    if (show && !wasShown && a) { void el.offsetWidth; }
    if (show && !wasShown && T.anim === 'type') {
      el.querySelectorAll('.cap-tw-char').forEach(sp => { sp.style.animation = 'none'; void sp.offsetWidth; sp.style.animation = ''; });
    }
    // Per-word anim overrides live as inline `animation:` — reflow alone won't
    // restart them, so clear/restore the exact value on each entry.
    if (show && !wasShown) {
      el.querySelectorAll('.ttl-word').forEach(sp => {
        const inl = sp.style.animation;
        if (!inl) return;
        sp.style.animation = 'none'; void sp.offsetWidth; sp.style.animation = inl;
      });
    }
    el.dataset.vis = show ? '1' : '0';
  }
  applyTitleVideoFx(layerEl, (!interactive && state.previewFxBurned) ? null : list, tNow);
}

// [HOOK-OVER-CAPTIONS] Same rule as the burn (trimCuesUnderHook): while a
// hook that took the caption area is on screen, no caption shows.
function captionsHiddenByHook(titles, t) {
  return (Array.isArray(titles) ? titles : []).some((T) => T && T.hideCaptions && t < (+T.end || 0));
}
// [KINETIC-CAPTION] The active cue as a kinetic "title" so the shared painter
// draws it. Null when no caption template is on or no cue is active.
function kineticCaptionTitle(cue, cfg, next = null) {
  const id = cfg && cfg.captionKinetic;
  if (cfg?.subtitleBoxColor || !id || !cue || !String(cue.text || '').trim() || !window.KineticTitle || !window.KineticTitle.TEMPLATES[id]) return null;
  return { id: '__kcap', kinetic: id, text: cue.text, start: +cue.start || 0, end: +cue.end || 0,
    x: +cfg.subtitleX || 540, capTop: +cfg.subtitleY || 540, fs: +cfg.subtitleFontSize || 64,
    // [KIN-CAP-NO-BLINK] same fade-out as the burn for this cue
    fadeOutMs: window.KineticTitle.kinCapFadeMs ? window.KineticTitle.kinCapFadeMs(cue, next, CONTIGUOUS_CUE_GAP_SEC) : 80,
    glow: cfg.subtitleGlow !== false };   // [CAP-QUOTE] Glow switch follows the caption's own
}
let _dashKinCap = null;

// Dashboard-side tick: same painter, same stage geometry as applyCaptionStyle.
function tickDashTitles() {
  const layer = document.getElementById('dashTitleLayer');
  if (!layer) return;
  // [DASH-TITLE] `state.current` never existed — the state object has
  // activeClip / currentPreviewIdx. Reading it always yielded undefined, so
  // this painter took its empty early-out on every call and persistent titles
  // were invisible in the dashboard preview even though the editor and the
  // burn both showed them.
  const clip = state.clips[state.activeClip];
  // [TITLE-DOUBLE] Mirrors previewSubsBurned's cueWords=[] short-circuit: a
  // file that already has these titles baked in must not also get them
  // painted live on top.
  const kin = state.previewSubsBurned ? null : _dashKinCap;   // [KINETIC-CAPTION]
  const titles = state.previewTitlesBurned ? [] : (clip?.titles || []);
  const blendLayer = kinBlendLayerFor(layer);
  if (!clip || (!titles.length && !kin)) { layer.innerHTML = ''; if (blendLayer) blendLayer.innerHTML = ''; return; }
  const styleH = parseFloat(els.stage?.style.height);
  const H = (Number.isFinite(styleH) && styleH > 0) ? styleH : (els.stage?.clientHeight || 1);
  const W = els.stage?.clientWidth || 1;
  const sub = !!kin && kinSubtract(state.cfg);
  paintTitleLayer(layer, titles.concat(kin && !sub ? [kin] : []), els.preview.currentTime || 0, W, H, {
    paused: !!els.preview.paused, interactive: false,
  });
  if (blendLayer) {
    if (sub) paintTitleLayer(blendLayer, [kin], els.preview.currentTime || 0, W, H, { paused: !!els.preview.paused, interactive: false });
    else blendLayer.innerHTML = '';
  }
}
// [SUBTRACT-SPLIT] Subtract (inverse_auto) on a Caption animasi template: the
// caption gets its OWN layer with mix-blend-mode:difference, as the burn
// blends only the captions. It must be a sibling of the title layer — that
// layer has a z-index (its own stacking context), so a blend set on a child
// would only mix with the layer, never with the video.
function kinSubtract(cfg) { return !!(cfg && cfg.subtitleStyle === 'inverse_auto'); }
function kinBlendLayerFor(layer) {
  if (!layer || !layer.parentElement) return null;
  let el = layer.parentElement.querySelector(':scope > .kin-blend-layer');
  if (!el) {
    el = document.createElement('div');
    el.className = `${layer.className} kin-blend-layer`;
    el.style.mixBlendMode = 'difference';
    layer.after(el);
  }
  return el;
}

// [BURN-FONT] The five faces offered for the burned caption. `value` is what
// goes into the ASS Style line and MUST be a name libass resolves from
// assets/fonts — these are the exact strings already proven in CAPTION_FONTS
// (probed with ffmpeg fontselect). `css` is only for the dropdown preview and
// maps to the @font-face families declared in styles.css.
// `sample` is drawn IN the face itself, so the button is the specimen — the
// name of a font tells you nothing, its shapes tell you everything. `size` and
// `track` per entry because the faces have wildly different metrics: Pinyon
// Script's x-height is a fraction of Open Sauce's, so a single font-size makes
// the row look broken rather than varied.
// [TRACK-UNIFORM] `track` here is what the SPECIMEN CHIP is drawn with, so it has
// to be the value the font actually burns at — otherwise the picker advertises a
// tightness the output never delivers, which is how "Times Cond -0.02" sat next
// to a burn that applied -0.05. Every face uses TRACK_EM_CSS now except Pinyon
// Script, a connected script whose letter joins break when pulled together.
// (`size` is chip-only: it balances the specimens optically in the picker and
// deliberately never reaches Fontsize — the caption size slider owns that.)
const BURN_FONTS = [
  { label: 'Default',               sample: 'Ikut gaya',   size: 15, track: TRACK_EM_CSS, value: '',                             css: "'Open Sauce Two Bold',sans-serif" },
  { label: 'Open Sauce Tight',      sample: 'Open Sauce',  size: 17, track: TRACK_EM_CSS, value: 'Open Sauce Two Bold',          css: "'Open Sauce Two Bold',sans-serif" },
  { label: 'Times New Roman Cond',  sample: 'Times Cond',  size: 19, track: TRACK_EM_CSS, value: 'Times New Roman MT Condensed', css: "'Times New Roman MT Condensed',serif" },
  { label: 'Arial Narrow Cond',     sample: 'Arial Narrow',size: 18, track: TRACK_EM_CSS, value: 'Arial Nova Cond',              css: "'Arial Nova Cond','Arial Narrow',sans-serif" },
  { label: 'Pinyon Script',         sample: 'Pinyon',      size: 26, track: '0',          value: 'Pinyon Script',                css: "'Pinyon Script',cursive" },
  { label: 'Apple Garamond',        sample: 'Garamond',    size: 19, track: TRACK_EM_CSS, value: 'Apple Garamond',               css: "'Apple Garamond',serif" },
];

// [BURN-LOOK] The three looks, expressed with style presets that already
// render correctly rather than new ones: plain = flat white, glow = the same
// white with a soft halo, subtract = the auto-inverting knockout (text flips
// the pixels underneath it, so it stays readable on any background).
const BURN_LOOKS = [
  { id: 'plain',    label: 'Plain white', hint: 'Putih rata, tanpa halo',                    cfg: { subtitleStyle: 'white_clean',  subtitleGlow: false } },
  { id: 'glow',     label: 'Glow',        hint: 'Putih dengan halo lembut',                  cfg: { subtitleStyle: 'white_clean',  subtitleGlow: true  } },
  { id: 'subtract', label: 'Subtract',    hint: 'Teks membalik warna latar di belakangnya',  cfg: { subtitleStyle: 'inverse_auto', subtitleGlow: false } },
];
function burnLookOf(c) {
  const st = c.subtitleStyle;
  if (st === 'inverse_auto') return 'subtract';
  if (st === 'white_clean') return c.subtitleGlow === false ? 'plain' : 'glow';
  return '';   // one of the neon/bw presets — no look chip is active
}

// [CAPTION-PLACEMENT] Clip Options' caption position + size: a mini preview,
// typed values, centre buttons, Y presets, a size slider, and dragging the
// caption inside the frame. Same contract as the Caption Editor's Position /
// Typography sliders: live writes to state.cfg while moving, saveCfg() on
// commit, and applyCaptionStyle() so the big preview follows along.
function paintCaptionPlacement() {
  const CP = window.CaptionPlacement;
  const frame = document.getElementById('f_cpFrame');
  const ov = document.getElementById('f_cpOv');
  const tx = document.getElementById('f_cpTx');
  if (!CP || !frame || !ov || !tx) return;
  const c = state.cfg;
  const ar = FORMAT_AR[c.format] || '9/16';
  const [arW, arH] = ar.split('/').map(Number);
  frame.style.aspectRatio = ar;
  // Landscape takes the panel's width; portrait and square keep the CSS height.
  frame.style.width = arW > arH ? '100%' : '';
  frame.style.height = arW > arH ? 'auto' : '';
  // Same look as the dashboard caption: style class, glow, burn font,
  // tracking and case — minus animation and the fit-width pass, which need
  // real cues.
  ov.className = `caption-overlay style-${c.subtitleStyle || 'neon_green'}${c.subtitleGlow === false ? ' no-glow' : ''}`;
  const bf = BURN_FONTS.find(f => f.value && f.value === (c.subtitleFont || ''));
  if (bf) tx.style.setProperty('font-family', bf.css, 'important');
  else tx.style.removeProperty('font-family');
  tx.style.setProperty('letter-spacing', fontTrackCss(bf && bf.value), 'important');   // [PINYON-TRACK]
  tx.style.textTransform = CASE_CSS[c.subtitleCase] || 'none';
  const v = { x: CP.clampValue('x', c.subtitleX), y: CP.clampValue('y', c.subtitleY), fs: CP.clampValue('fs', c.subtitleFontSize) };
  const g = CP.previewGeometry(v, frame.clientWidth, frame.clientHeight);
  ov.style.left = `${g.leftPct}%`;
  ov.style.top = `${g.topPx}px`;
  ov.style.bottom = 'auto';
  tx.style.fontSize = `${g.fontPx}px`;
  // Numbers: leave the field the user is typing in alone.
  for (const [k, id] of [['x', 'f_cpX'], ['y', 'f_cpY'], ['fs', 'f_cpFs']]) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v[k];
  }
  const range = document.getElementById('f_cpFsRange');
  if (range) range.value = v.fs;
  const val = document.getElementById('f_cpFsVal');
  if (val) val.textContent = `${v.fs}px`;
  document.querySelectorAll('#f_cpPreset button').forEach(b => b.classList.toggle('active', +b.dataset.y === v.y));
}

function wireCaptionPlacementPanel() {
  const CP = window.CaptionPlacement;
  const frame = document.getElementById('f_cpFrame');
  if (!CP || !frame) return;
  const KEY = { x: 'subtitleX', y: 'subtitleY', fs: 'subtitleFontSize' };
  const setLive = (patch) => {
    for (const [k, v] of Object.entries(patch)) state.cfg[KEY[k]] = v;
    paintCaptionPlacement();
    try { applyCaptionStyle(); } catch {}
  };
  const commit = (patch) => saveCfg(Object.fromEntries(Object.entries(patch).map(([k, v]) => [KEY[k], v])));
  const set = (patch) => { setLive(patch); commit(patch); };

  // Typed values: follow along only while the number is already in range
  // (typing "1440" passes through "1", which must not yank the caption to
  // the top), and clamp + save on Enter / blur.
  for (const [k, id] of [['x', 'f_cpX'], ['y', 'f_cpY'], ['fs', 'f_cpFs']]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      const n = Number(el.value);
      if (el.value !== '' && n >= CP.RANGE[k].min && n <= CP.RANGE[k].max) setLive({ [k]: Math.round(n) });
    });
    el.addEventListener('change', () => { const v = CP.clampValue(k, el.value); el.value = v; set({ [k]: v }); });
  }
  const range = document.getElementById('f_cpFsRange');
  range?.addEventListener('input', () => setLive({ fs: CP.clampValue('fs', range.value) }));
  range?.addEventListener('change', () => commit({ fs: CP.clampValue('fs', range.value) }));
  document.getElementById('f_cpXc')?.addEventListener('click', (e) => { e.preventDefault(); set({ x: 540 }); });
  document.getElementById('f_cpYc')?.addEventListener('click', (e) => { e.preventDefault(); set({ y: 960 }); });
  document.querySelectorAll('#f_cpPreset button').forEach(b => b.addEventListener('click', () => set({ y: +b.dataset.y })));

  // Drag anywhere in the frame: the caption moves by the same amount.
  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, moved: false,
      start: { x: CP.clampValue('x', state.cfg.subtitleX), y: CP.clampValue('y', state.cfg.subtitleY) } };
    frame.setPointerCapture(e.pointerId);
    frame.classList.add('is-dragging');
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.moved = true;
    setLive(CP.dragTo(drag.start, e.clientX - drag.sx, e.clientY - drag.sy, frame.clientWidth, frame.clientHeight));
  });
  const end = () => {
    if (!drag) return;
    if (drag.moved) commit({ x: state.cfg.subtitleX, y: state.cfg.subtitleY });
    drag = null;
    frame.classList.remove('is-dragging');
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);

  // Other caption controls in this panel (style, font, glow, case, format)
  // change what the preview should look like. The panel body outlives each
  // render of this panel, so that listener is attached once only.
  if (!els.panelBody.dataset.cpWired) {
    els.panelBody.dataset.cpWired = '1';
    const repaint = () => requestAnimationFrame(paintCaptionPlacement);
    els.panelBody.addEventListener('click', repaint);
    els.panelBody.addEventListener('change', repaint);
  }
  try { new ResizeObserver(() => paintCaptionPlacement()).observe(frame); } catch {}
  requestAnimationFrame(paintCaptionPlacement);
}

function wireBurnFontPanel() {
  const box = document.getElementById('f_burnFont');
  const prev = document.getElementById('f_burnFontPreview');
  if (!box || !prev) return;
  const paintPreview = () => {
    const cur = state.cfg.subtitleFont || '';
    const f = BURN_FONTS.find(x => x.value === cur) || BURN_FONTS[0];
    prev.style.fontFamily = f.css;
    prev.style.fontSize = Math.round(f.size * 1.35) + 'px';
    prev.style.letterSpacing = f.track;
    box.querySelectorAll('.fspec').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
  };
  paintPreview();
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('.fspec');
    if (!btn) return;
    await saveCfg({ subtitleFont: btn.dataset.v });
    paintPreview();
    // The unburned preview overlay must follow the burn, or the editor stops
    // being WYSIWYG — the exact drift that made caption editing untrustworthy
    // before.
    try { applyCaptionStyle(); } catch {}
    try { renderGallery(); } catch {}
  });
  document.querySelectorAll('#f_burnLook button').forEach(b => {
    b.addEventListener('click', async () => {
      const look = BURN_LOOKS.find(l => l.id === b.dataset.v);
      if (!look) return;
      await saveCfg(look.cfg);
      renderClipPanel();
      try { applyCaptionStyle(); } catch {}
      toast(`Gaya caption → ${look.label}`);
    });
  });
}

// [WHISPER-UI] Offline-transcription controls inside Clip Options: pick a
// model, see whether it is already on disk, download or remove it by hand.
// Deliberately a manual path in ADDITION to the mid-run prompt — being asked
// to wait for a ~200 MB download in the middle of a job is the worst possible
// moment to make that decision.
async function wireOfflineAsrPanel() {
  const box = document.getElementById('f_asrBox');
  if (!box || !window.socl?.whisper) { if (box) box.hidden = true; return; }
  const $s = (id) => document.getElementById(id);
  const status = $s('f_asrStatus');
  const sel = $s('f_whisperModel');
  const btnGet = $s('f_asrInstall');
  const btnDel = $s('f_asrRemove');

  const paint = async () => {
    let st;
    try { st = await window.socl.whisper.status(state.cfg.whisperModelSize); }
    catch { box.hidden = true; return; }
    if (!st.supported) {
      // Never advertise a download that cannot work on this machine.
      status.textContent = `Belum tersedia untuk ${st.platform}.`;
      sel.hidden = true; btnGet.hidden = true; btnDel.hidden = true;
      return;
    }
    sel.innerHTML = st.models.map(m =>
      `<option value="${esc(m.id)}" ${st.model === m.id ? 'selected' : ''}>${esc(m.label)}${m.installed ? ' ✓ terpasang' : ''}</option>`
    ).join('');
    const cur = st.models.find(m => m.id === st.model);
    status.innerHTML = cur?.installed
      ? `✓ Siap dipakai offline — <b>${esc(cur.label)}</b>.`
      : `Belum terpasang. Sekali unduh ~${st.sizeMB} MB, setelah itu jalan tanpa internet dan tanpa API key.<br>Dipakai hanya kalau video tidak punya subtitle dan tidak ada key — Groq (gratis) tetap lebih cepat.`;
    btnGet.hidden = !!cur?.installed;
    btnDel.hidden = !st.binary;
  };

  sel.addEventListener('change', async () => {
    await saveCfg({ whisperModelSize: sel.value });
    paint();
  });

  btnGet.addEventListener('click', async () => {
    if (btnGet.disabled) return;
    btnGet.disabled = true;
    const progEl = $s('f_asrProg');
    if (progEl) progEl.style.display = 'block';
    const bar = $s('f_asrBar'), msg = $s('f_asrMsg');
    const off = window.socl.whisper.onProgress((p) => {
      if (p.phase === 'done') return;
      const pct = Math.round((p.percent || 0) * 100);
      // [ASR-CLEANUP] These nodes are captured before the download starts and
      // are gone if the user switches rail panel meanwhile — the callback keeps
      // firing against the detached ones, which is harmless, but never assume
      // they were found in the first place.
      if (bar) bar.style.width = pct + '%';
      if (msg) msg.textContent = `${p.phase === 'binary' ? 'Mesin transkrip' : 'Model'} — ${pct}%`;
    });
    try {
      const r = await window.socl.whisper.ensure(sel.value);
      if (r?.ok) {
        // Downloading by hand is itself consent — do not ask again mid-run.
        await saveCfg({ localAsr: true });
        toast('✓ Caption offline siap dipakai');
      } else {
        toast('Gagal: ' + (r?.error || 'tidak diketahui'), 'err');
      }
    } catch (e) {
      toast('Gagal: ' + (e?.message || e), 'err');
    } finally {
      // [ASR-CLEANUP] The whisper download runs for minutes; switching the rail
      // panel meanwhile replaces #panelBody's innerHTML and destroys these
      // nodes. A bare `$s('f_asrProg').style` then threw TypeError right here,
      // aborting the rest of the cleanup (button never re-enabled, no repaint)
      // as an unhandled rejection with nothing shown to the user.
      off?.();
      const prog = $s('f_asrProg');
      if (prog) prog.style.display = 'none';
      if (bar) bar.style.width = '0';
      btnGet.disabled = false;
      if (document.getElementById('f_asrBox')) paint();
    }
  });

  btnDel.addEventListener('click', async () => {
    await window.socl.whisper.remove();
    toast('Caption offline dihapus');
    paint();
  });

  paint();
}

// [CTX-MODEL] "Pembaca konteks lokal": an optional ~95 MB model that reads the
// meaning of the transcript to pick moments when no AI key is set. Same manual
// install pattern as offline captions above.
async function wireContextModelPanel() {
  const box = document.getElementById('f_ctxBox');
  if (!box || !window.socl?.ctxModel) { if (box) box.hidden = true; return; }
  const $s = (id) => document.getElementById(id);
  const status = $s('f_ctxStatus'), btnGet = $s('f_ctxInstall'), btnDel = $s('f_ctxRemove');
  const paint = async () => {
    let st;
    try { st = await window.socl.ctxModel.status(); } catch { box.hidden = true; return; }
    if (!st.supported) {
      status.textContent = `Belum tersedia untuk ${st.platform}.`;
      btnGet.hidden = true; btnDel.hidden = true;
      return;
    }
    status.innerHTML = st.installed
      ? '✓ Terpasang — tanpa API key, momen klip dipilih dari makna transkrip (hook, cerita, punchline), bukan cuma kata yang sering muncul.'
      : `Belum terpasang. Sekali unduh ~${st.sizeMB} MB, jalan offline. Dipakai saat tidak ada API key AI; dengan Groq/Gemini, AI tetap yang memilih.`;
    btnGet.hidden = !!st.installed;
    btnDel.hidden = !st.installed;
  };
  btnGet.addEventListener('click', async () => {
    if (btnGet.disabled) return;
    btnGet.disabled = true;
    const prog = $s('f_ctxProg'), bar = $s('f_ctxBar'), msg = $s('f_ctxMsg');
    if (prog) prog.style.display = 'block';
    const off = window.socl.ctxModel.onProgress((p) => {
      if (p.phase === 'extract') { if (msg) msg.textContent = 'Memasang…'; if (bar) bar.style.width = '100%'; return; }
      if (p.phase !== 'download') return;
      const pct = Math.round((p.percent || 0) * 100);
      if (bar) bar.style.width = pct + '%';
      if (msg) msg.textContent = `Mengunduh — ${pct}%`;
    });
    let failed = '';
    try {
      const r = await window.socl.ctxModel.ensure();
      if (r?.ok) toast('✓ Pembaca konteks lokal siap dipakai');
      else failed = r?.error || 'tidak diketahui';
    } catch (e) {
      failed = e?.message || String(e);
    } finally {
      off?.();
      const pr = $s('f_ctxProg'); if (pr) pr.style.display = 'none';
      btnGet.disabled = false;
      if (document.getElementById('f_ctxBox')) await paint();
      if (failed) {
        toast('Gagal: ' + failed, 'err');
        // stays visible (a toast is gone before anyone reads it); a retry reuses what was already downloaded
        const st = $s('f_ctxStatus');
        if (st) st.innerHTML = `⚠ Unduhan gagal: ${esc(failed)}<br>Coba klik Download lagi, atau ganti jaringan (mis. hotspot HP).`;
      }
    }
  });
  btnDel.addEventListener('click', async () => {
    await window.socl.ctxModel.remove();
    toast('Pembaca konteks lokal dihapus');
    paint();
  });
  paint();
}

// [KEY-HYGIENE-UI] Must agree with autoProvider()/keyLooksReal() in
// pipeline-inverse-v1.js: this label tells the user which provider a run will
// use, so if the two drift the panel confidently names the wrong one. The logic
// cannot be imported (that module is main-process only, and the renderer has no
// require), so it is mirrored here and pinned by a parity test —
// test/ai-key-hygiene-asr-tiers.test.js evaluates THIS function against the
// pipeline's over a matrix of key combinations.
//
// Kept self-contained (no closure over anything) precisely so that test can
// lift it out of the file and run it.
function autoProviderUi(c) {
  const PREFIX = { geminiKey: /^AIza/, groqKey: /^gsk_/, openrouterKey: /^sk-or-/, anthropicKey: /^sk-ant-/, openaiKey: /^sk-/ };
  const PLACEHOLDER = /^(your|isi|masukkan|paste|todo|xxx|\.\.\.|--)/i;
  const looksReal = (field, v) => {
    const k = String(v == null ? '' : v).trim();
    if (k.length < 16 || /\s/.test(k) || PLACEHOLDER.test(k)) return false;
    return PREFIX[field] ? PREFIX[field].test(k) : true;
  };
  // The pipeline resolves a bare `apiKey` to its 'custom' provider. There is no
  // 'custom' chip in this panel, and 'free' is the entry that reads the same
  // apiKey field, so that is the honest label here.
  const ORDER = [['geminiKey','gemini'], ['anthropicKey','anthropic'], ['openaiKey','openai'],
                 ['openrouterKey','openrouter'], ['sumopodKey','sumopod'], ['groqKey','groq'], ['apiKey','free']];
  const present = ORDER.filter(([f]) => String((c || {})[f] || '').trim());
  if (!present.length) return 'free';
  return (present.find(([f]) => looksReal(f, (c || {})[f])) || present[0])[1];
}

function renderApiPanel() {
  els.panelEyebrow.textContent = 'API / AI';
  els.panelTitle.textContent = 'Highlight engine';
  const c = state.cfg;
  const prov = c.aiProvider || autoProviderUi(c);
  // Which cfg key holds the secret for the current provider
  // [PAID-TIER] 'openai' used to point at the generic `apiKey` field, which
  // effectiveAI() only reads for the 'custom' provider — the key was saved
  // somewhere the OpenAI path never looked.
  const KEY_FIELD = { gemini:'geminiKey', groq:'groqKey', openrouter:'openrouterKey', openai:'openaiKey', anthropic:'anthropicKey', sumopod:'sumopodKey', free:'apiKey' };
  // Which cfg field holds this provider's model name
  const MODEL_FIELD = { gemini:'geminiModel', groq:'groqModel', openrouter:'openrouterModel', openai:'openaiModel', anthropic:'anthropicModel', sumopod:'sumopodModel', free:'freeModel' };
  const curKey = c[KEY_FIELD[prov]] || '';
  const KEY_HINT = {
    gemini:'Gemini API key (aistudio.google.com)',
    groq:'Groq key — GRATIS di console.groq.com',
    openrouter:'OpenRouter key — GRATIS di openrouter.ai/keys',
    sumopod:'sk-… SumoPod key (ai.sumopod.com)',
    anthropic:'sk-ant-… Anthropic key (console.anthropic.com)',
    openai:'sk-… OpenAI key',
    free:'(tidak perlu) — memakai key Groq/OpenRouter gratis yang tersimpan',
  };
  els.panelBody.innerHTML = `
    <div class="field">
      <label>Provider</label>
      <div class="chip-grid" id="f_preset">
        <button data-v="groq"       class="${prov==='groq'?'on':''}">Groq · Llama 3.3 70B</button>
        <button data-v="openrouter" class="${prov==='openrouter'&&/(:free|^openrouter\/free)$/.test(c.openrouterModel||'')?'on':''}">OpenRouter free</button>
        <button data-v="openrouter_paid" class="${prov==='openrouter'&&!/(:free|^openrouter\/free)$/.test(c.openrouterModel||'')?'on':''}">OpenRouter paid</button>
        <button data-v="gemini"     class="${prov==='gemini'?'on':''}">Gemini</button>
        <button data-v="openai"     class="${prov==='openai'?'on':''}">OpenAI</button>
        <button data-v="sumopod"    class="${prov==='sumopod'?'on':''}">SumoPod</button>
        <button data-v="free"       class="${prov==='free'?'on':''}">Gratis saja</button>
      </div>
    </div>
    <div class="field">
      <label>API key <span style="float:right;color:var(--muted);font-weight:500">${prov}</span></label>
      <input id="f_key" type="password" value="${curKey}" placeholder="${KEY_HINT[prov]||''}">
    </div>
    <div class="field">
      <label>Model</label>
      <input id="f_model" type="text" value="${c[MODEL_FIELD[prov]] || c.model || ''}" placeholder="openai/gpt-oss-120b">
    </div>
    <div class="field">
      <label style="color:var(--lime)">⌁ Tip</label>
      <div style="color:var(--muted);font-size:12px;line-height:1.5">
        Untuk hook viral paling stabil: <b>Groq</b> (key gratis, cepat) — Llama 3.3 70B.
        Tanpa key sama sekali, highlight &amp; judul memakai deteksi lokal (tanpa AI).
      </div>
    </div>
  `;
  // Save the secret into the field matching the current provider
  $('#f_key').addEventListener('change', e => {
    const p = state.cfg.aiProvider || prov;
    saveCfg({ [KEY_FIELD[p] || 'apiKey']: e.target.value.trim() });
  });
  $('#f_model').addEventListener('change', e => {
    const v = e.target.value.trim();
    const p = state.cfg.aiProvider || prov;
    // Write the provider-scoped field too, otherwise switching providers
    // carries the previous one's model name over via the shared `model`.
    const patch = { model: v };
    if (MODEL_FIELD[p]) patch[MODEL_FIELD[p]] = v;
    saveCfg(patch);
  });
  document.querySelectorAll('#f_preset button').forEach(b => {
    b.addEventListener('click', async () => {
      const presets = {
        groq:       { aiProvider:'groq',       model: 'openai/gpt-oss-120b', groqModel: 'openai/gpt-oss-120b' },
        openrouter: { aiProvider:'openrouter', model: 'openrouter/free', openrouterModel: 'openrouter/free' },
        // [PAID-TIER] Sonnet-class default for the paid preset — the point of
        // paying is output quality, and the model box stays editable.
        openrouter_paid: { aiProvider:'openrouter', model: 'anthropic/claude-sonnet-4.5', openrouterModel: 'anthropic/claude-sonnet-4.5' },
        // gemini-2.5-flash is a hard 404 now — use Google's always-current alias.
        gemini:     { aiProvider:'gemini',     model: 'gemini-flash-latest', geminiModel: 'gemini-flash-latest' },
        openai:     { aiProvider:'openai',     model: 'gpt-4o-mini', openaiModel: 'gpt-4o-mini' },
        anthropic:  { aiProvider:'anthropic',  model: 'claude-haiku-4-5', anthropicModel: 'claude-haiku-4-5' },
        sumopod:    { aiProvider:'sumopod',    model: 'deepseek-v4-pro', sumopodModel: 'deepseek-v4-pro' },
        free:       { aiProvider:'free' },
      };
      await saveCfg(presets[b.dataset.v]);
      renderApiPanel();
      toast(`Provider → ${b.dataset.v}`);
    });
  });
}

// [CROP-PANEL] Small illustrations of what each crop mode does: a 16:9
// source, the crop box(es) on it, and the 9:16 result. Static markup, styled
// by .crop-art in styles.css; the lime window in the first one pans between
// its two keyframes (.crop-pan).
const CROP_ART_PAN = `<svg viewBox="0 0 220 112" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="12" width="136" height="76.5" rx="6" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.14)"/>
  <circle cx="80" cy="42" r="9" fill="rgba(255,255,255,.18)"/>
  <path d="M62 88.5c2-14 9-21 18-21s16 7 18 21z" fill="rgba(255,255,255,.12)"/>
  <rect x="24" y="12" width="43" height="76.5" rx="4" fill="none" stroke="rgba(213,255,64,.3)" stroke-dasharray="3 3"/>
  <rect x="93" y="12" width="43" height="76.5" rx="4" fill="none" stroke="rgba(213,255,64,.3)" stroke-dasharray="3 3"/>
  <g class="crop-pan"><rect x="58.5" y="12" width="43" height="76.5" rx="4" fill="rgba(213,255,64,.1)" stroke="var(--lime)" stroke-width="1.6"/></g>
  <line x1="12" y1="100" x2="148" y2="100" stroke="rgba(255,255,255,.14)"/>
  <path d="M45.5 96.5l3.5 3.5-3.5 3.5-3.5-3.5zM114.5 96.5l3.5 3.5-3.5 3.5-3.5-3.5z" fill="var(--lime)"/>
  <path d="M156 50h12m-4-4 4 4-4 4" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="176" y="14" width="40" height="71" rx="5" fill="rgba(255,255,255,.04)" stroke="var(--lime)" stroke-width="1.2"/>
  <circle cx="196" cy="42" r="8" fill="rgba(255,255,255,.18)"/>
  <path d="M181 85c2-12 8-18 15-18s13 6 15 18z" fill="rgba(255,255,255,.12)"/>
</svg>`;
const CROP_ART_SPLIT = `<svg viewBox="0 0 220 112" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="12" width="136" height="76.5" rx="6" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.14)"/>
  <rect x="20" y="20" width="84" height="61" rx="3" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.55)" stroke-width="1.3"/>
  <path d="M28 76l15-17 10 10 9-9 18 16z" fill="rgba(255,255,255,.14)"/>
  <rect x="112" y="20" width="28" height="24" rx="3" fill="rgba(213,255,64,.1)" stroke="var(--lime)" stroke-width="1.4"/>
  <circle cx="126" cy="29.5" r="4.5" fill="rgba(213,255,64,.4)"/>
  <path d="M118.5 44c1.5-5 4.5-7.5 7.5-7.5s6 2.5 7.5 7.5z" fill="rgba(213,255,64,.28)"/>
  <path d="M156 50h12m-4-4 4 4-4 4" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="177.5" y="15.5" width="37" height="26" rx="3.5" fill="rgba(213,255,64,.1)" stroke="var(--lime)" stroke-width="1.2"/>
  <circle cx="196" cy="25" r="4.5" fill="rgba(213,255,64,.4)"/>
  <path d="M188 41.5c1.5-5 4.5-7.5 8-7.5s6.5 2.5 8 7.5z" fill="rgba(213,255,64,.28)"/>
  <rect x="177.5" y="44" width="37" height="39.5" rx="3.5" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/>
  <path d="M180 80l11-12 7 7 6-6 9 11z" fill="rgba(255,255,255,.14)"/>
</svg>`;

function renderCropPanel() {
  els.panelEyebrow.textContent = 'Crop / Frame';
  els.panelTitle.textContent = 'Crop Studio';
  // Without a clip the two modes still show, disabled, so the panel explains
  // itself instead of standing empty.
  const clip = state.clips[state.activeClip];
  const off = clip ? '' : ' disabled';
  els.panelBody.innerHTML = `
    <p class="panel-desc">Atur bingkai klip ini sebelum render — pilih satu mode.</p>
    <button type="button" id="openCropStudioBtn" class="crop-mode"${off}>
      <span class="crop-art" aria-hidden="true">${CROP_ART_PAN}</span>
      <span class="crop-mode-txt"><b>Crop Studio</b><small>Satu jendela 9:16 dengan keyframe — bingkai bergeser mengikuti subjek sepanjang klip.</small></span>
      <span class="crop-go" aria-hidden="true">→</span>
    </button>
    <button type="button" id="openGamingSplitStudioBtn" class="crop-mode"${off}>
      <span class="crop-art" aria-hidden="true">${CROP_ART_SPLIT}</span>
      <span class="crop-mode-txt"><b>Split Screen</b><small>Facecam + gameplay — dua kotak crop, ditumpuk atas/bawah dalam 9:16.</small></span>
      <span class="crop-go" aria-hidden="true">→</span>
    </button>
    ${clip ? '' : '<p class="crop-note">Pilih klip di galeri dulu, lalu buka salah satu mode di atas.</p>'}`;
  document.getElementById('openCropStudioBtn').addEventListener('click', () => openCropStudio(state.activeClip));
  document.getElementById('openGamingSplitStudioBtn').addEventListener('click', () => openGamingSplitStudio(state.activeClip));
}

// ─── [WM-V1] Watermark panel ─────────────────────────────
// Project-level watermark editor. All state changes flow through this one
// function's event handlers → saveWatermark() → state.cfg.watermark (via
// saveCfg). updateWatermarkOverlay() is invoked after every change so the
// preview stage <img> mirrors the current settings live.
async function saveWatermark(patch) {
  const cur = state.cfg?.watermark || { ...wmMod.DEFAULT_WATERMARK };
  const next = wmMod.sanitize({ ...cur, ...patch });
  await saveCfg({ watermark: next });
  updateWatermarkOverlay();
}

// Convert a File (from <input type=file> or drop) into { path } stored under
// userData/watermarks/. Delegates the actual disk write to main.
async function uploadWatermarkFile(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await window.socl.watermark.saveAsset({ filename: file.name, bytes });
  if (r?.error) { toast(r.error, 'err'); return null; }
  // Read intrinsic dims so preview aspect is right and we can show "W×H".
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res; img.onerror = () => rej(new Error('decode-fail'));
    img.src = toFileURL(r.path);
  }).catch(() => {});
  return {
    path: r.path,
    filename: r.filename,
    ext: r.ext,
    bytes: r.bytes,
    width: img.naturalWidth || 0,
    height: img.naturalHeight || 0,
  };
}

function renderWatermarkPanel() {
  els.panelEyebrow.textContent = 'Overlay';
  els.panelTitle.textContent = 'Watermark';
  const wm = wmMod.sanitize(state.cfg?.watermark);
  const hasImg = !!wm.image?.path;
  // [WM-TEXT-OFF] A text-only watermark is just as "configured" as an image one.
  // Test for text CONTENT, not wmMod.isTextActive() — that also requires
  // `enabled`, which would disable the switch the moment you switched it off
  // and leave no way to switch it back on.
  const hasWm = hasImg || !!wm.text?.content;
  els.panelBody.innerHTML = `
    <div style="color:var(--muted);font-size:12px;line-height:1.5;margin-bottom:12px">
      Logo overlay dibakar ke output pas <b>Render all</b> atau <b>Apply</b> di editor. Per klip bisa di-override lewat badge <b>WM</b> di gallery card.
    </div>

    <label class="ap-toggle-card" for="wm_enabled" style="margin-bottom:12px">
      <div class="ap-ico">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7l7-4z"/></svg>
      </div>
      <div class="ap-copy">
        <div class="ap-title">Aktifkan watermark</div>
        <div class="ap-sub">Off = perilaku render tidak berubah</div>
      </div>
      ${/* [WM-TEXT-OFF] Gate on ANY configured watermark, not just an image.
            A text-only watermark burns into every render (pipeline drawtext),
            but the switch stayed `disabled`, so the only way to stop it was to
            delete the text. */''}
      <input type="checkbox" id="wm_enabled" ${wm.enabled ? 'checked' : ''} ${hasWm ? '' : 'disabled'}>
    </label>

    <div class="ap-block-head" style="margin-top:14px">IMAGE</div>
    ${hasImg ? `
      <div class="wm-preview-tile" id="wmTile">
        <img src="${toFileURL(wm.image.path)}?t=${Date.now()}" alt="">
        <div class="wm-info">
          <div class="wm-name">${(wm.image.filename || 'watermark').replace(/[<>]/g,'')}</div>
          <div class="wm-sub">${wm.image.width && wm.image.height ? wm.image.width + '×' + wm.image.height + ' · ' : ''}${wm.image.bytes ? (wm.image.bytes/1024).toFixed(1) + ' KB' : ''}</div>
        </div>
        <button id="wm_remove" title="Hapus">✕</button>
      </div>
      <button id="wm_replace" class="secondary-btn" style="width:100%;margin-top:6px;font-size:11px;padding:6px">Ganti gambar…</button>
    ` : `
      <div class="wm-dropzone" id="wmDrop">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14"/><path d="M6 9l6-6 6 6"/><path d="M5 21h14"/></svg>
        <div style="font-size:13px;margin-top:4px">Drop / klik pilih PNG, WebP, atau JPEG</div>
        <div style="font-size:11px;opacity:.7;margin-top:2px">PNG dengan transparansi paling bagus · Max 5MB</div>
      </div>
    `}
    <input type="file" id="wm_file" accept=".png,.webp,.jpg,.jpeg,image/png,image/webp,image/jpeg" hidden>

    <div class="ap-block-head" style="margin-top:14px">TEXT / TIPOGRAFI</div>
    ${/* [WM-LINES] One row per stacked line, built in wireWatermarkPanel from
          wmMod.textLines so values never pass through an HTML string. */''}
    <div class="wm-lines" id="wmLines"></div>
    <button type="button" class="wm-line-add" id="wm_line_add">+ Tambah baris</button>
    <div class="wm-text-row">
      <select id="wm_text_font">
        ${wmMod.TEXT_FONTS.map(f =>
          `<option value="${f.file}" ${wm.text?.font === f.file ? 'selected' : ''} style="font-family:'${f.label}'">${f.label}</option>`
        ).join('')}
      </select>
      <input type="color" id="wm_text_color" value="${wm.text?.color || '#ffffff'}">
    </div>
    <div class="wm-slider-row">
      <label for="wm_text_size">Ukuran</label>
      <input type="range" id="wm_text_size" min="1" max="20" step="0.5" value="${wm.text?.sizePct ?? 5}">
      <span class="wm-val" id="wm_text_size_val">${(wm.text?.sizePct ?? 5).toFixed(1)}%</span>
    </div>
    <div class="wm-slider-row">
      <label for="wm_text_op">Opacity</label>
      <input type="range" id="wm_text_op" min="0" max="100" step="1" value="${Math.round((wm.text?.opacity ?? 0.75)*100)}">
      <span class="wm-val" id="wm_text_op_val">${Math.round((wm.text?.opacity ?? 0.75)*100)}%</span>
    </div>
    <div style="font-size:10.5px;color:var(--ink-dim);margin-top:6px;line-height:1.4">
      Text & image bisa aktif bareng — keduanya berbagi anchor & padding di bawah. Kalau kamu mau posisi beda, pakai salah satu saja.
    </div>

    <div class="ap-block-head" style="margin-top:14px">POSISI</div>
    <div class="wm-anchor-grid" id="wmAnchorGrid">
      ${wmMod.ANCHORS.map(a => `
        <button class="wm-anchor-cell${a === wm.anchor ? ' wm-active' : ''}" data-anchor="${a}" aria-label="${a}">
          <span class="wm-dot"></span>
        </button>
      `).join('')}
    </div>

    <div class="ap-block-head" style="margin-top:14px">GEOMETRY</div>
    <div class="wm-slider-row">
      <label for="wm_x">Padding X</label>
      <input type="range" id="wm_x" min="0" max="40" step="0.5" value="${wm.xPct}">
      <span class="wm-val" id="wm_x_val">${wm.xPct.toFixed(1)}%</span>
    </div>
    <div class="wm-slider-row">
      <label for="wm_y">Padding Y</label>
      <input type="range" id="wm_y" min="0" max="40" step="0.5" value="${wm.yPct}">
      <span class="wm-val" id="wm_y_val">${wm.yPct.toFixed(1)}%</span>
    </div>
    <div class="wm-slider-row">
      <label for="wm_size">Ukuran</label>
      <input type="range" id="wm_size" min="3" max="40" step="0.5" value="${wm.sizePct}">
      <span class="wm-val" id="wm_size_val">${wm.sizePct.toFixed(1)}%</span>
    </div>
    <div class="wm-slider-row">
      <label for="wm_op">Opacity</label>
      <input type="range" id="wm_op" min="0" max="100" step="1" value="${Math.round(wm.opacity*100)}">
      <span class="wm-val" id="wm_op_val">${Math.round(wm.opacity*100)}%</span>
    </div>
  `;
  wireWatermarkPanel();
}

function wireWatermarkPanel() {
  const $id = s => document.getElementById(s);
  const fileInput = $id('wm_file');
  const drop      = $id('wmDrop');
  const tile      = $id('wmTile');
  const replaceBtn = $id('wm_replace');
  const removeBtn  = $id('wm_remove');
  const enabled    = $id('wm_enabled');
  const grid       = $id('wmAnchorGrid');

  const openPicker = () => fileInput?.click();
  drop?.addEventListener('click', openPicker);
  replaceBtn?.addEventListener('click', openPicker);
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files?.[0]; if (!f) return;
    const image = await uploadWatermarkFile(f);
    if (image) await saveWatermark({ image, enabled: true });
    renderWatermarkPanel();
  });
  ['dragover','dragenter'].forEach(ev => drop?.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('wm-drag'); }));
  ['dragleave','drop'].forEach(ev => drop?.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('wm-drag'); }));
  drop?.addEventListener('drop', async e => {
    const f = e.dataTransfer?.files?.[0]; if (!f) return;
    const image = await uploadWatermarkFile(f);
    if (image) await saveWatermark({ image, enabled: true });
    renderWatermarkPanel();
  });

  removeBtn?.addEventListener('click', async () => {
    const cur = state.cfg?.watermark;
    if (cur?.image?.path) {
      try { await window.socl.watermark.deleteAsset(cur.image.path); } catch {}
    }
    await saveWatermark({ image: null, enabled: false });
    renderWatermarkPanel();
  });

  enabled?.addEventListener('change', () => saveWatermark({ enabled: enabled.checked }));

  grid?.querySelectorAll('.wm-anchor-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      grid.querySelectorAll('.wm-anchor-cell').forEach(c => c.classList.remove('wm-active'));
      cell.classList.add('wm-active');
      saveWatermark({ anchor: cell.dataset.anchor });
    });
  });

  const bindSlider = (id, key, mult = 1, suffix = '%') => {
    const el = $id(id); const lbl = $id(id + '_val'); if (!el) return;
    el.addEventListener('input', () => {
      lbl.textContent = (parseFloat(el.value) * (mult === 1 ? 1 : 1)).toFixed(mult === 0.01 ? 0 : 1) + suffix;
      // Live-update overlay position/size WITHOUT persisting on every tick.
      const wm = wmMod.sanitize({ ...(state.cfg?.watermark || {}), [key]: parseFloat(el.value) * mult });
      state.cfg = { ...state.cfg, watermark: wm };
      updateWatermarkOverlay();
    });
    el.addEventListener('change', () => {
      saveWatermark({ [key]: parseFloat(el.value) * mult });
    });
  };
  bindSlider('wm_x',    'xPct');
  bindSlider('wm_y',    'yPct');
  bindSlider('wm_size', 'sizePct');
  bindSlider('wm_op',   'opacity', 0.01);

  // Text watermark controls. Text field commits on 'input' with a debounce so
  // typing feels live but doesn't spam saveCfg → main → JSON write.
  const wmLinesEl = $id('wmLines');
  const wmAddBtn  = $id('wm_line_add');
  const wmFontEl  = $id('wm_text_font');
  const wmColorEl = $id('wm_text_color');
  // [WM-LINES] Rows: text, size (% of Ukuran), move up/down, remove. An empty
  // row is kept on screen while you type into it; sanitizeText drops it (and
  // its size) from what gets saved and burned.
  const lineRow = (text = '', scale = 100) => {
    const row = document.createElement('div');
    row.className = 'wm-line';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'wm-text-input wm-line-text';
    input.maxLength = 200; input.value = text;
    input.placeholder = 'mis. socialvisuals · @nizar · Ⓒ 2026';
    const size = document.createElement('input');
    size.type = 'number'; size.className = 'wm-line-scale';
    size.min = String(wmMod.LINE_SCALE_MIN); size.max = String(wmMod.LINE_SCALE_MAX); size.step = '10';
    size.value = String(scale); size.title = 'Ukuran baris ini, % dari Ukuran';
    const pct = document.createElement('span'); pct.className = 'wm-line-pct'; pct.textContent = '%';
    const btn = (act, label, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'wm-line-btn'; b.dataset.act = act;
      b.textContent = label; b.title = title; return b;
    };
    row.append(input, size, pct,
      btn('up', '↑', 'Naikkan'), btn('down', '↓', 'Turunkan'), btn('del', '✕', 'Hapus baris'));
    return row;
  };
  const syncLineButtons = () => {
    const rows = [...(wmLinesEl?.children || [])];
    rows.forEach((r, i) => {
      r.querySelector('[data-act="up"]').disabled = i === 0;
      r.querySelector('[data-act="down"]').disabled = i === rows.length - 1;
    });
    if (wmAddBtn) wmAddBtn.disabled = rows.length >= wmMod.MAX_TEXT_LINES;
  };
  const savedLines = wmMod.textLines(wmMod.sanitize(state.cfg?.watermark).text);
  (savedLines.length ? savedLines : [{ text: '', scale: 100 }])
    .forEach(l => wmLinesEl?.append(lineRow(l.text, l.scale)));
  syncLineButtons();
  const readText = () => ({
    lines: [...(wmLinesEl?.children || [])].map(r => ({
      text:  r.querySelector('.wm-line-text')?.value || '',
      scale: parseFloat(r.querySelector('.wm-line-scale')?.value) || 100,
    })),
    font:    wmFontEl?.value || wmMod.DEFAULT_TEXT.font,
    color:   wmColorEl?.value || wmMod.DEFAULT_TEXT.color,
    sizePct: parseFloat($id('wm_text_size')?.value || 5),
    opacity: parseFloat($id('wm_text_op')?.value || 75) / 100,
  });
  let wmTextDebounce = null;
  // [WM-TEXT-OFF] Typing text turns the watermark on. Sync the switch in place
  // rather than re-rendering the panel (a re-render mid-keystroke would steal
  // focus): without this the switch kept reading OFF + disabled while the text
  // watermark was already burning into every render.
  const syncEnableSwitch = () => {
    const sw = $id('wm_enabled');
    if (!sw) return;
    const configured = !!state.cfg?.watermark?.text?.content
                    || !!state.cfg?.watermark?.image?.path;
    sw.disabled = !configured;
    // Reflect the stored flag; do NOT force it on. Forcing `checked = true`
    // here made "off" un-sticky: switching the watermark off and then touching
    // the text/font/colour/size turned it straight back on, which left the
    // user with the same dead end this fix was meant to remove.
    sw.checked = configured && state.cfg?.watermark?.enabled !== false;
  };
  // Typing text for the FIRST time turns the watermark on (otherwise the
  // feature looks broken). After that the switch is the user's call and edits
  // must not silently re-enable it.
  // `wm` belongs to renderWatermarkPanel's scope, not this function — read the
  // same state fresh here rather than assuming it leaked in.
  let wmTextSeen = !!state.cfg?.watermark?.text?.content;
  const commitText = () => {
    if (wmTextDebounce) clearTimeout(wmTextDebounce);
    wmTextDebounce = setTimeout(() => {
      const enabled = wmTextSeen ? (state.cfg?.watermark?.enabled !== false) : true;
      wmTextSeen = true;
      saveWatermark({ text: readText(), enabled });
      syncEnableSwitch();
      try { renderGallery(); } catch {}   // per-clip WM badge appears/disappears
    }, 250);
  };
  const liveText = () => {
    const wm = wmMod.sanitize({ ...(state.cfg?.watermark || {}), text: readText() });
    state.cfg = { ...state.cfg, watermark: wm };
    updateWatermarkOverlay();
  };
  wmLinesEl?.addEventListener('input', e => {
    if (e.target.matches('.wm-line-text, .wm-line-scale')) { liveText(); commitText(); }
  });
  wmLinesEl?.addEventListener('click', e => {
    const b = e.target.closest('.wm-line-btn'); if (!b || b.disabled) return;
    const row = b.closest('.wm-line');
    if (b.dataset.act === 'up' && row.previousElementSibling) row.after(row.previousElementSibling);
    else if (b.dataset.act === 'down' && row.nextElementSibling) row.before(row.nextElementSibling);
    else if (b.dataset.act === 'del') {
      // The last row is cleared rather than removed, so there is always a
      // field to type into.
      if (wmLinesEl.children.length > 1) row.remove();
      else { row.querySelector('.wm-line-text').value = ''; row.querySelector('.wm-line-scale').value = '100'; }
    }
    syncLineButtons(); liveText(); commitText();
  });
  wmAddBtn?.addEventListener('click', () => {
    if (wmLinesEl.children.length >= wmMod.MAX_TEXT_LINES) return;
    // A second line usually reads as a smaller caption under the first.
    const row = lineRow('', wmLinesEl.children.length ? 60 : 100);
    wmLinesEl.append(row);
    syncLineButtons();
    row.querySelector('.wm-line-text').focus();
  });
  wmFontEl?.addEventListener('change', () => { liveText(); commitText(); });
  wmColorEl?.addEventListener('input', () => { liveText(); commitText(); });
  const bindTextSlider = (id, mult, suffix) => {
    const el = $id(id); const lbl = $id(id + '_val'); if (!el) return;
    el.addEventListener('input',  () => {
      lbl.textContent = (parseFloat(el.value)).toFixed(mult === 0.01 ? 0 : 1) + suffix;
      liveText();
    });
    el.addEventListener('change', commitText);
  };
  bindTextSlider('wm_text_size', 1,    '%');
  bindTextSlider('wm_text_op',   0.01, '%');
}

// [WM-V1] Live preview overlay updater. Reads current merged watermark for
// the active clip and paints the <img id="wmOverlay"> on top of the preview
// stage to match. Called from renderPanel handlers, clip switching, and any
// state.cfg.watermark mutation.
function updateWatermarkOverlay(opts = {}) {
  const imgEl = document.getElementById('wmOverlay');
  const txtEl = document.getElementById('wmTextOverlay');
  if (!imgEl && !txtEl) return;
  const clip = state.activeClip >= 0 ? state.clips[state.activeClip] : null;
  const wm = currentWatermark(clip);
  // [WM-DOUBLE] The pipeline (and Editor Apply / batch render) already burn
  // this exact watermark into clip.file whenever it's active at render time —
  // painting it live on top a second time double-composites it (visibly
  // extra-dark/oversaturated whenever opacity < 100%, same class of bug as
  // the persistent-title double-render). Only skip the passive dashboard
  // redraw (opts.dashboard) when nothing has changed since that burn; a
  // settings-panel edit (or the per-clip WM badge toggle) must still paint
  // live, since clip.file does not reflect the unsaved change yet.
  if (opts.dashboard && clip && clip.watermarkBurnedSnapshot === JSON.stringify(wm)) {
    if (imgEl) { imgEl.hidden = true; imgEl.removeAttribute('src'); }
    if (txtEl) { txtEl.hidden = true; txtEl.textContent = ''; }
    return;
  }
  const css = wmMod.previewCSS(wm);

  // Image overlay
  if (imgEl) {
    if (!wmMod.isImageActive(wm)) {
      imgEl.hidden = true; imgEl.removeAttribute('src');
    } else {
      imgEl.src = toFileURL(wm.image.path);
      imgEl.hidden = false;
      imgEl.style.top       = css.top;
      imgEl.style.right     = css.right;
      imgEl.style.bottom    = css.bottom;
      imgEl.style.left      = css.left;
      imgEl.style.transform = css.transform;
      imgEl.style.width     = wm.sizePct + '%';
      imgEl.style.height    = 'auto';
      imgEl.style.opacity   = String(wm.opacity);
    }
  }

  // Text overlay
  if (txtEl) {
    if (!wmMod.isTextActive(wm)) {
      txtEl.hidden = true; txtEl.textContent = '';
    } else {
      // [WM-LINES] One block per stacked line, each at its own share of the
      // size. The burn aligns the lines to each other through \an (left /
      // centre / right from the anchor's column); text-align mirrors that.
      const font = wmMod.TEXT_FONTS.find(f => f.file === wm.text.font);
      txtEl.replaceChildren(...wmMod.textLines(wm.text).map(l => {
        const d = document.createElement('div');
        d.className = 'wm-text-line';
        d.textContent = l.text;
        d.style.fontSize = (wm.text.sizePct * l.scale / 100) + 'cqw';
        return d;
      }));
      txtEl.style.textAlign = { l: 'left', c: 'center', r: 'right' }[wm.anchor[1]] || 'left';
      // libass stacks lines winAscent+winDescent apart; see lineEm in watermark.js.
      txtEl.style.lineHeight = String(font?.lineEm || 1);
      txtEl.hidden = false;
      txtEl.style.top       = css.top;
      txtEl.style.right     = css.right;
      txtEl.style.bottom    = css.bottom;
      txtEl.style.left      = css.left;
      txtEl.style.transform = css.transform;
      // Size: sizePct is % of output width; using cqw (container query width)
      // perfectly mirrors this without JS resize listeners. Each line sets its
      // own cqw size above.
      const stage = txtEl.parentElement;
      if (stage && !stage.style.containerType) {
        stage.style.containerType = 'inline-size';
      }
      // [WM-FONT-FACE] The @font-face family of the burned file, not the label.
      txtEl.style.fontFamily = font ? `"${font.css}", sans-serif` : 'sans-serif';
      txtEl.style.color     = wm.text.color;
      txtEl.style.opacity   = String(wm.text.opacity);
    }
  }
}

// Map a crop-box aspect to the render output format. '9:16' keeps the user's
// current portrait choice (face/blur); 1:1 → square, 16:9 → landscape. 'free'
// is handled by the freeform branch in vfFor, so the format is irrelevant there.
function formatForAspect(aspect, fallback) {
  if (aspect === '1:1')  return 'square';
  if (aspect === '16:9') return 'landscape';
  return fallback;
}

// ─── Crop Studio: dedicated keyframe framing editor ──────
function openCropStudio(idx) {
  const clip = state.clips[idx];
  if (!clip) { toast('Select a clip first', 'err'); return; }
  // [CROP-SRC] REVERTED (see history) — always prefer clip.srcVideo (the
  // original master) when present, falling back to clip.file only when no
  // master is known or it fails to load (onSrcErr below). A prior version of
  // this function defaulted to clip.file whenever no cropX/Y was saved yet,
  // reasoning that an unsaved crop state meant srcVideo couldn't be trusted.
  // That reasoning was wrong: srcVideo legitimately gets reused across
  // sessions (the app avoids re-downloading/re-importing the same source —
  // confirmed on a real case where srcVideo pointed at an EARLIER session's
  // file but was byte-identical content, same duration, same video). Almost
  // every clip reaches Crop Studio with clip.file ALREADY auto-cropped to
  // the target aspect (smart-track or a default center-crop from the very
  // first pipeline render) — so defaulting to clip.file left ZERO pan/zoom
  // slack within the same aspect (source == target aspect already), making
  // "Apply crop" a silent no-op re-encode. The box legitimately starts at a
  // blind 50/50 center when cropX/Y was never saved — that's just this
  // tool's normal starting point for a fresh crop, not a bug; the user drags
  // it to where they want, same as any crop tool.
  const srcUrl = clip.srcVideo || clip.file;
  if (!srcUrl) { toast('No source video for this clip', 'err'); return; }

  const $id = s => document.getElementById(s);
  const studio = $id('cropStudio');
  const vid = $id('csVideo'), outVid = $id('csOutVideo');
  const wrap = $id('csSourceWrap'), source = $id('csSource'), cropBox = $id('csCropBox');
  const timeline = $id('csTimeline'), progress = $id('csProgress'), playhead = $id('csPlayhead');
  const playBtn = $id('csPlay'), timeLbl = $id('csTime');
  const kfList = $id('csKfList'), kfCount = $id('csKfCount'), statusEl = $id('csStatus');
  $id('csTitle').textContent = (clip.title || 'Clip').slice(0, 40);

  let clipStart = clip.start || 0;
  let clipEnd   = clip.end || (clipStart + (clip.dur || 5));
  const clipDur = Math.max(0.1, clipEnd - clipStart);

  // keyframes: { t (clip-relative s), x, y } with x,y fraction 0..1
  let kf  = Array.isArray(clip.cropKF) ? clip.cropKF.map(k => ({ ...k })) : [];
  let cur = { x: (clip.cropX ?? 50) / 100, y: (clip.cropY ?? 50) / 100 };
  let boxWFrac = 0.5625, boxHFrac = 1;
  let boxScale = (clip.cropScale != null ? Math.max(0.3, Math.min(1, clip.cropScale)) : 1);
  // Aspect mode: preset ratios lock the box shape; 'free' lets the user resize
  // the box to any rectangle, and the render output follows that rectangle.
  // `rect` = {x,y,w,h} as fractions of the source frame (free mode only).
  let aspect = clip.cropAspect || '9:16';
  let rect = clip.cropRect ? { ...clip.cropRect } : null;
  const ASPECTS = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  let rafId = 0;

  releaseDashboardPreview();
  studio.hidden = false;
  // [HISTORY-REUSE] usingSrc/fellBackToClipFile track which file the studio is
  // ACTUALLY showing/cropping — clip.file uses clip-local timing (0..clipDur),
  // clip.srcVideo uses master-timeline (clipStart..clipEnd). srcUrl above may
  // already be clip.file (no known crop state — see [CROP-SRC]); re-anchor the
  // timeline up front whenever that's the case, not only on a load error, so
  // both paths stay consistent.
  let usingSrc = srcUrl;
  let fellBackToClipFile = false;
  if (srcUrl === clip.file && clip.file !== clip.srcVideo) {
    fellBackToClipFile = true;
    clipStart = 0;
    clipEnd = clipDur;
  }
  const trySrc = (u) => MediaLifecycle.setMediaSource(vid, toFileURL(u));
  const onSrcErr = () => {
    if (usingSrc === clip.srcVideo && clip.file && clip.file !== usingSrc) {
      usingSrc = clip.file;
      fellBackToClipFile = true;
      // Clip file is already trimmed to clipDur; re-anchor the studio's timeline
      // to 0 so scrub / play / keyframe times are consistent with the loaded file.
      clipStart = 0;
      clipEnd = clipDur;
      toast('Master source tidak ditemukan — pakai file klip (crop akan re-crop hasil)', 'err');
      trySrc(clip.file);
    } else {
      toast('Video tidak bisa dimuat: file mungkin sudah dihapus/dipindah.', 'err');
    }
  };
  vid.addEventListener('error', onSrcErr, sig);
  outVid.addEventListener('error', () => {}, sig);
  vid.muted = true;
  trySrc(srcUrl);

  const timeRel = () => Math.max(0, Math.min(clipDur, (vid.currentTime || 0) - clipStart));
  const fmt = s => `${s.toFixed(1)}s`;

  function targetRatio() { return ASPECTS[aspect] || 9 / 16; }
  function computeBoxFrac() {
    const a = (vid.videoWidth || 16) / (vid.videoHeight || 9);
    if (aspect === 'free') {
      if (!rect) rect = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
      boxScale = 1;
      boxWFrac = rect.w; boxHFrac = rect.h;
      const sx = 1 - rect.w, sy = 1 - rect.h;
      cur.x = sx > 1e-6 ? rect.x / sx : 0.5;
      cur.y = sy > 1e-6 ? rect.y / sy : 0.5;
      return;
    }
    const target = targetRatio();
    if (a > target) { boxHFrac = 1; boxWFrac = target / a; }
    else { boxWFrac = 1; boxHFrac = a / target; }
  }
  // Reflect the current aspect in the output preview + box label, and toggle the
  // free-mode UI (resize handles visible, zoom/keyframes hidden).
  function syncFreeUI() {
    const free = aspect === 'free';
    studio.classList.toggle('cs-free', free);
    cropBox.classList.toggle('free', free);
    const out = $id('csOutput');
    const lbl = document.querySelector('.cs-out-label');
    const labelEl = cropBox.querySelector('.cs-handle-label');
    if (free && rect) {
      const ar = (rect.w * (vid.videoWidth || 9)) / (rect.h * (vid.videoHeight || 16));
      if (out) out.style.aspectRatio = ar.toFixed(4);
      if (lbl) lbl.textContent = 'Live output · Free';
      if (labelEl) labelEl.textContent = 'FREE';
    } else {
      if (out) out.style.aspectRatio = '';
      if (lbl) lbl.textContent = `Live output · ${aspect}`;
      if (labelEl) labelEl.textContent = aspect;
    }
  }
  function layoutSource() {
    const availW = wrap.clientWidth - 28, availH = wrap.clientHeight - 28;
    const a = (vid.videoWidth || 16) / (vid.videoHeight || 9);
    let w = availW, h = w / a;
    if (h > availH) { h = availH; w = h * a; }
    source.style.width = w + 'px'; source.style.height = h + 'px';
    applyBox();
  }
  function applyBox() {
    const sw = source.clientWidth, sh = source.clientHeight;
    // boxScale < 1 → smaller crop window = zoom in (excludes the frame edges).
    const bw = boxWFrac * sw * boxScale, bh = boxHFrac * sh * boxScale;
    cropBox.style.width = bw + 'px';
    cropBox.style.height = bh + 'px';
    cropBox.style.left = (cur.x * (sw - bw)) + 'px';
    cropBox.style.top  = (cur.y * (sh - bh)) + 'px';
    if (aspect === 'free' && rect) {
      // Exact-window preview: scale the source video so the dragged rect fills
      // the output container 1:1. Object-fit:cover drifts when the rect aspect
      // diverges from the container aspect, so we go transform-based instead.
      // [FREE-KF] With keyframes, the rect pans over time — use the interpolated
      // cur.x/cur.y (updated by the rAF loop) instead of rect.x/rect.y so the
      // preview matches what the ffmpeg render produces.
      const rw = Math.max(0.001, rect.w), rh = Math.max(0.001, rect.h);
      const rx = (kf.length >= 2) ? cur.x * (1 - rect.w) : rect.x;
      const ry = (kf.length >= 2) ? cur.y * (1 - rect.h) : rect.y;
      outVid.style.objectFit = 'fill';
      outVid.style.position = 'absolute';
      outVid.style.width  = `${(100 / rw).toFixed(3)}%`;
      outVid.style.height = `${(100 / rh).toFixed(3)}%`;
      outVid.style.left   = `${(-rx * 100 / rw).toFixed(3)}%`;
      outVid.style.top    = `${(-ry * 100 / rh).toFixed(3)}%`;
      outVid.style.transform = '';
      outVid.style.objectPosition = '';
      outVid.style.transformOrigin = '';
    } else {
      // Preset aspect: revert to object-fit:cover with positional anchoring +
      // zoom transform. Clear any free-mode overrides set above.
      outVid.style.objectFit = '';
      outVid.style.position = '';
      outVid.style.width = '';
      outVid.style.height = '';
      outVid.style.left = '';
      outVid.style.top = '';
      const ox = (cur.x * 100).toFixed(1), oy = (cur.y * 100).toFixed(1);
      outVid.style.objectPosition = `${ox}% ${oy}%`;
      outVid.style.transformOrigin = `${ox}% ${oy}%`;
      outVid.style.transform = boxScale < 1 ? `scale(${(1 / boxScale).toFixed(3)})` : '';
    }
  }
  // STEP / hold: the crop stays locked at the most recent keyframe (no drift),
  // matching the rendered output exactly.
  function interp(t) {
    if (!kf.length) return { x: cur.x, y: cur.y };
    let k = kf[0];
    for (let i = 0; i < kf.length; i++) {
      if (t >= kf[i].t) k = kf[i]; else break;
    }
    return { x: k.x, y: k.y };
  }

  function renderKfs() {
    kfCount.textContent = kf.length;
    timeline.querySelectorAll('.cs-kf-marker').forEach(m => m.remove());
    kf.forEach((k, i) => {
      const m = document.createElement('div');
      m.className = 'cs-kf-marker';
      m.style.left = `${(k.t / clipDur) * 100}%`;
      m.title = `Keyframe @ ${fmt(k.t)}`;
      m.addEventListener('click', () => seekTo(k.t), sig);
      timeline.appendChild(m);
    });
    if (!kf.length) {
      kfList.innerHTML = `<div class="cs-kf-empty">No keyframes — static center crop. Add one to start panning.</div>`;
      return;
    }
    kfList.innerHTML = kf.map((k, i) =>
      `<div class="cs-kf-row" data-i="${i}">
        <span class="kf-t">${fmt(k.t)}</span>
        <span class="kf-xy">x ${Math.round(k.x*100)}% · y ${Math.round(k.y*100)}%</span>
        <button class="kf-go" data-go="${i}">Go</button>
        <button class="kf-del" data-del="${i}">✕</button>
      </div>`).join('');
    kfList.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => seekTo(kf[+b.dataset.go].t), sig));
    kfList.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { kf.splice(+b.dataset.del, 1); renderKfs(); cropCommit(); }, sig));
  }
  function seekTo(tRel) {
    vid.currentTime = clipStart + Math.max(0, Math.min(clipDur, tRel));
    if (!playing()) { cur = interp(tRel); applyBox(); updatePlayhead(); }
  }
  function updatePlayhead() {
    const t = timeRel();
    const pct = (t / clipDur) * 100;
    playhead.style.left = pct + '%';
    progress.style.width = pct + '%';
    timeLbl.textContent = `${fmt(t)} / ${fmt(clipDur)}`;
  }
  const playing = () => !vid.paused && !vid.ended;

  // rAF loop: keep playback within [clipStart, clipEnd], drive crop + output
  function loop() {
    if (studio.hidden) return;
    if (vid.currentTime >= clipEnd - 0.03) { vid.currentTime = clipStart; }
    if (playing()) {
      cur = interp(timeRel());
      applyBox();
    }
    updatePlayhead();
    rafId = requestAnimationFrame(loop);
  }

  vid.addEventListener('loadedmetadata', () => {
    const mirrored = MediaLifecycle.attachCaptureMirror(vid, outVid);
    outVid.hidden = !mirrored;
    if (mirrored) outVid.play().catch(() => {});
    else statusEl.textContent = 'Live output tidak tersedia; source preview tetap bisa diedit.';
    computeBoxFrac();
    vid.currentTime = clipStart;
    layoutSource();
    renderKfs();
    updatePlayhead();
    syncFreeUI();
  }, sig);
  window.addEventListener('resize', layoutSource, sig);

  // Aspect selector: presets lock the box ratio; Free enables resize handles and
  // makes the output follow the dragged rectangle.
  document.querySelectorAll('#csAspect button').forEach(b => {
    if (b.dataset.a === aspect) b.classList.add('active'); else b.classList.remove('active');
    b.addEventListener('click', () => {
      document.querySelectorAll('#csAspect button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      aspect = b.dataset.a;
      if (aspect === 'free' && !rect) rect = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
      computeBoxFrac(); applyBox(); syncFreeUI();
    }, sig);
  });

  // Drag the crop window
  let drag = null;
  cropBox.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cropBox.setPointerCapture?.(e.pointerId);
    drag = { px: e.clientX, py: e.clientY, x: cur.x, y: cur.y };
    if (playing()) togglePlay();   // pause to edit
  }, sig);
  cropBox.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const sw = source.clientWidth, sh = source.clientHeight;
    const slackW = sw - boxWFrac * sw * boxScale, slackH = sh - boxHFrac * sh * boxScale;
    const nx = slackW > 0 ? drag.x + (e.clientX - drag.px) / slackW : 0.5;
    const ny = slackH > 0 ? drag.y + (e.clientY - drag.py) / slackH : 0.5;
    cur.x = Math.max(0, Math.min(1, nx));
    cur.y = Math.max(0, Math.min(1, ny));
    if (aspect === 'free' && rect) { rect.x = cur.x * (1 - rect.w); rect.y = cur.y * (1 - rect.h); }
    applyBox();
  }, sig);
  const endDrag = () => { if (drag) cropCommit(); drag = null; };   // [CROP-UNDO]
  cropBox.addEventListener('pointerup', endDrag, sig);
  cropBox.addEventListener('lostpointercapture', endDrag, sig);

  // Resize handles (free mode only). Each corner adjusts width+height; `rect` is
  // stored as source fractions {x,y,w,h}. Min 8% per axis, clamped to [0,1].
  ['nw', 'ne', 'sw', 'se'].forEach(dir => {
    const h = document.createElement('div');
    h.className = 'cs-handle cs-' + dir;
    cropBox.appendChild(h);
    let active = false;
    h.addEventListener('pointerdown', e => {
      if (aspect !== 'free' || !rect) return;
      e.stopPropagation(); e.preventDefault();
      active = true; h.setPointerCapture?.(e.pointerId);
      if (playing()) togglePlay();
    }, sig);
    h.addEventListener('pointermove', e => {
      if (!active) return;
      const sw = source.clientWidth, sh = source.clientHeight;
      const r = source.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (e.clientX - r.left) / sw));
      const py = Math.max(0, Math.min(1, (e.clientY - r.top) / sh));
      let x1 = rect.x, y1 = rect.y, x2 = rect.x + rect.w, y2 = rect.y + rect.h;
      if (dir.includes('w')) x1 = Math.min(px, x2 - 0.08); else x2 = Math.max(px, x1 + 0.08);
      if (dir.includes('n')) y1 = Math.min(py, y2 - 0.08); else y2 = Math.max(py, y1 + 0.08);
      rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      // [FREE-KF-FIX] Re-derive cur (slack-fraction anchor) from the new rect,
      // so a subsequent Add-Keyframe captures the ACTUAL current position rather
      // than a stale slack fraction from before the resize. Guard div-0 when
      // the rect fills the whole axis (slack = 0 → any cur value is fine).
      cur.x = rect.w < 1 ? rect.x / (1 - rect.w) : 0.5;
      cur.y = rect.h < 1 ? rect.y / (1 - rect.h) : 0.5;
      computeBoxFrac(); applyBox(); syncFreeUI();
    }, sig);
    const end = () => { if (active) cropCommit(); active = false; };   // [CROP-UNDO]
    h.addEventListener('pointerup', end, sig);
    h.addEventListener('lostpointercapture', end, sig);
  });

  // Timeline scrub
  timeline.addEventListener('click', (e) => {
    if (e.target.classList.contains('cs-kf-marker')) return;
    const rect = timeline.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * clipDur);
  }, sig);

  // [CROP-UNDO] Undo/redo for the crop box + keyframes (Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y).
  // Users misplace a box or a keyframe and had to rebuild it by hand.
  const cropHist = window.EditHistory.createHistory({ limit: 100 });
  const cropSnap = () => JSON.stringify({ kf, cur, boxScale, rect });
  let _cropPre = cropSnap();
  const syncCropHistBtns = () => {
    const u = $id('csUndo'), r = $id('csRedo');
    if (u) u.disabled = !cropHist.canUndo(); if (r) r.disabled = !cropHist.canRedo();
  };
  function cropCommit() {
    const now = cropSnap();
    if (now === _cropPre) return;
    cropHist.push(_cropPre); _cropPre = now; syncCropHistBtns();
  }
  function cropRestore(str) {
    let v; try { v = JSON.parse(str); } catch { return; }
    kf = v.kf || []; cur = v.cur || { x: 0.5, y: 0.5 }; boxScale = v.boxScale || 1; rect = v.rect || null;
    const z = $id('csZoom'), zv = $id('csZoomVal');
    if (z) z.value = Math.round(boxScale * 100); if (zv) zv.textContent = `${Math.round(boxScale * 100)}%`;
    try { if (aspect === 'free' && rect) { computeBoxFrac(); syncFreeUI(); } } catch {}
    applyBox(); renderKfs();
    _cropPre = cropSnap(); syncCropHistBtns();
  }
  const cropUndo = () => { cropCommit(); const p = cropHist.undo(cropSnap()); if (p != null) cropRestore(p); syncCropHistBtns(); };
  const cropRedo = () => { cropCommit(); const n = cropHist.redo(cropSnap()); if (n != null) cropRestore(n); syncCropHistBtns(); };
  $id('csUndo')?.addEventListener('click', cropUndo, sig);
  $id('csRedo')?.addEventListener('click', cropRedo, sig);
  document.addEventListener('keydown', (e) => {
    if (studio.hidden || !(e.metaKey || e.ctrlKey)) return;
    const k = (e.key || '').toLowerCase(); if (k !== 'z' && k !== 'y') return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|color)$/i.test(t.type || '')))) return;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) cropRedo(); else cropUndo();
  }, sig);
  syncCropHistBtns();

  function togglePlay() {
    if (vid.paused) {
      if (vid.currentTime < clipStart || vid.currentTime >= clipEnd - 0.03) vid.currentTime = clipStart;
      vid.play().catch(() => {});
      playBtn.textContent = '❚❚';
    } else {
      vid.pause(); playBtn.textContent = '▶';
    }
  }
  playBtn.addEventListener('click', togglePlay, sig);
  $id('csAddKf').addEventListener('click', () => {
    const t = timeRel();
    // [FREE-KF-WH] In free mode also capture rect.w/h so different keyframes
    // can carry different crop sizes (before, only one rect.w/h — the final
    // one at Apply time — was baked into every keyframe). w,h are undefined
    // for preset aspects so the pipeline falls back to legacy behavior.
    const entry = { t, x: cur.x, y: cur.y };
    if (aspect === 'free' && rect) { entry.w = rect.w; entry.h = rect.h; }
    const ex = kf.findIndex(k => Math.abs(k.t - t) < 0.15);
    if (ex >= 0) kf[ex] = entry;
    else kf.push(entry);
    kf.sort((a, b) => a.t - b.t);
    renderKfs(); cropCommit();
    toast(`Keyframe @ ${fmt(t)}`);
  }, sig);
  $id('csDelKf').addEventListener('click', () => {
    if (!kf.length) return;
    const t = timeRel(); let bi = 0, bd = 1e9;
    kf.forEach((k, i) => { const d = Math.abs(k.t - t); if (d < bd) { bd = d; bi = i; } });
    kf.splice(bi, 1); renderKfs(); cropCommit();
  }, sig);
  $id('csReset').addEventListener('click', () => {
    kf = []; cur = { x: 0.5, y: 0.5 }; boxScale = 1;
    const z = $id('csZoom'), zv = $id('csZoomVal');
    if (z) z.value = 100; if (zv) zv.textContent = '100%';
    applyBox(); renderKfs(); cropCommit();
    toast('Reset ke tengah — Ctrl+Z untuk membatalkan');
  }, sig);

  // Zoom / resize slider: shrink the crop window to zoom past edge artefacts.
  const zoomEl = $id('csZoom'), zoomVal = $id('csZoomVal');
  if (zoomEl) {
    zoomEl.value = Math.round(boxScale * 100);
    if (zoomVal) zoomVal.textContent = `${Math.round(boxScale * 100)}%`;
    zoomEl.addEventListener('input', () => {
      boxScale = Math.max(0.3, Math.min(1, (parseInt(zoomEl.value) || 100) / 100));
      if (zoomVal) zoomVal.textContent = `${Math.round(boxScale * 100)}%`;
      applyBox();
    }, sig);
    zoomEl.addEventListener('change', () => cropCommit(), sig);   // [CROP-UNDO] one step per slider release
  }

  function close() {
    cancelAnimationFrame(rafId);
    MediaLifecycle.releaseMedia(vid);
    MediaLifecycle.releaseMedia(outVid);
    ac.abort();
    studio.hidden = true;
    restoreDashboardPreview();
  }
  // Copy current framing to every clip in state so the user doesn't have to
  // re-set aspect/rect/keyframes/zoom per clip. Only metadata is updated — the
  // user still hits "Render edit" per clip to actually burn the new framing.
  $id('csApplyAll')?.addEventListener('click', () => {
    const total = (state.clips || []).length;
    if (!total) { toast('No clips to apply to', 'err'); return; }
    state.clips.forEach((cl, i) => {
      // [CROP-APPLY-ALL] This read `clipIdx`, which does not exist in this
      // function — openCropStudio's parameter is `idx`. Reading an undeclared
      // identifier throws, so the callback died on its FIRST iteration and the
      // button silently did nothing: no clip was updated, no error surfaced.
      // (`clipIdx` is a parameter of openCaptionEditor, an unrelated function,
      // which is why the name looked plausible.)
      if (i === idx) return;
      cl.cropAspect = aspect;
      cl.cropRect   = aspect === 'free' && rect ? { ...rect } : null;
      cl.cropKF     = kf.map(k => ({ ...k }));
      cl.cropScale  = boxScale;
      if (kf.length === 0 && aspect !== 'free') {
        cl.cropX = cur.x * 100; cl.cropY = cur.y * 100;
      }
      // [CROP-OVERRIDES-TRACK] Same override as the single-clip Apply path —
      // a copied manual framing must win over each target clip's own
      // smart-track plan, otherwise their next render silently reverts to
      // auto-track and ignores the framing we just copied in.
      cl.trackPlan = null;
      cl.smartTracked = false;
    });
    toast(`Framing applied to ${total - 1} other clip${total - 1 === 1 ? '' : 's'}`);
    statusEl.textContent = `✓ Framing copied to ${total - 1} clip${total - 1 === 1 ? '' : 's'} (render each to burn)`;
  }, sig);
  $id('csClose').addEventListener('click', close, sig);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !studio.hidden) close(); }, sig);

  // [APPLY-CROP] Bake the current framing (aspect / rect / keyframes / zoom /
  // manual pan) into the clip file. clip.file always points at this result;
  // clip.rawFile only follows it when no captions were burned in (see
  // [RAW-SRC] below) — otherwise the caption editor's next render would
  // start from a plate that already has captions baked into it.
  $id('csRender').addEventListener('click', async () => {
    const btn = $id('csRender');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Applying…';
    // [APPLY-CROP-BURN] Honor burnSubtitles toggle. History clips carry cueWords
    // in the report but Apply Crop used to always call `applyClipCrop` which
    // skips subtitle filters entirely → user gets a cropped file with no subs.
    // If burnSubtitles is ON and this clip has cueWords, route through
    // renderClipEdit (crop + subs in one pass) so the result matches what the
    // main preview shows. If OFF or no cueWords, keep the non-destructive
    // crop-only path (unchanged).
    // [SUBS-SELFHEAL] Try to rebuild cueWords from clip.words first — fixes
    // the v2.3.20 regression where clips loaded from history / imports had
    // an empty cueWords array (never persisted / never generated), causing
    // Apply Crop to silently fall to the no-subs applyClipCrop path even
    // with Burn subs ON.
    ensureCueWords(clip, state.cfg?.subtitleWordsPerChunk);
    const hasCues = Array.isArray(clip.cueWords) && clip.cueWords.length > 0;
    const wantSubs = state.cfg.burnSubtitles !== false && hasCues;
    if (state.cfg.burnSubtitles !== false && !hasCues) {
      console.warn('[apply-crop] burnSubtitles ON but clip has no cueWords AND no recoverable words — subs will NOT burn.',
                   { clipFile: clip.file, srcVideo: clip.srcVideo,
                     cueWordsLen: (clip.cueWords||[]).length,
                     wordsLen: (clip.words||[]).length });
      toast('Burn subs aktif, tapi klip ini tidak punya transkrip sama sekali. Jalankan pipeline ulang atau import SRT dulu.', 'err');
    }
    statusEl.textContent = wantSubs ? 'Applying crop + burning subtitles…' : 'Applying crop (no subtitles)…';
    clip.cropKF = kf.map(k => ({ ...k }));
    clip.cropScale = boxScale;
    clip.cropAspect = aspect;
    clip.cropRect = aspect === 'free' ? rect : null;
    // Prefer re-cutting from the pristine source. If the editor previously
    // burned captions into clip.file, rawFile is the clean copy; use it so we
    // don't crop already-burned pixels.
    const cleanSrc = clip.rawFile || clip.file;
    const payload = {
      clipIndex: idx,
      clipFile: cleanSrc,
      // If the master source was missing at studio open we already re-anchored
      // clipStart/clipEnd to the clip file — don't pass srcVideo, otherwise the
      // backend would try to re-cut master coords against clip-local times.
      srcVideo: fellBackToClipFile ? null : (clip.srcVideo || null),
      clipStart, clipEnd,
      clipFormat: formatForAspect(aspect, state.cfg.format),
      clipResolution: state.cfg.resolution,
      cropScale: boxScale,
      cropAspect: aspect,
      cropRect: aspect === 'free' ? rect : null,
    };
    if (kf.length >= 2) {
      payload.cropKeyframes = kf.map(k => {
        const out = { t: k.t, x: k.x * 100, y: k.y * 100 };
        if (Number.isFinite(k.w) && Number.isFinite(k.h)) {   // [FREE-KF-WH]
          out.w = k.w * 100; out.h = k.h * 100;
        }
        return out;
      });
    } else if (kf.length === 1) {
      clip.cropX = kf[0].x * 100; clip.cropY = kf[0].y * 100;
      payload.cropX = clip.cropX; payload.cropY = clip.cropY;
    } else {
      clip.cropX = cur.x * 100; clip.cropY = cur.y * 100;
      payload.cropX = clip.cropX; payload.cropY = clip.cropY;
    }
    // [APPLY-CROP-BURN] When burning, hand off to renderClipEdit which already
    // does crop + subs. Enrich payload with cueWords + style + titles.
    //
    // [CROP-OVERRIDES-TRACK] Deliberately do NOT forward clip.trackPlan here.
    // Crop Studio is the MANUAL framing tool — it loads clip.cropKF (manual
    // keyframes), never the smart-track plan, and the user just dragged a
    // crop box expecting it to take effect. But renderClipEdit, whenever a
    // trackPlan is present, takes the smart-track segment path and IGNORES
    // the manual cropX/cropY/cropKeyframes entirely (buildSegmentJobs bakes
    // the auto-track crop instead). So forwarding trackPlan made every
    // "Apply crop" on a smart-tracked clip a silent no-op: the output was
    // re-cropped with the ORIGINAL auto framing, identical to the raw clip —
    // exactly the "crop does nothing / live preview + output unchanged" bug.
    // Applying a manual crop is an explicit choice to override auto framing,
    // so we drop trackPlan for this render AND clear it on the clip (below,
    // on success) so later Caption-Editor / Render-All passes keep the
    // manual framing instead of silently reviving smart-track.
    if (wantSubs) {
      payload.cueWords = clip.cueWords;
      payload.titles   = Array.isArray(clip.titles) ? clip.titles : [];
      payload.trackPlan = null;
      // [AI-STICKER-CACHE] Per-clip, like trackPlan/titles above — the AI's
      // prior sticker resolutions for THIS clip's cues, so a re-render never
      // re-asks for a cue it already has an answer for.
      payload.aiStickerCache = clip.aiStickerCache || {};
      payload.style = {
        subtitleStyle:    state.cfg.subtitleStyle,
        subtitleFont:     state.cfg.subtitleFont || '',
        subtitleOffsetMs: state.cfg.subtitleOffsetMs || 0,
        subtitleFontSize: state.cfg.subtitleFontSize,
        subtitleY:        state.cfg.subtitleY,
        subtitleX:        state.cfg.subtitleX || 540,
        subtitleAnim:     state.cfg.subtitleAnim || 'pop',
        subtitleGlow:     state.cfg.subtitleGlow !== false,
        subtitleBoxColor: state.cfg.subtitleBoxColor || '',
        subtitleBoxRotation: window.CaptionBox.boxRotation(state.cfg.subtitleBoxRotation),
        subtitleCase:     state.cfg.subtitleCase || 'none',
        // [EMOJI-STICKER] Carried on all THREE style builders from the start.
        // The audit before this feature found subtitleFont and subtitleCase
        // present in one payload and missing from another, which is how a
        // setting ends up working in the editor and nowhere else.
        emojiStickers:     state.cfg.emojiStickers === true,
      };
      // [WM-V1] Resolved watermark (project default + per-clip override).
      payload.watermark = currentWatermark(clip);
    }
    try {
      const res = await trackRender(wantSubs ? window.socl.renderEdit(payload) : window.socl.applyCrop(payload));
      // [GALLERY-RENDER] Same envelope helper the batch loop uses: an {error}
      // payload AND a resolved-but-empty result both mean the render did not
      // happen. Hand-checking only res.error missed the second case.
      { const out = BatchRender.interpretRenderResult(res); if (!out.ok) throw new Error(out.error); }
      const label = wantSubs
        ? 'Crop + subs applied'
        : 'Crop plate saved (no subs — for editor input)';
      statusEl.innerHTML = `✓ ${label} · <b>${res.fileName}</b>`;
      toast(`✓ ${label}: ${res.fileName}`);
      // Same exportWarning surfacing the Caption Editor render and batch loop
      // already do — applyCrop's non-subs path only just started returning
      // this field, so it was silently dropped here before.
      if (res && res.exportWarning) toast(res.exportWarning, 'err');
      // file is what main previews load. rawFile is the CLEAN plate the
      // caption editor re-cuts from — only advance it when this render had
      // no captions burned in; otherwise rawFile would point at a file with
      // captions already baked, and the next editor/batch render would burn
      // a second pass on top of them.
      clip.file = res.file;
      if (res.thumbnail) clip.thumbnail = res.thumbnail;
      if (!wantSubs) clip.rawFile = res.file;
      // [CROP-OVERRIDES-TRACK] Persist the manual-crop override: now that the
      // user has committed a manual framing, drop the smart-track plan so any
      // subsequent re-render (Caption Editor, Render All) keeps THIS framing
      // instead of silently reverting to auto-track. The manual cropKF/cropX/
      // cropAspect/cropRect saved onto the clip above are now the sole framing
      // source of truth for this clip.
      clip.trackPlan = null;
      clip.smartTracked = false;
      // [SPLIT-STALE-CLEAR] A plain Crop Studio apply used to leave a stale
      // clip.splitCrop in place — the clip rendered correctly un-split, but
      // reopening Split Screen afterwards restored boxes for a composition
      // that no longer matched clip.file (and the persisted-writer fix means
      // that stale object would now survive a restart too).
      clip.splitCrop = null;
      // [APPLY-CROP-BURN] If we burned subs, mark the clip so the main preview's
      // JS overlay doesn't draw captions on top of the already-burned ones
      // (which would render them twice). Caption Editor's next Render Edit
      // still uses srcVideo → recut mode → fresh burn, so no double-stack.
      clip.subsBurned = !!wantSubs;
      // [AI-STICKER-CACHE] Carry back whatever the AI resolved (or didn't
      // need to) this render, so the NEXT one reuses it.
      if (res.aiStickerCache) clip.aiStickerCache = res.aiStickerCache;
      // Don't swap vid.src / outVid.src — the studio drags crop coordinates on
      // srcVideo (master YT source), and the backend re-cuts from srcVideo too.
      // Pointing the studio previews at the cropped output would let the user
      // pick a NEW crop rect against already-cropped pixels while the backend
      // still uses master coords → mismatch. Instead close the studio; the main
      // preview reloads and shows the applied crop.
      setTimeout(() => {
        if (!studio.hidden) close();
      }, 1200);
    } catch (e) {
      statusEl.textContent = `✗ ${e.message || e}`;
      toast(`Apply failed: ${e.message || e}`, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Apply crop';
    }
  }, sig);

  // Kick off
  rafId = requestAnimationFrame(loop);
  // If metadata already available (cached), lay out now
  if (vid.readyState >= 1) { computeBoxFrac(); vid.currentTime = clipStart; layoutSource(); renderKfs(); }
}

async function renderHistoryPanel() {
  // Panel kanan tetap ringkas; galeri sebenarnya tampil di overlay.
  els.panelEyebrow.textContent = 'History';
  els.panelTitle.textContent = 'Past sessions';
  els.panelBody.innerHTML = `<div class="empty">Membuka galeri…</div>`;
  await openHistoryGallery();
  els.panelBody.innerHTML = `<div class="empty">Galeri history terbuka. <br>Tekan Esc untuk menutup.</div>`;
}

// [HG-TILES] 6 cols × 2 rows = 12 portrait (3:4) tiles per page. That fills
// the default window; 7 × 2 = 14 shrank each preview to ~177px wide and left
// an empty band. Narrower windows reflow to 4 × 3 / 3 × 4 (styles.css).
const HISTORY_PAGE_SIZE = 12;
const HISTORY_POSTER_T = 0.5; // seek offset (s) so tiles show a real frame, not a black first frame

async function openHistoryGallery() {
  const sessions = await window.socl.listHistory();
  state.historyClips = window.HistoryGallery.flattenHistory(sessions);
  state.historyFilter = 'all';
  state.historyQuery = '';
  state.historyPage = 0;
  if (els.hgSearch) els.hgSearch.value = '';
  els.hgChips.querySelectorAll('.hg-chip').forEach(b =>
    b.classList.toggle('on', b.dataset.hgf === 'all'));
  els.historyOverlay.hidden = false;
  els.historyOverlay.setAttribute('aria-hidden', 'false');
  renderHistoryGrid();
}

function pauseHistoryVideos() {
  if (!els.hgGrid) return;
  // Hentikan & lepas semua video hover di grid (tile pakai <img>; video hanya muncul saat hover).
  els.hgGrid.querySelectorAll('video').forEach(v => {
    try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {}
  });
  els.hgGrid.querySelectorAll('.clip-card').forEach(card => { card._hoverVid = null; });
}

// ── Thumbnail per klip (ffmpeg di main process, di-cache di disk & memori, satu-per-satu) ──
const historyThumbCache = new Map(); // file path -> thumb path (atau false bila gagal)
const historyThumbQueue = [];
let historyThumbBusy = false;

function queueHistoryThumb(file, imgEl) {
  if (!file || !imgEl) return;
  const cached = historyThumbCache.get(file);
  if (cached) { imgEl.src = toFileURL(cached); return; }
  if (cached === false) return; // sudah pernah gagal → biarkan fallback session thumb
  historyThumbQueue.push({ file, imgEl });
  processHistoryThumbQueue();
}

async function processHistoryThumbQueue() {
  if (historyThumbBusy) return;
  const job = historyThumbQueue.shift();
  if (!job) return;
  historyThumbBusy = true;
  const { file, imgEl } = job;
  try {
    const cached = historyThumbCache.get(file);
    if (cached) { imgEl.src = toFileURL(cached); }
    else if (cached !== false) {
      const thumb = await window.socl.historyThumb(file);
      if (thumb) {
        historyThumbCache.set(file, thumb);
        if (imgEl.isConnected) imgEl.src = toFileURL(thumb);
      } else {
        historyThumbCache.set(file, false); // tandai gagal, jangan ulangi
      }
    }
  } catch (e) {
    console.warn('[history] thumb error:', e);
  } finally {
    historyThumbBusy = false;
    processHistoryThumbQueue();
  }
}

function closeHistoryGallery() {
  pauseHistoryVideos();
  // The overlay is display:none when closed, but hidden DOM still retains its
  // decoded poster surfaces. Rebuild from disk on the next open instead of
  // carrying an invisible page of images for the rest of the app session.
  historyThumbQueue.length = 0;
  historyThumbCache.clear();
  state.historyClips = [];
  els.hgGrid._filtered = [];
  els.hgGrid.replaceChildren();
  els.historyOverlay.hidden = true;
  els.historyOverlay.setAttribute('aria-hidden', 'true');
}

function renderHistoryGrid() {
  try {
    renderHistoryGridUnsafe();
  } catch (err) {
    console.error('[history] render error:', err);
    // Jangan biarkan overlay macet & memblokir UI — tutup & beri tahu user.
    closeHistoryGallery();
    toast('Gagal menampilkan galeri history');
  }
}

function renderHistoryGridUnsafe() {
  // pause + lepas decoder klip lama sebelum grid di-rebuild
  pauseHistoryVideos();
  const HG = window.HistoryGallery;
  const clips = HG.filterHistoryClips(state.historyClips, {
    filter: state.historyFilter, query: state.historyQuery,
  });
  const RES_LABEL = { '720p':'720p','1080p':'1080p','2K':'2K','4K':'4K' };
  const sessionCount = new Set(clips.map(c => c._jobId)).size;
  // Reference format: "<b>142</b> clip · 12 session"
  els.hgCount.innerHTML = `<b>${clips.length}</b> clip · ${sessionCount} session`;

  if (!clips.length) {
    els.hgGrid.innerHTML = state.historyClips.length
      ? `<div class="empty">Tidak ada klip cocok filter/pencarian ini.</div>`
      : `<div class="empty">Belum ada session. Run pipeline pertama dulu.</div>`;
    updateHistoryPager(0, 0);
    return;
  }

  // Paginasi — tampilkan tile besar & jelas, sisanya lewat tombol Next/Prev
  const totalPages = Math.ceil(clips.length / HISTORY_PAGE_SIZE);
  if (state.historyPage >= totalPages) state.historyPage = totalPages - 1;
  if (state.historyPage < 0) state.historyPage = 0;
  const startIdx = state.historyPage * HISTORY_PAGE_SIZE;
  const pageClips = clips.slice(startIdx, startIdx + HISTORY_PAGE_SIZE);
  updateHistoryPager(state.historyPage, totalPages);

  els.hgGrid.innerHTML = pageClips.map((c, gi) => {
    const durSec = Math.max(0, (c.end - c.start) || 0);
    const dur = `${String(Math.floor(durSec/60)).padStart(2,'0')}:${String(Math.floor(durSec%60)).padStart(2,'0')}`;
    const score = Math.round(c.score || 0);
    const hot = HG.isHotClip(c);
    // Static poster (di-cache). Video hanya on-hover — decode-cost aman.
    const thumbSrc = c._sessionThumb ? toFileURL(c._sessionThumb) : '';
    // Reference layout: rank pill top-left (relative day), status pill top-right
    // (◆ 96 for hot / ✓ SAVED for rendered), duration bottom-right, hero caption
    // bottom-center with lime highlight span, then meta strip below (title + sub).
    const rank = shortDayRank(c._createdAt);
    const status = hot
      ? `<span class="hg-status hot">◆ ${score || 90}</span>`
      : (c.file ? `<span class="hg-status saved">✓ SAVED</span>` : '');
    const srcTitle = shortSessionName(c._sessionTitle);
    const res = c.file ? (c._resolution || '1080p') : (hot ? 'HOT' : '—');
    // [HG-TILES] Preview above, words below on the card: the old hero caption
    // painted over the frame made every tile shout.
    return `
      <div class="hg-clip" data-hgi="${gi}">
        <div class="hg-media">
          <img class="hg-thumb-img" src="${thumbSrc}" alt="">
          <span class="hg-rank">${esc(rank)}</span>
          ${status}
          <span class="hg-dur">${dur}</span>
        </div>
        <div class="hg-overlay-meta">
          <div class="hg-title">${esc(c.title || c.hook || 'Untitled')}</div>
          <div class="hg-sub"><span>${esc(srcTitle)}</span><span class="${res==='HOT'?'r':(c.file?'r':'')}">${esc(res)}</span></div>
        </div>
      </div>`;
  }).join('');

  // simpan referensi klip halaman ini untuk handler (index gi merujuk ke array ini)
  els.hgGrid._filtered = pageClips;
  els.hgGrid.scrollTop = 0;
  bindHistoryGridEvents();

  // Generate/isi thumbnail per klip (satu per satu, di-cache) supaya tile tidak hitam.
  const cards = els.hgGrid.querySelectorAll('.hg-clip');
  pageClips.forEach((c, i) => {
    if (!c.file || !cards[i]) return;
    const img = cards[i].querySelector('img.hg-thumb-img');
    if (img) queueHistoryThumb(c.file, img);
  });
}

// ── History helpers (rank pill labels + session names) ──
function shortDayRank(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime(); if (isNaN(t)) return '—';
  const now = new Date();
  const d = new Date(t);
  const same = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  const y = new Date(now); y.setDate(y.getDate()-1);
  if (same(d, now)) return 'TODAY';
  if (same(d, y))   return "Y'DAY";
  const diff = Math.floor((now - d) / 86400000);
  if (diff < 7) return ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()];
  return d.toLocaleDateString('en', { month:'short', day:'numeric' }).toUpperCase();
}
function shortSessionName(name) {
  if (!name) return 'Session';
  const s = String(name).replace(/^https?:\/\/[^\s]+\s*/,'').trim();
  return s.length > 22 ? s.slice(0, 22) + '…' : s;
}

function updateHistoryPager(page, totalPages) {
  if (!els.hgPager) return;
  if (totalPages <= 1) { els.hgPager.hidden = true; return; }
  els.hgPager.hidden = false;
  els.hgPageInfo.textContent = `Halaman ${page + 1} / ${totalPages}`;
  els.hgPrev.disabled = page <= 0;
  els.hgNext.disabled = page >= totalPages - 1;
}

function historyHoverPlay(card) {
  const clips = els.hgGrid._filtered || [];
  const c = clips[+card.dataset.hgi];
  if (!c || !c.file || card._hoverVid) return;
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
  v.src = `${toFileURL(c.file)}#t=${HISTORY_POSTER_T}`;
  (card.querySelector('.hg-media') || card).appendChild(v);   // over the <img>, inside the 3:4 media box only
  card._hoverVid = v;
  v.play().catch(() => {});
}

function historyHoverStop(card) {
  const v = card._hoverVid;
  if (!v) return;
  card._hoverVid = null;
  try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {}
}

function bindHistoryGridEvents() {
  const clips = els.hgGrid._filtered || [];
  // hover: putar SATU video pada kartu yang di-hover saja
  els.hgGrid.querySelectorAll('.hg-clip').forEach(card => {
    card.addEventListener('mouseenter', () => historyHoverPlay(card));
    card.addEventListener('mouseleave', () => historyHoverStop(card));
    card.addEventListener('click', () => {
      const c = clips[+card.dataset.hgi];
      if (!c) return;
      state.clips = c._sessionClips.map(cl => ({
        ...cl, thumbnail: c._sessionThumb,
        isHot: cl.isHot != null ? cl.isHot : ((cl.score||0) >= 8),
        // [HISTORY-REUSE] onClip normalises this for live clips (see the
        // [SUBS-BURN] note there) and the History path normalised isHot right
        // next to it but left subsBurned alone. loadPreview reads it as
        // `!!c.subsBurned`, so an undefined flag means "draw the JS caption
        // overlay" — on top of a file that already has captions burned in.
        // flattenHistory fills it in from the path for older reports.
        subsBurned: cl.subsBurned != null ? cl.subsBurned : false,
      }));
      renderGallery();
      loadPreview(c._clipIndexInSession);
      closeHistoryGallery();
    });
  });
}

function initHistoryGalleryControls() {
  if (!els.historyOverlay) return;
  // Close via tombol ✕
  els.hgClose.addEventListener('click', closeHistoryGallery);
  // Close via klik backdrop (di luar .hg-panel)
  els.historyOverlay.addEventListener('click', e => {
    if (e.target === els.historyOverlay) closeHistoryGallery();
  });
  // Close via Esc
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !els.historyOverlay.hidden) closeHistoryGallery();
  });
  // Chip filter All/Hot
  els.hgChips.querySelectorAll('.hg-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      els.hgChips.querySelectorAll('.hg-chip').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      state.historyFilter = btn.dataset.hgf;
      state.historyPage = 0;
      renderHistoryGrid();
    });
  });
  // Search (debounced — full-grid rebuild per keystroke was janky)
  let hgSearchDebounce = null;
  els.hgSearch.addEventListener('input', () => {
    clearTimeout(hgSearchDebounce);
    hgSearchDebounce = setTimeout(() => {
      state.historyQuery = els.hgSearch.value;
      state.historyPage = 0;
      renderHistoryGrid();
    }, 200);
  });
  // Paginasi Prev/Next
  els.hgPrev.addEventListener('click', () => {
    if (els.hgPrev.disabled) return;
    if (state.historyPage > 0) { state.historyPage--; renderHistoryGrid(); }
  });
  els.hgNext.addEventListener('click', () => {
    if (els.hgNext.disabled) return;
    state.historyPage++; renderHistoryGrid();
  });
}

function bindSegment(id, cb) {
  document.querySelectorAll('#' + id + ' button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#' + id + ' button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      cb(b.dataset.v);
    });
  });
}

// ─── Gallery ─────────────────────────────────────────────
// Hot is an explicit per-clip flag (seeded from score, then user-toggleable).
const isHot = c => c.isHot ?? ((c.score || 0) >= 8);
const CANDIDATE_STATE_LABELS = {
  waiting: 'Menunggu Smart Track',
  tracking: 'Smart Track',
  rendering: 'Rendering',
  standard: 'Crop standar',
  ready: 'Siap',
  failed: 'Gagal',
};
function candidateStateLabel(clip) {
  return CANDIDATE_STATE_LABELS[clip?.state] || CANDIDATE_STATE_LABELS.waiting;
}

function showPosterPreview(preview, label) {
  const source = typeof preview === 'object' && (preview?.file || preview?.srcVideo || state.sourcePreview?.file);
  if (source) {
    hidePosterPreview();
    state.cueWords = [];
    els.captionTx.textContent = ''; els.captionOv.style.visibility = 'hidden';
    const url = toFileURL(source);
    const seek = () => {
      if (els.preview.getAttribute('src') !== url) return;
      try { els.preview.currentTime = Math.max(0,Number(preview?.start)||0); } catch {}
    };
    if (els.preview.getAttribute('src') !== url) {
      els.preview.addEventListener('loadedmetadata',seek,{once:true});
      MediaLifecycle.setMediaSource(els.preview,url);
    } else if (els.preview.readyState >= 1) seek();
    if (label) els.sceneTag.textContent = label;
    return;
  }
  const thumbnail = typeof preview === 'string' ? preview : preview?.thumbnail;
  if (!thumbnail) return;
  releaseDashboardPreview();
  els.preview.hidden = true;
  const src = toFileURL(thumbnail);
  els.sourceBackdrop.src = src;
  els.sourcePoster.src = src;
  els.sourceBackdrop.hidden = false;
  els.sourcePoster.hidden = false;
  if (els.transport) els.transport.hidden = true;
  if (label) els.sceneTag.textContent = label;
}

function hidePosterPreview() {
  els.sourceBackdrop.hidden = true;
  els.sourcePoster.hidden = true;
  els.sourceBackdrop.removeAttribute('src');
  els.sourcePoster.removeAttribute('src');
  els.preview.hidden = false;
  if (els.transport) els.transport.hidden = false;
}

function releaseDashboardPreview() {
  MediaLifecycle.releaseMedia(els.preview);
  if (els.playBtn) els.playBtn.textContent = '▶';
}

function restoreDashboardPreview() {
  if (state.activeClip >= 0 && state.clips[state.activeClip]?.file) {
    loadPreview(state.activeClip, { autoplay: false });
  }
}

function renderGallery() {
  persistClippingSession();
  refreshOutputPill();   // [OUTPUT-PILL] clip count follows the gallery
  // Keep the auto-processing strip stats in sync with clip mutations
  try { refreshApStrip(); } catch {}
  const filtered = state.clips.filter(c => {
    if (state.filter === 'hot')   return isHot(c);
    if (state.filter === 'saved') return !!c.file;
    return true;
  });
  els.clipCountBadge.textContent = state.clips.length;
  els.cntAll.textContent = state.clips.length;
  els.cntHot.textContent = state.clips.filter(isHot).length;
  els.cntSaved.textContent = state.clips.filter(c => c.file).length;
  const gallerySub = document.getElementById('gallerySub');
  if (gallerySub) gallerySub.textContent = state.clips.length
    ? `${state.clips.length} found · ${state.clips.filter(c => c.file).length} rendered · ${state.clips.filter(isHot).length} hot`
    : '';
  // [GALLERY-RENDER] Contextual action zone. Hot / Render all are the gallery's
  // batch toolbar and show whenever there are clips — gating the whole zone on
  // "a clip has been through the Caption Editor" left Render all display:none
  // on a fresh run, so the only way to batch-render was to open the editor and
  // apply an edit first. Only the "N edit pending" note is contextual. Still
  // mutually exclusive with select mode: both zones share the same 44px slot.
  const editAct = document.getElementById('sbarEditAct');
  if (editAct) {
    const zone = BatchRender.batchZoneState({
      clipCount: state.clips.length,
      editN:     state.clips.filter(c => c.editDirty).length,
      hotN:      state.clips.filter(isHot).length,
      selectMode: state.selectMode,
      dismissed:  state.batchBarDismissed,
    });
    editAct.hidden = !zone.showZone;
    const noteEl  = document.getElementById('gb_note');
    const editLbl = document.getElementById('gb_editCount');
    const hotLbl  = document.getElementById('gb_hotN');
    const dismiss = document.getElementById('gb_dismiss');
    // A batch in flight owns the note slot; don't fight it for the label.
    if (noteEl && !batchRunning)  noteEl.hidden  = !zone.showNote;
    if (dismiss && !batchRunning) dismiss.hidden = !zone.showNote;
    if (editLbl) editLbl.textContent = zone.noteText;
    if (hotLbl)  hotLbl.textContent  = zone.hotText;
  }

  if (!filtered.length) {
    els.gallery.innerHTML = `<div class="empty">No clip in this filter.</div>`;
    return;
  }

  // Reference strip: uniform thumbnail row of ALL detected clips (no time
  // ruler / no waveform). Portrait 9:16 tiles for face/vertical formats,
  // landscape 16:9 when the active format is landscape. Overflow scrolls
  // horizontally so 30-clip batches still fit without shrinking.
  // Detected-clip tiles follow the selected output format aspect: 9:16 for
  // face/blur (default portrait), 1:1 for square, 16:9 for landscape.
  const fmt = state.cfg?.format || 'face';
  const stripClass = fmt === 'landscape' ? 'gtl-strip--wide'
                   : fmt === 'square'    ? 'gtl-strip--square'
                   : '';
  // [WM-V1] Only show the per-clip override badge when the project has a
  // watermark image set — nothing to toggle otherwise. Three visual states:
  //   default (null override) → subtle "WM" chip
  //   forced off ({enabled:false}) → red strike-through "WM"
  //   forced on ({enabled:true}) → accent-lime "WM"  (used when the project
  //   default is currently disabled but the user wants this specific clip on)
  // [WM-TEXT-OFF] Text-only watermarks burn too, so the per-clip override badge
  // has to appear for them as well — it was image-gated, leaving a text
  // watermark with no per-clip escape hatch at all.
  // Content presence, not isTextActive() — matches the image branch, which is
  // likewise independent of the enabled flag.
  const projectHasWm = !!(state.cfg?.watermark?.image?.path)
                    || !!(state.cfg?.watermark?.text?.content);
  const wmBadgeHTML = (c) => {
    if (!projectHasWm) return '';
    const ov = c.watermarkOverride;
    const cls = ov?.enabled === false ? ' wm-off'
              : ov?.enabled === true  ? ' wm-on'
              : '';
    const title = ov?.enabled === false ? 'Watermark OFF (klik → default project)'
                : ov?.enabled === true  ? 'Watermark FORCE-ON (klik → default project)'
                : 'Watermark: pakai default project (klik → OFF)';
    return `<i class="wm-badge${cls}" title="${title}" data-wm-idx="${state.clips.indexOf(c)}">WM</i>`;
  };
  const cards = filtered.map((c) => {
    const idx = state.clips.indexOf(c);
    const active = idx === state.activeClip;
    const card = ClipCard.model(c, idx, fmt);
    const media = c.thumbnail
      ? `<img src="${toFileURL(c.thumbnail)}" alt="${esc(card.title)}">`
      : `<span class="gtl-empty"></span>`;
    const flame = card.hot
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c1.3 3-1 4.2-1 6.4 0 1.1.9 2 2 2 1.5 0 2-2 2-3.2 2.2 2.1 3.6 5 3.6 7.3a6.6 6.6 0 1 1-13.2 0c0-3.1 1.3-5.3 3.3-7.3 1 1.4 2 2.5 3 2.5-1.1-2.2-1.1-5.3.3-7.7z"/></svg>'
      : '';
    return `
      <button class="gtl-tile gtl-ratio-${card.ratio}${active?' gtl-active':''}${isHot(c)?' gtl-hot':''}${c.file?' gtl-rendered':''}${state.selection.has(idx)?' gtl-picked':''}"
              data-idx="${idx}"
              title="${esc(card.title)} · ${card.scoreText}">
        <span class="gtl-media">
          ${media}
          <strong class="gtl-title-overlay">${esc(card.title)}</strong>
          <span class="gtl-number">${card.number}</span>
          <i class="gtl-score gtl-score-${card.tier}" title="Skor highlight ${card.scoreText}">${flame}${card.scoreText}</i>
          <span class="gtl-duration">${card.duration}</span>
          <span class="gtl-pick"><svg viewBox="0 0 24 24" fill="none" stroke="#10130a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span>
          ${wmBadgeHTML(c)}
          ${c.file ? `<svg class="gtl-check" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--lime)"/><path d="M7.5 12.2l3.2 3.2 6-6" fill="none" stroke="#10130a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
        </span>
      </button>`;
  }).join('');

  els.gallery.innerHTML = `<div class="gtl-strip${stripClass?' '+stripClass:''}${state.selectMode?' is-selecting':''}">${cards}</div>`;
  els.gallery.querySelectorAll('.gtl-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const idx = parseInt(tile.dataset.idx, 10);
      if (state.selectMode) { state.selection.toggle(idx); renderGallery(); syncSelectUI(); return; }
      loadPreview(idx);
    });
  });
  // [WM-V1] Per-clip WM badge cycles: default → off → default. stopPropagation
  // so clicking the badge does NOT also fire the tile's loadPreview.
  els.gallery.querySelectorAll('.wm-badge').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = parseInt(b.dataset.wmIdx, 10);
      const clip = state.clips[i]; if (!clip) return;
      const ov = clip.watermarkOverride;
      clip.watermarkOverride = ov?.enabled === false ? null : { enabled: false };
      renderGallery();
      if (i === state.activeClip) updateWatermarkOverlay();
    });
  });
}

function setRenderedPreviewSource(video, clip) {
  video.poster = clip.thumbnail ? (/^https?:/i.test(clip.thumbnail) ? clip.thumbnail : toFileURL(clip.thumbnail)) : '';
  return MediaLifecycle.setMediaSource(video, toFileURL(clip.file));
}
function syncCompletedClipPreview(preferredIndex) {
  if (state.retainPreviousClips) return false;
  const clips = state.clips || [];
  const selected = state.currentPreviewIdx;
  const index = Number.isInteger(selected) && clips[selected]?.file ? selected
    : Number.isInteger(preferredIndex) && clips[preferredIndex]?.file ? preferredIndex
      : clips.findIndex(clip => clip?.file);
  if (index < 0) return false;
  const clip = clips[index];
  // The gallery's clip object may already be ready while the decoder still
  // points at the 68-minute source. Inspect the actual loaded URL, not file flags.
  const loaded = els.preview.getAttribute('src');
  if (loaded === toFileURL(clip.file)
      && state.previewSubsBurned === !!clip.subsBurned
      && state.previewTitlesBurned === !!clip.titlesBurned) return false;
  loadPreview(index, { autoplay: false });
  return true;
}
function loadPreview(idx, opts = {}) {
  const c = state.clips[idx];
  if (!c) return;
  // Hydrate the same cues/tokens as Edit before the first dashboard paint.
  prepareClipCaptionPreview(c);
  _dashKinCap = null;
  state.activeClip = idx;
  state.currentPreviewIdx = idx;
  // Clear stale caption text from previous clip
  els.captionTx.textContent = '';
  els.captionOv.style.visibility = 'hidden';
  // [WM-V1] Repaint the watermark overlay for this clip's resolved settings
  // (project default merged with per-clip override).
  try { updateWatermarkOverlay({ dashboard: true }); } catch {}
  if (!c.file) {
    state.previewSubsBurned = false;
    state.previewTitlesBurned = false;
    state.cueWords = [];
    state.stickerAiCache = null;
    showPosterPreview(c, `Clip ${String(idx + 1).padStart(2, '0')} · ${candidateStateLabel(c)}`);
    els.gallery.querySelectorAll('.gtl-tile').forEach(tile => {
      tile.classList.toggle('gtl-active', parseInt(tile.dataset.idx) === idx);
    });
    const pA = document.getElementById('prevArrow');
    const nA = document.getElementById('nextArrow');
    if (pA) pA.disabled = idx <= 0;
    if (nA) nA.disabled = idx >= state.clips.length - 1;
    return;
  }
  {
    const dur = Math.max(0, (c.end || 0) - (c.start || 0));
    const mm = String(Math.floor(dur / 60)).padStart(2, '0');
    const ss = String(Math.floor(dur % 60)).padStart(2, '0');
    const hot = isHot(c);
    const score = Math.round(c.score || 0);
    els.sceneTag.innerHTML = `
      <span class="st-pill"><b>Clip ${String(idx + 1).padStart(2,'0')}</b> · ${mm}:${ss}</span>
      <span class="st-pill hot ${hot?'':'off'}" id="stHot" title="Toggle hot">
        <svg viewBox="0 0 24 24" fill="${hot?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        ${hot ? '<b>HOT</b>' : 'Mark hot'}${score ? ` · ${score}` : ''}
      </span>`;
    const stHot = document.getElementById('stHot');
    if (stHot) stHot.addEventListener('click', (e) => {
      e.stopPropagation();
      c.isHot = !isHot(c);
      renderGallery();
      loadPreview(idx, { autoplay: false });
    });
  }
  // If the loaded file already has captions burned in (either from the
  // pipeline with burnSubtitles=on, or from a previous Editor Apply), skip the
  // JS overlay — otherwise we render captions twice (baked font A + live overlay
  // font B) and the two stack on top of each other.
  state.previewSubsBurned = !!c.subsBurned;
  // [FX-NO-BURN] The file already carries its Efek video; tinting it again
  // live would double it (and hide the cut-out under a full-frame tint).
  state.previewFxBurned = !!c.fxBurned;
  state.cueWords = (state.previewSubsBurned ? [] : (Array.isArray(c.cueWords) ? c.cueWords : []));
  // [TITLE-DOUBLE] Same reasoning as previewSubsBurned above, but titles never
  // had the equivalent gate: tickDashTitles() always painted clip.titles live
  // regardless of whether the currently-loaded clip.file already has those
  // exact titles baked in by a previous Editor Apply — showing the title
  // twice (baked pixels + a live DOM layer on top, at a slightly different
  // position since the two renderers are not pixel-identical).
  state.previewTitlesBurned = !!c.titlesBurned;
  // [AI-STICKER-CACHE] The preview may only READ this — a video-tick handler
  // must never make a network call — but reading it is what lets an
  // AI-resolved sticker show up in the preview at all, instead of appearing
  // for the first time in the burned file.
  state.stickerAiCache = c.aiStickerCache || null;
  if (c.file && c.file.endsWith('.mp4')) {
    hidePosterPreview();
    // The initial paused preview should show the actual rendered poster,
    // rather than frame zero where caption entrance animations are invisible.
    setRenderedPreviewSource(els.preview, c);
    if (opts.autoplay !== false) {
      els.preview.play().then(() => {
        // play() resolves only after the file loads. If the caption editor
        // opened in the meantime, it already paused everything — don't start
        // audio underneath the overlay (Windows loads slower, so this race
        // was the "background keeps playing behind the editor" bug).
        if (isCaptionStudioOpen()) { els.preview.pause(); els.playBtn.textContent = '▶'; return; }
        els.playBtn.textContent = '❚❚';
      }).catch(() => {});
    }
  }
  applyCaptionStyle();
  tickDashTitles();   // [TITLE-PARITY] paint titles for the newly-loaded clip
  // Update active tile highlight without full re-render (matches .gtl-tile).
  els.gallery.querySelectorAll('.gtl-tile').forEach(tile => {
    tile.classList.toggle('gtl-active', parseInt(tile.dataset.idx) === idx);
  });
  // Preview chevrons: disable at edges
  const pA = document.getElementById('prevArrow');
  const nA = document.getElementById('nextArrow');
  if (pA) pA.disabled = idx <= 0;
  if (nA) nA.disabled = idx >= state.clips.length - 1;
}

// ─── [EMOJI-STICKER] Preview parity ──────────────────────
// The burn plans stickers with EmojiMap.planStickers() and places them with
// EmojiMap.stickerRect(); so does this. Same table, same caps, same
// arithmetic, same PNG — the two cannot drift, which is exactly the failure
// mode caption geometry has hit before (a preview tuned by eye against a burn
// that computed something else).
//
// The plan is cached: planStickers walks every cue, and this runs on a video
// tick. It is rebuilt when the cue list or the toggle changes.
let _stickerPlan = [];
let _stickerPlanCues = null;
let _stickerPlanOn = null;
let _stickerPlanCache = null;

function stickerPlan() {
  const on = state.cfg.emojiStickers === true;
  const cache = state.stickerAiCache || null;
  if (state.cueWords !== _stickerPlanCues || on !== _stickerPlanOn || cache !== _stickerPlanCache) {
    _stickerPlanCues = state.cueWords;
    _stickerPlanOn = on;
    _stickerPlanCache = cache;
    // state.cueWords is EMPTY when the loaded file already has captions burned
    // in (see loadPreview / previewSubsBurned) — and a burned file already has
    // its stickers too, so drawing them again would double them up.
    // [AI-STICKER-CACHE] aiHits comes from the clip's PERSISTED resolutions
    // only — never a fresh query. The burn maps the cache the same way
    // (EmojiMap.hitsFromCache), so once a clip has been rendered once, its
    // AI-resolved stickers appear here too instead of surfacing for the first
    // time in the output file.
    _stickerPlan = (on && Array.isArray(state.cueWords) && state.cueWords.length)
      ? window.EmojiMap.planStickers(state.cueWords, {
          aiHits: window.EmojiMap.hitsFromCache(state.cueWords, cache),
        })
      : [];
  }
  return _stickerPlan;
}

// Force a rebuild + repaint (toggle flipped, caption geometry changed).
function updateStickerOverlay() {
  _stickerPlanCues = null;
  tickStickerPreview();
}

// [STICKER-ROW] A cue-moment can show 2-3 emoji side by side (groupSize on
// each planStickers entry). #stickerOverlay in index.html is only ONE <img>;
// rather than hardcode MAX_EMOJI_PER_CUE into the markup, a small pool of
// siblings is cloned from it lazily, on first use. Index 0 is always the
// original element, so a clip with no multi-emoji moments never allocates
// anything beyond what already existed.
const _stickerOvPool = [];
function stickerOvAt(i) {
  if (_stickerOvPool[i]) return _stickerOvPool[i];
  if (i === 0) { _stickerOvPool[0] = els.stickerOv; return els.stickerOv; }
  const base = els.stickerOv;
  if (!base) return null;
  const clone = base.cloneNode(false);
  clone.removeAttribute('id');
  base.parentElement.appendChild(clone);
  _stickerOvPool[i] = clone;
  return clone;
}

function tickStickerPreview() {
  if (!els.stickerOv) return;
  const plan = stickerPlan();
  // Same shifted timeline the captions read, or a sticker would appear a beat
  // away from the word that triggered it.
  const t = (els.preview.currentTime || 0) - (state.cfg.subtitleOffsetMs || 0) / 1000;
  const hits = plan.filter(s => t >= s.start && t < s.end);
  const groupSize = hits.length;
  // Hide any pool member beyond what THIS tick needs — carried over from a
  // previous, larger group, or simply nothing active right now.
  for (let i = groupSize; i < _stickerOvPool.length; i++) {
    if (_stickerOvPool[i]) _stickerOvPool[i].hidden = true;
  }
  if (!groupSize) return;
  // Canonical basis: every ratio below is scale-free, so 1080×1920 stands in
  // for whatever the stage is actually sized at right now.
  const OUT_W = 1080, OUT_H = 1920;
  // Same row layout the burn uses (EmojiMap.stickerRowRect) — a single emoji
  // (groupSize 1) centres exactly as before; 2-3 fan out around that centre.
  const rects = window.EmojiMap.stickerRowRect(groupSize, {
    fontSize: state.cfg.subtitleFontSize || 64,
    captionY: state.cfg.subtitleY || 540,
    outputW: OUT_W, outputH: OUT_H,
  });
  hits.forEach((hit, i) => {
    const img = stickerOvAt(i);
    if (!img) return;
    // Sized/placed off HEIGHT for x (the asset is square, so width follows)
    // and off WIDTH for x — keeps face / square / landscape stages
    // consistent without a per-format case, matching the burn's own geometry.
    const src = `../assets/emoji/${hit.file}`;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.style.height = `${(rects[i].size / OUT_H) * 100}%`;
    img.style.width = 'auto';
    img.style.top = `${(rects[i].y / OUT_H) * 100}%`;
    img.style.left = `${(rects[i].x / OUT_W) * 100}%`;
    img.style.transform = 'none';
    img.hidden = false;
  });
}

// Show the cue whose time window contains currentTime. Burned-in captions
// stay in the file; this overlay is only for the unburned preview / live tuning.

// [CAP-DIM] Gelapkan background: a black layer over the video, under the
// captions, at cfg.captionDim opacity — the burn draws the same drawbox.
function syncDimLayers() {
  const d = Math.max(0, Math.min(0.6, +(state.cfg && state.cfg.captionDim) || 0));
  document.querySelectorAll('.preview-stage, .cap-stage').forEach((stage) => {
    let el = stage.querySelector(':scope > .cap-dim-layer');
    if (!d) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'cap-dim-layer';
      Object.assign(el.style, { position: 'absolute', inset: '0', background: '#000', pointerEvents: 'none', zIndex: '1' });
      const v = stage.querySelector('video');
      if (v && v.parentElement === stage) v.after(el); else stage.prepend(el);
    }
    if (el.style.opacity !== String(d)) el.style.opacity = String(d);
  });
}
function tickCaptionPreview() {
  syncDimLayers();   // [CAP-DIM]
  // [CAP-OFFSET] Preview must read the SAME shifted timeline as the burn, or
  // calibrating by eye here would tune the preview and leave the render alone.
  const t = (els.preview.currentTime || 0) - (state.cfg.subtitleOffsetMs || 0) / 1000;
  let active = '';
  // [HL-PALETTE] The cue's INDEX, not just its text: a rotating accent is keyed
  // to it, and it must be the index into the same array the burn iterates
  // (cueWords) or the preview would show a different colour than it renders.
  let activeIdx = 0;
  let activeCue = null;
  // [CUE-BRIDGE] Same small-gap bridging as the burn, so a 0.2 s pause
  // between two cues does not blank the preview either. Declared out here:
  // the cap-contig check below reads it too.
  const dispCues = window.CaptionBox.bridgeCueGaps(state.cueWords || []) || [];
  const hookHides = captionsHiddenByHook((state.clips[state.activeClip] || {}).titles, t);
  if (dispCues.length && !hookHides && subsOn()) {   // [SUBS-TOGGLE]
    const i = dispCues.findIndex(w => t >= w.start && t < w.end);
    if (i >= 0) { activeCue = dispCues[i]; active = activeCue.text; activeIdx = i; }
  }
  setCueTextWithBox(els.captionTx, activeCue, t, state.cfg.subtitleStyle, activeIdx, state.cfg.subtitleBoxColor, state.cfg.subtitleFontSize);
  els.captionOv.style.visibility = (!(_dashKinCap = kineticCaptionTitle(activeCue, state.cfg, activeCue ? dispCues[activeIdx + 1] : null)) && active) ? 'visible' : 'hidden';
  tickDashTitles();   // [TITLE-PARITY] titles ride the same tick as captions
  tickStickerPreview();   // [EMOJI-STICKER] and so do stickers
  // Replay the pop/blur intro each time a new word-chunk appears.
  if (active && active !== _lastPreviewCue) {
    // [CUE-SOLID-IN] A cue that directly follows the last one enters solid.
    els.captionTx.classList.toggle('cap-contig', cuesJoin(dispCues[activeIdx - 1], activeCue));
    restartCaptionAnim(els.captionTx);
  }
  _lastPreviewCue = active;
  if (els.preview.duration) {
    // Clock shows the true video position — `t` above is shifted by
    // subtitleOffsetMs for cue lookup only, and reusing it here made the
    // displayed time (and its / duration ratio) lag behind the real playhead.
    const fmt = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
    els.transportTime.textContent = `${fmt(els.preview.currentTime || 0)} / ${fmt(els.preview.duration)}`;
  }
}

// ─── Rail nav ────────────────────────────────────────────
// Rail buttons update the side inspector panel. Crop opens the dedicated
// full-screen Crop Studio when a clip is selected.
// ─── Settings (full-screen, BYOK + cookies + export) ─────
// [PAID-TIER] One list drives prefill, badges, buttons and save — adding a
// provider here is all it takes; three loops used to be hardcoded to
// ['gemini','groq'] independently.
// Set a <select> to `val` even when `val` isn't a listed <option> (e.g. a
// SumoPod model saved before it was in the dropdown, or one the catalogue
// dropped). Assigning an unknown value silently blanks a <select>, which would
// erase the user's real choice on reopen — so inject a temporary option first.
function setSelectValue(sel, val) {
  if (!sel) return;
  const v = String(val == null ? '' : val);
  if (v && ![...sel.options].some(o => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v + ' (tersimpan)';
    sel.appendChild(opt);
  }
  sel.value = v;
}
const KEY_FIELDS = ['gemini', 'groq', 'openai', 'anthropic', 'openrouter', 'sumopod'];
const PROVIDER_LABELS = {
  gemini: 'Gemini', groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic',
  openrouter: 'OpenRouter', sumopod: 'SumoPod',
};
const PROVIDER_MODEL_IDS = {
  gemini: 'sv_geminiModel', groq: 'sv_groqModel', openai: 'sv_openaiModel',
  anthropic: 'sv_anthropicModel', openrouter: 'sv_openrouterModel', sumopod: 'sv_sumopodModel',
};
// [KEY-ROW-STATE] Three states, and the row must always tell the truth about
// which one it is in. The old version had two bugs that read as one:
//   • clicking Edit hid the SAVED chip and relabelled the button "Add", so the
//     UI announced the key was GONE — while it was still stored, and still used
//     by every run. Nothing had actually been deleted, and there was no way back
//     except closing the panel.
//   • with no key stored the button still said "Add" and did nothing but clear
//     an already-empty box.
//   • and no button anywhere could actually REMOVE a stored key: the save
//     handler only patches fields the user typed into, by design, so a blanked
//     box was indistinguishable from "leave it alone".
// 'saved' → chip + masked tail, readonly, [Ganti] [Hapus]
// 'edit'  → chip stays (it IS still stored), editable + focused, [Batal]
// 'empty' → no chip, editable, no buttons; typing into the box IS adding.
//
// Module scope, not per-open: the button handlers are wired exactly once
// (view.dataset.wired), so a per-call closure would leave them mutating the
// FIRST open's state set while later opens repaint from a different one.
const keyEditing = new Set();
function paintKeyState(which) {
  const $id = s => document.getElementById(s);
  const input = $id(`sv_${which}Key`);
  if (!input) return;
  const badge = $id(`sv_${which}Saved`);
  const btn   = $id(`sv_${which}Btn`);
  const del   = $id(`sv_${which}Del`);
  const test  = $id(`sv_${which}Test`);
  const stored = String((state.cfg || {})[`${which}Key`] || '').trim();
  const mode = keyEditing.has(which) ? 'edit' : (stored ? 'saved' : 'empty');
  if (badge) {
    badge.hidden = mode === 'empty';
    badge.textContent = mode === 'edit' ? 'TERSIMPAN' : `SAVED ····${stored.slice(-4)}`;
    badge.classList.toggle('sv-saved--editing', mode === 'edit');
  }
  if (btn) {
    btn.hidden = mode === 'empty';
    btn.textContent = mode === 'edit' ? 'Batal' : 'Ganti';
  }
  if (del) {
    del.hidden = mode !== 'saved';
    // The Settings markup is static and outlives a panel close, so a Hapus left
    // armed ("Yakin?") would still be armed on reopen. Repainting disarms it.
    del.textContent = 'Hapus';
    if (del.dataset) delete del.dataset.arm;
  }
  if (mode === 'saved') input.setAttribute('readonly', ''); else input.removeAttribute('readonly');
  if (test) test.disabled = mode === 'empty' && !input.value.trim();
  input.placeholder = mode === 'saved' ? '••••••••' + stored.slice(-4)
    // Short enough not to be clipped by the input width — verified in the
    // running app, where the longer wording cut off mid-word.
    : mode === 'edit' ? 'Tempel key baru — atau Batal'
    : 'Belum diisi';
  // The stored key is never echoed into the DOM; the masked tail is all that is
  // shown. Leaving the box empty in edit mode is what makes "typed nothing →
  // keep the old key" work in the save handler.
  input.value = '';
}

async function testKeyProvider(which, { quiet = false } = {}) {
  const input = document.getElementById(`sv_${which}Key`);
  const button = document.getElementById(`sv_${which}Test`);
  const message = document.getElementById(`sv_${which}TestMsg`);
  const modelEl = document.getElementById(PROVIDER_MODEL_IDS[which]);
  const label = PROVIDER_LABELS[which] || which;
  if (!input || !button) return { ok: false, provider: which, error: 'Kontrol tidak tersedia.' };
  const hasStored = !!String((state.cfg || {})[`${which}Key`] || '').trim();
  const typed = input.value.trim();
  if (!typed && !hasStored) {
    const result = { ok: false, provider: which, error: 'API key belum diisi.' };
    if (message) { message.textContent = result.error; message.className = 'sv-key-test err'; }
    return result;
  }

  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Tes…';
  if (message) { message.textContent = 'Menguji koneksi langsung…'; message.className = 'sv-key-test'; }
  if (!quiet) toast(`Menguji ${label} dengan request kecil…`);
  let result;
  try {
    result = await window.socl.testProvider({
      provider: which,
      key: typed,
      model: modelEl ? modelEl.value.trim() : '',
    });
  } catch (error) {
    result = { ok: false, provider: which, error: error?.message || 'Koneksi gagal.' };
  }
  const detail = result.ok
    ? `Tersambung · ${result.model || 'model aktif'} · ${result.latencyMs || 0} ms`
    : `Gagal · ${result.error || 'tidak diketahui'}`;
  if (message) { message.textContent = detail; message.className = `sv-key-test ${result.ok ? 'ok' : 'err'}`; }
  if (!quiet) toast(`${label}: ${detail}`, result.ok ? '' : 'err');
  button.textContent = previous;
  button.disabled = !typed && !hasStored;
  return result;
}

// [ENGINES] Populate + wire the "Mesin Unduh & Render" card. Self-contained so
// openSettings() can call it every open without re-reading its internals.
function wireEnginesPanel() {
  const $id = s => document.getElementById(s);
  if (!window.socl || !window.socl.engines || !$id('sv_enginesList')) return;

  // [ENGINE-PROG-DUPE-FIX] `d.message` from bootstrap.js already has the
  // percentage baked in ("Downloading deno… 24%") — this used to ALSO append
  // `${pct}` as a separate suffix, so the row read "Downloading deno… 24%
  // 24%". Strip any trailing "NN%" the message already carries and drive a
  // real progress-bar fill from `d.pct` instead of repeating the number as
  // more text — one clear percentage, one moving line, not two overlapping
  // sources of the same number.
  const setProg = (id, msg, pct) => {
    const row = document.querySelector(`[data-prog="${id}"]`);
    if (!row) return;
    const fill = row.querySelector('.sv-engine-bar-fill');
    const label = row.querySelector('.sv-engine-prog-label');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, Math.round((pct || 0) * 100)))}%`;
    if (label) label.textContent = String(msg || '').replace(/\s*\d+%\s*$/, '').trim();
  };
  // Wire the live progress stream ONCE — openSettings re-runs on every open.
  if (!window.__enginesProgWired) {
    window.__enginesProgWired = true;
    window.socl.engines.onProgress((d) => {
      if (!d) return;
      setProg(d.id, d.message || 'Memproses…', d.pct);
    });
  }

  const render = (data) => {
    const list = $id('sv_enginesList');
    if (!list) return;
    const rows = (data && data.rows) || [];
    if (!rows.length) { list.innerHTML = '<div class="sv-hint">Tidak bisa membaca status alat.</div>'; return; }
    list.innerHTML = rows.map((r) => {
      const ver = !r.installed
        ? '<span class="sv-badge err">belum terpasang</span>'
        : r.updateAvailable
          ? `<span class="sv-badge warn">v${esc(r.installed)}<span class="sv-ver-arrow">→</span>v${esc(r.latest)}</span>`
          : `<span class="sv-badge ok">v${esc(r.installed)}</span>`;
      const btnCls = r.updateAvailable ? 'primary-btn' : 'ghost-btn';
      const btnTxt = r.updateAvailable ? 'Perbarui' : (r.present ? 'Pasang ulang' : 'Pasang');
      return `<div class="sv-engine">
        <div class="sv-engine-top"><span class="sv-engine-name">${esc(r.name)}</span>${ver}</div>
        <div class="sv-engine-prog" data-prog="${esc(r.id)}">
          <div class="sv-engine-bar"><div class="sv-engine-bar-fill"></div></div>
          <div class="sv-engine-prog-label"></div>
        </div>
        <button type="button" class="${btnCls}" data-update="${esc(r.id)}">${btnTxt}</button>
      </div>`;
    }).join('') + (data.online ? '' : '<div class="sv-engines-note">⚠ Cek versi terbaru gagal (offline?). Tombol Perbarui tetap bisa dipakai untuk unduh ulang.</div>');
    // Wire per-row update buttons (fresh nodes each render → .onclick is safe).
    list.querySelectorAll('[data-update]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-update');
        btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Mengunduh…';
        setProg(id, 'Mulai…', 0);
        try {
          const res = await window.socl.engines.update(id);
          setProg(id, res && res.ok ? `Selesai${res.version ? ' — v' + res.version : ''}` : `Gagal: ${(res && res.error) || 'tidak diketahui'}`, res && res.ok ? 1 : 0);
        } catch (e) { setProg(id, `Gagal: ${e.message}`, 0); }
        btn.disabled = false; btn.textContent = prev;
        load();   // refresh versions/badges
      };
    });
  };

  const load = async () => {
    const list = $id('sv_enginesList');
    if (list && !list.querySelector('[data-update]')) list.innerHTML = '<div class="sv-hint">Memeriksa versi…</div>';
    try {
      const data = await window.socl.engines.status();
      render(data);
      return data;
    } catch {
      if (list) list.innerHTML = '<div class="sv-hint">Gagal memuat status alat.</div>';
      return null;
    }
  };

  const checkBtn = $id('sv_enginesCheck');
  if (checkBtn) checkBtn.onclick = async () => {
    const prev = checkBtn.textContent;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Mengecek…';
    toast('Memeriksa versi terpasang dan versi terbaru…');
    try {
      const data = await load();
      if (data && data.online) {
        toast('Cek versi selesai — data terbaru berhasil dimuat.');
      } else {
        toast('Versi lokal terbaca, tetapi server versi terbaru tidak dapat dihubungi.', 'err');
      }
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = prev;
    }
  };

  const fixBtn = $id('sv_fixYoutube');
  const fixMsg = $id('sv_fixYoutubeMsg');
  if (fixBtn) fixBtn.onclick = async () => {
    fixBtn.disabled = true; const prev = fixBtn.textContent; fixBtn.textContent = 'Memperbaiki…';
    if (fixMsg) fixMsg.textContent = 'Menyegarkan yt-dlp + Deno…';
    try {
      const res = await window.socl.engines.fixYoutube();
      const ok = res && res.ytdlp === true && res.deno === true;
      if (fixMsg) fixMsg.textContent = ok
        ? '✓ Selesai — coba unduh video lagi.'
        : `Sebagian gagal: yt-dlp=${res.ytdlp === true ? 'ok' : res.ytdlp}, deno=${res.deno === true ? 'ok' : res.deno}`;
    } catch (e) { if (fixMsg) fixMsg.textContent = `Gagal: ${e.message}`; }
    fixBtn.disabled = false; fixBtn.textContent = prev;
    load();
  };

  // Auto-check on open — "kalau konek internet, selalu periksa yang baru".
  load();
}

async function openSettings() {
  const $id = s => document.getElementById(s);
  const view = $id('settingsView');
  const c = state.cfg || {};
  // Prefill
  $id('sv_provider').value    = c.aiProvider || '';
  // Secrets are deliberately NOT prefilled — paintKeyState() below owns every
  // key row and shows only a masked tail, so the plaintext key never enters the
  // DOM at all. (The old prefill also missed sumopodKey, so that one row alone
  // never showed its SAVED state.)
  setSelectValue($id('sv_geminiModel'), c.geminiModel || 'gemini-flash-latest');
  setSelectValue($id('sv_groqModel'), c.groqModel || 'openai/gpt-oss-120b');
  // [PAID-TIER] paid credentials + free-form model names
  $id('sv_openaiModel').value     = c.openaiModel || 'gpt-4o-mini';
  $id('sv_anthropicModel').value  = c.anthropicModel || 'claude-haiku-4-5';
  $id('sv_openrouterModel').value = c.openrouterModel || 'openrouter/free';
  setSelectValue($id('sv_sumopodModel'), c.sumopodModel || 'deepseek-v4-pro');
  $id('sv_openrouterFallbacks').value = c.openrouterFallbacks || '';
  $id('sv_localAsr').value        = c.localAsr === false ? '0' : c.localAsr === true ? '1' : 'ask';
  $id('sv_whisperModelSize').value = c.whisperModelSize || 'small';
  const freeM = $id('sv_freeModel'); if (freeM) freeM.value = c.freeModel || '';

  // [ABOUT] The `app-info` IPC has always existed — it even walks the output
  // folder asynchronously specifically so opening this panel doesn't freeze —
  // but nothing in the renderer ever called it, so none of it was visible.
  // Fire-and-forget: About is reference material, and a failure here must not
  // take the rest of the Settings panel down with it.
  (async () => {
    try {
      const info = await window.socl.appInfo();
      const ver = $id('sv_appVer');
      if (ver) ver.textContent = `v${info.version}`;
      // [UPDATE-BETA-OPTIN] A beta install always sees betas — show the switch
      // as on and locked rather than letting it pretend to do something.
      const betaBox = $id('sv_updateBeta');
      if (betaBox && /-/.test(String(info.version || ''))) {
        betaBox.checked = true;
        betaBox.disabled = true;
        const hint = $id('sv_updateBetaHint');
        if (hint) hint.textContent = 'Kamu memakai versi beta — beta dan stable baru selalu ikut dicek.';
      }
      const box = $id('sv_aboutInfo');
      if (box) {
        const gb = (info.diskBytes || 0) / 1073741824;
        box.innerHTML =
          `Versi <b>${esc(info.version)}</b> · ${esc(info.runtime || "Tauri 2")}<br>` +
          `Output: <code>${esc(info.outputRoot)}</code><br>` +
          `Config: <code>${esc(info.cfgPath)}</code><br>` +
          `Sesi tersimpan: <b>${gb < 0.1 ? (info.diskBytes / 1048576).toFixed(0) + ' MB' : gb.toFixed(2) + ' GB'}</b>`;
      }
      // [DEVICE-SPEC] Requested feature: show the machine's own spec (OS,
      // CPU, RAM) so a user reporting a bug — or wondering why a heavy
      // feature like Smart Track is slow — can see it themselves instead
      // of us asking them to dig through System Information / About This Mac.
      const devBox = $id('sv_deviceInfo');
      if (devBox && info.device) {
        const d = info.device;
        const osName = d.platform === 'darwin' ? 'macOS'
          : d.platform === 'win32' ? 'Windows'
          : (d.platform || 'OS tidak diketahui');
        const ramGb = (d.totalRamBytes || 0) / 1073741824;
        devBox.innerHTML =
          `${esc(osName)} ${esc(d.osRelease || '')} · ${esc(d.arch || '')}<br>` +
          `CPU: ${esc(d.cpuModel || 'Tidak diketahui')} (${d.cpuCores || '?'} core)<br>` +
          `RAM: <b>${ramGb.toFixed(1)} GB</b>`;
      }
    } catch (e) {
      const box = $id('sv_aboutInfo');
      if (box) box.textContent = 'Info versi tidak tersedia.';
    }
  })();

  // [ENGINES] Download/render tools panel. openSettings() re-runs on every
  // open, so buttons use .onclick (overwrite-safe) and the progress listener
  // is wired ONCE via a module guard to avoid stacking duplicates.
  wireEnginesPanel();

  // [UPDATE-CHECK] openSettings() re-runs every time the panel opens, so this
  // button is re-wired via .onclick (overwrite-safe) instead of
  // addEventListener, which would stack a duplicate listener — and therefore
  // a duplicate network call — on every reopen.
  // [UPDATE-BETA-OPTIN] Saved the moment it changes — nothing else on this
  // card has a Save button. Re-wired via .onchange for the same reopen reason
  // as the button below. A beta install is locked on (see appInfo above).
  const updateBeta = $id('sv_updateBeta');
  if (updateBeta) {
    if (!updateBeta.disabled) updateBeta.checked = c.updateBetaChannel === true;
    updateBeta.onchange = () => { saveCfg({ updateBetaChannel: !!updateBeta.checked }); };
  }
  const updateBtn = $id('sv_checkUpdateBtn');
  const updateStatus = $id('sv_updateStatus');
  if (updateBtn) {
    updateBtn.onclick = async () => {
      updateBtn.disabled = true;
      const prevLabel = updateBtn.textContent;
      updateBtn.textContent = 'Mengecek…';
      if (updateStatus) updateStatus.textContent = '';
      try {
        const res = await window.socl.checkUpdate();
        if (!res.ok) {
          if (updateStatus) updateStatus.textContent = `Gagal cek update: ${res.error || 'tidak diketahui'}`;
        } else if (res.hasUpdate) {
          if (updateStatus) {
            updateStatus.innerHTML = `Versi ${res.isBeta ? 'beta ' : ''}baru tersedia: <b>v${esc(res.latest)}</b> →`;
            const dl = document.createElement('button');
            dl.type = 'button';
            dl.className = 'primary-btn';
            dl.style.marginLeft = '8px';
            dl.textContent = 'Buka halaman unduhan';
            dl.onclick = () => window.socl.openDownloadPage();
            updateStatus.appendChild(dl);
          }
        } else {
          if (updateStatus) updateStatus.textContent = `Sudah versi terbaru (v${esc(res.current)}).`;
        }
      } catch (e) {
        if (updateStatus) updateStatus.textContent = 'Gagal cek update: tidak ada koneksi.';
      } finally {
        updateBtn.disabled = false;
        updateBtn.textContent = prevLabel;
      }
    };
  }

  // ── SAVED / EDIT / EMPTY state per key row — see [KEY-ROW-STATE] ──
  // Reopening the panel always lands on the truthful resting state, never
  // half-way through an edit the user abandoned last time.
  keyEditing.clear();
  KEY_FIELDS.forEach(paintKeyState);

  const setCookieStatus = (name, sizeKB) => {
    const has = !!(name || c.cookiesPath);
    const el = $id('sv_cookieStatus');
    el.textContent = has ? `ACTIVE${sizeKB ? ' · '+sizeKB+' KB' : ''}` : 'STATUS EMPTY';
    el.classList.toggle('ok', has);
    $id('sv_cookieClear').hidden = !has;
    // Update drop-zone label
    if (has) {
      $id('sv_cookieDropTitle').innerHTML = `<b>${name || 'cookies.txt'}</b> — youtube.com`;
      $id('sv_cookieDropSub').textContent = 'Klik untuk ganti, atau drag & drop file baru';
    } else {
      $id('sv_cookieDropTitle').textContent = 'Drag & drop cookies.txt di sini, atau klik untuk browse';
      $id('sv_cookieDropSub').textContent = 'Export dari ekstensi "Get cookies.txt LOCALLY" (Chrome/Firefox)';
    }
  };
  setCookieStatus();
  const setExport = (p) => {
    // [EXPORT-PATH] The empty state used to read "~/Videos/SOCL/hooks/", a path
    // the app never writes to — it read like a working default and hid the fact
    // that nothing had been configured. Say what actually happens instead.
    $id('sv_exportPath').textContent = p || 'Folder sesi internal aplikasi (belum diatur)';
    $id('sv_exportStatus').textContent = p ? 'CUSTOM' : 'INTERNAL';
  };
  setExport(c.exportPath);
  // [EXPORT-PATH-BETA] Show the real internal default path so a user whose
  // custom (external-drive) export path fails can see exactly where their
  // clips actually landed instead of guessing.
  window.socl.appInfo().then((info) => {
    const el = $id('sv_exportInternalPath');
    if (el && info && info.outputRoot) el.textContent = info.outputRoot;
  }).catch(() => {});

  // [KEYCHAIN-WARN] A saved BYOK key that silently stops decrypting (OS
  // keychain locked/unavailable — a real risk on unsigned builds) looks
  // IDENTICAL to "the key does nothing": aiAvailable() goes false and the
  // pipeline quietly falls back to Free/local with no other signal. Surface
  // the capability check directly so the user isn't left guessing.
  //
  // The two notes are mutually exclusive and must never both show (or both
  // hide) — showing "dienkripsi di OS keychain" while ALSO warning it isn't
  // available reads as a flat contradiction, and the OLD warning text
  // additionally overstated the risk (claimed keys "TIDAK akan tersimpan
  // permanen" / won't persist at all) when main.js's writeCfg() actually
  // still saves them locally in plaintext settings.json as a fallback —
  // never lost, just not OS-encrypted. Toggle both from the same check so
  // exactly one, accurate message is visible at a time.
  (async () => {
    try {
      const ok = await window.socl.secretsAvailable();
      const okNote = $id('sv_keyStorageOk');
      const warn = $id('sv_keychainWarn');
      if (okNote) okNote.hidden = !ok;
      if (warn) warn.hidden = !!ok;
    } catch {}
  })();

  view.hidden = false;

  // [LIC-REFRESH] refreshLicense() must run on EVERY open, not just the
  // first — it's defined and invoked here, above the "wire once" guard
  // below, so a stale license status/button visibility from a prior
  // activate/deactivate elsewhere doesn't get frozen at whatever it was
  // when Settings was first opened this session.
  
  
  
  

  // Wire once per open via cloned listeners guard
  if (view.dataset.wired) return;
  view.dataset.wired = '1';

  $id('svClose').addEventListener('click', () => { view.hidden = true; setActiveRail(state.activePanel || 'clip'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !view.hidden) { view.hidden = true; } });

  // [KEY-ROW-STATE] Ganti ⇄ Batal is a reversible toggle over the SAME stored
  // key — neither direction touches what is saved, so a mis-click costs nothing.
  // Deleting is its own explicitly-labelled button.
  KEY_FIELDS.forEach(which => {
    const input = $id(`sv_${which}Key`);
    const test = $id(`sv_${which}Test`);
    if (input && test) {
      input.addEventListener('input', () => {
        const hasStored = !!String((state.cfg || {})[`${which}Key`] || '').trim();
        test.disabled = !input.value.trim() && !hasStored;
      });
      test.addEventListener('click', () => testKeyProvider(which));
    }
    const btn = $id(`sv_${which}Btn`);
    if (btn) btn.addEventListener('click', () => {
      if (keyEditing.has(which)) keyEditing.delete(which); else keyEditing.add(which);
      paintKeyState(which);
      if (keyEditing.has(which)) $id(`sv_${which}Key`).focus();
    });
    // Deleting a key is not undoable, so it takes two clicks — but via the
    // button's own label rather than window.confirm(), which nothing else in
    // this app uses and which blocks the renderer behind a native dialog.
    // Arming reverts on its own, so a stray click cannot leave a live
    // delete-on-next-click sitting in the panel.
    const del = $id(`sv_${which}Del`);
    if (del) del.addEventListener('click', async () => {
      const label = which.charAt(0).toUpperCase() + which.slice(1);
      if (del.dataset.arm !== '1') {
        del.dataset.arm = '1';
        del.textContent = 'Yakin?';
        del.title = `Klik lagi untuk menghapus key ${label}`;
        clearTimeout(+del.dataset.armT || 0);
        del.dataset.armT = String(setTimeout(() => {
          delete del.dataset.arm; del.textContent = 'Hapus'; del.title = '';
        }, 4000));
        return;
      }
      clearTimeout(+del.dataset.armT || 0);
      delete del.dataset.arm;
      del.textContent = 'Hapus';
      del.title = '';
      keyEditing.delete(which);
      // Empty string is what actually deletes it: main.js writeCfg → secrets.set
      // removes the field from secrets.bin rather than storing a blank.
      await saveCfg({ [`${which}Key`]: '' });
      paintKeyState(which);
      toast(`Key ${label} dihapus — run berikutnya pakai provider lain yang masih punya key, atau mode Free`);
    });
  });

  const testAll = $id('sv_testAllProviders');
  if (testAll) testAll.addEventListener('click', async () => {
    const summary = $id('sv_providerTestSummary');
    const candidates = KEY_FIELDS.filter(which => {
      const typed = $id(`sv_${which}Key`)?.value.trim();
      const stored = String((state.cfg || {})[`${which}Key`] || '').trim();
      return !!(typed || stored);
    });
    if (!candidates.length) {
      toast('Belum ada API key untuk dites.', 'err');
      return;
    }
    testAll.disabled = true;
    const previous = testAll.textContent;
    testAll.textContent = 'Menguji…';
    if (summary) { summary.hidden = false; summary.className = 'sv-provider-test-summary'; summary.textContent = `Menguji ${candidates.length} provider satu per satu…`; }
    const results = await Promise.all(candidates.map(which => testKeyProvider(which, { quiet: true })));
    const healthy = new Set(results.filter(r => r.ok).map(r => r.provider));
    const primary = $id('sv_provider')?.value || candidates[0];
    const openrouterModel = $id('sv_openrouterModel')?.value.trim() || '';
    const fallbackPriority = /(:free|^openrouter\/free)$/.test(openrouterModel)
      ? ['anthropic', 'openai', 'sumopod', 'groq', 'openrouter']
      : ['anthropic', 'openai', 'openrouter', 'sumopod', 'groq'];
    const fallbackOrder = fallbackPriority
      .filter(which => which !== primary && healthy.has(which));
    const states = results.map(r => `${r.ok ? '✓' : '×'} ${PROVIDER_LABELS[r.provider]}`).join(' · ');
    const fallbackText = fallbackOrder.length
      ? `Cadangan siap: ${fallbackOrder.map(p => PROVIDER_LABELS[p]).join(' → ')}.`
      : 'Belum ada provider cadangan lintas-provider yang sehat.';
    if (summary) {
      summary.textContent = `${states}. ${fallbackText}`;
      summary.className = `sv-provider-test-summary ${healthy.size ? 'ok' : ''}`;
    }
    toast(healthy.size ? `${healthy.size}/${results.length} provider tersambung. ${fallbackText}` : 'Semua tes provider gagal.', healthy.size ? '' : 'err');
    testAll.disabled = false;
    testAll.textContent = previous;
  });

  $id('sv_save').addEventListener('click', async () => {
    const patch = { aiProvider: $id('sv_provider').value };
    // Only patch keys when user actually typed a new value (preserve existing)
    const typed = {};
    KEY_FIELDS.forEach(which => {
      const v = $id(`sv_${which}Key`).value.trim();
      if (v) { typed[which] = v; patch[`${which}Key`] = v; }
    });
    patch.geminiModel = $id('sv_geminiModel').value;
    patch.groqModel = $id('sv_groqModel').value || 'openai/gpt-oss-120b';
    // Free-form model names — fall back to the default when left blank so an
    // empty box can never resolve to a nonexistent model id downstream.
    patch.openaiModel = $id('sv_openaiModel').value.trim() || 'gpt-4o-mini';
    patch.anthropicModel = $id('sv_anthropicModel').value.trim() || 'claude-haiku-4-5';
    patch.openrouterModel = $id('sv_openrouterModel').value.trim() || 'openrouter/free';
    patch.sumopodModel = $id('sv_sumopodModel').value.trim() || 'deepseek-v4-pro';
    patch.openrouterFallbacks = $id('sv_openrouterFallbacks').value.trim();
    // 'ask' is stored as the string so the pipeline can tell "not decided yet"
    // apart from an explicit yes/no — a boolean cannot carry three states.
    const asr = $id('sv_localAsr').value;
    patch.localAsr = asr === '1' ? true : asr === '0' ? false : 'ask';
    patch.whisperModelSize = $id('sv_whisperModelSize').value;
    if ($id('sv_freeModel')) patch.freeModel = $id('sv_freeModel').value;
    await saveCfg(patch);
    // Refresh saved badges & lock inputs. An edit the user opened but typed
    // nothing into is simply closed — the stored key stays, which is what the
    // "Batal untuk tetap pakai yang lama" placeholder promises.
    Object.entries(typed).forEach(([which, v]) => { state.cfg[`${which}Key`] = v; });
    keyEditing.clear();
    KEY_FIELDS.forEach(paintKeyState);
    const msg = $id('sv_saveMsg');
    msg.textContent = '✓ Tersimpan';
    setTimeout(() => { msg.textContent = ''; }, 2500);
    toast('Settings saved');
  });

  $id('sv_browseExport').addEventListener('click', async () => {
    // [EXPORT-PATH] pick-folder now returns { path } or { error } (it write-probes
    // the folder) — a folder we can't write to must be rejected HERE, loudly,
    // instead of being saved and then silently skipped at render time.
    const r = await window.socl.pickFolder();
    if (!r) return;                                  // cancelled
    if (r.error) { toast(r.error, 'err'); return; }
    const p = typeof r === 'string' ? r : r.path;     // tolerate the old shape
    if (!p) return;
    await saveCfg({ exportPath: p });
    setExport(p);
    toast('✓ Folder output diatur — semua clip & hasil edit disalin ke sini');
  });
  $id('sv_clearExport').addEventListener('click', async () => {
    await saveCfg({ exportPath: '' }); setExport(''); toast('Export path reset');
  });

  // Cookies: click-to-browse + drag&drop
  const drop = $id('sv_cookieDrop');
  const importCookies = async (filePath) => {
    const r = await window.socl.setCookies(filePath ? { filePath } : {});
    if (r && r.ok) {
      state.cfg.cookiesPath = r.path;
      setCookieStatus(r.name || 'cookies.txt');
      // [COOKIES-VALIDATE] Sebutkan APA yang tersimpan. "Cookies saved" tanpa
      // syarat dulu muncul bahkan untuk berkas yang pasti gagal saat Fetch —
      // user tidak punya cara tahu bedanya sampai render berhenti.
      const n = r.cookieRows || 0;
      const fixes = [];
      if ((r.fixed || []).includes('bom')) fixes.push('BOM dibuang');
      if ((r.fixed || []).includes('header')) fixes.push('baris header dipasang');
      let msg = `Cookies tersimpan — ${n} cookie`;
      if (r.skippedRows) msg += `, ${r.skippedRows} baris dilewati`;
      if (fixes.length) msg += ` (${fixes.join(', ')})`;
      toast(msg);
    }
    else if (r && r.error) toast('Cookies: ' + r.error, 'err');
  };
  drop.addEventListener('click', () => importCookies());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    // [DROP-PATH] f.path is undefined since Electron 32, so the drop used to do
    // nothing at all — no import, no message.
    const p = f ? (window.socl.pathForFile?.(f) || f.path || '') : '';
    if (p) importCookies(p);
    else toast('Cookies: file tidak terbaca — klik kotak ini untuk memilih file', 'err');
  });
  $id('sv_cookieClear').addEventListener('click', async () => {
    await window.socl.setCookies({ clear: true });
    state.cfg.cookiesPath = ''; setCookieStatus(''); toast('Cookies removed');
  });

  // ── License card wiring ────────────────────────────────
  // Reference format: title "Aktif — Lifetime" · badge "◆ LIC-8A2F" ·
  // one-line info "Terdaftar untuk email · Machine MAC-…"
  // (refreshLicense() itself is defined above, before the wire-once guard,
  // so it runs on every open — only the click listeners below are one-time.)
  // [LIC-BTN] Was only ever shown/hidden by refreshLicense() — no click
  // handler was ever attached, so the trial user's primary CTA ("Aktifkan
  // license") was inert.
  
  
}

els.rail.forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.panel;
  if (p === 'crop') {
    setActiveRail('crop');
    state.activePanel = 'crop';
    renderCropPanel();
    return;
  }
  if (p === 'settings') { setActiveRail('settings'); openSettings(); return; }
  renderPanel(p);
}));
els.openOutput.addEventListener('click', () => window.socl.openOutput(null));
document.getElementById('outputPill')?.addEventListener('click', (e) => {
  window.socl.openOutput(currentSessionDir());
  if (e.detail > 0) e.currentTarget.blur();   // no focus ring when F / Esc follows a click
});
// [SV-JUMP] / [SV-BAR] / [SV-SPY] Header chips. A click glides to the card, flashes it,
// and HOLDS its chip until the glide ends — otherwise the spy below lights
// every section the smooth scroll passes, and for two cards sharing a grid
// row (Cookies | License, same top) it would light the wrong one.
(() => {
  const view = document.getElementById('settingsView');
  const bar = view?.querySelector('.sv-head');
  const chips = Array.from(document.querySelectorAll('.sv-jump button'));
  if (!view || !bar || !chips.length) return;
  let lock = null, unlockT = 0, queued = false;
  const setActive = (chip) => chips.forEach(c => c.classList.toggle('is-active', c === chip));
  // The section under the bar: the card whose top sits closest above the
  // bar's bottom edge. Strict `>` so, of two cards in one row, the first keeps
  // the chip. At the very bottom the last cards can never reach the bar, so
  // there the last card on screen wins.
  const spy = () => {
    queued = false;
    if (lock) return;
    const edge = bar.getBoundingClientRect().bottom + 40;
    const viewBottom = view.getBoundingClientRect().bottom;
    const atEnd = view.scrollTop + view.clientHeight >= view.scrollHeight - 2;
    let current = chips[0], bestTop = -Infinity;
    for (const chip of chips) {
      const card = document.getElementById(chip.dataset.target);
      if (!card) continue;
      const top = card.getBoundingClientRect().top;
      if (atEnd ? top < viewBottom : top <= edge) {
        if (atEnd || top > bestTop) { bestTop = top; current = chip; }
      }
    }
    setActive(current);
  };
  chips.forEach(b => b.addEventListener('click', (e) => {
    const card = document.getElementById(b.dataset.target);
    if (!card) return;
    lock = b; setActive(b);
    // scrollend never fires when the card is already in place.
    clearTimeout(unlockT); unlockT = setTimeout(() => { lock = null; }, 1200);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.remove('sv-flash'); void card.offsetWidth; card.classList.add('sv-flash');
    if (e.detail > 0) b.blur();
  }));
  view.addEventListener('scrollend', () => { lock = null; clearTimeout(unlockT); });
  view.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
  new MutationObserver(() => { if (!view.hidden) { lock = null; requestAnimationFrame(spy); } })
    .observe(view, { attributes: true, attributeFilter: ['hidden'] });
})();

// Editor rail icon → open the full caption editor for the active clip.
document.getElementById('openEditorBtn')?.addEventListener('click', () => {
  const idx = state.activeClip;
  const clip = idx >= 0 ? state.clips[idx] : null;
  if (!clip || (!clip.file && !clip.srcVideo)) { toast('Pilih klip yang sudah dirender dulu.', 'err'); return; }
  // No autoplay: the editor opens right after and has its own video; a pending
  // play() would resolve post-pause and leave audio running behind the overlay.
  loadPreview(idx, { autoplay: false });
  openCaptionEditor(idx);
});

// ─── Draggable splitter (preview ↔ detected clips) ───────
// Reworked for stability across window resize / macOS zoom / minimize:
//  * Listens on WINDOW (not just handle) while dragging → no stall when
//    pointer strays off the 14px strip.
//  * Uses lower/upper minima from the actual gallery+lower-area heights so
//    the preview can never eat the batch-bar or pipeline strip.
//  * On window resize (maximize / restore / OS zoom), the fixed px --hero-h
//    is re-clamped; if it becomes impossible to satisfy, it's cleared so the
//    default fr ratio takes over — fixes the "stuck in the middle" bug where
//    a stale px value from a smaller window survived a maximize.
(function initSplitter() {
  const handle = document.getElementById('splitHandle');
  const ws = document.querySelector('.workspace');
  if (!handle || !ws) return;

  // Match the CSS grid minima so the clamp never pushes the split-handle
  // off-screen (was 240 → smaller than the grid's minmax(300px, ...) which
  // caused overflow:hidden to swallow the handle when hero grew too tall).
  const HERO_MIN = 280;    // preview never shorter than this
  const LOWER_MIN = 320;   // gallery-head + one tile row + batch + pipe strip

  function clampHeroPx(px) {
    const rect = ws.getBoundingClientRect();
    // Rough budget: workspace minus topbar (~54) minus split-handle (14) minus lower-min.
    const topbarH = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 54;
    const budget = rect.height - topbarH - 14 - LOWER_MIN;
    const upper = Math.max(HERO_MIN, budget);
    return Math.max(HERO_MIN, Math.min(upper, px));
  }

  // [GTL-ZOOM] The gallery header's − / + magnifier buttons carry data-zoom
  // but NOTHING ever read that attribute — no handler, no zoom state anywhere
  // in the app. They have been decorative since they were added. Tile height
  // follows the gallery row, so zoom is the same axis the split-handle already
  // drives: zoom in → give the preview less height, tiles grow. Reuses
  // clampHeroPx so it obeys the identical minima the drag does.
  const ZOOM_STEP = 60;
  document.querySelectorAll('.gtl-tool[data-zoom]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = parseInt(btn.dataset.zoom, 10) || 0;   // +1 = bigger tiles
      const cur = parseFloat(ws.style.getPropertyValue('--hero-h'))
               || ((document.querySelector('.hero-grid')?.getBoundingClientRect().height) ?? HERO_MIN);
      const next = clampHeroPx(cur - dir * ZOOM_STEP);
      ws.style.setProperty('--hero-h', next + 'px');
      // At the clamp the row can't change — say so instead of looking broken.
      if (Math.abs(next - cur) < 1) toast(dir > 0 ? 'Sudah paling besar' : 'Sudah paling kecil');
      try { applyStageAspect(state.cfg?.format); applyCaptionStyle(); } catch {}
    });
  });

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const heroTop = document.querySelector('.hero-grid')?.getBoundingClientRect().top
                 ?? ws.getBoundingClientRect().top;
    ws.style.setProperty('--hero-h', clampHeroPx(e.clientY - heroTop) + 'px');
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add('resizing');
    // Move listeners on the window so drag survives pointer leaving the strip.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  // Double-click handle → reset to default fr ratio (escape hatch if user
  // dragged too far and can't grab the handle anymore).
  handle.addEventListener('dblclick', () => {
    ws.style.removeProperty('--hero-h');
    document.body.classList.remove('tray-max');
    toast?.('Split reset');
  });

  // Wire the fullscreen icon in the gallery header → toggle tray-max mode
  // (tray takes ~65vh, preview shrinks to min). Clicking again restores.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.gtl-tool[title="Fullscreen"]');
    if (!btn) return;
    const on = !document.body.classList.contains('tray-max');
    document.body.classList.toggle('tray-max', on);
    if (on) ws.style.setProperty('--hero-h', HERO_MIN + 'px');
    else ws.style.removeProperty('--hero-h');
  });

  // On window resize (maximize, minimize+restore, macOS zoom, OS DPI change):
  // re-clamp the stored px value; if the new viewport can't satisfy the min
  // budget for both rows, drop the override so the default 2.5fr grid resumes.
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const cur = ws.style.getPropertyValue('--hero-h').trim();
      if (!cur.endsWith('px')) return;
      const px = parseFloat(cur);
      if (!Number.isFinite(px)) { ws.style.removeProperty('--hero-h'); return; }
      const rect = ws.getBoundingClientRect();
      const topbarH = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 54;
      const budget = rect.height - topbarH - 14 - LOWER_MIN;
      // If budget < HERO_MIN the window is too small for a custom split — reset.
      if (budget < HERO_MIN) { ws.style.removeProperty('--hero-h'); return; }
      const clamped = clampHeroPx(px);
      if (Math.abs(clamped - px) > 1) ws.style.setProperty('--hero-h', clamped + 'px');
    }, 60);
  });
})();

// Log toggle: collapses the whole pipeline strip (steps + progress + raw log)
// down to just the header row. Header still shows spinner + step name + %,
// which is enough at-a-glance status without eating half the screen.
// Fold toggle: expands/collapses the step cards + raw log panel under the
// status bar row. Collapsed by default; raw log stays hidden even when the
// fold opens, until the user's next click reveals it too — same two-stage
// behavior the old .pipe-strip.is-min had, just renamed.
document.getElementById('logToggle').addEventListener('click', () => {
  const fold = document.getElementById('sbarFold');
  const log = document.getElementById('log');
  const btn = document.getElementById('logToggle');
  StatusDisclosure.toggleLog({ fold, log, button: btn });
});
document.getElementById('reviewAllBtn').addEventListener('click', openClipReview);
// ─── Select mode ────────────────────────────────────────
function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selection.clear();
  document.getElementById('selectModeBtn')?.classList.toggle('active', on);
  document.getElementById('sbarSelectAct').hidden = !on;
  document.getElementById('statusBar').classList.toggle('is-selecting', on);
  renderGallery();
  syncSelectUI();
}
function syncSelectUI() {
  const n = state.selection.size();
  const countEl = document.getElementById('selCount');
  const renderBtn = document.getElementById('selRenderBtn');
  if (countEl) countEl.textContent = n;
  if (renderBtn) {
    renderBtn.disabled = n === 0;
    renderBtn.textContent = n ? `Render terpilih (${n})` : 'Render terpilih';
  }
}
document.getElementById('selectModeBtn')?.addEventListener('click', () => setSelectMode(!state.selectMode));
document.getElementById('selDoneBtn')?.addEventListener('click', () => setSelectMode(false));
document.getElementById('selAllBtn')?.addEventListener('click', () => {
  // Only clips passing the active gallery filter chip (All/Hot/Rendered) —
  // matches what's actually visible in the strip right now.
  const visible = state.clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => state.filter === 'hot' ? isHot(c) : state.filter === 'saved' ? !!c.file : true)
    .map(({ i }) => i);
  state.selection.selectAll(visible);
  renderGallery(); syncSelectUI();
});
document.getElementById('selClearBtn')?.addEventListener('click', () => {
  state.selection.clear();
  renderGallery(); syncSelectUI();
});
document.getElementById('selRenderBtn')?.addEventListener('click', () => {
  const idx = state.selection.list();
  if (!idx.length) return;
  batchRenderClips(idx);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selectMode) setSelectMode(false);
});
document.getElementById('pipeCancel')?.addEventListener('click', () => {
  const btn = document.getElementById('pipeCancel');
  // [SBAR-CANCEL-FEEDBACK] This button delegates to the topbar Run/Cancel
  // toggle (els.runBtn), which is what actually shows "Cancelling…" and
  // disables itself — but els.runBtn lives in a different part of the page
  // and this button never changed its own look. First click genuinely
  // cancels the run every time; it just LOOKS like nothing happened, so
  // users clicked again — and that second click silently did nothing,
  // because els.runBtn was already disabled by the first click (a disabled
  // button does not fire .click() listeners). Reported as "kadang bisa
  // kadang tidak"; it always worked, the button just never said so.
  // [CANCEL-SILENT-GUARD] This guard used to be a bare `return`. That made it
  // the ONLY path through this handler with no reaction whatsoever — every
  // other branch either flips the label to "Cancelling…" or toasts. Combined
  // with `.sbar-btn.danger` having had no `:disabled` style (a disabled Cancel
  // rendered identically to a live one), a stuck-disabled button was
  // indistinguishable from a dead one: reported as "Cancel masih belum bisa",
  // with no toast and no label change to go on. Say why nothing happens.
  if (btn?.disabled) {
    toast('Pembatalan sedang diproses — tunggu klip yang sedang jalan selesai.');
    return;
  }
  // [BATCH-CANCEL] The status bar (percent, step name, this Cancel button) is
  // SHARED between an actual pipeline run and a gallery batch render — they
  // are two different underlying operations with two different lifecycles,
  // and this handler used to know about only one of them. It checked
  // `state.running` (pipeline-only) and did NOTHING otherwise — not even a
  // toast — so clicking Cancel during "Render all" was a silent no-op: no
  // error, no log line, no visible reaction at all. That is the exact bug
  // report ("Cancel tidak bisa dipencet, toastnya tidak bekerja"). It always
  // "worked" in the sense of not crashing; it just had nothing to do, and
  // said nothing about that.
  if (batchCancelRequest) {
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    batchCancelRequest();
    return;
  }
  if (state.running) {
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    els.runBtn.click();
    return;
  }
  // Neither a pipeline nor a batch owns the bar right now (stale visibility
  // from a previous run) — say so instead of doing nothing silently.
  toast('Tidak ada proses yang sedang berjalan untuk dibatalkan.', 'err');
});
document.getElementById('gb_dismiss')?.addEventListener('click', () => {
  // [GALLERY-RENDER] Dismisses the "N edit di Caption Editor" nag only. It used
  // to hide the whole zone, which took Hot / Render all with it for the rest of
  // the session.
  state.batchBarDismissed = true;
  renderGallery();
});

// Batch re-render bar under gallery. Re-renders selected clips using the
// styling last saved in the Caption Editor. This replaces the old Caption
// side panel's batch buttons (removed with the Style panel).
document.getElementById('gb_renderAll')?.addEventListener('click', () => {
  if (!state.clips.length) return;
  batchRenderClips(state.clips.map((_, i) => i));
});
document.getElementById('gb_renderHot')?.addEventListener('click', () => {
  const hotIdx = state.clips.map((c, i) => ({ c, i })).filter(({ c }) => isHot(c)).map(({ i }) => i);
  if (!hotIdx.length) { toast('No hot clips. Tap 🔥 on a clip to mark it hot.', 'err'); return; }
  batchRenderClips(hotIdx);
});

// ─── Chips ──────────────────────────────────────────────
els.chips.forEach(b => b.addEventListener('click', () => {
  els.chips.forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.filter = b.dataset.filter;
  renderGallery();
}));

// ─── Pipeline events ────────────────────────────────────
window.socl.onLog((d) => logLine(d.line, d.kind));
// Turn raw pipeline detail strings (yt-dlp/ffmpeg/ffprobe jargon) into short
// elegant Indonesian phrases so users never see tool names in the status line.
function prettyDetail(stepName, raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Strip any tool-name mentions defensively
  const cleaned = s
    .replace(/yt-?dlp/gi, '')
    .replace(/ffmpeg/gi, '')
    .replace(/ffprobe/gi, '')
    .trim();
  if (stepName === 'Fetch') {
    if (/loading local/i.test(cleaned)) return 'Membaca file lokal…';
    if (/checking dependencies/i.test(cleaned)) return 'Mengecek yt-dlp…';
    if (/probing video info/i.test(cleaned))    return 'Membaca info video…';
    if (/preparing download/i.test(cleaned))    return 'Menyiapkan unduhan…';
    if (/merging/i.test(cleaned))        return 'Menggabungkan audio + video…';
    const pct = cleaned.match(/(\d{1,3})\s*%/);
    if (pct) return `Mengunduh video · ${pct[1]}%`;
    if (/fetch/i.test(cleaned) || !cleaned) return 'Menyiapkan sumber…';
    return 'Menyiapkan sumber…';
  }
  if (stepName === 'Transcribe') {
    if (/metadata/i.test(cleaned))  return 'Membaca metadata video…';
    if (/thumbnail/i.test(cleaned)) return 'Menyiapkan thumbnail…';
    if (/transcrib|whisper/i.test(cleaned)) return 'Menyalin ucapan…';
    return cleaned || 'Memproses audio…';
  }
  if (stepName === 'Detect hooks') {
    if (/topic summary/i.test(cleaned)) return 'Meringkas topik episode…';
    if (/viral|highlight/i.test(cleaned)) return 'Mencari momen hook…';
    const m = cleaned.match(/(\d+)\s*kandidat/i);
    if (m) return `${m[1]} kandidat ditemukan`;
    return cleaned || 'Menganalisa transkrip…';
  }
  if (stepName === 'Titles') {
    const m = cleaned.match(/rewriting\s+(\d+)\s+titles?/i);
    if (m) return `Menulis ${m[1]} hook title…`;
    return cleaned || 'Menyusun judul…';
  }
  if (stepName === 'Render') {
    const cm = cleaned.match(/clip\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.+)$/i);
    if (cm) {
      const inner = cm[3];
      if (/analyzing faces?/i.test(inner)) return `Clip ${cm[1]}/${cm[2]} · deteksi wajah`;
      const ap = inner.match(/analyzing\s+(\d+)%/i);
      if (ap) return `Clip ${cm[1]}/${cm[2]} · deteksi wajah · ${ap[1]}%`;
      const p = inner.match(/(\d{1,3})\s*%/);
      if (p) return `Clip ${cm[1]}/${cm[2]} · render ${p[1]}%`;
      return `Clip ${cm[1]}/${cm[2]} · ${inner.slice(0, 30)}`;
    }
    return cleaned || 'Menyusun video…';
  }
  return cleaned;
}

window.socl.onProgress((d) => {
  // Map any legacy step name (Download/Analyze/…) → new user-facing index.
  const idx = STEP_MAP[d.step] ?? Math.max(0, PIPELINE_STEPS.findIndex(s => s[0] === d.step));
  const stepName = PIPELINE_STEPS[idx]?.[0];
  const detail = prettyDetail(stepName, d.detail);
  if (stepName) state.stepDetail[stepName] = detail;
  const pct = Math.min(100, d.percent || 0);
  // Feed the animated engine (it repaints the bar + per-step cards on its ticker).
  prog.feed(pct, idx);
  renderSteps(idx);
  // Short human-readable sub-status; tool names (yt-dlp/ffmpeg) already stripped
  // in prettyDetail above. Fall back to the step name when detail is empty.
  els.statusLine.textContent = detail || stepName || '';
});
window.socl.onSourcePreview((preview) => {
  Object.assign(state, LivePreviewState.setSourcePreview(state, preview));
  if (state.retainPreviousClips || state.clips[state.currentPreviewIdx]?.file) return;
  const label = preview?.phase === 'remote' ? 'Menyiapkan source YouTube…' : 'Menganalisis source…';
  showPosterPreview(preview, label);
});
window.socl.onClipsDetected((clips) => {
  Object.assign(state, LivePreviewState.setCandidates(state, clips));
  renderGallery();
  if (!state.retainPreviousClips && state.clips.length) loadPreview(0, { autoplay: false });
});
window.socl.onClipState((update) => {
  Object.assign(state, LivePreviewState.setCandidateState(state, update));
  renderGallery();
  if (state.currentPreviewIdx >= 0 && !state.clips[state.currentPreviewIdx]?.file && state.clips[state.currentPreviewIdx]?.candidateId === update?.candidateId) {
    loadPreview(state.currentPreviewIdx, { autoplay: false });
  }
});
window.socl.onClip((c) => {
  // Seed hot flag from AI score; user can toggle it afterward via the 🔥 button
  if (c.isHot === undefined) c.isHot = (c.score || 0) >= 8;
  // [SUBS-BURN] Trust whatever `subsBurned` the pipeline emitted. The pipeline
  // now runs a post-render burn pass when cfg.burnSubtitles is on and the clip
  // has cueWords (pipeline-inverse-v1.js — [PIPELINE-BURN]), so the raw file
  // in `c.file` may already contain baked captions. `subsBurned=true` from the
  // pipeline emit tells loadPreview to skip the JS caption overlay so we don't
  // draw a second (JS) caption pass on top of the baked one. If the emit
  // arrives without the flag (older pipeline / partial state), default to
  // false so the JS overlay renders — matching the pre-burn behavior. Never
  // infer this from the toggle alone (the old bug).
  if (c.subsBurned === undefined) c.subsBurned = false;
  // [AUTO-TITLE] Same trust-the-emit rule as subsBurned above: the pipeline now
  // burns an auto title and says so. Default false when the flag is absent
  // (older pipeline / partial state) so the live overlay still draws.
  if (c.titlesBurned === undefined) c.titlesBurned = false;
  // [WM-DOUBLE] The pipeline burns the PROJECT watermark (no per-clip
  // override exists at pipeline time — see [WM-V1] at the pipeline call
  // site) into every clip it delivers. Snapshot what was actually burned so
  // the dashboard can tell "unchanged since render" (suppress the live
  // overlay) from "settings edited since" (still show it).
  // [WM-DOUBLE] Fresh pipeline emits have no snapshot yet — compute from the
  // project watermark it just burned. A clip reopened from History arrives with
  // the PERSISTED snapshot (report.json) already set; keep it, or a project-wm
  // change since render would re-overlay the new watermark on top of the baked
  // one. resolveBurnedWmSnapshot handles both (undefined → compute, else keep),
  // mirroring the subsBurned/titlesBurned "only fill when undefined" rule above.
  c.watermarkBurnedSnapshot = wmMod.resolveBurnedWmSnapshot(c, state.cfg);
  Object.assign(state, LivePreviewState.completeClip(state, c));
  renderGallery();
  const completedIdx = state.clips.findIndex(clip => clip.candidateId === c.candidateId);
  try { syncCompletedClipPreview(completedIdx); }
  catch (error) { console.error('[preview-handoff] cannot load rendered clip', error); }
});
window.socl.onDone((report) => {
  Object.assign(state, LivePreviewState.finishRun(state, true));
  try {
    for (let i = 0; i < PIPELINE_STEPS.length; i++) state.stepPct[i] = 100;
    prog.set(100, PIPELINE_STEPS.length - 1);
    prog.stop();
    renderSteps(PIPELINE_STEPS.length - 1, 'done');
    if (els.progressFill) els.progressFill.style.width = '100%';
    if (els.pipePct) els.pipePct.textContent = '100%';
    const n = (report && Array.isArray(report.clips)) ? report.clips.length : (state.clips ? state.clips.length : 0);
    if (els.statusLine) els.statusLine.textContent = `Selesai — ${n} clip siap`;
    toast(`✓ ${n} clip ready`);
    renderGallery();
    syncCompletedClipPreview();
  } catch (err) {
    console.error('[onDone] error', err);
  } finally {
    state.running = false;
    if (els.runBtn) {
      els.runBtn.disabled = false;
      els.runBtn.textContent = 'Run pipeline';
      els.runBtn.dataset.mode = 'run';
    }
  }
});
window.socl.onError((e) => {
  Object.assign(state, LivePreviewState.finishRun(state, false));
  prog.stop();
  // [STEP-ATTRIBUTION] The failing step is whichever one was live, NOT step 0.
  // Hardcoding 0 labelled every failure "Error — Fetch" and lit the Fetch card
  // red: a render that died at clip 4 of 5 sent the user to debug downloading.
  renderSteps(prog.activeIdx >= 0 ? prog.activeIdx : 0, 'error');
  logLine(`✗ ${e.message}`, 'err');
  els.pipePct.textContent = '';
  els.statusLine.textContent = `Error: ${e.message}`;
  toast(e.message || 'Pipeline failed', 'err');
  state.running = false;
  els.runBtn.disabled = false;
  els.runBtn.textContent = 'Run pipeline';
  els.runBtn.dataset.mode = 'run';
});

// No-op stub — auto-processing strip removed in v3 (toggles moved into
// Clip Options panel). Retained so legacy call sites don't throw.
function refreshApStrip() { /* no-op */ }
// [OUTPUT-PILL] Topbar "Hasil render": says how many clips the folder holds.
function refreshOutputPill() {
  const el = document.getElementById('outputPillHint');
  if (!el) return;
  const n = (state.clips || []).filter(c => c && c.file).length;
  el.textContent = n ? `${n} klip · buka` : 'Buka folder';
}
// The session folder (socl-<timestamp>/) holding the current clips, derived
// from a clip's own path: <session>/<raw|hasil|edited|…>/NN-title.mp4.
// null before the first run — open-output then falls back to the output root.
function currentSessionDir() {
  const f = (state.clips || []).find(c => c && c.file)?.file || '';
  if (!f) return null;
  const sep = f.includes('\\') && !f.includes('/') ? '\\' : '/';
  const parts = f.split(/[\\/]/);
  parts.pop();                                     // file name
  if (['raw', 'hasil', 'edited', 'efek', 'subtitle', 'crop-biasa', 'crop-gaming', 'burn-edited', '_clean'].includes(parts[parts.length - 1])) parts.pop();
  return parts.join(sep) || null;
}
// ─── Pick file ─────────────────────────────────────────
els.pickBtn.addEventListener('click', async () => {
  const f = await window.socl.pickVideo();
  if (!f) return;
  state.selectedFile = f;
  els.urlInput.value = '';
  els.urlInput.placeholder = f.split(/[/\\]/).pop();
  document.getElementById('im_file').textContent = '🎬 ' + f.split(/[/\\]/).pop();
  els.importMeta.hidden = false;
  refreshOutputPill();
  toast(`Imported: ${f.split(/[/\\]/).pop()}`);
});
// Attach a transcript file (SRT/VTT/TXT) to the imported video.
document.getElementById('im_attach').addEventListener('click', async () => {
  if (state.noTranscript) return;
  const s = await window.socl.pickSubtitle();
  if (!s) return;
  state.subtitleFile = s;
  const el = document.getElementById('im_sub');
  el.textContent = '📄 ' + s.split(/[/\\]/).pop();
  el.hidden = false;
  document.getElementById('im_subClear').hidden = false;
});
document.getElementById('im_subClear').addEventListener('click', () => {
  state.subtitleFile = null;
  document.getElementById('im_sub').hidden = true;
  document.getElementById('im_subClear').hidden = true;
});
document.getElementById('im_noTrans').addEventListener('change', (e) => {
  state.noTranscript = e.target.checked;
  document.getElementById('im_attach').disabled = e.target.checked;
  if (e.target.checked) document.getElementById('im_subClear').click();
});
// Typing a URL switches back to URL mode → hide the import meta row.
els.urlInput.addEventListener('input', () => {
  if (els.urlInput.value.trim()) { state.selectedFile = null; els.importMeta.hidden = true; }
  refreshOutputPill();
});

// ─── Run pipeline ──────────────────────────────────────
els.runBtn.addEventListener('click', async () => {
  if (state.running) {
    if (els.runBtn.dataset.mode === 'cancel') {
      try { window.socl.cancel(); } catch {}
      els.runBtn.disabled = true;
      els.runBtn.textContent = 'Cancelling…';
    }
    return;
  }
  const url = els.urlInput.value.trim();
  const source = url || state.selectedFile;
  if (!source) { toast('Paste URL atau Import file dulu.', 'err'); return; }
  // [MANUAL-PREFLIGHT] Manual mode with no valid segment can only fail — and used
  // to fail only after fetching + transcribing the whole video (94 min in the
  // reported case). Stop here instead, with the reason on screen.
  if (state.cfg.clipMode === 'manual' && typeof state.msValidCount === 'function' && state.msValidCount() === 0) {
    toast('Mode Manual: isi minimal 1 segmen MULAI–SELESAI yang valid (mis. 12:30 → 13:15), atau ganti Mode Klip ke Auto.', 'err');
    document.getElementById('f_manualWrap')?.scrollIntoView({ block: 'center' });
    return;
  }
  if (url) await saveCfg({ lastUrl: url });

  state.running = true;
  Object.assign(state, LivePreviewState.beginRun(state));
  if (state.selectMode) setSelectMode(false);
  state.stepDetail = {};
  state.stepPct = {};
  prog.reset();
  els.pipePct.textContent = '';
  renderGallery();
  els.log.innerHTML = '';
  els.runBtn.disabled = false;
  els.runBtn.textContent = 'Cancel';
  els.runBtn.dataset.mode = 'cancel';
  // [SBAR-CANCEL-FEEDBACK] A prior run's cancel can leave pipeCancel disabled
  // with "Cancelling…" — reset it here so a fresh run always starts with a
  // clean, clickable Cancel button rather than one stuck from last time.
  const sbarCancel = document.getElementById('pipeCancel');
  if (sbarCancel) { sbarCancel.disabled = false; sbarCancel.textContent = 'Cancel'; }
  renderSteps(0);
  prog.feed(0, 0);
  els.progressFill.style.width = '0%';
  els.statusLine.textContent = '0% • Starting…';

  try {
    await window.socl.runPipeline({
      source,
      overrides: { ...state.cfg },
      subtitleFile: state.selectedFile ? state.subtitleFile : null,
      noTranscript: state.selectedFile ? state.noTranscript : false,
    });
  } catch (e) {
    // Error event already handled
  }
});

// ─── Overlay engine ─────────────────────────────────────
const overlay = {
  root:    document.getElementById('overlay'),
  body:    document.getElementById('overlayBody'),
  title:   document.getElementById('overlayTitle'),
  eyebrow: document.getElementById('overlayEyebrow'),
  close:   document.getElementById('overlayClose'),
};
// [OVERLAY-DISMISS] Modals that AWAIT a user decision (the tracker install
// prompt) resolve from its own Cancel/Install buttons. The three
// generic dismissal paths below used to just hide the overlay, leaving that
// promise pending forever — so pressing Esc on the Smart Face Tracking prompt
// left the toggle visibly ON while cfg.smartTrack stayed false, and the next
// run silently did no tracking. openOverlay() registers a dismiss callback;
// closing by ANY route now runs it exactly once.
let overlayOnDismiss = null;
function dismissOverlay() {
  if (overlay.root.hidden) return;
  overlay.root.hidden = true;
  const cb = overlayOnDismiss; overlayOnDismiss = null;
  if (cb) { try { cb(); } catch (e) { console.error('[overlay] dismiss handler', e); } }
}
overlay.close.addEventListener('click', dismissOverlay);
overlay.root.addEventListener('click', (e) => { if (e.target === overlay.root) dismissOverlay(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissOverlay(); });

// Single source of truth for "is the Caption Editor currently open" — used
// everywhere that used to read overlay.root.hidden as a proxy for this
// (resize loop, timeline teardown, keyboard hijack guard, pause-on-open,
// the #capEditor selector). Caption Studio is its own top-level panel now,
// separate from the generic #overlay modal other panels still use.
const captionStudio = {
  root:  document.getElementById('captionStudio'),
  body:  document.getElementById('captionStudioBody'),
  title: document.getElementById('csEditorTitle'),
  close: document.getElementById('csEditorClose'),
};
function isCaptionStudioOpen() { return !captionStudio.root.hidden; }
let rollbackCaptionDraft = null;
const persistCaptionSettings = patch => saveCfg(patch);
function closeCaptionStudio() {
  rollbackCaptionDraft?.();
  rollbackCaptionDraft = null;
  captionStudio.body.querySelectorAll('video, audio').forEach((media) => {
    MediaLifecycle.releaseMedia(media);
  });
  captionStudio.root.hidden = true;
  captionStudio.body.replaceChildren();
  restoreDashboardPreview();
}
captionStudio.close.addEventListener('click', closeCaptionStudio);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isCaptionStudioOpen()) closeCaptionStudio(); });

// [OVERLAY-DISMISS] `onDismiss` runs when the user closes the overlay by ✕,
// backdrop click or Esc — the routes that bypass a modal's own buttons.
function openOverlay(eyebrow, title, html, onDismiss = null) {
  overlay.eyebrow.textContent = eyebrow;
  overlay.title.textContent = title;
  overlay.body.innerHTML = html;
  overlayOnDismiss = onDismiss;
  overlay.root.hidden = false;
}

// First-time Smart Face Tracking install prompt.
// Shows a confirm dialog, streams download+extract progress, resolves true on
// success, false on user cancel / failure (caller reverts the toggle).
function promptInstallTracker() {
  return new Promise(async (resolve) => {
    const platform = await window.socl.tracker.platform();
    const version  = await window.socl.tracker.version();
    openOverlay('Smart Face Tracking', 'One-time setup', `
      <div style="max-width:520px;line-height:1.5">
        <p>Smart Face Tracking needs a portable Python runtime + AI models
        (~600&nbsp;MB, one-time download for <code>${esc(platform)}</code>, v${esc(version)}).</p>
        <p>Installed into your app data folder. You can remove it later via settings.</p>
        <div id="trk_progress" style="margin:16px 0;display:none">
          <div style="height:6px;background:#222;border-radius:3px;overflow:hidden">
            <div id="trk_bar" style="height:100%;width:0;background:#D2F96F;transition:width .2s"></div>
          </div>
          <div id="trk_status" style="margin-top:8px;font-size:12px;opacity:.7">Preparing…</div>
        </div>
        <div id="trk_actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button id="trk_cancel" class="ghost-btn">Cancel</button>
          <button id="trk_install" class="primary-btn">Install</button>
        </div>
      </div>
    `);
    // [OVERLAY-DISMISS] settle() is idempotent: whichever route fires first
    // (our buttons, or ✕ / backdrop / Esc via openOverlay's onDismiss) wins.
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; overlayOnDismiss = null; overlay.root.hidden = true; resolve(ok); };
    overlayOnDismiss = () => done(false);   // ✕ / backdrop / Esc == Cancel
    document.getElementById('trk_cancel').addEventListener('click', () => done(false));
    document.getElementById('trk_install').addEventListener('click', async () => {
      // [OVERLAY-DISMISS] Once the download is underway, ✕ / backdrop / Esc must
      // no longer count as Cancel: main has no way to abort ensure(), so
      // resolving false here reverted the toggle while the install carried on
      // and still toasted success — installed on disk, off in config.
      overlayOnDismiss = null;
      document.getElementById('trk_actions').style.display = 'none';
      document.getElementById('trk_progress').style.display = 'block';
      const bar = document.getElementById('trk_bar');
      const stat = document.getElementById('trk_status');
      const off = window.socl.tracker.onProgress((p) => {
        if (p.phase === 'download') {
          const pct = Math.round((p.percent || 0) * 100);
          bar.style.width = pct + '%';
          const mb = p.got ? (p.got / 1048576).toFixed(1) : '?';
          const tot = p.total ? (p.total / 1048576).toFixed(0) : '?';
          stat.textContent = `Downloading ${mb} / ${tot} MB (${pct}%)`;
        } else if (p.phase === 'extract') {
          bar.style.width = '100%';
          stat.textContent = 'Extracting…';
        } else if (p.phase === 'done') {
          stat.textContent = 'Installed.';
        }
      });
      const res = await window.socl.tracker.ensure();
      try { off && off(); } catch {}
      if (res.ok) {
        toast(res.fallback
          ? `⚠ Versi terbaru gagal dipasang — memakai Smart Face Tracking ${res.fallback.version} yang sudah ada (${res.fallback.error})`
          : '✓ Smart Face Tracking installed');
        done(true);
      } else {
        stat.textContent = 'Failed: ' + (res.error || 'unknown error');
        stat.style.color = '#ff5c7a';
        document.getElementById('trk_actions').style.display = 'flex';
        document.getElementById('trk_install').textContent = 'Retry';
      }
    });
  });
}

// ── Review all detected clips ──
// Viral hook category → label + accent color
const CATEGORY_META = {
  EDUCATIONAL:   { label: 'EDUCATIONAL',   short: 'EDU',   color: '#3da5ff' },
  INSPIRATIONAL: { label: 'INSPIRATIONAL', short: 'INSP',  color: '#2cd36b' },
  CONTROVERSIAL: { label: 'CONTROVERSIAL', short: 'CTRL',  color: '#ff5c7a' },
  STORYTELLING:  { label: 'STORYTELLING',  short: 'STORY', color: '#a06bff' },
  ENTERTAINING:  { label: 'ENTERTAINING',  short: 'FUN',   color: '#ffb13d' },
  RELATABLE:     { label: 'RELATABLE',     short: 'REAL',  color: '#27d4c4' },
};
const catMeta = c => CATEGORY_META[(c && c.category) || 'EDUCATIONAL'] || CATEGORY_META.EDUCATIONAL;
const esc = s => String(s || '').replace(/[<>&"']/g, m => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;' }[m]));

// [HOOK-REGEN] Best-effort full transcript text of a clip — feeds the AI
// regenerate call so new copy is grounded in THIS clip's words.
function clipReviewText(clip) {
  if (Array.isArray(clip.words) && clip.words.length)
    return clip.words.map(w => w.text || w.w || '').join(' ').replace(/\s+/g, ' ').trim();
  if (Array.isArray(clip.cueWords) && clip.cueWords.length)
    return clip.cueWords.map(c => c.text || '').join(' ').replace(/\s+/g, ' ').trim();
  return String(clip.hook || clip.title || '').trim();
}
// [LANG-HINT] The pipeline already detects the clip's real language — trust
// it (ASR-hinted, script/stopword-checked across many languages — see
// detectedLang/languageDisplayName in pipeline-inverse-v1.js) rather than
// re-guessing here from a 10-word English-only stopword list. Reported live:
// a Japanese/Spanish/etc. clip's "✨ Regenerate" defaulted to Indonesian
// because this heuristic only ever recognised "clearly English" vs
// "everything else". Falls back to the old heuristic only for clips with no
// `lang` field — e.g. loaded from a history/report.json saved before this
// fix existed.
function clipReviewLang(clip) {
  const txt = clipReviewText(clip);
  // [LANG-STALE] `clip.lang` is written once, when the pipeline first emits
  // the clip — unlike `txt` above, it is never refreshed if the user later
  // edits this clip's captions into a different language (manual edit,
  // attaching a different-language transcript to just this clip). Snapshot
  // the text `clip.lang` actually corresponds to the first time it's read;
  // if the live text has since diverged, the cached hint is stale and this
  // falls back to the heuristic instead of trusting it blindly.
  if (clip && typeof clip.lang === 'string' && clip.lang) {
    if (clip._langTextSnapshot === undefined) clip._langTextSnapshot = txt;
    if (clip._langTextSnapshot === txt) return clip.lang;
  }
  const lower = txt.toLowerCase();
  const enHits = (lower.match(/\b(the|and|of|to|is|you|that|with|this|are|was)\b/g) || []).length;
  return enHits >= 5 ? 'en' : 'id';
}

// [HOOK-EDIT] Judul & hook review: per-clip title / hook / description are
// EDITABLE inline (saved straight to the clip object), with an AI "Generate
// title" button (re-writes all three from the transcript). The headline is
// applied to the video as a title layer as it is typed (see below).
// [HOOK-REVIEW-V2] The clip's headline as an on-video title layer: at most
// one per clip, tagged src:'headline' so later edits find it. Older layers
// added by the retired "Ke video" button are matched by their text.
function headlineLayer(clip) {
  const ts = Array.isArray(clip?.titles) ? clip.titles : [];
  const text = String(clip?.title || '').trim();
  return ts.find(t => t.src === 'headline') || (text ? ts.find(t => String(t.text || '').trim() === text) : null) || null;
}
// Create, update or remove that layer. An empty headline leaves an existing
// layer alone: clearing the field to retype must not reset the position the
// user set in the editor.
function syncHeadlineTitle(idx, on) {
  const clip = state.clips[idx]; if (!clip) return;
  clip.titles = Array.isArray(clip.titles) ? clip.titles : [];
  const text = String(clip.title || '').trim();
  const layer = clip.titles.find(t => t.src === 'headline');
  if (!on) {
    if (!layer) return;
    clip.titles = clip.titles.filter(t => t !== layer);
    clip.editDirty = true;
  } else if (layer) {
    // [VIDEO-HOOK-EDIT] The on-video text has its own field ("Teks di video");
    // the long headline must not overwrite a short hook the user sees there.
    if (layer.src === 'headline' && layer.id === 'ttl_hook0') return;
    if (!text || layer.text === text) return;
    layer.text = text;
    // [HOOK-AUTOBURN] A preset/auto hook carries per-word `tokens`, and the
    // burn draws tokens over text. Re-shape them here: the dashboard painter
    // (the only other caller that would) is skipped while the clip's titles
    // are already burned, so the next re-render burned the OLD words.
    ensureTitleTokens(layer);
    clip.editDirty = true;
  } else {
    if (!text) return;
    const cd = Math.max(1, (clip.end - clip.start) || 5);
    // [TITLE-PARITY] The EXACT defaults the editor's "+ Add title" uses
    // (same centred position, size, style, anim, glow) — titleDefaultY/
    // TITLE_DEFAULT_X/TITLE_DEFAULT_DUR are shared so the two entry points
    // can't drift apart again.
    clip.titles.push({
      id: 'ttl_' + Math.random().toString(36).slice(2, 8), src: 'headline',
      text, start: 0, end: Math.min(cd, TITLE_DEFAULT_DUR),
      x: TITLE_DEFAULT_X, y: titleDefaultY(clip.titles.length), fs: 96, style: 'white_clean', anim: 'pop', glow: true,
    });
    clip.editDirty = true;   // surfaces the batch re-render bar
  }
  // Paint it in the dashboard preview right away, as the editor would.
  try { if (state.activeClip === idx) tickDashTitles(); } catch {}   // [DASH-TITLE]
}

function openClipReview() {
  if (!state.clips.length) {
    openOverlay('Judul & hook', 'Review', '<div class="empty">Belum ada clip terdeteksi. Run pipeline dulu.</div>');
    return;
  }
  // [HOOK-REVIEW-V2] Minimal cards. The headline is what goes on the video:
  // typing applies it (syncHeadlineTitle), the switch takes it off. Hook and
  // description are posting copy — nothing burns them, so they no longer
  // claim to be an overlay. The thumbnail opens the clip; the one button
  // opens the Caption Editor on its Titles tab, where the headline layer is.
  for (const c of state.clips) {
    // A title added by the old "Ke video" button carries no tag: adopt it, so
    // editing the headline moves that layer instead of stacking a second one.
    const legacy = headlineLayer(c);
    if (legacy && !legacy.src) legacy.src = 'headline';
  }
  const html = `<p class="hook-hint">Ketik judul — langsung tampil di video. Posisi, durasi &amp; gaya judul diatur di Caption Editor.</p>
  <div class="hook-grid">${state.clips.map((c, i) => {
    const dur = ((c.end - c.start) || 0).toFixed(0) + 's';
    const score = Math.round(c.score || 0);
    const m = catMeta(c);
    // Candidate JPGs keep this review grid lightweight. Opening a clip owns
    // the single long-lived preview decoder; cards never allocate decoders.
    const ar = FORMAT_AR[formatForAspect(c.cropAspect, state.cfg.format)] || '9/16';
    const media = c.thumbnail
      ? `<img class="hook-thumb" src="${toFileURL(c.thumbnail)}" alt="">`
      : `<div class="hook-thumb hook-thumb--empty"><span>#${i + 1}</span><small>thumbnail tidak tersedia</small></div>`;
    return `
      <div class="hook-card" data-idx="${i}">
        <button type="button" class="hook-media" data-act="preview" data-idx="${i}" style="aspect-ratio:${ar}" title="Buka di preview">${media}
          <span class="hook-media-idx">#${i + 1}</span>
          <span class="hook-media-dur">${dur}</span>
          <span class="hook-media-play" aria-hidden="true">▶</span>
        </button>
        <div class="hook-top">
          <span class="hook-cat" style="--cat:${m.color}">${esc(m.label)}</span>
          <span class="hook-score">★ ${score}</span>
        </div>
        <div class="hook-field">
          <div class="hook-lbl"><span>Judul</span>
            <label class="hook-onvid" title="Tampilkan judul ini di video"><span>di video</span>
              <span class="ap-switch"><input type="checkbox" class="hr-onvid" data-idx="${i}" ${headlineLayer(c) ? 'checked' : ''}><i></i></span>
            </label>
          </div>
          <textarea class="hr-field hr-title" data-idx="${i}" rows="2" placeholder="Judul viral…">${esc(c.title || '')}</textarea>
        </div>
        <div class="hook-field">
          <div class="hook-lbl"><span>Teks di video</span><small>hook 3,5 detik pertama · edit bebas</small></div>
          <textarea class="hr-field hr-vid" data-idx="${i}" rows="2" placeholder="Hook singkat di video…">${esc((headlineLayer(c) || {}).text || '')}</textarea>
        </div>
        <div class="hook-field">
          <div class="hook-lbl"><span>Hook</span><small>kalimat pembuka posting</small></div>
          <textarea class="hr-field hr-hook" data-idx="${i}" rows="2" placeholder="Teks hook singkat…">${esc(c.hook || '')}</textarea>
        </div>
        <div class="hook-field">
          <div class="hook-lbl"><span>Deskripsi</span><small>caption posting</small></div>
          <textarea class="hr-field hr-desc" data-idx="${i}" rows="2" placeholder="Teaser 1 kalimat…">${esc(c.why || '')}</textarea>
        </div>
        <div class="hook-actions">
          <button class="hook-btn regen" data-act="regen" data-idx="${i}" title="Minta AI membuat judul, hook &amp; deskripsi baru dari transkrip klip ini">↻ Generate title</button>
          <button class="hook-btn edit" data-act="edit" data-idx="${i}" title="Buka Caption Editor di tab Titles">Atur judul →</button>
        </div>
      </div>`;
  }).join('')}</div>
  <div class="hook-scroll" hidden>
    <button type="button" class="hook-nav prev" aria-label="Geser ke kiri">‹</button>
    <div class="hook-track" title="Klik untuk lompat"><i class="hook-thumbbar"></i></div>
    <button type="button" class="hook-nav next" aria-label="Geser ke kanan">›</button>
  </div>`;
  openOverlay('Judul & hook', `${state.clips.length} klip`, html);
  // [HOOK-ROW] A mouse wheel scrolls the row sideways — unless the overlay
  // itself overflows vertically on a short window, where the wheel must keep
  // scrolling down. Trackpad sideways swipes stay native.
  const hookRow = overlay.body.querySelector('.hook-grid');
  hookRow?.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (hookRow.scrollWidth <= hookRow.clientWidth) return;
    if (overlay.body.scrollHeight > overlay.body.clientHeight + 4) return;
    hookRow.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  // [HOOK-ROW] Scroll cue: the lit segment of the line is the part of the row
  // in view; the arrows page by most of a view; the edges fade where cards
  // are hidden. Hidden altogether when every card already fits.
  const cue = overlay.body.querySelector('.hook-scroll');
  const cueBar = cue?.querySelector('.hook-thumbbar');
  const paintCue = () => {
    if (!hookRow || !cue || !cueBar) return;
    const max = hookRow.scrollWidth - hookRow.clientWidth;
    cue.hidden = max <= 2;
    const x = hookRow.scrollLeft;
    hookRow.style.setProperty('--fade-l', x > 2 ? '56px' : '0px');
    hookRow.style.setProperty('--fade-r', x < max - 2 ? '56px' : '0px');
    const w = hookRow.clientWidth / hookRow.scrollWidth;
    cueBar.style.width = `${w * 100}%`;
    cueBar.style.left = `${max > 0 ? (x / max) * (1 - w) * 100 : 0}%`;
    cue.querySelector('.prev').disabled = x <= 2;
    cue.querySelector('.next').disabled = x >= max - 2;
  };
  if (hookRow && cue) {
    hookRow.addEventListener('scroll', () => requestAnimationFrame(paintCue), { passive: true });
    const page = (dir) => hookRow.scrollBy({ left: dir * hookRow.clientWidth * 0.85, behavior: 'smooth' });
    cue.querySelector('.prev').addEventListener('click', () => page(-1));
    cue.querySelector('.next').addEventListener('click', () => page(1));
    cue.querySelector('.hook-track').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      hookRow.scrollTo({ left: f * (hookRow.scrollWidth - hookRow.clientWidth), behavior: 'smooth' });
    });
    try { new ResizeObserver(paintCue).observe(hookRow); } catch {}
    requestAnimationFrame(paintCue);
  }

  // [META-PERSIST] Write edited metadata back to report.json. Until this
  // existed, saveField and the Regenerate button only ever mutated the
  // in-memory clip — `clip.metaEdited = true` was set at both call sites and
  // read NOWHERE, so History (which re-reads report.json) showed the original
  // title again after a restart, silently.
  //
  // Debounced because saveField fires on every keystroke: a title is edited a
  // character at a time and each one would otherwise rewrite the whole report.
  // Keyed per clip so editing clip 2 never cancels a pending save for clip 1.
  const metaSaveTimers = new Map();
  const persistClipMeta = (idx, { immediate = false } = {}) => {
    const clip = state.clips[idx];
    if (!clip || !clip.file) return;                 // not rendered yet → nothing to attach to
    const prev = metaSaveTimers.get(idx);
    if (prev) clearTimeout(prev);
    const run = async () => {
      metaSaveTimers.delete(idx);
      try {
        await window.socl.saveClipMeta({
          outputFile: clip.file,
          clipIndex: idx,
          title: clip.title || '',
          hook: clip.hook || '',
          why: clip.why || '',
        });
      } catch { /* best-effort: a failed metadata save must never block editing */ }
    };
    if (immediate) { run(); return; }
    metaSaveTimers.set(idx, setTimeout(run, 600));
  };

  const saveField = (idx, kind, val) => {
    const clip = state.clips[idx]; if (!clip) return;
    if (kind === 'title') clip.title = val;
    else if (kind === 'hook') clip.hook = val;
    else if (kind === 'desc') clip.why = val;
    clip.metaEdited = true;
    persistClipMeta(idx);
  };
  // [HOOK-UI] Grow the title/hook boxes to fit their text so a long headline is
  // fully readable at a glance — the whole point of enlarging them. Runs once
  // on open and on every keystroke.
  const autoGrow = (el) => {
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, 34) + 'px';
  };
  // [HOOK-REVIEW-V2] Typing a headline applies it to the video. The first edit
  // turns the switch on — unless it was switched off for this clip, which is
  // a deliberate "not on the video" that typing must not overrule.
  const applyHeadline = (idx) => {
    const clip = state.clips[idx]; if (!clip) return;
    const sw = overlay.body.querySelector(`.hr-onvid[data-idx="${idx}"]`);
    if (sw && !sw.checked && !clip._headlineOff) sw.checked = true;
    if (sw?.checked) syncHeadlineTitle(idx, true);
  };
  // [GEN-TITLE-NO-ONVID] ↻ Generate title is asking AI for copy, not putting a
  // title on the video: keep an on-video headline in step with the new text,
  // but never switch one on. applyHeadline above is for typing only.
  const refreshHeadline = (idx) => {
    const sw = overlay.body.querySelector(`.hr-onvid[data-idx="${idx}"]`);
    if (sw?.checked) syncHeadlineTitle(idx, true);
  };
  overlay.body.querySelectorAll('.hr-onvid').forEach(sw => sw.addEventListener('change', () => {
    const idx = +sw.dataset.idx;
    const clip = state.clips[idx]; if (!clip) return;
    clip._headlineOff = !sw.checked;
    syncHeadlineTitle(idx, sw.checked);
    toast(sw.checked ? '✓ Judul tampil di video' : 'Judul dilepas dari video', '');
  }));
  overlay.body.querySelectorAll('.hr-title').forEach(el => {
    autoGrow(el);
    el.addEventListener('input', () => { autoGrow(el); saveField(+el.dataset.idx, 'title', el.value); applyHeadline(+el.dataset.idx); });
    el.addEventListener('blur', () => { try { renderGallery(); } catch {} });
  });
  // [VIDEO-HOOK-EDIT] Edit the exact text drawn on the video. Creates the
  // layer when the clip has none; the next render burns the new words.
  overlay.body.querySelectorAll('.hr-vid').forEach(el => {
    autoGrow(el);
    el.addEventListener('input', () => {
      autoGrow(el);
      const idx = +el.dataset.idx;
      const clip = state.clips[idx]; if (!clip) return;
      const val = el.value.replace(/\s+/g, ' ').trim();
      let layer = headlineLayer(clip);
      if (!layer && val) {
        const keep = clip.title;
        clip.title = val; syncHeadlineTitle(idx, true); clip.title = keep;
        layer = (clip.titles || []).find(t => t.src === 'headline');
        const sw = overlay.body.querySelector(`.hr-onvid[data-idx="${idx}"]`);
        if (sw) sw.checked = true;
      }
      if (!layer || !val || layer.text === val) return;
      layer.text = val;
      ensureTitleTokens(layer);
      clip.editDirty = true;
      clip.metaEdited = true;
      persistClipMeta(idx);
      try { if (state.activeClip === idx) tickDashTitles(); } catch {}
    });
  });
  overlay.body.querySelectorAll('.hr-hook').forEach(el => {
    autoGrow(el);
    el.addEventListener('input', () => { autoGrow(el); saveField(+el.dataset.idx, 'hook', el.value); });
  });
  overlay.body.querySelectorAll('.hr-desc').forEach(el =>
    el.addEventListener('input', () => saveField(+el.dataset.idx, 'desc', el.value)));

  overlay.body.querySelectorAll('.hook-card [data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      const act = btn.dataset.act;
      const clip = state.clips[idx]; if (!clip) return;
      if (act === 'preview') { overlay.root.hidden = true; loadPreview(idx); return; }
      if (act === 'edit') {
        // Full caption editor, straight to the Titles tab: that is where the
        // headline layer lives, with its position, duration and style.
        overlay.root.hidden = true;
        loadPreview(idx, { autoplay: false });
        openCaptionEditor(idx);
        document.querySelector('#ce_tabs .cap-tab[data-tab="titles"]')?.click();
        return;
      }
      if (act === 'regen') {
        if (btn.disabled) return;
        const card = btn.closest('.hook-card');
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '✨ …';
        try {
          const res = await window.socl.regenHook({
            clipText: clipReviewText(clip),
            category: clip.category || '',
            lang: clipReviewLang(clip),
          });
          if (res?.error) { toast(res.error, 'err'); return; }
          if (res.title)       { clip.title = res.title;       const f = card.querySelector('.hr-title'); if (f) f.value = res.title; refreshHeadline(idx); }
          if (res.hook)        { clip.hook  = res.hook;        const f = card.querySelector('.hr-hook');  if (f) f.value = res.hook; }
          if (res.description) { clip.why   = res.description; const f = card.querySelector('.hr-desc');  if (f) f.value = res.description; }
          card.querySelectorAll('.hr-title, .hr-hook').forEach(autoGrow);
          clip.metaEdited = true;
          // [META-PERSIST] Save straight away — a regenerate is a deliberate,
          // one-shot action, not a keystroke, so there is nothing to debounce.
          persistClipMeta(idx, { immediate: true });
          toast((res.title || res.hook || res.description) ? '✓ Judul/hook/deskripsi diperbarui' : 'AI tidak mengubah apa-apa', '');
          try { renderGallery(); } catch {}
        } catch (err) {
          toast(err?.message || 'AI gagal', 'err');
        } finally {
          btn.disabled = false; btn.textContent = orig;
        }
      }
    });
  });
}

// ─── Caption font library (per-word styling) ─────────────
// value = exact family name libass burns by (matches @font-face in styles.css).
// '' = inherit the style's base font. See docs/specs per-word-caption-styling.
// Per-word / per-title animation choices. Value '' = inherit (use the parent
// cue's / title's anim). Keep in sync with pipeline-inverse-v1.js `effAnim`
// switch and the CSS `.anim-*` selectors in styles.css.
const CAPTION_ANIMS = [
  { label: 'Inherit',    value: '' },
  { label: 'None',       value: 'none' },
  { label: 'Fade',       value: 'fade' },
  { label: 'Pop',        value: 'pop' },
  { label: 'Rise',       value: 'rise' },
  { label: 'Drop',       value: 'drop' },
  { label: 'Zoom',       value: 'zoom' },
  { label: 'Blur',       value: 'blur' },
  { label: 'Type',       value: 'type' },
];
// Preview-side mapping: anim key → CSS `animation` shorthand. Used to override
// the cue-level anim class on a specific span (per-word animation). Keep the
// keyframe names, durations, and easings identical to `.anim-*` rules in
// styles.css so preview matches burn output.
// [ANIM-CSS-PARITY] Same values as the `.anim-*` class rules in styles.css,
// which [TITLE-ANIM-PARITY] pinned to the burn's ANIM_TIMING (pop/blur 200ms,
// fade 130ms, zoom 260ms, rise/drop 550ms). This table was left at the older
// 240/260/280ms, so a word with its own animation played slower in the
// preview than in the render. test/caption-anim-no-replay.test.js pins both.
const ANIM_CSS = {
  pop:  'capPop .20s cubic-bezier(.2,.8,.3,1) both',
  fade: 'capFade .26s ease-out both',
  rise: 'capRise .55s cubic-bezier(.16,1,.3,1) both',
  drop: 'capDrop .55s cubic-bezier(.16,1,.3,1) both',
  zoom: 'capZoom .26s cubic-bezier(.2,.8,.3,1) both',
  blur: 'capBlur .20s ease-out both',
  slam: 'capSlam .16s linear both',   // [HOOK-SLAM]
  // 'type' and 'none' are intentionally absent — 'type' has its own char-level
  // machinery; 'none' means no animation (unset any inherited animation).
};
// [CUE-SOLID-IN] Same timing, no opacity ramp — what a cue that directly
// follows another plays, in the preview as in the burn (applyCueContinuity in
// pipeline-inverse-v1.js). Fade has no motion, so it simply appears.
const ANIM_CSS_SOLID = {
  pop:  'capPopSolid .20s cubic-bezier(.2,.8,.3,1) both',
  fade: 'capFade .26s ease-out both',
  rise: 'capRiseSolid .55s cubic-bezier(.16,1,.3,1) both',
  drop: 'capDropSolid .55s cubic-bezier(.16,1,.3,1) both',
  zoom: 'capZoomSolid .26s cubic-bezier(.2,.8,.3,1) both',
  blur: 'capBlurSolid .20s ease-out both',
};
// Must equal CONTIGUOUS_CUE_GAP_SEC in pipeline-inverse-v1.js (test-pinned):
// two cues this close are one continuous caption, not a disappear/reappear.
const CONTIGUOUS_CUE_GAP_SEC = 0.05;
function cuesJoin(a, b) {
  return !!(a && b) && Number(b.start) - Number(a.end) <= CONTIGUOUS_CUE_GAP_SEC;
}
const CAPTION_FONTS = [
  { label: 'Default (style)',     value: '' },
  { label: 'Open Sauce Bold',     value: 'Open Sauce Two Bold' },
  { label: 'Open Sauce ExtraBold',value: 'Open Sauce Two ExtraBold' },
  { label: 'Times Condensed',     value: 'Times New Roman MT Condensed' },
  { label: 'Times Cond Italic',   value: 'Times New Roman MT Cond Italic' },
  { label: 'Times NR Cond Bold',  value: 'Times NR Condensed Bold' },
  // Value is the PostScript name — libass's Full-name matcher trips on
  // "Bold Condensed" so we key on the PS name (also aliased in styles.css).
  { label: 'Times MT Std Bold Cond', value: 'TimesNewRomanMTStd-BoldCond' },
  { label: 'Pinyon Script',       value: 'Pinyon Script' },
  { label: 'Anton',               value: 'Anton' },
  { label: 'Hanken Grotesk',      value: 'Hanken Grotesk' },
  // Poppins (2026-07-09) — VALUE = the font's real family/full name. The PS
  // names ('Poppins-Light'/'Poppins-Bold') looked right but libass silently
  // fell back to Helvetica for them (PS-name matching only works for the CFF
  // OTFs like Editor's Note, not these TTFs — verified via ffmpeg fontselect
  // logs). pipeline-inverse-v1 normalises the old saved values on burn.
  { label: 'Poppins Light',       value: 'Poppins Light' },
  { label: 'Poppins Bold',        value: 'Poppins Bold' },
  // Editor's Note (2026-07-05) — VALUE = each file's PostScript name.
  // libass's Full-name matcher fails on "Editor's Note X" (probably chokes
  // on the apostrophe in a multi-word key), but PS-name matching works
  // reliably. See /tmp/font-proof for the proof render evidence.
  // Trimmed to the three weights actually used (2026-07-09, user request):
  // Light / Regular / Bold. The other @font-face declarations stay in
  // styles.css so old projects that saved e.g. Semibold still render.
  { label: "Editor's Note Light",       value: "Editor'sNote-Light" },
  { label: "Editor's Note",             value: "Editor'sNote-Regular" },
  { label: "Editor's Note Bold",        value: "Editor'sNote-Bold" },
  // Apple Garamond — libass matches these via family+subfamily lookup on the
  // fonts' internal name table (unlike Editor's Note which matches by PS name).
  { label: 'Apple Garamond',            value: 'Apple Garamond' },
  { label: 'Apple Garamond Italic',     value: 'Apple Garamond Italic' },
  { label: 'Apple Garamond Bold',       value: 'Apple Garamond Bold' },
  // Arial Nova Cond + Cooper BT (2026-07-11) — VALUE = the name libass actually
  // resolves via fontsdir (probed with ffmpeg fontselect): Arial Nova matches
  // its subfamily "Arial Nova Cond"; the Cooper TTFs only match their internal
  // FAMILY names ("CooperBlkBT-Regular"…) — friendly names → Helvetica.
  { label: 'Arial Nova Condensed',      value: 'Arial Nova Cond' },
  { label: 'Arial Nova Light',          value: 'Arial Nova Light' },
  { label: 'Cooper Black',              value: 'CooperBlkBT-Regular' },
  { label: 'Cooper Medium',             value: 'CooperMdBT-Regular' },
  { label: 'Cooper Light',              value: 'CooperLtBT-Regular' },
  { label: 'Cooper Light Bold',         value: 'CooperLtBT-Bold' },
  // [FONTS-2026-10-12] Display faces the user licensed for the app + a narrow
  // sans. VALUE = the family libass resolves (fontselect-probed: each maps to
  // its own file, Bitblast regular vs Textured included).
  { label: 'Bootzy',                    value: 'Bootzy TM' },
  { label: 'Narrow (Liberation)',       value: 'Liberation Sans Narrow' },
  { label: 'Bitblast Sans',             value: 'Bitblast Sans' },
  { label: 'Bitblast Sans Textured',    value: 'Bitblast Sans Textured' },
  { label: 'Bitblast Serif',            value: 'Bitblast Serif' },
  { label: 'Bitblast Serif Textured',   value: 'Bitblast Serif Textured' },
  { label: 'Salted Butter',             value: 'ATP-SaltedButter' },
  { label: 'Slow Living Rounded',       value: 'Slow Living Club Rounded' },
  { label: 'Slow Living Outline',       value: 'Slow Living Club Outline' },
];
// Shared <option> list builder — was a closure local to renderTitlesList();
// hoisted so custom-chunk rules (which need the same font list) don't need
// their own copy.
function fontOpts(sel) {
  return CAPTION_FONTS.map(f => `<option value="${f.value}" ${sel===f.value?'selected':''}>${f.label}</option>`).join('');
}
// A cue carries per-word styling once any of its words has a non-empty style.
function cueHasTokens(cue) {
  return cue && Array.isArray(cue.tokens) && cue.tokens.some(t => t.style && Object.keys(t.style).length);
}
// Lazily split a cue's flat text into word tokens so each word can be styled.
function ensureTokens(cue) {
  if (!Array.isArray(cue.tokens) || !cue.tokens.length) {
    cue.tokens = String(cue.text || '').trim().split(/\s+/).filter(Boolean).map(w => ({ text: w }));
  }
  return cue.tokens;
}
// Re-chunk a clip's cueWords into groups of N words while preserving each
// word's existing style (font/bold/colour/size). Per-word timing within an
// original cue is interpolated uniformly across that cue's [start,end] window.
// Used when the user changes "Words per chunk" in the caption editor.
// [WORD-TIMING] Prefer the stored real per-word list (clip.words) so re-chunking
// keeps true spoken timing. Fall back to even distribution for legacy clips
// that have no word-level data. Shared by rechunkCues and rechunkCuesCustom so
// both re-chunk modes start from the identical flat word list.
function flattenClipWords(clip) {
  const cues = Array.isArray(clip.cueWords) ? clip.cueWords : [];
  if (!cues.length) return [];
  if (Array.isArray(clip.words) && clip.words.length) {
    return clip.words
      .filter(w => w && w.text && isFinite(+w.start) && isFinite(+w.end))
      .map(w => ({ text: w.text, style: w.style ? { ...w.style } : undefined, start: +w.start, end: +w.end }));
  }
  // Legacy fallback: flatten existing chunk cues with even per-word spacing.
  const flat = [];
  cues.forEach(c => {
    const toks = ensureTokens(c);
    const dur = Math.max(0.05, (c.end || 0) - (c.start || 0));
    const per = dur / toks.length;
    toks.forEach((t, i) => {
      flat.push({
        text: t.text,
        style: t.style ? { ...t.style } : undefined,
        start: (c.start || 0) + i * per,
        end:   (c.start || 0) + (i + 1) * per,
      });
    });
  });
  return flat;
}
function rechunkCues(clip, n) {
  const N = Math.max(1, Math.min(8, n|0));
  const flat = flattenClipWords(clip);
  if (!flat.length) return;
  // Re-group into chunks of N words.
  const out = [];
  for (let i = 0; i < flat.length; i += N) {
    const chunk = flat.slice(i, i + N);
    const tokens = chunk.map(w => w.style ? { text: w.text, style: w.style } : { text: w.text });
    out.push({
      start: chunk[0].start,
      end:   chunk[chunk.length - 1].end,
      text:  chunk.map(w => w.text).join(' '),
      tokens,
      // [BOX-HIGHLIGHT] No `.words` field — box highlight derives per-word
      // timing fresh from tokens+cue bounds at use time.
    });
  }
  clip.cueWords = out;
}
// [CUSTOM-CHUNKS] Same re-chunk entry point, but grouping is driven by
// clip.customChunkRules (time-ranged words-per-chunk + optional font
// override) instead of one flat N. `globalN` is what applies OUTSIDE every
// rule's range — the same value the plain 1W-5W chips write.
// [WPC-AUTO] the numeric chunk size for code that needs one ('auto' → 3).
function wpcNumR() { return Math.max(1, Math.min(8, Number(state.cfg && state.cfg.subtitleWordsPerChunk) || 3)); }
// [CLIPOPT-LIVE] Clip setting's Animasi / Kata per caption chips only feed the
// NEXT run, so the dashboard preview never moved when they were clicked — the
// preview kept the cues the pipeline baked. Re-chunk the active clip's words
// for the PREVIEW only (clip.cueWords stays as rendered) and replay the cue.
function previewApplyClipOpts() {
  const clip = state.clips && state.clips[state.activeClip];
  if (!clip) return;
  if (state.previewSubsBurned) { toast('Klip ini sudah ter-burn caption — perubahan dipakai saat Run berikutnya, atau ubah di Caption Editor.'); return; }
  const flat = flattenClipWords(clip);
  if (flat.length) {
    const mix = (state.cfg?.subtitleWordsPerChunk === 'auto' || autoChunkKin(state.cfg?.captionKinetic)) && window.KineticTitle?.mixChunks;
    const N = wpcNumR();
    const groups = mix ? kinChunksR(flat) : flat.reduce((a, w, i) => { if (i % N === 0) a.push([]); a[a.length - 1].push(w); return a; }, []);
    state.cueWords = groups.map((g) => ({ start: g[0].start, end: g[g.length - 1].end, text: g.map((w) => w.text).join(' '), tokens: g.map((w) => (w.style ? { text: w.text, style: w.style } : { text: w.text })) }));
  }
  _lastPreviewCue = '';
  try { applyCaptionStyle(); tickCaptionPreview(); } catch {}
}
function autoChunkKin(id) { return !(Number(state.cfg?.subtitleWordsPerChunk) > 0) && (id === 'cap_sauce_mix' || id === 'cap_quote' || id === 'cap_fokus_oranye' || id === 'cap_estetik'); }
// [CAP-QUOTE] Quote and Sorot run up to 4 words per cue; Lirik stays at 3.
// [CAP-ESTETIK] Estetik groups 2–5 words around one key word; the rest mixChunks.
function kinChunksR(flat) { const id = state.cfg?.captionKinetic; return id === 'cap_estetik' ? window.KineticTitle.estChunks(flat) : window.KineticTitle.mixChunks(flat, mixMaxR(id)); }
function mixMaxR(id) { return id === 'cap_quote' || id === 'cap_fokus_oranye' || id === 'cap_estetik' ? 4 : 3; }
function rechunkCuesCustom(clip, globalN) {
  const flat = flattenClipWords(clip);
  if (!flat.length) return;
  // [WPC-AUTO] Auto with no custom rules: the same natural 1–3 word cues as the pipeline.
  if ((state.cfg?.subtitleWordsPerChunk === 'auto' || autoChunkKin(state.cfg?.captionKinetic)) && !(clip.customChunkRules || []).length && window.KineticTitle?.mixChunks) {
    clip.cueWords = kinChunksR(flat).map((g) => ({ start: g[0].start, end: g[g.length - 1].end, text: g.map((w) => w.text).join(' '), tokens: g.map((w) => (w.style ? { text: w.text, style: w.style } : { text: w.text })) }));
    return;
  }
  const dur = Math.max(clip.end - clip.start || 0, flat[flat.length - 1].end);
  clip.cueWords = window.CustomChunks.rechunkWithRules(flat, clip.customChunkRules || [], globalN, dur);
}
// Paint a cue into an element: styled per-word spans when it has token styling,
// otherwise the normal (highlight-aware) flat text. `H` = preview height in px
// for scaling per-word font sizes authored in ASS 1920-unit space.
function paintCue(tx, cue, style, H, anim, cueIdx = 0, burnFont = '') {
  if (!tx) return;
  if (!cue || (!cue.text && !(Array.isArray(cue.tokens) && cue.tokens.length))) { tx.textContent = ''; return; }
  if (cue.textMotion && ((cue.textMotion.motion && cue.textMotion.motion !== 'none') || (cue.textMotion.flicker && cue.textMotion.flicker !== 'none'))) {
    const tokens = ensureTokens(cue);
    cue = { ...cue, tokens: tokens.map(t => ({ ...t, style: { ...t.style, an:'none' } })) };
    anim = 'none';
  }
  const sc = (H || 1080) / 1920;
  // Typewriter mode: words reveal one-by-one. The whole cue is laid out at once
  // (stable positions); each word fades in after a staggered delay. Mirrors the
  // ASS \alpha\t stagger in buildAss.
  const typeMode = anim === 'type';
  const twCueMs = typeMode ? Math.max(300, ((cue.end || 0) - (cue.start || 0)) * 1000) : 0;
  // Char-level typewriter: total characters (incl. inter-word spaces) drives the
  // per-character stagger so the preview matches the burned char-by-char reveal.
  // [TYPE-DRIFT-FIX] MUST exclude positioned (dragged, dx/dy) tokens from this
  // count — buildTypeCue's inlineCharCount in pipeline-inverse-v1.js does
  // (positioned words get their own \pos line + word-level stagger, not the
  // inline char-by-char one). Before this fix, a cue with any dragged word
  // counted its characters here but not on the burn side, so the two sides'
  // char totals diverged and the per-character stagger ran at a different
  // speed in the Caption Editor preview than in the actual rendered video.
  const twIsPositioned = (t) => !!(t && t.style && ((+t.style.dx) || (+t.style.dy)));
  const twChars = typeMode
    ? ensureTokens(cue).filter(t => !twIsPositioned(t)).reduce((s, t) => s + Array.from(String(t.text || '')).length + 1, 0)
    : 0;
  const twCharStep = (typeMode && twChars > 1) ? Math.min(55, (twCueMs * 0.55) / twChars) : 0;
  let twCharIdx = 0;   // running character index across the whole cue
  // Always render EVERY word as its own .pw-tok span (even with no styling yet)
  // so each word is individually selectable AND free-draggable in the preview.
  // ensureTokens materialises the cue's word tokens (no styles → harmless; the
  // ASS burn still treats an unstyled cue as flat text). Spans set
  // pointer-events:auto so they receive drag events even though the overlay
  // container is pointer-events:none.
  const toks = ensureTokens(cue);
  const accent = hiAccentFor(style, cueIdx);   // [HL-PALETTE] tint the trailing word; may rotate per cue
  const lastIdx = toks.length - 1;
  // Container is the layout anchor so positioned (.is-pos) tokens float relative
  // to the cue's top-center origin — matches the ASS \pos(subX+dx, subY+dy).
  tx.style.position = 'relative';
  // [CAP-ANIM-ONE-LAYER] The cue-level animation normally runs on the
  // container (styles.css). A cue where some word has its OWN animation goes
  // per word instead — container still, each word animating once with its
  // override or the cue's animation — the same split buildAss makes when
  // cueHasAnimOverride() sends a cue down its per-word path. Animating the
  // container too would stack two transforms on the overridden word.
  const perWordAnim = toks.some(t => t && t.style && t.style.an);
  tx.classList.toggle('cap-pw-anim', perWordAnim);
  // [CUE-SOLID-IN] A back-to-back cue's words enter without the opacity ramp.
  const contigCue = !!(tx.classList.contains && tx.classList.contains('cap-contig'));
  const animTable = contigCue ? ANIM_CSS_SOLID : ANIM_CSS;
  const baseStyle = (t) => {
    const st = t.style || {}; const s = [];
    // `!important` on EVERY per-word override so cinematic_white / inverse_auto
    // / white_clean's own `!important` class rules in styles.css don't win. Was
    // the "per-word font ignored in preview" bug: those styles hard-set
    // font-family/weight/color !important on `.cap-overlay.style-X span`, and
    // an inline value without !important loses the specificity race.
    // Double-quote wrapping so family names with an apostrophe (e.g. "Editor's
    // Note") don't break CSS — but as &quot; because this string lands inside a
    // double-quoted HTML style="…" attribute. A literal `"` would TERMINATE the
    // attribute right after `font-family:`, silently killing every inline
    // per-word override (font, colour, size, dx/dy). The entity decodes back to
    // a real quote when the browser parses the attribute, so CSS still sees
    // font-family:"Name".
    // [BURN-FONT] A word with no per-word override still burns in the CLIP's
    // burn-font override (cfg.subtitleFont), not the style's default face —
    // applyCE() applies that override to #capTx, but paintCue renders every
    // word as its own .pw-tok child span, and several style-*/span rules in
    // styles.css win the specificity race over inherited font-family. Without
    // this fallback, the preview showed the style's default face while the
    // burn used the override.
    const _wordBf = !st.fn && burnFont ? BURN_FONTS.find(f => f.value && f.value === burnFont) : null;
    if (st.fn)        s.push(`font-family:&quot;${st.fn}&quot; !important`);
    else if (_wordBf) s.push(`font-family:${_wordBf.css} !important`);
    // [TRACK-UNIFORM] Per-word tracking now comes from the SAME helper the rest
    // of the preview uses, so a word with its own font can no longer sit at a
    // different tightness than the line around it — or than its own burn. The
    // old per-font ladder lived here in triplicate (here, titleFontTracking, and
    // the style branches below); three copies of a number is how they drifted.
    // [PINYON-TRACK] A face of its own always writes its tracking, 'normal'
    // for Pinyon included (the burn stamps \fsp0 on that word).
    { const _fnT = st.fn || (_wordBf && _wordBf.value);
      if (_fnT) s.push(`letter-spacing:${fontTrackCss(_fnT)} !important`); }
    if (st.i)         s.push('font-style:italic !important');
    if (st.b != null) s.push(`font-weight:${st.b ? '700' : '400'} !important`);
    if (st.color)     s.push(`color:${st.color} !important`);
    if (st.fs)        s.push(`font-size:${(st.fs * sc).toFixed(2)}px !important`);
    // [MC-TRACK] Per-token letter spacing — Manual Caption stamps its entry's
    // spacing onto every token, so an inline caption tracks the same in the
    // preview as it does in the burn.
    if (st.tr != null && Number.isFinite(+st.tr)) s.push(`letter-spacing:${+st.tr}em !important`);
    // Per-word animation override. `an=''` (inherit) falls through to whatever
    // .anim-* class the cue-level applied. `an='none'` clears it. Any other key
    // maps to the same keyframe/timing the cue uses — must match ANIM_CSS.
    if (st.an === 'none')          s.push('animation:none !important');
    // Per-word 'type': the inner .cap-tw-char spans animate; the outer token
    // must NOT also run the cue-level anim or the word fades twice.
    else if (st.an === 'type')     s.push('animation:none !important');
    else if (st.an && animTable[st.an]) s.push(`animation:${animTable[st.an]} !important`);
    else if (!st.an && perWordAnim && !typeMode && animTable[anim]) s.push(`animation:${animTable[anim]} !important`);
    return s;
  };
  const interact = 'pointer-events:auto;cursor:grab;touch-action:none';
  // Inner .cap-tw-char spans are also matched by the `.cap-overlay.style-X
  // span {…!important}` rules in styles.css, which would override the per-word
  // font/colour set inline on the parent .pw-tok (inline !important only wins
  // on the element it sits on, not on children). Force the char spans to
  // inherit from their .pw-tok so per-word styling survives typewriter mode.
  const charInherit = 'font-family:inherit !important;font-weight:inherit !important;font-style:inherit !important;color:inherit !important;letter-spacing:inherit !important';
  const cueMs = Math.max(300, ((cue.end || 0) - (cue.start || 0)) * 1000);
  tx.innerHTML = toks.map((t, wi) => {
    const st = t.style || {};
    const s = baseStyle(t);
    const hiCls = (accent && wi === lastIdx && !st.color) ? ` cap-hi cap-hi-${accent}` : '';
    const dx = +st.dx || 0, dy = +st.dy || 0;
    // Typewriter: inner per-character spans, each staggered, so letters type in
    // one-by-one (matches the burned ASS char reveal). The outer .pw-tok span
    // keeps selection/drag intact. Non-type modes render plain text — unless
    // the WORD itself has a per-word 'type' override (st.an === 'type'), which
    // types just that word (mirrors buildAnimTokenCue's per-word char reveal).
    let inner;
    // [TYPE-DRIFT-FIX] buildTypeCue on the burn side gives a positioned
    // (dragged, dx/dy) token a completely different treatment — its own
    // \pos line with a plain word-level fade, NOT the inline char-by-char
    // reveal (see its "Positioned words can't type per-char sensibly — keep
    // a word stagger" comment) — and its `ci` char counter is never advanced
    // for that token. Before this fix, the preview ran EVERY token including
    // positioned ones through the char-reveal loop and advanced twCharIdx for
    // it, so a cue mixing dragged + inline words in Type mode both counted
    // extra characters into `twChars` the burn never counts (already fixed
    // above) AND, without this guard, kept consuming twCharIdx for a token
    // the burn treats as instantaneous — the two sides' stagger would run at
    // different speeds and the dragged word itself would visibly type
    // letter-by-letter in the editor while appearing all at once in the
    // rendered video.
    // [TYPE-OVERRIDE-PRECEDENCE] Mirrors buildAss's cueHasAnimOverride-before-
    // typeMode fix: a word with its OWN non-'type' override (st.an set to
    // 'pop'/'rise'/'drop'/etc.) must render as plain text here — NOT the cue-
    // level char-by-char reveal — so baseStyle()'s inline `animation:` for
    // that override is what's actually seen instead of always typing. Before
    // this guard, every non-dragged word typed whenever the CUE's default was
    // "Type", regardless of what its own per-word animation said.
    if (typeMode && !dx && !dy && (!st.an || st.an === 'type')) {
      inner = Array.from(t.text).map(ch => {
        // [TYPE-SOLID-FIRST] Same as the burn: a cue that follows another
        // back-to-back shows its first character at once (no blank frame).
        const solid = contigCue && twCharIdx === 0;
        const d = Math.round(twCharIdx * twCharStep); twCharIdx++;
        return solid
          ? `<span class="cap-tw-char" style="animation:none;opacity:1;${charInherit}">${esc(ch)}</span>`
          : `<span class="cap-tw-char" style="animation-delay:${d}ms;${charInherit}">${esc(ch)}</span>`;
      }).join('');
      twCharIdx++;   // account for the space typed between words
    } else if (st.an === 'type') {
      const chars = Array.from(t.text);
      const step = chars.length > 1 ? Math.min(45, (cueMs * 0.4) / chars.length) : 0;
      inner = chars.map((ch, k) =>
        `<span class="cap-tw-char" style="animation-delay:${Math.round(k * step)}ms;${charInherit}">${esc(ch)}</span>`
      ).join('');
    } else {
      inner = esc(t.text);
    }
    if (dx || dy) {
      // Positioned: anchored to cue origin (top-center); removed from inline
      // flow so neighbours close up — mirrors the ASS positioned-token layout.
      // [POS-ANIM-FIX] Positioning rides the independent `translate` property,
      // NOT `transform` — the anim-* keyframes (capRise/capDrop/capPop/capZoom)
      // animate `transform:` with fill-mode `both`, which would permanently
      // override an inline transform and teleport the dragged word back to the
      // cue origin the moment an animation applied. `translate` composes with
      // the keyframe transform, so the word slides/pops around its own spot —
      // exactly like the ASS \move(px,py±slide → px,py) burn.
      s.push(`position:absolute;left:50%;top:0;white-space:nowrap`);
      s.push(`translate:calc(-50% + ${(dx * sc).toFixed(2)}px) ${(dy * sc).toFixed(2)}px`);
      return `<span class="pw-tok is-pos${hiCls}" data-wi="${wi}" style="${s.join(';')};${interact}">${inner}</span>`;
    }
    return `<span class="pw-tok${hiCls}" data-wi="${wi}" style="${s.join(';')};${interact}">${inner}</span>`;
  }).join(' ');
}

// [BOX-PREVIEW] Menyalakan/mematikan box highlight pada SATU span kata yang
// tepat, dipanggil SETIAP FRAME dari tickCE — beda dari paintCue() yang
// sengaja hanya dipanggil ulang saat CUE berganti (supaya animasi per-kata
// tidak restart terus). Kata aktif berganti lebih sering dari cue, jadi tidak
// boleh lewat paintCue(). CSS background pada <span> inline otomatis
// membungkus teks kata itu — tidak perlu menghitung lebar/posisi manual
// seperti sisi burn (textWidthEm/wordCenterOffsetsEm), browser yang
// me-layout.
function updateBoxHighlightPreview(tx, cue, t, boxColor, style) {
  if (!tx) return;
  const prev = tx.querySelector('.pw-tok.cap-box-active');
  const clearPrev = () => {
    if (!prev) return;
    prev.classList.remove('cap-box-active');
    prev.classList.remove('cap-box-rotated');
    prev.style.removeProperty('--cap-box-angle');
    prev.style.removeProperty('--cap-box-color');
    prev.style.removeProperty('background');
    prev.style.removeProperty('color');
    prev.style.removeProperty('border-radius');
    prev.style.removeProperty('padding');
    prev.style.removeProperty('margin-right');   // [BOX-RIGHT-EDGE]
    prev.style.removeProperty('box-decoration-break');
    prev.style.removeProperty('text-shadow');
    // [BOX-H-FIXED] Added alongside the inline-block/line-height box height —
    // without clearing these, every word that has ONCE been the active box
    // keeps display:inline-block and a 1.2em line-height for the rest of the
    // cue, so the line's word spacing and baseline drift as the box advances.
    prev.style.removeProperty('display');
    prev.style.removeProperty('line-height');
  };
  // [BOX-ANIM-PRECEDENCE] Mirrors buildAss's [BOX-ANIM-PRECEDENCE] fix: the
  // burn path now skips box highlight entirely for a cue where any word has
  // its own animation override (tk.style.an), instead falling through to the
  // per-word animation emitter. Preview must skip it here too, or the box
  // would keep showing in the editor while the burned video plays the
  // per-word animation instead — the exact preview/burn drift this codebase
  // has been bitten by before.
  // [BOX-ELIGIBLE] ...and every other reason the burn skips the box (mixed
  // sizes, dragged words, outline, inverse_auto) — one shared rule.
  if (window.CaptionBox && window.CaptionBox.boxEligible && !window.CaptionBox.boxEligible(cue, style)) { clearPrev(); return; }
  // [BOX-HIGHLIGHT] Derived fresh from tokens+cue bounds every call — see
  // deriveWordTiming in src/caption-box.js. paintCue() renders one .pw-tok
  // span per token in the SAME order, so index i here lines up with the
  // `data-wi="${i}"` attribute those spans already carry.
  const words = (window.CaptionBox && Array.isArray(cue?.tokens))
    ? window.CaptionBox.deriveWordTiming(cue.tokens, cue.start, cue.end)
    : null;
  // Box OFF, atau cue ini belum bawa token (mis. cue kosong) — bersihkan
  // sisa box dari kata sebelumnya lalu berhenti.
  if (!boxColor || !words || !words.length || !window.CaptionBox) { clearPrev(); return; }
  const idx = words.findIndex(w => t >= w.start && t < w.end);
  if (prev && Number(prev.dataset.wi) !== idx) clearPrev();
  if (idx < 0) return;
  const span = tx.querySelector(`.pw-tok[data-wi="${idx}"]`);
  if (!span) return;
  if (span.classList.contains('cap-box-active')) {
    applyBoxRotationPreview(span, boxColor, state.cfg.subtitleBoxRotation);
    return;
  }
  span.classList.add('cap-box-active');
  const ink = window.CaptionBox.contrastInk(boxColor);
  // setProperty(..., 'important') — paintCue() memasang !important di hampir
  // semua override warna per-kata (lihat baseStyle() di dalamnya); tanpa ini
  // box highlight bisa kalah spesifisitas dari warna kata yang sudah di-set.
  span.style.setProperty('background', boxColor, 'important');
  span.style.setProperty('color', ink, 'important');
  // A neon/glow style's text-shadow (the halo around .pw-tok's own text)
  // reads as a muddy smear once that same word sits on a solid background —
  // the halo was designed for text on bare video, not text on a box.
  span.style.setProperty('text-shadow', 'none', 'important');
  // [PREVIEW-BURN-DRIFT] Same fix as setCueTextWithBox above — this used to
  // hardcode 0.25em/0.05em independently of what buildAss actually burns.
  const { PAD_EM, RADIUS_EM, BOX_H_EM } = window.CaptionBox;
  span.style.setProperty('border-radius', `${RADIUS_EM}em`, 'important');
  // [BOX-H-FIXED] An INLINE span's background height is the browser's own
  // font content-box (~cssLineHeightEm) — not something padding can shrink,
  // only grow. That is why the box used to be ~1.48em tall and why the burn
  // had to match it with cssLineHeightEm. To get the tight, font-size-relative
  // BOX_H_EM the burn now draws, the preview needs a height it CONTROLS:
  // inline-block + an explicit line-height makes the background exactly
  // BOX_H_EM tall, with the text optically centred inside it by the line box.
  // Vertical padding is therefore 0 — the height already includes it.
  span.style.setProperty('display', 'inline-block', 'important');
  span.style.setProperty('line-height', `${BOX_H_EM}em`, 'important');
  span.style.setProperty('padding', `0 ${PAD_EM}em`, 'important');
  // [BOX-RIGHT-EDGE] Same right-edge correction as boxPadCss (dashboard),
  // from the letter-spacing this token actually renders with.
  let lsPx = 0;
  try { lsPx = parseFloat(getComputedStyle(span).letterSpacing) || 0; } catch {}
  if (lsPx) {
    const ls = +lsPx.toFixed(3);
    span.style.setProperty('padding-right', `calc(${PAD_EM}em ${ls < 0 ? '+' : '-'} ${Math.abs(ls)}px)`, 'important');
    span.style.setProperty('margin-right', `${ls}px`, 'important');
  }
  span.style.setProperty('box-decoration-break', 'clone', 'important');
  applyBoxRotationPreview(span, boxColor, state.cfg.subtitleBoxRotation);
}

// ── Per-clip caption editor ──
// [ERR-VISIBLE] The Caption Editor is the worst place in the app for a silent
// throw. openCaptionEditorInner() paints its markup, then attaches ~1700 lines
// of controls one after another with no internal guard — and "✓ Apply" is the
// LAST control wired. So any exception in between produces an editor that looks
// completely normal, lets the user spend real time styling a clip, and then
// does nothing when they try to save it. The user has no way to tell that from
// "the button is broken".
//
// This does not repair a half-wired editor — it cannot. It makes the failure
// LOUD, names Apply specifically (the control users actually notice missing),
// and tells them the one thing that helps: reopen the editor.
function openCaptionEditor(clipIdx) {
  try {
    openCaptionEditorInner(clipIdx);
  } catch (e) {
    if (!isCaptionStudioOpen()) restoreDashboardPreview();
    reportRendererCrash('Caption Editor gagal dimuat sepenuhnya', e);
    logLine('⚠ Sebagian tombol editor (termasuk ✓ Apply) mungkin tidak berfungsi. Tutup editor lalu buka lagi; kalau tetap begini, kirim baris ✗ di atas ke support.', 'yellow');
    const stat = document.getElementById('ce_status');
    if (stat) stat.textContent = '✗ Editor tidak termuat penuh — tutup dan buka lagi.';
  }
}

function openCaptionEditorInner(clipIdx) {
  persistClippingSession();
  const c = state.cfg;
  const clip = state.clips[clipIdx];
  if (!clip || (!clip.file && !clip.srcVideo)) { toast('Render clip dulu sebelum edit caption.', 'err'); return; }
  let savedCfg = structuredClone(state.cfg);
  let savedClip = structuredClone(clip);
  // Editor controls update the live draft for preview, never persisted settings.
  async function saveCfg(patch) { Object.assign(state.cfg, patch); return state.cfg; }
  rollbackCaptionDraft = () => {
    for (const key of Object.keys(state.cfg)) if (!(key in savedCfg)) delete state.cfg[key];
    Object.assign(state.cfg, savedCfg);
    for (const key of Object.keys(clip)) if (!(key in savedClip)) delete clip[key];
    Object.assign(clip, structuredClone(savedClip));
    persistClippingSession();
  };
  let proxyMode = !!(clip.subsBurned && (!clip.rawFile || clip.rawFile === clip.file));
  let cleanSourceLoading = false;
  // [RAW-SRC] Snapshot the pre-edit file once. clip.file gets overwritten with the
  // burned output after "Render edit"; clip.rawFile always stays the untouched
  // source so buildCePayload can re-cut/re-burn from a clean plate on the NEXT
  // edit instead of stacking a second caption pass onto the already-burned file.
  if (!clip.rawFile) clip.rawFile = clip.file;
  releaseDashboardPreview();

  const html = `
    <div class="cap-editor cap-momo">
      <div class="cap-main">
      <div class="cap-stage-wrap">
        <!-- [GUTTER-V1] Tab dock beside the stage. Tab 1 = cue list (jump to a
             cue's start time), built as a tab container from the start so a
             future tab (e.g. tracks) doesn't need this re-architected. -->
        <div class="cap-gutter" id="ceGutter">
          <div class="cap-gutter-tabs" id="ceGutterTabs">
            <button type="button" class="cg-tab active" data-tab="cues">Cue</button>
          </div>
          <div class="cap-gutter-page" id="ceGutterCues"></div>
        </div>
        <button type="button" id="ce_max" class="stage-max-btn" title="Perbesar preview">⛶</button>
        <div class="cap-stage" id="capStage">
          <video id="capVideo" src="${toFileURL(clip.rawFile || clip.file || clip.srcVideo || '')}" controls controlsList="nofullscreen" disablePictureInPicture></video>
          <div class="cap-overlay" id="capOv"><span id="capTx"></span></div>
          <!-- [TITLE-V1] Persistent-title overlay layer. Sits above the subtitle
               overlay so titles are always drawn (subtitle can only show one cue
               at a time; multiple titles can co-exist). -->
          <div class="cap-title-layer" id="capTitleLayer"></div>
          <div class="cap-mc-layer" id="capMcLayer"></div>
        </div>
      </div>
      <div class="cap-panel">
        <div class="cap-tabs" id="ce_tabs">
          <button type="button" class="cap-tab active" data-tab="style">Style</button>
          <button type="button" class="cap-tab" data-tab="words">Words</button>
          <button type="button" class="cap-tab" data-tab="titles">Titles</button>
          <button type="button" class="cap-tab" data-tab="manualcap">Manual Caption</button>
          <button type="button" class="cap-tab" data-tab="textmotion" title="Stabilo, coretan, Blink, preset custom dan motion caption">Teks & Motion</button>
        </div>
        <div class="cap-tabpage" data-page="textmotion" hidden>${window.CaptionExtrasUI?.html() || ''}</div>
        <div class="cap-tabpage" data-page="style">
        <!-- Iter 4: Style tab split into section cards (Preset / Typography /
             Position / Effects & Output). Field ids unchanged — bindings safe. -->
        <div class="cap-card">
        <div class="cap-sec">Preset</div>
        <div class="field"><label>Style</label>
          <div class="swatches" id="ce_style">
            ${[['neon_green','#f1ff00'],['neon_pink','#ff4d6a'],['yellow','#ff9540'],['bw','#f6f6ef'],['bw_neon_green','linear-gradient(90deg,#f6f6ef 55%,#f1ff00 55%)'],['bw_neon_yellow','linear-gradient(90deg,#f6f6ef 55%,#ff9540 55%)'],['cinematic_white','radial-gradient(circle,#ffffff 35%,rgba(255,255,255,.35) 70%,rgba(255,255,255,0) 100%)'],
              /* [INVERSE-V1] swatch in caption-editor style picker */
              ['inverse_auto','linear-gradient(90deg,#000 50%,#fff 50%)'],
              /* [WHITE-CLEAN] pure-white flat swatch */
              ['white_clean','#ffffff'],
              /* [HL-PALETTE] More trailing-word accents. Each swatch shows the
                 base text colour on the left and the accent on the right, the
                 same split the two bw_neon_* swatches above use. */
              ['bw_hi_lime','linear-gradient(90deg,#f6f6ef 55%,#d2f96f 55%)'],
              ['bw_hi_red','linear-gradient(90deg,#f6f6ef 55%,#ff3b30 55%)'],
              ['bw_hi_white','linear-gradient(90deg,#9a9a9a 55%,#ffffff 55%)'],
              /* Rainbow shows the whole rotation, in cycle order. */
              ['bw_hi_rainbow','linear-gradient(90deg,#d2f96f 0 25%,#ff3b30 25% 50%,#f1ff00 50% 75%,#ff9540 75%)'],
              /* True-white base + saturated lime-green accent (#32CD32) — a
                 punchier, greener trailing word than the paler bw_hi_lime mint. */
              ['white_hi_lime','linear-gradient(90deg,#ffffff 55%,#32cd32 55%)']
            ].map(([v,col]) =>
              `<div class="swatch ${c.subtitleStyle===v?'active':''}" data-v="${v}" style="background:${col}"></div>`).join('')}
          </div>
        </div>
        </div>
        <div class="cap-card">
        <div class="cap-sec">Typography</div>
        <div class="field"><label>Font size <span style="float:right;color:#fff;font-weight:600" id="ce_fsv">${c.subtitleFontSize}</span></label>
          <div class="slider-row"><input id="ce_fs" type="range" min="32" max="120" value="${c.subtitleFontSize}"><span class="val">${c.subtitleFontSize}</span></div>
        </div>
        <!-- [CASE-V1] Text case transform: as-typed / UPPERCASE / lowercase. -->
        <div class="field"><label>Text case</label>
          <div class="segment" id="ce_case">
            ${[['none','Aa'],['upper','AA'],['lower','aa']].map(([v,l]) => `<button data-v="${v}" class="${(c.subtitleCase||'none')===v?'active':''}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="field"><label>Words per chunk</label>
          <div class="segment" id="ce_wpc">
            ${[1,2,3,4,5].map(n => `<button data-v="${n}" class="${clip.chunkMode!=='custom' && (c.subtitleWordsPerChunk||3)===n?'active':''}">${n}w</button>`).join('')}
            <button data-v="custom" class="${clip.chunkMode==='custom'?'active':''}">Custom</button>
          </div>
          <!-- [CUSTOM-CHUNKS] Per-clip time-ranged overrides: "for THIS section
               of THIS clip, use this many words per chunk (and optionally this
               font)". Reuses the same per-word tokens[].style.fn override the
               burn already reads for ordinary captions — no pipeline change. -->
          <div id="ce_wpcCustom" style="margin-top:8px;display:flex;flex-direction:column;gap:6px" ${clip.chunkMode==='custom'?'':'hidden'}>
            <div id="ce_wpcRules" style="display:flex;flex-direction:column;gap:6px"></div>
            <button type="button" class="mini-btn" id="ce_wpcAddRule" style="align-self:flex-start">+ Tambah rentang</button>
          </div>
        </div>
        </div>
        <div class="cap-card">
        <div class="cap-sec">Position</div>
        <div class="field"><label>Caption Y position <button type="button" class="mini-btn" id="ce_yc">⌖ Center</button> <span style="float:right;color:#fff;font-weight:600" id="ce_yv">${c.subtitleY}</span></label>
          <div class="slider-row"><input id="ce_y" type="range" min="50" max="1850" value="${c.subtitleY}"><span class="val">${c.subtitleY}</span></div>
        </div>
        <div class="field"><label>Caption X position <button type="button" class="mini-btn" id="ce_xc">⌖ Center</button> <span style="float:right;color:#fff;font-weight:600" id="ce_xv">${c.subtitleX||540}</span></label>
          <div class="slider-row"><input id="ce_x" type="range" min="0" max="1080" value="${c.subtitleX||540}"><span class="val">${c.subtitleX||540}</span></div>
        </div>
        </div>
        <div class="cap-card">
        <div class="cap-sec">Effects &amp; Output</div>
        <div class="field"><label>Glow effect</label>
          <div class="segment" id="ce_glow">
            <button data-v="on"  class="${c.subtitleGlow!==false?'active':''}">ON</button>
            <button data-v="off" class="${c.subtitleGlow===false?'active':''}">OFF</button>
          </div>
        </div>
        <div class="field"><label>Box highlight <span style="color:var(--muted);font-weight:500;font-size:11px">· kotak mengikuti kata aktif</span></label>
          <div class="segment" id="ce_box">
            <button data-v="on"  class="${c.subtitleBoxColor?'active':''}">ON</button>
            <button data-v="off" class="${!c.subtitleBoxColor?'active':''}">OFF</button>
          </div>
          <div class="slider-row" id="ce_boxColorRow" style="margin-top:8px" ${c.subtitleBoxColor?'':'hidden'}>
            <input id="ce_boxColor" type="color" value="${c.subtitleBoxColor || '#F1FF00'}" style="width:44px;height:32px;padding:0;border-radius:8px;cursor:pointer">
            <span class="val" style="margin-left:8px">Warna kotak</span>
          </div>
          <div id="ce_boxRotationRow" ${c.subtitleBoxColor?'':'hidden'}>
            <label for="ce_boxRotation" style="margin-top:12px">Rotasi box · teks tetap lurus</label>
            <div class="slider-row">
              <input id="ce_boxRotation" aria-label="Rotasi box" type="range" min="-45" max="45" step="1" value="${window.CaptionBox.boxRotation(c.subtitleBoxRotation)}">
              <input id="ce_boxRotationValue" aria-label="Sudut rotasi box" type="number" min="-45" max="45" step="1" value="${window.CaptionBox.boxRotation(c.subtitleBoxRotation)}" style="width:60px">
              <span>°</span><button type="button" id="ce_boxRotationReset">Reset</button>
            </div>
          </div>
        </div>
        <div class="field"><label>Animation</label>
          <div class="segment seg-wrap" id="ce_anim">
            ${[['pop','Pop'],['fade','Fade'],['rise','Rise'],['drop','Drop'],['zoom','Zoom'],['blur','Blur'],['type','Type'],['none','Off']].map(([v,l]) => `<button data-v="${v}" class="${(c.subtitleAnim||'pop')===v?'active':''}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="field"><label>Subtitle di video</label>
          <div class="segment" id="ce_burn">
            <button data-v="on"  class="${c.burnSubtitles?'active':''}">ON</button>
            <button data-v="off" class="${!c.burnSubtitles?'active':''}">OFF</button>
          </div>
        </div>
        </div>
        </div>
        <div class="cap-tabpage" data-page="words" hidden>
        <div class="field pw-section">
          <label>Per-word styling <span style="color:var(--muted);font-weight:500;font-size:11px">· click a word, then style it</span> <button type="button" class="mini-btn" id="ce_fixtypo" style="float:right">✦ AI Fix Typo</button></label>
          <div class="pw-style-bar" id="pw_bar" data-empty="1">
            <select id="pw_font" class="pw-input" title="Font">
              ${CAPTION_FONTS.map(f => `<option value="${f.value}">${f.label}</option>`).join('')}
            </select>
            <select id="pw_anim" class="pw-input" title="Word animation (blank = inherit from clip)">
              ${CAPTION_ANIMS.map(a => `<option value="${a.value}">${a.label}</option>`).join('')}
            </select>
            <button id="pw_bold" class="pw-tog" title="Bold">B</button>
            <button id="pw_ital" class="pw-tog" title="Italic" style="font-style:italic">I</button>
            <input id="pw_color" type="color" class="pw-color" value="#ffffff" title="Word colour">
            <button id="pw_colorOff" class="pw-tog" title="Clear colour">⊘</button>
            <input id="pw_size" type="number" class="pw-input pw-size" placeholder="size" min="20" max="200" title="Font size (blank = inherit)">
            <button id="pw_posReset" class="pw-tog" title="Reset manual position (drag a word in the preview to move it)">⌖</button>
            <input id="pw_text" class="pw-input pw-text" placeholder="edit word text" title="Edit the word text">
          </div>
          <div class="pw-words" id="pw_words"><div class="pw-empty">No cues for this clip.</div></div>
        </div>
        </div>
        <div class="cap-tabpage" data-page="titles" hidden>
        <!-- [TITLE-V1] start — Persistent titles panel. Each entry is a title
             stamped on the video for a chosen [start,end] range with its own
             text, position (drag in preview), font size, style, and animation.
             Independent from subtitles — both burn in the same pass. -->
        <div class="field ce-titles-field">
          <label>
            Persistent titles
            <button type="button" class="mini-btn" id="ce_addTitle" style="float:right">+ Add title @ current time</button>
          </label>
          <div id="ce_titles_list" class="titles-list" style="display:flex;flex-direction:column;gap:8px;margin-top:6px;max-height:38vh;overflow-y:auto;padding-right:4px"></div>
          <div style="color:var(--muted);font-size:11px;line-height:1.4;margin-top:6px">
            Drag a title in the preview to reposition. Titles render alongside subtitles and appear only in their time window.
          </div>
        </div>
        <!-- [TITLE-V1] end -->
        </div>
        <div class="cap-tabpage" data-page="manualcap" hidden>
        <!-- [MANUAL-CAPTION] Manual, user-authored caption cues. Unlike Titles,
             these are NOT independently stylable — they always render using the
             clip's active subtitle style/font/position, either spliced into the
             caption flow (mode: inline) or as a free-standing overlay (mode: layer).
             See docs/superpowers/specs/2026-09-04-manual-caption-design.md. -->
        <div class="field ce-mc-field">
          <label>
            Manual caption
            <button type="button" class="mini-btn" id="ce_addMc" style="float:right">+ Add caption @ current time</button>
          </label>
          <div id="ce_mc_list" class="titles-list" style="display:flex;flex-direction:column;gap:8px;margin-top:6px;max-height:38vh;overflow-y:auto;padding-right:4px"></div>
          <div style="color:var(--muted);font-size:11px;line-height:1.4;margin-top:6px">
            Inline: menyisip ke alur caption (caption lain otomatis dipangkas kalau tumpang tindih). Layer: berdiri bebas, boleh tumpang tindih dengan apa pun — drag di preview untuk atur posisi. Size &amp; font bisa diatur di kedua mode; pilihan Style (warna/glow) hanya muncul &amp; berlaku untuk mode Layer.
          </div>
        </div>
        </div>
      </div>
      </div>
      <div class="cap-timeline" id="ce_tl">
        <div class="tl-top">
          <button type="button" class="tl-btn" id="tl_prev" title="Cue sebelumnya">◁</button>
          <button type="button" class="tl-btn tl-play" id="tl_play" title="Play/Pause">▶</button>
          <button type="button" class="tl-btn" id="tl_next" title="Cue berikutnya">▷</button>
          <span class="tl-time"><b id="tl_cur">0:00.00</b><span id="tl_meta"> / 0:00.00</span></span>
          <!-- [CUE-SHIFT] Global nudge: geser SEMUA subtitle maju/mundur saat
               hasil render telat/kecepetan terhadap audio. -->
          <span class="tl-shift" title="Geser semua subtitle (telat/kecepetan)">Geser semua
            <button type="button" class="tl-mini" id="tl_shL">−0.1s</button>
            <button type="button" class="tl-mini" id="tl_shR">+0.1s</button>
          </span>
          <span class="tl-zoom">🔍<input type="range" id="tl_zoom" min="1" max="10" step="0.5" value="1"></span>
        </div>
        <div class="tl-scroll" id="tl_scroll">
          <div class="tl-track" id="tl_track">
            <!-- [FILM-V1] Video thumbnail filmstrip — gives the cue lane below it
                 a visual reference to the actual footage, so dragging/retiming a
                 cue can be lined up against what's on screen at that moment. -->
            <div class="tl-film" id="tl_film"></div>
            <div class="tl-ruler" id="tl_ruler"></div>
            <div class="tl-lane" id="tl_lane"></div>
            <!-- [TITLE-LANE] Second lane for clip.titles — same time axis
                 (left/width are % of clip duration) as the cue lane above
                 it, so both lanes stay pixel-aligned at any zoom level. -->
            <div class="tl-title-lane" id="tl_titlelane"></div>
            <div class="tl-mc-lane" id="tl_mclane"></div>
            <div class="tl-playhead" id="tl_ph"><span id="tl_phT">0:00.00</span></div>
          </div>
        </div>
        <div class="tl-foot">
          <div class="tl-chip" id="tl_chip" hidden>
            Cue <input id="tl_cs" class="tl-in" type="number" step="0.01" min="0"> →
            <input id="tl_ce" class="tl-in" type="number" step="0.01" min="0">
            · size <button type="button" class="tl-mini" id="tl_szDown">−</button><b id="tl_szVal">–</b><button type="button" class="tl-mini" id="tl_szUp">+</button>
            · <select id="tl_font" class="tl-sel"></select>
            · <select id="tl_anim" class="tl-sel"></select>
            · <button type="button" class="tl-mini tl-del" id="tl_del" title="Hapus cue subtitle ini">🗑 Hapus</button>
          </div>
          <div class="tl-chip" id="tl_mcchip" hidden>
            Manual caption: <b id="tl_mctext"></b>
            <button type="button" class="tl-mini tl-del" id="tl_mcdel" title="Hapus manual caption ini">🗑 Hapus</button>
          </div>
          <div class="cap-actions">
            <!-- [UNDO-V1] Editor-session undo/redo for destructive caption edits
                 (cue delete/retime, font/style changes, titles). History clears
                 each time the editor opens. -->
            <!-- [CE-ACTIONS-PROPORTION] Bare .mini-btn sizes to its own content
                 (padding 2px + a single glyph), and .cap-actions stretches it to
                 the row's height only — a 23×44 sliver next to full-width pill
                 buttons. cap-icon-btn gives these a matching square footprint. -->
            <button id="ce_subToggle" class="ghost-btn ce-sub-toggle ${c.burnSubtitles !== false ? 'on' : ''}" title="Tampilkan / sembunyikan subtitle di video. OFF = video tanpa subtitle saat Apply & Render.">${c.burnSubtitles !== false ? 'Subtitle: ON' : 'Subtitle: OFF'}</button>
            <button id="ce_undo" class="mini-btn cap-icon-btn" title="Undo — batalkan langkah terakhir (Ctrl+Z / Cmd+Z)" disabled>↺</button>
            <button id="ce_redo" class="mini-btn cap-icon-btn" title="Redo — ulangi lagi (Ctrl+Shift+Z / Ctrl+Y)" disabled>↻</button>
            <button id="ce_preview" class="ghost-btn" title="Preview export renders the real result (fast 480p proxy) so you can play it back before committing. Apply creates the full-quality version and replaces this clip in the Detected Clips gallery.">▷ Preview</button>
            <button id="ce_reveal" class="ghost-btn">Finder</button>
            <button id="ce_render" class="primary-btn" title="Apply the current styling to this clip. The rendered file replaces the clip in the gallery — batch re-render from there when you're done editing.">✓ Apply</button>
          </div>
        </div>
        <div id="ce_status" style="font-size:11px;color:var(--lime);min-height:14px"></div>
      </div>
    </div>`;
  captionStudio.title.textContent = clip.title || `Clip ${clipIdx+1}`;
  captionStudio.body.innerHTML = html;
  captionStudio.root.hidden = false;

  // [MOMO] Right-panel tabs — pure show/hide, ids untouched.
  const tabBtns = Array.from(document.querySelectorAll('#ce_tabs .cap-tab'));
  const tabPages = Array.from(document.querySelectorAll('.cap-tabpage'));
  function showTab(name) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPages.forEach(p => { p.hidden = p.dataset.page !== name; });
    // [AR-FIT] The stage-wrap's box is meant to stay fixed across tabs (see
    // .overlay-card:has(.cap-momo) in styles.v3.css), so this SHOULD be a
    // no-op most of the time — but fitStage() bakes its pixel size from a
    // clientHeight read taken once at editor-open, before webfonts/layout
    // may have fully settled. Re-measuring on every tab switch is cheap
    // insurance against that first-paint race, and self-corrects if the
    // wrap's size ever does legitimately change (e.g. a future tab adds
    // enough content to trigger scrollbar gutter width changes).
    requestAnimationFrame(() => {
      try { fitStage(); } catch {}
      try { applyCE(); } catch {}
      try { tickTitleLayer(); } catch {}
    });
  }
  tabBtns.filter(b => b.dataset.tab).forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Stop any other clip/preview audio that may still be playing in the
  // background so the editor's own video is the only sound source. Without
  // this, opening the editor while the main preview or another clip
  // thumbnail is playing leaves two audio streams overlapping.
  document.querySelectorAll('video, audio').forEach(el => {
    if (el.id === 'capVideo') return;
    try { el.pause(); } catch {}
  });
  if (els.playBtn) els.playBtn.textContent = '▶';

  const stage = document.getElementById('capStage');
  const ov = document.getElementById('capOv');
  const tx = document.getElementById('capTx');
  const vid = document.getElementById('capVideo');

  // [AR-FLEX] Make the editor stage follow the clip's OUTPUT aspect ratio so
  // landscape stays landscape / portrait stays portrait / square stays square —
  // and, critically, so the stage matches the burn's PlayRes (see [AR-FIT] below,
  // where the stage aspect is set from formatForAspect, never from the loaded
  // file's pixel ratio).
  const FMT_AR = { face: 9/16, blur: 9/16, square: 1/1, landscape: 16/9 };
  // [AR-FIT] Pure CSS aspect-ratio + height:100% + max-width:100% breaks for
  // landscape (max-width caps width, height stays full → letterboxed stage that
  // is NOT the video ratio). applyCE/paintCue/bake all scale from stage height,
  // so a letterboxed stage inflates the preview font vs the burn. Compute pixel
  // dimensions instead, mirroring applyStageAspect() for the dashboard preview.
  let stageRatio = FMT_AR.face;
  function fitStage() {
    if (!stage || !stageRatio) return;
    const wrap = stage.parentElement;
    const maxW = Math.max(60, (wrap ? wrap.clientWidth : 60) - 32);   // 16px padding each side
    const maxH = Math.max(60, (wrap ? wrap.clientHeight : 60) - 32);
    let sw = maxW, sh = maxW / stageRatio;
    if (sh > maxH) { sh = maxH; sw = maxH * stageRatio; }
    stage.style.width  = Math.floor(sw) + 'px';
    stage.style.height = Math.floor(sh) + 'px';
  }
  function setStageAspect(ratio) {
    if (!stage || !ratio || !isFinite(ratio) || ratio <= 0) return;
    stageRatio = ratio;
    stage.style.aspectRatio = String(ratio);
    fitStage();
  }
  // [TITLE-AR] tickTitleLayer maps titles from the stage rect, so titles must
  // reflow on stage resize just like captions (applyCE). Hoisted-function call
  // is safe here: tickTitleLayer is declared later in this same scope.
  try { new ResizeObserver(() => { fitStage(); applyCE(); try { tickTitleLayer(); } catch {} }).observe(stage.parentElement); } catch {}
  // [AR-FIT] The stage aspect MUST follow the OUTPUT format the burn targets —
  // NOT the loaded <video>'s pixel ratio. buildCePayload sends
  // formatForAspect(clip.cropAspect, state.cfg.format) to the pipeline, whose
  // assPlayRes() sets the ASS PlayRes (portrait 1080×1920 / landscape 1920×1080 /
  // square 1080×1080). EVERY caption measurement (applyCE font px, bake ax/ay,
  // drag dx/dy) is taken against the stage HEIGHT, so preview↔burn parity holds
  // only when stageHeight/stageWidth === PR.h/PR.w. The loaded <video> is the
  // pre-edit RAW source (exitProxy → clip.rawFile) or a 480p proxy, whose aspect
  // can differ from the cropped output (e.g. a 16:9 source cropped to 9:16, or a
  // clip whose cropAspect was changed after a render) — snapping the stage to it
  // scattered the burn wide vs the compact preview. Use the exact same formula as
  // the burn so the stage and the output frame always agree.
  const outFmt = formatForAspect(clip.cropAspect, (state.cfg && state.cfg.format) || 'face');
  setStageAspect(FMT_AR[outFmt] || 9/16);
  // [AR-FIT] The very first fitStage() (just above, via setStageAspect) reads
  // stage.parentElement's clientHeight synchronously right after the editor's
  // HTML was injected — before webfonts/the modal's own CSS transition (if
  // any) have necessarily finished settling into their final layout. Refit
  // one more time a couple of frames later so the baked pixel size matches
  // the SETTLED layout, not a transient first-paint one.
  requestAnimationFrame(() => requestAnimationFrame(() => { try { fitStage(); applyCE(); } catch {} }));
  vid.addEventListener('loadedmetadata', () => {
    // Deliberately do NOT re-derive the stage aspect from vid.videoWidth/Height —
    // the output format is authoritative (see above). Just re-apply now that the
    // <video> box has its intrinsic size settled.
    try { applyCE(); } catch {}
  });

  // [CAP-MAX] Expand the preview to fill the window. Enlarges the STAGE (video +
  // caption/title overlays together) — native <video> fullscreen is useless here
  // because the overlays are siblings of the video, not children, so they vanish.
  const capEditor = document.querySelector('#captionStudioBody .cap-editor, .cap-editor');
  const maxBtn = document.getElementById('ce_max');
  function setCapMax(on) {
    if (!capEditor) return;
    capEditor.classList.toggle('cap-maxed', on);
    if (maxBtn) { maxBtn.textContent = on ? '✕' : '⛶'; maxBtn.title = on ? 'Kecilkan (Esc)' : 'Perbesar preview'; maxBtn.classList.toggle('is-on', on); }
    requestAnimationFrame(() => { fitStage(); try { applyCE(); } catch {} try { tickTitleLayer(); } catch {} });
  }
  // [GUTTER-V1] Under the 980px breakpoint the gutter collapses to a slim
  // rail (CSS-driven); tapping it while collapsed flips it open.
  document.getElementById('ceGutter')?.addEventListener('click', (e) => {
    const g = e.currentTarget;
    if (getComputedStyle(g).width !== '40px') return;   // already expanded above the breakpoint
    g.classList.toggle('open');
  });
  if (maxBtn) maxBtn.addEventListener('click', () => setCapMax(!capEditor.classList.contains('cap-maxed')));
  // Capture phase so the first Esc only exits the expanded preview instead of
  // reaching the document-level handler that hides the whole overlay.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && capEditor && capEditor.isConnected && capEditor.classList.contains('cap-maxed')) {
      e.stopPropagation(); e.preventDefault();
      setCapMax(false);
    }
  }, true);

  const PALETTE = { neon_green:'#f1ff00', neon_pink:'#ff4d6a', yellow:'#ff9540', bw:'#f6f6ef', bw_neon_green:'#f6f6ef', bw_neon_yellow:'#f6f6ef', cinematic_white:'#ffffff',
    /* [INVERSE-V1] inverse_auto: preview uses pure white + mix-blend-mode:difference. */
    inverse_auto:'#ffffff',
    /* [WHITE-CLEAN] flat pure white, no stroke/shadow/glow. */
    white_clean:'#ffffff',
    /* [HL-PALETTE] Base BODY text colour (the accent lives in .cap-hi-*).
       bw_hi_white is the one that dims its base so a white accent can read —
       must match SUB_STYLES.bw_hi_white.primary (&H009A9A9A). */
    bw_hi_lime:'#f6f6ef', bw_hi_red:'#f6f6ef', bw_hi_rainbow:'#f6f6ef', bw_hi_white:'#9a9a9a',
    /* True white base (unlike the bw_hi_* family's near-white #F6F6EF) — must
       match SUB_STYLES.white_hi_lime.primary (&H00FFFFFF). */
    white_hi_lime:'#ffffff' };
  // [AR-FIT] Single source of truth for the stage's authored height. Prefer the
  // explicit px fitStage() just wrote — clientHeight can lag a frame behind
  // layout right after a maximize/restore toggle or a ResizeObserver tick.
  // EVERY caption measurement path (applyCE base font, paintCue per-word fs,
  // bakeCueWordOffsets ax/ay, per-word drag/pinch dx/dy) MUST divide by the SAME
  // height — a stale clientHeight at bake time skews baked offsets vs the visible
  // preview, so the burn scatters the words. All those call sites use stageH().
  function stageH() {
    const styleH = parseFloat(stage.style.height);
    return (Number.isFinite(styleH) && styleH > 0) ? styleH : (stage.clientHeight || 520);
  }
  // Width twin of stageH() — same explicit-style-first rule (fitStage writes
  // style.width; clientWidth lags a frame after maximize/restore).
  function stageW() {
    const styleW = parseFloat(stage.style.width);
    return (Number.isFinite(styleW) && styleW > 0) ? styleW : (stage.clientWidth || 293);
  }
  function applyCE() {
    if (proxyMode || cleanSourceLoading) { ov.style.visibility = 'hidden'; return; }
    const H = stageH();
    // Map subtitleY (0–1920 ASS units) to overlay top in preview pixels. Round to a
    // whole pixel so the caption doesn't shimmer/jitter vertically as each cue chunk
    // re-lays-out during playback.
    ov.style.top = `${Math.round(Math.max(0, Math.min(H - 32, (c.subtitleY / 1920) * H)))}px`;
    // X: position center of overlay at X% of stage (ASS PlayResX=1080, center=540=50%)
    const xPct = ((c.subtitleX || 540) / 1080 * 100).toFixed(2);
    ov.style.left = xPct + '%';
    ov.style.transform = 'translateX(-50%)';
    // Scale font proportionally to preview height (ASS is authored at 1920px height)
    ov.style.bottom = 'auto';
    tx.style.fontSize = `${Math.max(11, (c.subtitleFontSize / 1920) * H).toFixed(2)}px`;
    // [CASE-V1] Preview case via CSS text-transform (no data mutation) — mirrors
    // the .toUpperCase()/.toLowerCase() applied in the ASS burn.
    tx.style.textTransform = CASE_CSS[c.subtitleCase] || 'none';
    const col = PALETTE[c.subtitleStyle] || '#2cff05';
    tx.style.color = col;
    const CINE = c.subtitleStyle === 'cinematic_white';
    const BW = c.subtitleStyle === 'bw';
    // [INVERSE-V1] inverse_auto: Open Sauce Two Bold, tight tracking, blend-difference.
    const INV = c.subtitleStyle === 'inverse_auto';
    // [WHITE-CLEAN] white_clean: same Open Sauce Bold tight look as inverse but
    // pure white with NO blend and NO stroke/shadow/glow.
    const WC = c.subtitleStyle === 'white_clean';
    // Cinematic: serif, narrow, no black edge — only a soft white halo.
    // BW (default white): Times New Roman Condensed, bold, pure white + crisp black halo.
    if (INV || WC) {
      // [INVERSE-V1] start — humanist sans, tight tracking, no stroke/shadow.
      tx.style.fontFamily = `'Open Sauce Two Bold', 'Open Sans', 'Helvetica Neue', Arial, sans-serif`;
      tx.style.fontWeight = '700';
      // [TRACK-UNIFORM] one value for every style — see TRACK_EM_CSS above. Must
      // equal the pipeline's TRACK_EM or preview drifts from the burn again.
      tx.style.letterSpacing = TRACK_EM_CSS;
      // [INVERSE-V1] end
    } else if (CINE || BW) {
      tx.style.fontFamily = `'Times New Roman MT Condensed', 'Times New Roman', serif`;
      tx.style.fontWeight = '700';
      // [TRACK-UNIFORM] CINE and BW used to differ from each other; now neither does.
      tx.style.letterSpacing = TRACK_EM_CSS;
    } else {
      // [WYSIWYG-FONT] Neon/highlight styles: Open Sauce Two ExtraBold — the
      // BUNDLED face the burn now uses. 'Arial Black' isn't in assets/fonts, so
      // libass silently substituted Helvetica and the render never matched this
      // preview. weight 400 = raw face (pipeline burns these styles Bold=0).
      tx.style.fontFamily = `'Open Sauce Two ExtraBold', 'Arial Black', 'Helvetica Neue', sans-serif`;
      tx.style.fontWeight = '400';
      tx.style.letterSpacing = TRACK_EM_CSS;   // [TRACK-UNIFORM] neon styles burned untracked; now they match too
    }
    // [BURN-FONT] The three branches above pin a face per STYLE, which is
    // correct until the user overrides the burn font in Clip Options — after
    // which this editor kept previewing the style's face while the burn used
    // the override. The editor is where captions are judged, so a mismatch
    // here is the same WYSIWYG break the branches above were written to fix.
    // Applied last so it wins over whichever branch ran.
    // Same `important` priority and same tracking as the dashboard overlay —
    // see the [BURN-FONT] note there. The editor is where captions are judged,
    // so it is the worst place for the override to lose to a stylesheet rule.
    const _bf = BURN_FONTS.find(f => f.value && f.value === (c.subtitleFont || ''));
    if (_bf) {
      tx.style.setProperty('font-family', _bf.css, 'important');
      // [PINYON-TRACK] Unconditional: skipping Pinyon left the branch's
      // TRACK_EM_CSS above in place, i.e. tightened, while the burn is not.
      tx.style.setProperty('letter-spacing', fontTrackCss(_bf.value), 'important');
    }
    // [CAPTION-FIT-WIDTH-PREVIEW] Mirrors buildAss's [CAPTION-FIT-WIDTH]
    // (pipeline-inverse-v1.js) on the preview side. That burn-only mechanism
    // shrinks the caption font size for the WHOLE CLIP the instant even one
    // cue's text would overflow the frame — this editor preview never
    // applied the same shrink, so any clip with one wide cue burned visibly
    // SMALLER captions than the editor showed for every cue, not just the
    // wide one (the burn shrink is clip-wide, matching several other burn
    // code paths — box width/position, per-word \fs, the Style Fontsize
    // baked once into the ASS header — that all trust ONE size for the pass).
    // Reuses the real `tx` element to measure each cue's flat text at the
    // font/weight/letter-spacing/case just settled above — same principle as
    // [TITLE-FIT-WIDTH] reading a live element's scrollWidth instead of
    // re-deriving the burn's font-metrics-table formula in the renderer
    // process (which can't reach it — see font-metrics.js's fs/path requires,
    // unavailable in this contextIsolated, no-require renderer). Only
    // re-measures when the cues/font/size/style actually changed (cached on
    // the clip object) — scanning every cue via scrollWidth forces a
    // synchronous reflow per cue, too costly to redo every paint tick.
    const fitCues = clip.cueWords || [];
    const fitSig = JSON.stringify([fitCues.map(w => w.text), c.subtitleFont, c.subtitleFontSize, c.subtitleStyle]);
    if (clip._capFitSig !== fitSig) {
      const savedHTML = tx.innerHTML;
      const fitMaxW = stageW() * 0.9259;
      const fitTrim = captionFitTrimPx(tx);   // [FIT-WIDTH-PAD]
      let fitWidest = 0;
      for (const cue of fitCues) {
        tx.textContent = cue.text || '';
        const w = tx.scrollWidth - fitTrim;
        if (w > fitWidest) fitWidest = w;
      }
      tx.innerHTML = savedHTML;
      clip._capFitSig = fitSig;
      clip._capFitRatio = (fitWidest > fitMaxW && fitWidest > 0) ? fitMaxW / fitWidest : 1;
    }
    if (clip._capFitRatio < 1) {
      tx.style.fontSize = `${Math.max(11, (c.subtitleFontSize / 1920) * H * clip._capFitRatio).toFixed(2)}px`;
    }
    tx.style.transform = '';
    tx.style.transformOrigin = '';
    // [INVERSE-V1] start — mix-blend-mode MUST be on the overlay (ov), not the
    // span (tx). The overlay has transform:translateX(-50%) which creates a
    // stacking context; a span-level blend would only see the transparent
    // overlay backdrop (result: plain white text). Applied on the overlay,
    // the whole flattened overlay blends against the video below = XOR/invert.
    tx.style.mixBlendMode = '';
    ov.style.mixBlendMode = INV ? 'difference' : '';
    // [INVERSE-V1] end
    // Mirror the burned ASS render: crisp black edge, plus a coloured halo when
    // glow is on. Glow off ("og" caption) = crisp edge only, no halo.
    const edge = `-1.5px 0 #000,1.5px 0 #000,0 -1.5px #000,0 1.5px #000,-1.5px -1.5px #000,1.5px 1.5px #000,-1.5px 1.5px #000,1.5px -1.5px #000`;
    // [HL-PALETTE] Ask the accent table rather than naming styles: this used to
    // be a hardcoded pair of ids, so any new highlight style would have kept the
    // body halo the accent path is supposed to suppress.
    const HI = !!HIGHLIGHT_ACCENT[c.subtitleStyle];
    // Highlight styles: parent span gets no halo; the .cap-hi child carries
    // its own coloured glow via CSS. BW: subtle black halo on the body text.
    const glow = HI ? 'transparent' : (c.subtitleStyle === 'bw' ? 'rgba(0,0,0,.95)' : col);
    if (INV) {
      // [INVERSE-V1] no stroke, no shadow. INV blends against the video (above).
      tx.style.webkitTextStroke = '';
      tx.style.textShadow = 'none';
    } else if (CINE || WC) {
      // Cinematic + [WHITE-CLEAN]: NO stroke — only a soft outer white glow when
      // glow is ON (same gentle halo size as cinematic), none when OFF. WC uses
      // the Open Sauce sans font (set above); the halo recipe is identical.
      tx.style.webkitTextStroke = '';
      tx.style.textShadow = (c.subtitleGlow === false)
        ? 'none'
        : `0 0 3px rgba(255,255,255,.4),0 0 8px rgba(255,255,255,.22),0 0 14px rgba(255,255,255,.1)`;
    } else {
      // Non-cinematic styles: clear any leftover text-stroke from a previous
      // CINE render so switching back to neon/bw doesn't keep a white contour.
      tx.style.webkitTextStroke = '';
      // White/ivory styles: tighter halo so the firm black edge stays crisp and
      // the letters read with high contrast instead of a fuzzy bloom.
      const soft = (c.subtitleStyle === 'bw' || c.subtitleStyle === 'cinematic_white');
      const r1 = soft ? 4 : 10, r2 = soft ? 8 : 20;
      tx.style.textShadow = (c.subtitleGlow === false)
        ? edge
        : `${edge},0 0 ${r1}px ${glow},0 0 ${r2}px ${glow}`;
    }
    // Mirror the burned intro animation in the editor preview.
    const anim = c.subtitleAnim || 'pop';
    // Carry the style-*/no-glow classes exactly like the dashboard preview
    // (applyCaptionStyle) so the shared .cap-overlay.style-* CSS rules fire here
    // too — that's what keeps the editor font identical to the dashboard tab.
    const animCls = ['pop','fade','rise','drop','zoom','blur'].includes(anim) ? ` anim-${anim}` : '';
    const glowCls = c.subtitleGlow === false ? ' no-glow' : '';
    ov.className = `cap-overlay style-${c.subtitleStyle || 'neon_green'}${animCls}${glowCls}`;
    // Repaint the currently-relevant cue so EVERY style/font/glow change is
    // reflected immediately. While PAUSED we always re-render the active cue
    // (the parent-style cascade alone misses highlight accents and per-word
    // spans). While PLAYING, tickCE drives the repaint per frame — here we only
    // seed text if the overlay is empty so playback gaps stay accurate.
    if (vid.paused) {
      const tNow = vid.currentTime || 0;
      const cues = window.CaptionBox.bridgeCueGaps(window.ManualCaption.mergeInlineManualCaptions(clip.cueWords || [], clip.manualCaptions || []));   // [CUE-BRIDGE]
      let idx = cues.findIndex(w => tNow >= w.start && tNow < w.end);
      if (idx < 0 && cues.length) idx = 0;
      const activeCue = idx >= 0 ? cues[idx] : null;
      if (activeCue) {
        tx.classList.toggle('cap-contig', cuesJoin(cues[idx - 1], activeCue));   // [CUE-SOLID-IN]
        paintCue(tx, activeCue, c.subtitleStyle, stageH(), anim, idx, c.subtitleFont || '');
        // [CAP-NO-REPLAY] paintCue rebuilds every word span, and a new span
        // plays its intro again. applyCE runs on every slider `input` event,
        // style click, per-word edit and stage resize, so while paused the
        // caption replayed its animation dozens of times a second while a
        // slider moved. Replay only for a cue not shown yet, or when the
        // user just picked an animation; otherwise show the end state.
        // Keyed on start|index, not text, so a typo fix doesn't count as new.
        const animKey = `${activeCue.start}|${idx}`;
        if (animKey === _ceAnimKey && !_ceReplayAnim) settleCaptionAnim(tx);
        _ceAnimKey = animKey;
        _ceReplayAnim = false;
        updateBoxHighlightPreview(tx, activeCue, tNow, c.subtitleBoxColor, c.subtitleStyle); _lastCECue = `${activeCue.start}|${activeCue.text}`; _lastCECueIdx = idx;
      }
      else { setCueText(tx, clip.title || 'Caption Preview', c.subtitleStyle, 0); _lastCECue = ''; _lastCECueIdx = -1; }
    } else if (!tx.textContent) {
      const c0 = clip.cueWords?.[0];
      if (c0) { paintCue(tx, c0, c.subtitleStyle, stageH(), anim, 0, c.subtitleFont || ''); _lastCECue = `${c0.start}|${c0.text}`; _lastCECueIdx = 0; }
      else setCueText(tx, clip.title || 'Caption Preview', c.subtitleStyle, 0);
    }
    const kineticActive = !c.subtitleBoxColor && !!window.KineticTitle?.TEMPLATES?.[c.captionKinetic];
    ov.style.visibility = kineticActive ? 'hidden' : 'visible';
    if (kineticActive) { tickCE(); tickTitleLayer(); }
  }
  let _lastCECue = '';
  // [CAP-NO-REPLAY] Which cue's intro the paused preview has already played,
  // and whether the next applyCE should play it again (an animation pick).
  // Separate from _lastCECue on purpose: applyToSelection() blanks that one
  // to force a repaint, which must not also mean "replay the intro".
  let _ceAnimKey = '';
  let _ceReplayAnim = false;
  // Index into clip.cueWords for whichever cue paintCue most recently drew into
  // tx. Drag / pinch handlers fall back to this when vid.currentTime is between
  // cues (e.g. paused at t=0 while the first cue starts at 0.5s) — otherwise
  // the very first word would be visible in the preview but not interactive.
  let _lastCECueIdx = -1;
  let _ceKinCap = null;   // [KINETIC-CAPTION] active cue as a kinetic layer
  function tickCE() {
    syncDimLayers();   // [CAP-DIM]
    if (proxyMode || cleanSourceLoading) { ov.style.visibility = 'hidden'; return; }
    const t = vid.currentTime || 0;
    const cues = window.CaptionBox.bridgeCueGaps(window.ManualCaption.mergeInlineManualCaptions(subsOn() ? (clip.cueWords || []) : [], clip.manualCaptions || []));   // [CUE-BRIDGE] [SUBS-TOGGLE]
    if (!subsOn() && !cues.length) { tx.textContent = ''; _lastCECue = ''; }
    const idx = captionsHiddenByHook(clip.titles, t) ? -1 : cues.findIndex(w => t >= w.start && t < w.end);   // [HOOK-OVER-CAPTIONS]
    const cue = idx >= 0 ? cues[idx] : null;
    _ceKinCap = kineticCaptionTitle(cue, c, idx >= 0 ? cues[idx + 1] : null);   // [KINETIC-CAPTION] [KIN-CAP-NO-BLINK]
    if (_ceKinCap) {
      // [KINETIC-CAPTION] drawn by tickTitleLayer; keep the plain overlay off.
      ov.style.visibility = 'hidden';
      try { tickTitleLayer(); } catch {}
    } else if (cue) {
      // Repaint ONLY when the cue changes — repainting every frame would restart
      // the per-word ("Type") fade-in animation continuously. Style edits while
      // paused repaint via applyCE instead.
      const key = `${cue.start}|${cue.text}`;
      if (key !== _lastCECue) {
        tx.classList.toggle('cap-contig', cuesJoin(cues[idx - 1], cue));   // [CUE-SOLID-IN]
        paintCue(tx, cue, c.subtitleStyle, stageH(), c.subtitleAnim || 'pop', idx, c.subtitleFont || '');
        restartCaptionAnim(tx);
        _ceAnimKey = `${cue.start}|${idx}`;   // [CAP-NO-REPLAY]
        _lastCECue = key;
        _lastCECueIdx = idx;
      }
      ov.style.visibility = 'visible';
      updateBoxHighlightPreview(tx, cue, t, c.subtitleBoxColor, c.subtitleStyle);
    } else if (!vid.paused) {
      // Gap between cues while playing → hide so gap is accurate
      tx.textContent = '';
      ov.style.visibility = 'hidden';
      _lastCECue = '';
      _lastCECueIdx = -1;
    }
    // While paused with no active cue: keep current preview text visible
  }
  vid.addEventListener('timeupdate', tickCE);
  vid.addEventListener('loadedmetadata', () => { applyCE(); tickCE(); });
  // Use rAF so stage has its layout height before first applyCE reads clientHeight
  requestAnimationFrame(() => { applyCE(); tickCE(); });

  // [TITLE-V1] proxyMode is shared with the per-word subtitle editor further
  // down (line ~2344). Declared here so title handlers running at setup time
  // (renderTitlesList/tickTitleLayer below) can read it without hitting TDZ.
  // proxyMode is initialized before any editor layout/resize handlers run.

  // [TITLE-V1] start — Persistent titles subsystem (list editor + preview layer).
  // Titles are stored on the clip object (clip.titles). Each entry:
  //   { id, text, start, end, x, y, fs, style, anim }
  //   x,y are in ASS 1080×1920 units (matches subtitleX/subtitleY convention).
  clip.titles = Array.isArray(clip.titles) ? clip.titles : [];
  // [CUSTOM-CHUNKS] Per-clip words-per-chunk override state — see the
  // "Words per chunk" field below for the UI, rechunkCuesCustom() for the
  // rechunk entry point, and src/custom-chunks.js for the pure logic.
  clip.chunkMode = clip.chunkMode === 'custom' ? 'custom' : 'fixed';
  clip.customChunkRules = Array.isArray(clip.customChunkRules) ? clip.customChunkRules : [];
  // [TITLE-ID] Every title-card handler is keyed on `id`. A title arriving
  // without one (older session report, hand-edited state) would render a card
  // whose every field is silently inert, so backfill before anything reads it.
  clip.titles.forEach(t => { if (t && !t.id) t.id = 'ttl_' + Math.random().toString(36).slice(2, 8); });

  // [MANUAL-CAPTION] Manual Caption entries: { id, text, start, end, tokens,
  // mode: 'inline'|'layer', x, y }. See clip.titles above for the analogous
  // pattern this mirrors — id backfill for the same reason (older session
  // state, hand-edited reports).
  clip.manualCaptions = Array.isArray(clip.manualCaptions) ? clip.manualCaptions : [];
  clip.manualCaptions.forEach(m => { if (m && !m.id) m.id = 'mc_' + Math.random().toString(36).slice(2, 8); });

  // ── [UNDO-V1] Editor-session undo/redo ────────────────────────────────────
  // Snapshots the destructive editor state (cue words, titles, and the global
  // caption-style cfg fields) as serialized JSON so identical states dedupe by
  // ===. History is created fresh each editor open (this closure) — there is
  // nothing to clear across sessions.
  //
  // Model: `_preSnap` always holds the state as of the last SETTLED point.
  // Mutations run through the existing funnels (applyToSelection, saveTitles,
  // commitRetime, shiftAllCues, cue-delete, rechunk, the global-style handlers,
  // and drag/pinch release), each of which calls commitHist() AFTER mutating.
  // commitHist pushes the PRE-mutation snapshot (_preSnap) and rebaselines. For
  // rapid-fire sources (typing a word/title, colour drag, pinch resize) the
  // trailing-debounced commitHistDebounced() coalesces a burst into one entry.
  // Declared here (before the funnels that reference it) but restore() only
  // touches later-declared helpers at CALL time (undo/redo are user actions
  // that fire long after setup), so no TDZ.
  const CFG_HIST_FIELDS = ['subtitleStyle', 'captionKinetic', 'subtitleFontSize', 'subtitleY', 'subtitleX', 'subtitleAnim', 'subtitleCase', 'subtitleWordsPerChunk', 'subtitleBoxColor', 'subtitleBoxRotation'];
  const hist = window.EditHistory.createHistory({ limit: 100 });
  function snap() {
    const cfg = {};
    for (const k of CFG_HIST_FIELDS) cfg[k] = k === 'subtitleBoxRotation' ? window.CaptionBox.boxRotation(state.cfg[k]) : state.cfg[k];
    // Materialise every cue's tokens up front so snapshots are STABLE: paintCue
    // otherwise fills cue.tokens lazily as cues scroll into view, which would
    // make an unrelated snapshot differ (producing phantom undo steps whose only
    // "change" is token materialisation). ensureTokens is idempotent and tokens
    // are canonical data the burn already relies on.
    const cues = clip.cueWords || [];
    for (const cue of cues) { try { ensureTokens(cue); } catch {} }
    // clip.words (the source per-word timing list) is part of the snapshot too:
    // cue delete filters it and global shift retimes it in place, and
    // rechunkCues() rebuilds cueWords FROM it — undoing a delete/shift without
    // restoring clip.words would silently lose words on the next re-chunk.
    // [CUSTOM-CHUNKS] chunkMode/customChunkRules are per-clip (unlike the
    // global subtitleWordsPerChunk chips), so they ride in the snapshot
    // alongside cueWords/words/titles rather than in `cfg`.
    return JSON.stringify({
      cueWords: cues, words: clip.words || [], titles: clip.titles || [], cfg,
      manualCaptions: clip.manualCaptions || [],
      chunkMode: clip.chunkMode || 'fixed', customChunkRules: clip.customChunkRules || [],
    });
  }
  let _preSnap = snap();
  let _histTimer = 0;
  function syncHistButtons() {
    const u = document.getElementById('ce_undo');
    const r = document.getElementById('ce_redo');
    if (u) u.disabled = !hist.canUndo();
    if (r) r.disabled = !hist.canRedo();
  }
  // Immediate commit for discrete edits. Pushes the pre-mutation snapshot iff
  // the live state actually changed since the last settled point.
  function commitHist() {
    if (_histTimer) { clearTimeout(_histTimer); _histTimer = 0; }
    const cur = snap();
    if (cur === _preSnap) return;   // nothing changed → no history entry
    hist.push(_preSnap);
    _preSnap = cur;
    syncHistButtons();
  }
  // Trailing-debounced commit for rapid-fire sources: keeps _preSnap anchored on
  // the pre-burst state and pushes one entry ~450ms after the last change. Any
  // interleaved discrete commitHist() flushes it immediately.
  function commitHistDebounced() {
    if (_histTimer) clearTimeout(_histTimer);
    _histTimer = setTimeout(() => { _histTimer = 0; commitHist(); }, 450);
  }
  // Reflect a restored snapshot onto the global-style tab controls so the UI
  // (sliders, swatches, segments) matches the data after undo/redo.
  function syncStyleControls() {
    const cf = state.cfg;
    for (const id of ['ce_boxRotation', 'ce_boxRotationValue']) {
      const input = document.getElementById(id);
      if (input) input.value = window.CaptionBox.boxRotation(cf.subtitleBoxRotation);
    }
    for (const id of ['ce_boxColorRow', 'ce_boxRotationRow']) {
      const row = document.getElementById(id);
      if (row) row.hidden = !cf.subtitleBoxColor;
    }
    const boxColorInput = document.getElementById('ce_boxColor');
    if (boxColorInput) boxColorInput.value = cf.subtitleBoxColor || '#F1FF00';
    document.querySelectorAll('#ce_box button').forEach(button => button.classList.toggle('active', (button.dataset.v === 'on') === !!cf.subtitleBoxColor));
    const setSlider = (id, valId, v) => {
      const s = document.getElementById(id);
      if (s) { s.value = v; const sib = s.nextElementSibling; if (sib) sib.textContent = v; }
      const lab = document.getElementById(valId);
      if (lab) lab.textContent = v;
    };
    setSlider('ce_fs', 'ce_fsv', cf.subtitleFontSize);
    setSlider('ce_y', 'ce_yv', cf.subtitleY);
    setSlider('ce_x', 'ce_xv', cf.subtitleX || 540);
    const setSeg = (sel, val) => document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset.v === String(val)));
    document.querySelectorAll('#ce_style .swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.v === cf.subtitleStyle));
    setSeg('#ce_anim button', cf.subtitleAnim || 'pop');
    setSeg('#ce_case button', cf.subtitleCase || 'none');
    // [CUSTOM-CHUNKS] Undo/redo can flip chunkMode back and forth — resync
    // which chip is active, the rules panel's visibility, and its rows.
    setSeg('#ce_wpc button', clip.chunkMode === 'custom' ? 'custom' : (cf.subtitleWordsPerChunk || 3));
    const wpcBox = document.getElementById('ce_wpcCustom');
    if (wpcBox) wpcBox.hidden = clip.chunkMode !== 'custom';
    // syncStyleControls() is only ever invoked from restore() (undo/redo),
    // by which point the editor's full synchronous setup — including
    // renderWpcRules()'s own DOM lookups — has already run.
    renderWpcRules();
  }
  // Apply a serialized snapshot back onto the live editor + refresh all UI.
  function restore(snapshotStr) {
    let s; try { s = JSON.parse(snapshotStr); } catch { return; }
    exitProxy();                       // restore into live-edit mode, not proxy
    clip.cueWords = Array.isArray(s.cueWords) ? s.cueWords : [];
    // Reassignment is safe/consistent: no code holds a long-lived reference to
    // clip.words — cue delete itself reassigns (filter) and rechunkCues() /
    // shiftAllCues() re-read clip.words fresh on every call.
    clip.words    = Array.isArray(s.words) ? s.words : clip.words;
    clip.titles   = Array.isArray(s.titles) ? s.titles : [];
    clip.manualCaptions = Array.isArray(s.manualCaptions) ? s.manualCaptions : [];
    clip.chunkMode = s.chunkMode === 'custom' ? 'custom' : 'fixed';
    clip.customChunkRules = Array.isArray(s.customChunkRules) ? s.customChunkRules : [];
    if (s.cfg) {
      for (const k of CFG_HIST_FIELDS) if (k in s.cfg) state.cfg[k] = s.cfg[k];
      const patch = {}; for (const k of CFG_HIST_FIELDS) patch[k] = state.cfg[k];
      saveCfg(patch);                  // persist via the editor's normal path
      syncStyleControls();
    }
    // Selection indices are no longer valid after cue/title arrays change.
    sel = []; tlSelCue = -1; selTitle = { id: null, wi: -1 }; tlSelMc = -1;
    _lastCECue = ''; _lastCECueIdx = -1;
    // Full UI refresh — mirrors the post-rechunk / post-delete refresh sites.
    renderWords(); fillBar(); renderLane(); fillChip();
    renderTitlesList(); tickTitleLayer();
    renderMcList(); tickMcLayer();
    requestAnimationFrame(() => { applyCE(); tickCE(); tickTL(); });
    syncHistButtons();
    _preSnap = snap();
  }
  function undoEdit() {
    // Flush any pending debounced burst FIRST so undo steps back over the burst
    // (one step) instead of skipping its never-pushed baseline entirely.
    commitHist();
    const prev = hist.undo(snap());
    if (prev != null) restore(prev);
    syncHistButtons();
  }
  function redoEdit() {
    commitHist();   // same flush rationale as undoEdit
    const next = hist.redo(snap());
    if (next != null) restore(next);
    syncHistButtons();
  }
  document.getElementById('ce_undo')?.addEventListener('click', undoEdit);
  document.getElementById('ce_redo')?.addEventListener('click', redoEdit);
  // Document-level keyboard while the editor is open. Ignore when typing in a
  // field so native text undo keeps working. Removed on editor teardown.
  function onHistKey(e) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    const t = e.target;
    // [UNDO-FOCUS] Only TEXT fields keep their native undo. A slider, checkbox
    // or button keeps focus after you use it, and blocking on any INPUT made
    // Ctrl+Z silently do nothing right after moving a slider ("undo rusak").
    const textual = t && (t.tagName === 'TEXTAREA' || t.isContentEditable
      || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|color)$/i.test(t.type || '')));
    if (textual) return;
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoEdit(); }
    else if (k === 'z') { e.preventDefault(); undoEdit(); }
  }
  document.addEventListener('keydown', onHistKey, true);
  // ── [UNDO-V1] end ─────────────────────────────────────────────────────────

  const titleLayer = document.getElementById('capTitleLayer');
  const titlesListEl = document.getElementById('ce_titles_list');
  const addTitleBtn = document.getElementById('ce_addTitle');
  const mcListEl = document.getElementById('ce_mc_list');
  const addMcBtn = document.getElementById('ce_addMc');
  const TITLE_STYLES = [
    ['inverse_auto', 'Inverse (auto)'],
    ['white_clean', 'White (flat)'],
    ['bw', 'BW (white)'],
    ['cinematic_white', 'Cinematic'],
    ['neon_green', 'Neon lime'],
    ['neon_pink', 'Neon pink'],
    ['yellow', 'Yellow'],
  ];
  const TITLE_ANIMS = [
    ['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'],
    ['rise', 'Rise'], ['drop', 'Drop'], ['zoom', 'Zoom'], ['blur', 'Blur'],
    ['type', 'Type'],   // [TITLE-TYPE] typewriter, matches caption 'type'
    ['slam', 'Slam (hantam)'],   // [HOOK-SLAM]
  ];
  const genTitleId = () => 'ttl_' + Math.random().toString(36).slice(2, 8);
  // [TITLE-V1] Per-word styling state: which title + word index is selected for
  // the mini style-bar. { id:null, wi:-1 } = nothing selected.
  let selTitle = { id: null, wi: -1 };
  // [TITLE-PARITY] ensureTitleTokens now lives at module scope so the dashboard
  // painter tokenises identically. (Was duplicated here.)
  // [UNDO-V1] `rapid` = true for continuous title sources (text typing, colour
  // drag) so their bursts coalesce into a single undo entry.
  function saveTitles(rapid) {
    // [TITLE-V1] Any title mutation must leave proxy playback — otherwise the
    // burned proxy video keeps showing the OLD titles while the DOM overlay
    // draws the NEW ones on top, causing the ghost/stack bug. First call flips
    // vid.src back to the raw clip; subsequent calls are no-ops.
    exitProxy();
    // In-memory only — clip object persists through the session's report/history
    // via the same path as clip.cueWords / clip.cropKF (no explicit write).
    tickTitleLayer();
    // [TITLE-LANE] The timeline lane is a second view of the SAME clip.titles.
    // saveTitles is the funnel every title-card edit goes through, but it never
    // repainted the lane — so `+ Add title` produced no bar, deleting a card
    // left a ghost bar behind, and editing from/to never moved the bar. The
    // lane only caught up when some unrelated action happened to re-render it.
    try { renderTitleLane(); } catch {}
    // [TITLE-DASH-SYNC] Same class of gap as [TITLE-LANE] above, one layer
    // out: tickTitleLayer() only repaints the Caption Editor's OWN overlay
    // (`titleLayer`) — the dashboard behind/under the editor modal has a
    // SEPARATE title layer (`tickDashTitles()` → `#dashTitleLayer`) that is
    // otherwise driven purely by the dashboard `<video>`'s `timeupdate`. That
    // element is normally paused while the editor is open, so it never got
    // this tick, and every title edit (font size was the reported case —
    // "tidak menyesuaikan size, dapat tahu ketika sudah di apply" — but this
    // is generic: text, position, style, anim all had the same stale-until-
    // Apply gap) sat invisible until Apply reloaded the clip and forced a
    // fresh paint from scratch. Guarded on activeClip the same way the
    // "tovid" quick-add path above already does, since saveTitles can only
    // be reached while THIS clip's editor is open, but activeClip is the
    // dashboard's own notion of "which clip's layer is even mounted".
    try { if (state.activeClip === clipIdx) tickDashTitles(); } catch {}
    (rapid ? commitHistDebounced : commitHist)();   // [UNDO-V1]
  }
  // [HOOK-CARD] hookPresetSample() lives at module scope (moved for the
  // Clip Options hook picker, which renders the SAME cards outside this editor).

  // [TITLE-LINE-GEOM] Bangun ulang daftar judul, TAPI jangan saat fokus ada di
  // dalamnya: rebuild innerHTML akan merebut caret dari input yang sedang
  // diketik. Kalau begitu, kartunya menunggu render alami berikutnya.
  function _titlesListRefresh() {
    if (!titlesListEl) return;
    const act = document.activeElement;
    if (act && titlesListEl.contains(act)) return;
    renderTitlesList();
  }
  function renderTitlesList() {
    if (!titlesListEl) return;
    // [TITLE-LINE-GEOM] Metrik face datang asinkron lewat IPC, dan kartu preset
    // di bawah dibangun SEKALI — jadi ia harus dibangun ulang begitu angkanya
    // sampai. Dipasang di sini supaya tidak ada urutan inisialisasi yang perlu
    // dijaga, dan idempoten: metrik yang sudah ter-cache tidak memicu fetch
    // baru, jadi rantainya berhenti sendiri.
    if (_onBurnFaceResolved !== _titlesListRefresh) _onBurnFaceResolved = _titlesListRefresh;
    if (!clip.titles.length) {
      titlesListEl.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:8px;border:1px dashed rgba(255,255,255,.12);border-radius:8px;text-align:center">No titles yet. Click <b>+ Add title</b> to create one at the current playhead.</div>`;
      return;
    }
    const styleOpts = (sel) => TITLE_STYLES.map(([v,l]) => `<option value="${v}" ${sel===v?'selected':''}>${l}</option>`).join('');
    const animOpts  = (sel) => TITLE_ANIMS.map(([v,l]) => `<option value="${v}" ${sel===v?'selected':''}>${l}</option>`).join('');
    // fontOpts is now a module-level helper (shared with the custom-chunk rules UI).
    // [TITLE-V1] Per-word style bar HTML — only rendered inside the card of the
    // currently-selected title, showing the selected word's overrides.
    // [TITLE-PANEL-FIT] `width:100%;min-width:0;box-sizing:border-box` — without
    // these, a bare <input>/<select> keeps its browser-default intrinsic width
    // (measured: a number input floors at ~159px with no CSS width set at all)
    // instead of filling its grid track. Reported live with screenshots on both
    // Mac and Windows: the from/to/font-size row's three 1fr columns can't
    // shrink below that per-input floor (159+159+55 > the ~320px track actually
    // available inside the fixed 400px .cap-panel), so the row overflows its
    // container — and because .cap-tabpage sets overflow-y:auto, CSS computes
    // its overflow-x to auto too (not visible), so that overflow becomes a
    // horizontal scrollbar instead of wrapping, cutting off every field
    // mid-scroll exactly as pictured. Root cause confirmed by measuring
    // getBoundingClientRect()/scrollWidth on this exact markup in a browser
    // sandbox before and after. Reproduces at ANY window size on ANY platform,
    // since .cap-panel is a fixed 400px regardless of the outer window.
    const inp = 'padding:4px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.3);color:#fff;width:100%;min-width:0;box-sizing:border-box';
    const wordBar = (t) => {
      if (selTitle.id !== t.id || selTitle.wi < 0) return '';
      const toks = ensureTitleTokens(t);
      const tk = toks[selTitle.wi];
      if (!tk) return '';
      const st = tk.style || {};
      return `
        <div class="tt_wordbar" style="border-top:1px dashed rgba(255,255,255,.12);padding-top:6px;display:flex;flex-direction:column;gap:6px">
          <div style="font-size:11px;color:var(--lime)">Word: <b>${(tk.text||'').replace(/</g,'&lt;')}</b> <span style="color:var(--muted)">· styles just this word</span></div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select class="ttw_font" style="${inp};flex:1;min-width:110px">${fontOpts(st.fn||'')}</select>
            <select class="ttw_anim" title="Word animation (blank = inherit from title)" style="${inp};min-width:80px">${CAPTION_ANIMS.map(a => `<option value="${a.value}" ${(st.an||'')===a.value?'selected':''}>${a.label}</option>`).join('')}</select>
            <button type="button" class="mini-btn ttw_b" style="${st.b?'background:var(--lime);color:#111':''}">B</button>
            <button type="button" class="mini-btn ttw_i" style="font-style:italic;${st.i?'background:var(--lime);color:#111':''}">I</button>
            <button type="button" class="mini-btn ttw_box" title="Box highlight this word (uses the title's Box colour)" style="${st.box?'background:var(--lime);color:#111':''}">Box</button>
            <!-- [TITLE-WORD-GLOW] Marking ONE word switches the title's
                 all-or-nothing halo off and lights only the marked words —
                 both here and in the burn. -->
            <button type="button" class="mini-btn ttw_glow" title="Glow this word only (turns off the title-wide halo)" style="${st.gl?'background:var(--lime);color:#111':''}">Glow</button>
            <button type="button" class="mini-btn ttw_ol" title="Outline this word (kosongkan warna kata untuk huruf berongga)" style="${st.ol?'background:var(--lime);color:#111':''}">Outline</button>
            <input type="color" class="ttw_olc" value="${st.olc||'#ffffff'}" title="Warna garis outline" style="width:30px;height:26px;border:0;background:none;padding:0;cursor:pointer">
            <input type="color" class="ttw_color" value="${st.color||'#ffffff'}" title="Word colour" style="width:30px;height:26px;border:0;background:none;padding:0;cursor:pointer">
            <button type="button" class="mini-btn ttw_colorOff" title="Clear colour">⊘</button>
            <input type="number" class="ttw_size" placeholder="size" value="${st.fs||''}" min="24" max="240" title="Word size (blank = title size)" style="${inp};width:64px">
          </div>
        </div>`;
    };
    titlesListEl.innerHTML = clip.titles.map(t => `
      <div class="title-card" data-id="${t.id}" style="border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;gap:6px;align-items:center">
          <span class="title-drag" title="Drag to reorder">⠿</span>
          <input type="text" class="tt_text" value="${(t.text||'').replace(/"/g,'&quot;')}" placeholder="Title text" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.3);color:#fff;font-size:12px">
          <button type="button" class="mini-btn tt_del" title="Delete title" style="color:#ff8080">✕</button>
        </div>
        <!-- [HOOK-PRESET] One-click hook looks. A preset only sets appearance —
             font, style, box colour, glow, shape and the per-word accents — and
             never touches this title's text, timing or position, so it is a
             starting point the user keeps editing, not a lock. -->
        <div style="font-size:10px;color:var(--muted);margin-bottom:2px">HOOK</div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
          ${(window.HookPresets ? window.HookPresets.HOOK_PRESETS : []).map(p => `
            <button type="button" class="tt_preset" data-preset="${p.id}" title="Terapkan gaya ${p.label}"
              style="display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#141414;cursor:pointer;text-align:center;min-width:0">
              <span style="display:flex;align-items:center;justify-content:center;height:70px;overflow:hidden;width:100%">${hookPresetSample(p)}</span>
              <span style="font-size:10px;color:var(--muted)">${p.label}</span>
            </button>
          `).join('')}
        </div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:6px;font-size:11px;color:var(--muted)">
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">from (s)<input type="number" class="tt_start" value="${(+t.start).toFixed(2)}" step="0.1" min="0" style="${inp}"></label>
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">to (s)<input type="number" class="tt_end" value="${(+t.end).toFixed(2)}" step="0.1" min="0.1" style="${inp}"></label>
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">font size<input type="number" class="tt_fs" value="${+t.fs||96}" min="24" max="240" style="${inp}"></label>
        </div>
        <!-- [TITLE-TRACK] Letter spacing, in em. The burn has honoured T.track
             for a while (\fsp) and so has the preview; this is the control that
             was missing, so the value could only come from a preset. Blank
             inherits the font/style default. -->
        <!-- [TITLE-SLIDERS] Sliders, not just number boxes. Dragging the title
             in the preview kept losing the press to the caption word-drag, so
             position and spacing get a control that cannot be stolen: drag the
             scale, the preview follows live. The readout beside each label is
             the exact value, so nothing is lost versus typing it. -->
        <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)">
          <label style="display:flex;flex-direction:column;gap:2px">
            <span style="display:flex;justify-content:space-between">X <b class="tt_xv" style="color:var(--lime)">${Math.round(+t.x || 540)}</b></span>
            <input type="range" class="tt_x" value="${Math.round(+t.x || 540)}" min="0" max="1080" step="1" style="width:100%">
          </label>
          <label style="display:flex;flex-direction:column;gap:2px">
            <span style="display:flex;justify-content:space-between">Y <b class="tt_yv" style="color:var(--lime)">${Math.round(+t.y || 960)}</b></span>
            <input type="range" class="tt_y" value="${Math.round(+t.y || 960)}" min="0" max="1920" step="1" style="width:100%">
          </label>
          <label style="display:flex;flex-direction:column;gap:2px">
            <span style="display:flex;justify-content:space-between">spasi huruf (em) <b class="tt_trackv" style="color:var(--lime)">${t.track != null ? t.track : 'auto'}</b></span>
            <input type="range" class="tt_track" value="${t.track != null ? t.track : 0}" min="-0.2" max="0.4" step="0.01" style="width:100%">
          </label>
        </div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;font-size:11px;color:var(--muted)">
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">style<select class="tt_style" style="${inp}">${styleOpts(t.style)}</select></label>
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">anim<select class="tt_anim" style="${inp}">${animOpts(t.anim)}</select></label>
        </div>
        <!-- [TITLE-FONT] Font for the WHOLE title. Previously font could only be
             set per word (click a word in the preview), which is why changing the
             font appeared to do nothing at the title level. Blank = follow the
             style's own font, matching the burn's fallback. -->
        <label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted)">font
          <select class="tt_font" style="${inp}">${fontOpts(t.fn||'')}</select>
        </label>
        <!-- [TITLE-GLOW] Per-title glow toggle. -->
        <div class="segment tt_glow" style="display:flex;gap:4px">
          <button type="button" data-v="on"  class="${t.glow!==false?'active':''}" style="flex:1">Glow ON</button>
          <button type="button" data-v="off" class="${t.glow===false?'active':''}" style="flex:1">Glow OFF</button>
        </div>
        <!-- [TITLE-BOX] 1 box colour per title — WHICH words use it is toggled
             per-word in the word-bar below (ttw_box). Picking a colour here
             does nothing on its own until at least one word has its Box
             toggle on; see titleWordCss()/buildAss() for how boxColor is
             consumed. Default swatch matches the hook-word lime it replaces,
             so a freshly-toggled word is never invisible. -->
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)">
          Box colour
          <input type="color" class="tt_boxColor" value="${t.boxColor || '#F1FF00'}" title="Box highlight colour — pick words with the Box button below">
        </label>
        <div style="font-size:10.5px;color:var(--muted)">Click a word in the preview to style it individually.</div>
        ${wordBar(t)}
      </div>
    `).join('');
    refreshKineticCards();   // [KINETIC-CARD]
    // Wire up per-card handlers. All updates go through the same title object,
    // then re-tick the preview layer so drag/preview reflect edits immediately.
    titlesListEl.querySelectorAll('.title-card').forEach(card => {
      const id = card.dataset.id;
      const T = clip.titles.find(x => x.id === id);
      // [TITLE-ID] A card whose id doesn't resolve gets NO handlers at all — it
      // renders complete and every field is inert, with no error. Every current
      // creator assigns an id (ensureTitleIds above backfills anything that
      // arrives without one), so this is the last line of defence, not a
      // routine path — log it rather than failing mute.
      if (!T) { console.error('[titles] card', id, 'has no matching title — handlers skipped'); return; }
      // [TITLE-LANE] Clicking anywhere on the card (not its inputs/buttons —
      // those already have their own handlers and would otherwise double-fire)
      // highlights the matching bar in the timeline lane.
      card.addEventListener('click', (e) => {
        if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return;
        if (e.target.closest('.title-drag')) return;
        tlSelTitle = id;
        renderTitleLane();
      });
      card.querySelector('.tt_text').addEventListener('input', e => {
        T.text = e.target.value; ensureTitleTokens(T);   // keep tokens in sync
        // Selected word index may now be out of range → drop selection.
        if (selTitle.id === id && selTitle.wi >= (T.tokens?.length || 0)) selTitle = { id: null, wi: -1 };
        saveTitles(true);   // [UNDO-V1] coalesce keystrokes
      });
      // [EVENT-WINDOW] Menaikkan `from` melewati `to` dulu meninggalkan rentang
      // TERBALIK: panelnya menampilkan from 5 / to 2, preview tidak menampilkan
      // apa pun, dan render mengedipkannya 0,05s. Handler `to` sudah menjaga
      // sisinya (max(start+0.1, ...)); ini sisi yang terlewat.
      card.querySelector('.tt_start').addEventListener('change', e => {
        T.start = Math.max(0, +e.target.value || 0);
        // Hanya bangun ulang kartunya kalau `to` BENAR-BENAR dikoreksi —
        // rebuild tanpa sebab akan mencabut fokus dari input yang baru diisi.
        const fixed = !(+T.end >= T.start + MIN_EVENT_DUR);
        if (fixed) T.end = +(T.start + MIN_EVENT_DUR).toFixed(2);
        saveTitles();
        if (fixed) renderTitlesList();
      });
      card.querySelector('.tt_end').addEventListener('change', e => { T.end = Math.max(T.start + MIN_EVENT_DUR, +e.target.value || 1); saveTitles(); });
      card.querySelector('.tt_fs').addEventListener('change', e => { T.fs = Math.max(24, Math.min(240, +e.target.value || 96)); saveTitles(); });
      card.querySelector('.tt_style').addEventListener('change', e => { T.style = e.target.value; saveTitles(); });
      // `input`, not `change`: spacing and position are nudged repeatedly to
      // find the right feel, and waiting for blur to repaint reads as dead.
      // [TITLE-SLIDERS] Live on `input`, and the readout updates in the same
      // handler — re-rendering the whole list on every slider step would tear
      // the control out from under the pointer mid-drag.
      const bindRange = (cls, valCls, apply, fmt) => {
        const el = card.querySelector(cls);
        const out = card.querySelector(valCls);
        if (!el) return;
        el.addEventListener('input', (e) => {
          const v = +e.target.value;
          apply(v);
          if (out) out.textContent = fmt ? fmt(v) : String(v);
          saveTitles(true);
          tickTitleLayer();
        });
      };
      bindRange('.tt_x', '.tt_xv', v => { T.x = Math.max(0, Math.min(1080, v)); });
      bindRange('.tt_y', '.tt_yv', v => { T.y = Math.max(0, Math.min(1920, v)); });
      bindRange('.tt_track', '.tt_trackv', v => { T.track = Math.max(-0.2, Math.min(0.4, v)); }, v => v.toFixed(2));
      // [HOOK-PRESET] Apply in place: the title object keeps its identity so
      // every other handler on this card (and the drag handler holding a
      // reference to it) stays bound to the same title. Re-render the list so
      // the style/font selects show what the preset just chose.
      card.querySelectorAll('.tt_preset').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!window.HookPresets) return;
          const next = window.HookPresets.applyHookPreset(btn.dataset.preset, T);
          Object.assign(T, next);
          saveTitles();
          renderTitlesList();
        });
      });
      // [TITLE-FONT] '' clears the override so the title falls back to its style font.
      card.querySelector('.tt_font').addEventListener('change', e => { T.fn = e.target.value || undefined; saveTitles(); });
      card.querySelector('.tt_anim').addEventListener('change', e => { T.anim = e.target.value; saveTitles(); });
      // [TITLE-GLOW] Per-title glow on/off.
      card.querySelectorAll('.tt_glow button').forEach(b => b.addEventListener('click', () => {
        T.glow = b.dataset.v === 'on';
        card.querySelectorAll('.tt_glow button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        saveTitles();
      }));
      card.querySelector('.tt_del').addEventListener('click', () => {
        clip.titles = clip.titles.filter(x => x.id !== id);
        if (selTitle.id === id) selTitle = { id: null, wi: -1 };
        renderTitlesList(); saveTitles();
      });
      // [TITLE-BOX] Box colour is per-title, shared by every word that has
      // its own Box toggle on — mirrors T.style/T.fn's "one field, read by
      // every word" pattern, not per-word colour like ttw_color.
      card.querySelector('.tt_boxColor').addEventListener('change', e => { T.boxColor = e.target.value; saveTitles(); });
      // [TITLE-V1] Per-word style bar handlers — mutate the selected token's style.
      const bar = card.querySelector('.tt_wordbar');
      if (bar && selTitle.id === id && selTitle.wi >= 0) {
        const tk = ensureTitleTokens(T)[selTitle.wi];
        const setStyle = (patch, rapid) => {
          tk.style = { ...(tk.style || {}), ...patch };
          // Drop empty keys so an unstyled word stays a plain token.
          Object.keys(tk.style).forEach(k => { const v = tk.style[k]; if (v === '' || v == null || v === false) delete tk.style[k]; });
          saveTitles(rapid);   // [UNDO-V1]
        };
        bar.querySelector('.ttw_font').addEventListener('change', e => setStyle({ fn: e.target.value || undefined }));
        bar.querySelector('.ttw_anim').addEventListener('change', e => setStyle({ an: e.target.value || undefined }));
        bar.querySelector('.ttw_b').addEventListener('click', () => { setStyle({ b: !(tk.style && tk.style.b) }); renderTitlesList(); });
        bar.querySelector('.ttw_i').addEventListener('click', () => { setStyle({ i: !(tk.style && tk.style.i) }); renderTitlesList(); });
        bar.querySelector('.ttw_color').addEventListener('input', e => setStyle({ color: e.target.value }, true));
        bar.querySelector('.ttw_colorOff').addEventListener('click', () => { setStyle({ color: undefined }); renderTitlesList(); });
        bar.querySelector('.ttw_size').addEventListener('change', e => setStyle({ fs: e.target.value ? Math.max(24, Math.min(240, +e.target.value)) : undefined }));
        // [TITLE-BOX] Toggle only — setStyle already drops the key entirely
        // when the patch value is falsy, so turning Box off leaves a plain
        // token behind exactly like turning Bold off does.
        bar.querySelector('.ttw_box').addEventListener('click', () => { setStyle({ box: !(tk.style && tk.style.box) }); renderTitlesList(); });
        bar.querySelector('.ttw_glow').addEventListener('click', () => { setStyle({ gl: !(tk.style && tk.style.gl) }); renderTitlesList(); });
        bar.querySelector('.ttw_ol').addEventListener('click', () => { setStyle({ ol: !(tk.style && tk.style.ol) }); renderTitlesList(); });
        bar.querySelector('.ttw_olc').addEventListener('input', e => setStyle({ olc: e.target.value }, true));
      }
    });
    bindTitleDragReorder();
  }

  // [TITLE-REORDER-V1] Drag-to-reorder the persistent-titles list. Safe to
  // let titles swap position (unlike subtitle cues) because titles are NOT
  // transcript-locked — they're independent freeform overlays, so array
  // order has no bearing on caption sync.
  //
  // The dragged card follows the pointer via a raw (untransitioned) inline
  // transform so it feels attached to the cursor; other cards animate out of
  // the way with a short CSS transition once the drag crosses their slot.
  // Only ONE renderTitlesList() happens, on release — mid-drag we mutate
  // transforms directly so the dragged card's own DOM node (and its pointer
  // capture) survives the whole gesture, same principle as the cue lane's
  // documented MID-DRAG REBUILD fix above.
  function bindTitleDragReorder() {
    const cards = Array.from(titlesListEl.querySelectorAll('.title-card'));
    if (cards.length < 2) return;
    const r0 = cards[0].getBoundingClientRect();
    const r1 = cards[1].getBoundingClientRect();
    const step = (r1.top - r0.top) || (r0.height + 8);

    cards.forEach((card, origIdx) => {
      const handle = card.querySelector('.title-drag');
      if (!handle) return;
      handle.addEventListener('pointerdown', (e) => {
        const dragId = card.dataset.id;
        let order = cards.map(c => c.dataset.id);
        const startY = e.clientY;
        card.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
        let raf = 0, lastDy = 0;

        const applyPositions = () => {
          raf = 0;
          card.style.transform = `translateY(${lastDy}px)`;
          const slot = Math.max(0, Math.min(cards.length - 1, origIdx + Math.round(lastDy / step)));
          const curPos = order.indexOf(dragId);
          if (slot !== curPos) { order.splice(curPos, 1); order.splice(slot, 0, dragId); }
          cards.forEach((c, ci) => {
            if (c === card) return;
            const shift = (order.indexOf(c.dataset.id) - ci) * step;
            c.style.transition = 'transform .12s ease';
            c.style.transform = shift ? `translateY(${shift}px)` : '';
          });
        };
        const onMove = (ev) => {
          lastDy = ev.clientY - startY;
          if (!raf) raf = requestAnimationFrame(applyPositions);
        };
        const finish = () => {
          if (raf) cancelAnimationFrame(raf);
          // A fast/synthetic drag can deliver pointerup before the rAF from
          // the last pointermove ever runs, leaving `order` stale — resolve
          // the final slot synchronously so release always matches where
          // the card visually ended up.
          applyPositions();
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          card.classList.remove('dragging');
          const reordered = order.map(id => clip.titles.find(t => t.id === id)).filter(Boolean);
          clip.titles = reordered;
          saveTitles();
          renderTitlesList();   // single rebuild — resets every inline transform
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        e.preventDefault();
      });
    });
  }

  // [MANUAL-CAPTION] List UI — deliberately simpler than renderTitlesList():
  // no per-word style bar, no font/glow/anim pickers. Styling always mirrors
  // the clip's active subtitle style; only text/time/mode are per-entry.
  function renderMcList() {
    if (!mcListEl) return;
    if (!clip.manualCaptions.length) {
      mcListEl.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:8px;border:1px dashed rgba(255,255,255,.12);border-radius:8px;text-align:center">Belum ada manual caption. Klik <b>+ Add caption</b> untuk membuat di posisi playhead.</div>`;
      return;
    }
    const inp = 'padding:4px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.3);color:#fff;width:100%;min-width:0;box-sizing:border-box';
    // [MC-STYLE] "Inherit" leads the list (blank value) so a fresh manual
    // caption follows the main Style tab by default — same convention as a
    // title's blank font ("follow the style's own font").
    const mcStyleOpts = (sel) => ['<option value="">Inherit (ikuti Style utama)</option>']
      .concat(TITLE_STYLES.map(([v, l]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`))
      .join('');
    mcListEl.innerHTML = clip.manualCaptions.map(m => `
      <div class="mc-card" data-id="${m.id}" style="border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;gap:6px;align-items:center">
          <input type="text" class="mc_text" value="${(m.text||'').replace(/"/g,'&quot;')}" placeholder="Caption text" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.3);color:#fff;font-size:12px">
          <button type="button" class="mini-btn mc_del" title="Hapus" style="color:#ff8080">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;font-size:11px;color:var(--muted)">
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">from (s)<input type="number" class="mc_start" value="${(+m.start).toFixed(2)}" step="0.1" min="0" style="${inp}"></label>
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">to (s)<input type="number" class="mc_end" value="${(+m.end).toFixed(2)}" step="0.1" min="0.1" style="${inp}"></label>
        </div>
        <div class="segment mc_mode" style="display:flex;gap:4px">
          <button type="button" data-v="inline" class="${m.mode!=='layer'?'active':''}" style="flex:1">Inline</button>
          <button type="button" data-v="layer" class="${m.mode==='layer'?'active':''}" style="flex:1">Layer</button>
        </div>
        <!-- [MC-STYLE] Size + font apply to BOTH modes (burned as a per-word
             override, same mechanism every other cue's per-word style uses).
             Style (glow colour/box/etc.) only takes effect in Layer mode —
             Inline splices into the running caption's own Style block, so a
             per-word visual-style swap isn't structurally possible there;
             hidden instead of shown-but-inert to avoid "I set it and nothing
             happened". -->
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;font-size:11px;color:var(--muted)">
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">size (blank = ikut Style)<input type="number" class="mc_fs" value="${m.fs || ''}" placeholder="auto" min="20" max="240" style="${inp}"></label>
          <label style="display:flex;flex-direction:column;gap:2px;min-width:0">font (blank = ikut Style)<select class="mc_font" style="${inp}">${fontOpts(m.fn || '')}</select></label>
        </div>
        <!-- [MC-TRACK] Letter spacing in em, applied to BOTH modes: inline
             stamps it onto every token it splices in, layer puts it on its own
             line. Blank inherits the style's own tracking. -->
        <!-- [TITLE-SLIDERS] Same scales as the Titles panel: a control that
             cannot lose the press to another drag handler. -->
        <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)">
          <label style="display:flex;flex-direction:column;gap:2px">
            <span style="display:flex;justify-content:space-between">spasi huruf (em) <b class="mc_trackv" style="color:var(--lime)">${m.track != null ? m.track : 'auto'}</b></span>
            <input type="range" class="mc_track" value="${m.track != null ? m.track : 0}" min="-0.2" max="0.4" step="0.01" style="width:100%">
          </label>
          ${m.mode === 'layer' ? `
          <label style="display:flex;flex-direction:column;gap:2px">
            <span style="display:flex;justify-content:space-between">X <b class="mc_xv" style="color:var(--lime)">${Math.round(+m.x || 540)}</b></span>
            <input type="range" class="mc_x" value="${Math.round(+m.x || 540)}" min="0" max="1080" step="1" style="width:100%">
          </label>
          <label style="display:flex;flex-direction:column;gap:2px">
            <span style="display:flex;justify-content:space-between">Y <b class="mc_yv" style="color:var(--lime)">${Math.round(+m.y || 1500)}</b></span>
            <input type="range" class="mc_y" value="${Math.round(+m.y || 1500)}" min="0" max="1920" step="1" style="width:100%">
          </label>` : ''}
        </div>
        ${m.mode === 'layer' ? `
        <label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted)">style
          <select class="mc_style" style="${inp}">${mcStyleOpts(m.style || '')}</select>
        </label>` : ''}
      </div>
    `).join('');
    mcListEl.querySelectorAll('.mc-card').forEach(card => {
      const id = card.dataset.id;
      const M = clip.manualCaptions.find(x => x.id === id);
      if (!M) { console.error('[manual-caption] card', id, 'has no matching entry — handlers skipped'); return; }
      card.querySelector('.mc_text').addEventListener('input', e => {
        M.text = e.target.value;
        M.tokens = [{ text: M.text }];
        saveManualCaptions(true);
      });
      // [EVENT-WINDOW] Sama seperti judul: sisi `from` juga harus mengoreksi `to`.
      card.querySelector('.mc_start').addEventListener('change', e => {
        M.start = Math.max(0, +e.target.value || 0);
        const fixed = !(+M.end >= M.start + MIN_EVENT_DUR);
        if (fixed) M.end = +(M.start + MIN_EVENT_DUR).toFixed(2);
        saveManualCaptions();
        if (fixed) renderMcList();
      });
      card.querySelector('.mc_end').addEventListener('change', e => { M.end = Math.max(M.start + MIN_EVENT_DUR, +e.target.value || 1); saveManualCaptions(); });
      // [MC-STYLE] Blank clears the override so the entry falls back to the
      // main Style tab — same "blank = inherit" convention as titles' font.
      card.querySelector('.mc_fs').addEventListener('change', e => {
        const v = +e.target.value;
        M.fs = v ? Math.max(20, Math.min(240, v)) : undefined;
        saveManualCaptions();
      });
      card.querySelector('.mc_font').addEventListener('change', e => { M.fn = e.target.value || undefined; saveManualCaptions(); });
      // [MC-TRACK] `input`, not `change`: this is the one control users nudge
      // repeatedly to find the right feel, and waiting for blur to repaint
      // makes it feel dead. Blank clears the override.
      // [TITLE-SLIDERS] Live, and the readout moves in the same handler — a
      // re-render mid-drag would pull the slider out from under the pointer.
      const bindMcRange = (cls, valCls, apply, fmt) => {
        const el = card.querySelector(cls);
        const out = card.querySelector(valCls);
        if (!el) return;
        el.addEventListener('input', (e) => {
          const v = +e.target.value;
          apply(v);
          if (out) out.textContent = fmt ? fmt(v) : String(v);
          saveManualCaptions(true);
        });
      };
      bindMcRange('.mc_track', '.mc_trackv', v => { M.track = Math.max(-0.2, Math.min(0.4, v)); }, v => v.toFixed(2));
      bindMcRange('.mc_x', '.mc_xv', v => { M.x = Math.max(0, Math.min(1080, v)); });
      bindMcRange('.mc_y', '.mc_yv', v => { M.y = Math.max(0, Math.min(1920, v)); });
      const styleSel = card.querySelector('.mc_style');
      if (styleSel) styleSel.addEventListener('change', e => { M.style = e.target.value || undefined; saveManualCaptions(); });
      card.querySelectorAll('.mc_mode button').forEach(b => b.addEventListener('click', () => {
        M.mode = b.dataset.v;
        if (M.mode === 'layer' && (M.x == null || M.y == null)) { M.x = 540; M.y = 1500; }
        // Re-render this card so the Style select appears/disappears with mode.
        renderMcList();
        saveManualCaptions();
      }));
      card.querySelector('.mc_del').addEventListener('click', () => {
        clip.manualCaptions = clip.manualCaptions.filter(x => x.id !== id);
        renderMcList(); saveManualCaptions();
      });
    });
  }

  // [MANUAL-CAPTION] Funnel every mutation through here — mirrors saveTitles()
  // exactly (exit proxy playback, re-tick previews, re-render the lane,
  // commit undo history).
  function saveManualCaptions(rapid) {
    exitProxy();
    tickCE();
    try { tickMcLayer(); } catch {}
    try { renderMcLane(); } catch {}
    (rapid ? commitHistDebounced : commitHist)();
  }

  // [TITLE-AR] Coordinate space for title previews: the STAGE, which since
  // 998af58 is locked to the OUTPUT format aspect (formatForAspect) — the same
  // frame the burn's ASS PlayRes describes. buildAss maps a title's canonical
  // 1080×1920 x/y to x/1080 of PR.w and y/1920 of PR.h, i.e. fractions of the
  // OUTPUT frame, so the preview must map onto the stage rect too. Do NOT map
  // into the <video>'s painted content box: the loaded raw/proxy file's aspect
  // can differ from the output (object-fit:contain letterboxes it inside the
  // stage), and anchoring titles to that letterboxed box made previews drift
  // from where the burned \pos lands. Captions already anchor to the stage.
  function titleStageRect() {
    return { W: stageW(), H: stageH() };
  }

  // Preview layer: one absolutely-positioned div per title. Visible only when
  // vid.currentTime ∈ [start, end]. Uses the caption style CSS classes so an
  // inverse_auto title auto-inverts via mix-blend-mode:difference in preview too.
  function tickTitleLayer() {
    if (!titleLayer) return;
    // [TITLE-V1] While a burned preview proxy is playing, its titles are baked
    // into the video pixels. Drawing the DOM overlay on top would ghost every
    // title twice (matches the visible-overlap bug). Hide the layer; any user
    // edit calls exitProxy() first, which flips proxyMode back off.
    if (proxyMode) {
      titleLayer.style.visibility = 'hidden';
      // [FX-FRONT] no title paint this tick → clear a live tint left from the hook window
      if (vid && vid.style.filter) vid.style.filter = '';
      return;
    }
    titleLayer.style.visibility = '';
    // [TITLE-PARITY] The paint itself is the SHARED module-scope painter, so
    // this stage and the dashboard preview can never drift apart. Editor-only
    // behaviour (drag handles + per-word selection) rides in via opts.
    // [TITLE-AR] Map into the stage = output frame (see titleStageRect) so
    // preview font-size and X/Y stay locked to the frame ffmpeg burns into.
    const { W, H } = titleStageRect();
    // [KINETIC-CAPTION] the cue tickCE found rides along as a kinetic layer.
    const kin = _ceKinCap;
    const sub = !!kin && kinSubtract(c);   // [SUBTRACT-SPLIT]
    paintTitleLayer(titleLayer, (clip.titles || []).concat(kin && !sub ? [kin] : []), vid.currentTime || 0, W, H, {
      paused: !!vid.paused,
      interactive: true,
      selTitle,
      onBuild: attachTitleDrag,
      });
    const blendLayer = kinBlendLayerFor(titleLayer);
    if (blendLayer) {
      if (sub) paintTitleLayer(blendLayer, [kin], vid.currentTime || 0, W, H, { paused: !!vid.paused, interactive: false });
      else blendLayer.innerHTML = '';
    }
  }

  // [MANUAL-CAPTION] Layer-mode preview: one absolutely-positioned div per
  // entry, visible only within its [start,end] window, painted with the
  // SAME paintCue() the main caption uses (so font/style always matches the
  // active subtitle style) — mirrors tickTitleLayer()'s structure exactly,
  // but there is no per-entry style to look up (see saveManualCaptions doc).
  const mcLayer = document.getElementById('capMcLayer');
  // [MANUAL-CAPTION] Diff-then-patch, not rebuild-every-tick — same fix class
  // as paintTitleLayer's (see the comment above that function): rebuilding the
  // DOM + rebinding attachMcDrag() on every timeupdate would (a) leak a fresh
  // window-level mousemove/mouseup listener pair per tick (never removed —
  // attachTitleDrag/attachMcDrag bind on window, not the element) and (b)
  // restart paintCue()'s entrance animation (e.g. 'type') continuously. Only
  // rebuild nodes when the visible id SET changes; only re-paint a node when
  // its content/style signature changes (mirrors tickCE()'s _lastCECue guard).
  function tickMcLayer() {
    if (!mcLayer) return;
    if (proxyMode) { mcLayer.style.visibility = 'hidden'; return; }
    mcLayer.style.visibility = '';
    const t = vid.currentTime || 0;
    const { W, H } = titleStageRect();
    const entries = window.ManualCaption.layerManualCaptions(clip.manualCaptions || [])
      // [EVENT-WINDOW] Jendela yang sama dengan burn (buildAss memakai
      // eventWindow untuk baris manual caption juga), jadi rentang yang tidak
      // masuk akal tampil sama di kedua sisi.
      .filter((m) => {
        const w = (window.TitleLayout && window.TitleLayout.eventWindow)
          ? window.TitleLayout.eventWindow(m.start, m.end)
          : { start: Math.max(0, +m.start || 0), end: Math.max((+m.start || 0) + 0.05, +m.end || 1) };
        return t >= w.start && t < w.end;
      });

    const current = Array.from(mcLayer.querySelectorAll(':scope > .mc-el')).map(el => el.dataset.mid);
    const wanted = entries.map(m => m.id);
    if (current.length !== wanted.length || current.some((id, i) => id !== wanted[i])) {
      mcLayer.innerHTML = '';
      for (const m of entries) {
        const div = document.createElement('div');
        div.className = 'cap-overlay mc-el';
        div.dataset.mid = m.id;
        // [MANUAL-CAPTION] pointer-events:auto is REQUIRED here, inline — the
        // parent #capMcLayer is pointer-events:none (see the CSS added in Step
        // 7 below), same as .cap-title-layer/.title-el's existing pattern (find
        // where .title-el divs are created — the inline style string there sets
        // "pointer-events:auto" the same way, never via a CSS class rule).
        // Without this, attachMcDrag's mousedown listener never fires — clicks
        // pass straight through to whatever is behind the layer.
        div.style.position = 'absolute';
        div.style.pointerEvents = 'auto';
        div.style.cursor = 'grab';
        mcLayer.appendChild(div);
        attachMcDrag(div);   // bound ONCE per node, not once per tick
      }
    }

    for (const m of entries) {
      const div = mcLayer.querySelector(`[data-mid="${m.id}"]`);
      if (!div) continue;
      div.style.left = ((( +m.x || 540) / 1080) * W) + 'px';
      div.style.top = ((( +m.y || 1500) / 1920) * H) + 'px';
      // [MC-STYLE] Per-entry style/font/size, falling back to the main Style
      // tab when unset — mirrors tickTitleLayer's effFs (T.fs || 96) and
      // buildAss's ts2/fs2 resolution for titles, kept in parity with the
      // burn-side sL/fsBaseL resolution in pipeline-inverse-v1.js.
      const effStyle = m.style || state.cfg.subtitleStyle;
      const effFont = m.fn || state.cfg.subtitleFont || '';
      const effFs = +m.fs || state.cfg.subtitleFontSize;
      div.style.fontSize = `${Math.max(11, (effFs / 1920) * H).toFixed(2)}px`;
      // [MC-TRACK] The entry's own letter spacing, mirroring the burn's \fsp.
      // Clamped to the same range the burn clamps to, so preview and render
      // can never show two different spacings for one value.
      div.style.letterSpacing = (m.track != null && Number.isFinite(+m.track))
        ? `${Math.max(-0.2, Math.min(0.4, +m.track))}em`
        : '';
      // [MC-SIG] paintCue membaca text, tokens, start DAN end — semuanya wajib
      // ikut, atau perubahannya tidak pernah sampai ke preview. Durasi masuk
      // karena stagger animasi `type` dihitung dari (end - start), dan entri
      // yang diperpanjang sempat tetap mengetik pada kecepatan lama sementara
      // burn-nya sudah memakai yang baru. tokens masuk karena entri bisa
      // membawa gaya per-kata sendiri. x/y/track TIDAK perlu di sini: ketiganya
      // dipasang tiap tick di luar penjaga ini, jadi tidak pernah bisa basi.
      const sig = `${m.text}|${effStyle}|${state.cfg.subtitleAnim || 'pop'}|${effFont}|${effFs}|${m.start}|${m.end}|${JSON.stringify(m.tokens || null)}`;
      if (div.dataset.sig !== sig) {
        paintCue(div, m, effStyle, H, state.cfg.subtitleAnim || 'pop', 0, effFont);
        div.dataset.sig = sig;
      }
    }
  }

  vid.addEventListener('timeupdate', tickTitleLayer);
  vid.addEventListener('loadedmetadata', tickTitleLayer);
  vid.addEventListener('timeupdate', tickMcLayer);
  vid.addEventListener('loadedmetadata', tickMcLayer);

  function attachTitleDrag(el) {
    let dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0, T = null, downWi = -1;
    let wordDrag = false, origWdx = 0, origWdy = 0;
    // [TITLE-EVENT-ORDER] pointerdown, NOT mousedown. The caption word-drag
    // listens for pointerdown on the stage and calls preventDefault(), and per
    // the Pointer Events spec that suppresses the compatibility mousedown this
    // handler used to wait for — so the stage ALWAYS won and the caption moved
    // instead of the title. Geometric guards only papered over it. Taking the
    // event in the target phase and stopping it here means the stage handler
    // never runs for a press that belongs to a title, whatever their boxes
    // happen to overlap.
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      T = clip.titles.find(x => x.id === el.dataset.tid);
      if (!T) return;
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      // [TITLE-V1] Any drag starts a live edit — bail out of proxy playback so
      // the drag reflects onto the raw clip, not on top of a burned frame.
      exitProxy();
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      origX = T.x || 540; origY = T.y || 960;
      // Remember which word the press landed on so a click (no drag) selects it.
      // [TITLE-WORD-HIT] Direct hit only. A 40px nearest-word fallback made
      // almost every press inside the title resolve to a word, which quietly
      // TOOK AWAY whole-title dragging — the thing that had always worked.
      // Word dragging is opt-in below instead, so a miss can never cost the
      // gesture people rely on.
      const w = e.target?.closest?.('.ttl-word');
      downWi = w ? (+w.dataset.wi) : -1;
      // [TITLE-WORD-DRAG] Only an ALREADY-SELECTED word drags on its own;
      // every other press still moves the whole title. Making any word press
      // grab the word removed whole-title drag entirely, which is worse than
      // a per-word drag that needs one extra click to arm.
      // A DIRECT hit on a word drags that word; the gaps, the padding and the
      // line ends still belong to the whole title. Verified in the app: the
      // hit-test, the selection, the stored dx/dy and the preview transform
      // all work — what made it feel broken was needing a separate click to
      // arm it first.
      wordDrag = (downWi >= 0);
      if (wordDrag) {
        const tk = (T.tokens || [])[downWi] || {};
        origWdx = +(tk.style && tk.style.dx) || 0;
        origWdy = +(tk.style && tk.style.dy) || 0;
      }
      el.style.cursor = 'grabbing';
      e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging || !T) return;
      // [TITLE-AR] Convert pixel delta in the stage = output frame — the same
      // space tickTitleLayer positions in, so drag and render stay 1:1.
      const { W, H } = titleStageRect();
      const dxPx = e.clientX - startX;
      const dyPx = e.clientY - startY;
      if (Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3) moved = true;
      // Delta in stage px → ASS unit delta. Reversal: preview px → ASS units.
      const dxAss = (dxPx / W) * 1080;
      const dyAss = (dyPx / H) * 1920;
      if (wordDrag) {
        // ensureTitleTokens is what the painter itself uses — creating a bare
        // {text:''} here would insert an empty word into the title and the
        // burn would render the gap.
        const toks = ensureTitleTokens(T);
        const tk = toks[downWi];
        if (!tk) return;
        tk.style = tk.style || {};
        tk.style.dx = Math.max(-540, Math.min(540, Math.round(origWdx + dxAss)));
        tk.style.dy = Math.max(-960, Math.min(960, Math.round(origWdy + dyAss)));
      } else {
        T.x = Math.max(20, Math.min(1060, Math.round(origX + dxAss)));
        T.y = Math.max(20, Math.min(1900, Math.round(origY + dyAss)));
      }
      tickTitleLayer();
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      const wasT = T, wasWi = downWi, wasMoved = moved;
      dragging = false; el.style.cursor = 'grab';
      if (wasMoved && wasT) commitHist();   // [UNDO-V1] committed title reposition
      // [TITLE-V1] A press that didn't drag = a click → select the word under it
      // (or clear selection if the click missed a word). Opens the word style-bar.
      if (!wasMoved && wasT) {
        if (wasWi >= 0) selTitle = { id: wasT.id, wi: wasWi };
        else selTitle = { id: null, wi: -1 };
        renderTitlesList(); tickTitleLayer();
      }
    });
  }

  // [MANUAL-CAPTION] Drag-to-reposition for layer-mode entries — identical
  // mechanics to attachTitleDrag(), operating on manualCaptions instead of
  // titles. No per-word selection (Manual Caption has no per-word style), so
  // this is simpler: a plain click never opens anything, only drag moves it.
  function attachMcDrag(el) {
    let dragging = false, moved = false, startX = 0, startY = 0, origX = 0, origY = 0, M = null;
    // [TITLE-EVENT-ORDER] Same reasoning as the title drag above.
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      M = clip.manualCaptions.find(x => x.id === el.dataset.mid);
      if (!M) return;
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      exitProxy();
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      origX = M.x || 540; origY = M.y || 1500;
      el.style.cursor = 'grabbing';
      e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging || !M) return;
      const { W, H } = titleStageRect();
      const dxPx = e.clientX - startX, dyPx = e.clientY - startY;
      if (Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3) moved = true;
      const dxAss = (dxPx / W) * 1080, dyAss = (dyPx / H) * 1920;
      M.x = Math.max(20, Math.min(1060, Math.round(origX + dxAss)));
      M.y = Math.max(20, Math.min(1900, Math.round(origY + dyAss)));
      tickMcLayer();
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      const wasMoved = moved;
      dragging = false; el.style.cursor = 'grab';
      if (wasMoved) commitHist();
      M = null;
    });
  }

  if (addTitleBtn) {
    addTitleBtn.addEventListener('click', () => {
      // [TITLE-V1] Adding a new title is a mutation — same reason as saveTitles.
      exitProxy();
      const tNow = vid.currentTime || 0;
      const clipDur = (vid.duration && isFinite(vid.duration)) ? vid.duration : 5;
      // [TITLE-V1] Stagger each new title's default Y so multiple titles don't
      // stack exactly on top of each other (was the cause of the overlapping
      // "brightspot/best/buy" pile). titleDefaultY centres on the frame and
      // spreads outward — see [TITLE-CENTER] near titleFontTracking.
      const T = {
        id: genTitleId(),
        text: 'YOUR TITLE',
        // [EVENT-WINDOW] tNow bisa PERSIS di akhir klip (video habis), dan dulu
        // itu melahirkan judul berdurasi NOL: start == end. Preview tidak
        // menampilkannya, render mengedipkannya 0,05s. Jalur "+ Add caption"
        // sudah menjaga ini dengan menahan start; judul terlewat.
        start: +tNow.toFixed(2),
        end: +Math.max(tNow + MIN_EVENT_DUR, Math.min(clipDur, tNow + TITLE_DEFAULT_DUR)).toFixed(2),
        x: TITLE_DEFAULT_X, y: titleDefaultY(clip.titles.length), fs: 96,
        style: 'white_clean', anim: 'pop', glow: true,   // [TITLE-GLOW]
      };
      clip.titles.push(T);
      commitHist();   // [UNDO-V1] add title
      renderTitlesList(); tickTitleLayer();
      // [TITLE-LANE] Without this the button's title got a card and a preview
      // but no timeline bar, while the lane's own click-to-create path drew one
      // — two creation routes, two different results.
      try { renderTitleLane(); } catch {}
    });
  }
  renderTitlesList(); tickTitleLayer();

  // [MANUAL-CAPTION] Default duration 1.5s, clamped to clip length — matches
  // the spec's stated default. Starts empty so the user types immediately;
  // mode defaults to 'inline' (splice into the caption flow).
  if (addMcBtn) {
    addMcBtn.addEventListener('click', () => {
      exitProxy();
      const tNow = vid.currentTime || 0;
      const clipDur = (vid.duration && isFinite(vid.duration)) ? vid.duration : 5;
      const start = Math.min(tNow, Math.max(0, clipDur - 0.5));
      const M = {
        id: 'mc_' + Math.random().toString(36).slice(2, 8),
        text: '', tokens: [{ text: '' }],
        start: +start.toFixed(2),
        end: +Math.min(clipDur, start + 1.5).toFixed(2),
        mode: 'inline',
      };
      clip.manualCaptions.push(M);
      commitHist();
      renderMcList();
      try { tickMcLayer(); } catch {}
      try { renderMcLane(); } catch {}
    });
  }
  renderMcList();
  try { tickMcLayer(); } catch {}
  // [MANUAL-CAPTION] end
  // [TITLE-V1] end

  // ── Drag a single word in the preview to set its manual offset ──
  // Pointerdown on a .pw-tok inside the live caption: find the active cue at
  // the current playhead time, locate its token by wi, then translate pointer
  // delta from stage pixels into ASS (1920-tall) pixel space stored on the
  // token as style.dx/dy. Pointer must move >4px to count as a drag (smaller
  // moves are treated as accidental clicks). On release we refresh the per-
  // word panel + the caption preview so the offset is reflected immediately.
  let dragTok = null;
  // Resolve the .pw-tok under (or nearest to) the pointer. Direct hit-test via
  // closest() misses the first-word span in a few situations we've seen: (1) the
  // pointer lands on the ' ' text node between spans, (2) the entrance
  // animation's initial transform (rise/pop/…) has offset the visual box so the
  // hit rect doesn't match the click point, (3) sub-pixel gaps between spans on
  // certain zoom levels. Falling back to the nearest .pw-tok within 40px keeps
  // per-word drag reliable regardless of which of those trips a given click.
  const nearestTok = (e) => {
    const direct = e.target?.closest?.('.pw-tok');
    if (direct) return direct;
    const toks = tx.querySelectorAll('.pw-tok');
    if (!toks.length) return null;
    let best = null, bestD = Infinity;
    toks.forEach(sp => {
      const r = sp.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(cx - e.clientX, cy - e.clientY);
      if (d < bestD) { bestD = d; best = sp; }
    });
    return bestD <= 40 ? best : null;
  };
  stage.addEventListener('pointerdown', (e) => {
    // [TITLE-CLICK-STEAL] A click squarely on a title must never fall through
    // to the caption-word drag below. nearestTok()'s 40px proximity fallback
    // (needed so a slightly-missed caption word still grabs) doesn't know the
    // difference between "missed the word by a few px" and "the title is
    // visually sitting on top of a caption word right here" — titles and
    // captions routinely overlap on screen. Worse: this handler calls
    // preventDefault() below, and per the Pointer Events spec that suppresses
    // the compatibility `mousedown` event attachTitleDrag listens for — so the
    // title's OWN drag handler silently never even ran. Reported live:
    // "saya mau adjust title position dan sudah select title tp malah yg
    // keselect transcript captionnya". A real hit on the title element (or
    // anything inside it) belongs to attachTitleDrag, full stop — bail before
    // nearestTok's fallback ever gets a chance to steal it.
    if (e.target.closest('.title-el')) return;
    if (e.target.closest('.mc-el')) return;   // [MANUAL-CAPTION] same reasoning as [TITLE-CLICK-STEAL]
    // Only act when the pointer is inside the caption overlay's box or very
    // close to a caption word — otherwise let clicks on the video pass through
    // to the native controls.
    const span = nearestTok(e);
    if (!span) return;
    const t = vid.currentTime || 0;
    const cues = clip.cueWords || [];
    // Fall back to whichever cue is currently painted when playhead is between
    // cues (e.g. paused at t=0). Without this, the first word is visible but
    // its drag returns silently because findIndex → -1.
    let ci = cues.findIndex(w => t >= w.start && t < w.end);
    if (ci < 0) ci = (_lastCECueIdx >= 0) ? _lastCECueIdx : (cues.length ? 0 : -1);
    if (ci < 0) return;
    const wi = +span.dataset.wi;
    const tok = ensureTokens(cues[ci])[wi];
    if (!tok) return;
    tok.style = tok.style || {};
    e.preventDefault();
    span.setPointerCapture?.(e.pointerId);
    if (!vid.paused) vid.pause();
    // Any per-word drag is a live edit — bail out of proxy playback so the DOM
    // overlay shows the drag against the raw clip, not on top of a burned copy
    // (mirrors the title-drag fix in attachTitleDrag).
    exitProxy();
    // sc converts stage pixels ↔ ASS canonical (1920-tall) space. Uses stageH()
    // so it matches applyCE/paintCue's own scale — they read/write the same
    // style.dx/dy and any drift here shows as a jump on release.
    const sc = stageH() / 1920;
    // Seed dx0/dy0 from a token's CURRENT natural inline position so the very
    // first pixel of drag doesn't snap it to the cue origin. Once dx/dy are
    // recorded, paintCue switches the word to absolute positioning anchored at
    // the cue top-center — matching the ASS \pos(subX+dx, subY+dy) emit.
    const seedDxDy = (t2, sp2) => {
      let dx0 = +t2.style.dx || 0, dy0 = +t2.style.dy || 0;
      if (!dx0 && !dy0) {
        const txRect = tx.getBoundingClientRect();
        const spRect = sp2.getBoundingClientRect();
        dx0 = ((spRect.left + spRect.width / 2) - (txRect.left + txRect.width / 2)) / sc;
        dy0 = (spRect.top - txRect.top) / sc;
      }
      return { dx0, dy0 };
    };
    // [MULTI-DRAG] If the clicked word is part of an existing multi-selection
    // (chips highlighted via cmd/shift-click), drag every selected word
    // together by the same delta — not just the one under the cursor.
    // Reported live: "ketika batch select ... kasihkan solusi di select 2 itu
    // tapi saat di editor hanya bisa menggeser ... salah satunya aja padahal
    // di select semua". Before this, `dragTok` only ever tracked a single
    // token; the font/color/bold/italic/size controls already batch-apply via
    // applyToSelection() (loops `sel`) — only the on-stage drag gesture never
    // consulted `sel` at all. Falls back to solo-drag (the original behaviour)
    // when the clicked word isn't part of a multi-selection, so a plain single
    // click-drag is untouched.
    const inMultiSel = sel.length > 1 && isSelected(ci, wi);
    // [MULTI-DRAG] `.pw-tok` spans only carry `data-wi` (see paintCue) — the
    // stage only ever renders the ONE cue that's currently on screen, so a
    // selected word from a DIFFERENT cue has no live span here to drag at
    // all. Group members are scoped to same-cue selections; a cross-cue
    // multi-selection still batch-applies via applyToSelection() for style
    // properties, it just can't be dragged as one gesture (nothing visible
    // to grab for the other cue's word).
    const group = (inMultiSel ? sel.filter(s => s.ci === ci) : [{ ci, wi }]).map(({ wi: gwi }) => {
      const gTok = tokAt(ci, gwi);
      if (!gTok) return null;
      gTok.style = gTok.style || {};
      const gSpan = gwi === wi ? span : tx.querySelector(`.pw-tok[data-wi="${gwi}"]`);
      if (!gSpan) return null;
      const { dx0, dy0 } = seedDxDy(gTok, gSpan);
      return { ci, wi: gwi, tok: gTok, span: gSpan, dx0, dy0 };
    }).filter(Boolean);
    const anchorSeed = group.find(g => g.ci === ci && g.wi === wi) || group[0];
    dragTok = {
      ci, wi, span, px: e.clientX, py: e.clientY,
      dx0: anchorSeed.dx0, dy0: anchorSeed.dy0, sc, moved: false,
      wasMultiSel: inMultiSel, group,
    };
    span.style.cursor = 'grabbing';
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragTok) return;
    const ddx = (e.clientX - dragTok.px) / dragTok.sc;
    const ddy = (e.clientY - dragTok.py) / dragTok.sc;
    if (!dragTok.moved && Math.hypot(ddx * dragTok.sc, ddy * dragTok.sc) < 4) return;
    dragTok.moved = true;
    // [MULTI-DRAG] Apply the SAME pixel delta to every token in the group,
    // each measured from its OWN seeded dx0/dy0 — not just the anchor token.
    for (const g of dragTok.group) {
      const nx = Math.round(g.dx0 + ddx);
      const ny = Math.round(g.dy0 + ddy);
      g.tok.style.dx = nx;
      g.tok.style.dy = ny;
      // Live update: switch the span to absolute positioning at cue origin +
      // (dx, dy). Avoids re-running paintCue every frame, which would steal
      // the pointer capture mid-drag.
      const sp = g.span;
      sp.style.position = 'absolute';
      sp.style.left = '50%';
      sp.style.top = '0';
      sp.style.whiteSpace = 'nowrap';
      // [POS-ANIM-FIX] `translate` (not transform) so the anim-* keyframes'
      // transform never fights/overrides the drag position — see paintCue.
      sp.style.translate = `calc(-50% + ${(nx * dragTok.sc).toFixed(2)}px) ${(ny * dragTok.sc).toFixed(2)}px`;
      sp.style.transform = '';
    }
  });
  const endTokDrag = () => {
    if (!dragTok) return;
    const { moved, group } = dragTok;
    for (const g of group) {
      if (moved && g.tok.style) {
        if (!g.tok.style.dx) delete g.tok.style.dx;
        if (!g.tok.style.dy) delete g.tok.style.dy;
      }
      // pointerdown seeds tok.style = {} — drop it again when nothing was
      // written so a plain click never marks the word as "styled".
      if (g.tok.style && Object.keys(g.tok.style).length === 0) delete g.tok.style;
    }
    // Plain click (no actual drag) on a word in the VIDEO = select it for
    // styling, exactly like clicking its chip in the per-word panel. This is
    // the natural gesture ("click a word, then style it") — before, only the
    // chip list updated `sel`, so picking a font after clicking a word on the
    // video silently did nothing.
    // [MULTI-DRAG] Skip the collapse-to-one-word reset when the click landed
    // on a word that was ALREADY part of a multi-selection — a plain click
    // (mouse down+up with no movement) on the video would otherwise silently
    // discard the rest of the batch selection on every single drag attempt.
    if (!moved && !dragTok.wasMultiSel) {
      sel = [{ ci: dragTok.ci, wi: dragTok.wi }];
      // Clicking a word directly on the video stage should reveal the Words
      // tab (it may be hidden behind Timeline/etc) so the selection the user
      // just made is actually visible, not silently applied off-screen.
      // Accepted tradeoff: this intentionally yanks the user to the Words tab
      // even if they were on another tab (e.g. Timeline) — unlike the chip's
      // ensureChipSelection() fallback, which uses keepTab to avoid that.
      showTab('words');
    }
    dragTok.span.style.cursor = 'grab';
    if (moved) commitHist();   // [UNDO-V1] committed word reposition
    dragTok = null;
    // Invalidate the tickCE cache and force a repaint so the dragged word's
    // final dx/dy is committed to the preview (paintCue re-emits the token as
    // `.is-pos`). Without this, the inline transform we wrote during
    // pointermove sticks until the next cue transition — feels laggy.
    _lastCECue = '';
    renderWords();
    fillBar();
    // Keep the selected chip visible in the words panel so the toolbar state
    // and the on-video selection stay obviously in sync.
    pwWords.querySelector('.pw-word.sel')?.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => { applyCE(); tickCE(); });
  };
  stage.addEventListener('pointerup', endTokDrag);
  stage.addEventListener('pointercancel', endTokDrag);
  stage.addEventListener('lostpointercapture', endTokDrag);

  // Pinch / scroll-to-resize on selected words. Trackpad pinch on macOS emits a
  // wheel event with ctrlKey=true; regular scroll wheel over a word also works
  // as a size dial. Applies to the selected words if any, else the word under
  // the pointer. Base size falls back to the clip's subtitleFontSize so an
  // unstyled word still has a defined starting point.
  // Pinch / scroll-to-resize per-word. Attached to the STAGE (not tx) because
  // `.cap-overlay` is pointer-events:none — a wheel gesture over caption
  // whitespace (not directly on letter glyphs) would otherwise pass through to
  // the video element and never reach tx. Stage sees every wheel inside the
  // preview and we do our own hit-testing.
  //
  // If words are selected in the pw panel, resize the selection. Otherwise
  // auto-target the SINGLE word under the pointer (or the nearest one if the
  // pointer landed on padding) so it's truly per-word, never generalised.
  stage.addEventListener('wheel', (e) => {
    let targets = sel.slice();
    // Fall back to whichever cue is currently painted when the playhead is
    // between cues (e.g. paused at t=0) — same fix as the drag handler.
    const t0 = vid.currentTime || 0;
    let activeCueIdx = (clip.cueWords || []).findIndex(w => t0 >= w.start && t0 < w.end);
    if (activeCueIdx < 0) activeCueIdx = _lastCECueIdx;
    if (!targets.length) {
      // Prefer the token directly under the pointer; if none (pointer over
      // caption whitespace/video), pick the nearest token by center distance.
      let span = e.target?.closest?.('.pw-tok');
      if (!span) {
        const toks = tx.querySelectorAll('.pw-tok');
        if (!toks.length) return;
        let best = null, bestD = Infinity;
        toks.forEach(sp => {
          const r = sp.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const d = Math.hypot(cx - e.clientX, cy - e.clientY);
          if (d < bestD) { bestD = d; best = sp; }
        });
        // Only auto-target if the pointer is reasonably near the caption (300px
        // radius) — otherwise let the scroll pass through as normal.
        if (!best || bestD > 300) return;
        span = best;
      }
      if (activeCueIdx < 0) return;
      targets = [{ ci: activeCueIdx, wi: +span.dataset.wi }];
    }
    e.preventDefault();
    exitProxy();
    // deltaY > 0 (scroll down / pinch in) → shrink; < 0 → grow. Scale step with
    // |deltaY| so fast flicks move more than slow ticks; floor at 1 for pinch.
    const dir = Math.sign(e.deltaY);
    const step = Math.max(1, Math.round(Math.abs(e.deltaY) * 0.15));
    const baseCfg = (state && state.cfg && state.cfg.subtitleFontSize) || DEFAULT_SUB_FS;
    const sc = stageH() / 1920;
    // Live DOM patch for the visible cue's words — no full repaint so the
    // caption's entrance animation isn't restarted on every wheel tick and the
    // preview follows the pinch truly realtime.
    targets.forEach(({ci, wi}) => {
      const tok = tokAt(ci, wi); if (!tok) return;
      tok.style = tok.style || {};
      let cur = +tok.style.fs;
      if (!cur) {
        // Seed from the WORD's currently-rendered pixel size so the first tick
        // doesn't snap it to cfg.subtitleFontSize — style-based sizing (e.g.
        // cinematic_white) can differ meaningfully from cfg.
        // ...but the RENDERED size is clamped by applyCE/paintCue with
        // Math.max(11, ...) so a caption stays legible on a small stage.
        // Dividing a clamped value back by sc invents a size nobody chose: on
        // a 152px stage (Windows at 150% scaling — see [SHORT-VIEWPORT] in
        // styles.css) sc is 0.079, so the 11px floor seeds 11/0.079 = 139.
        // The word then carries fs:139 forever, and because a per-word size
        // outranks cfg.subtitleFontSize, the size slider stops doing anything
        // to that word — the reported "I raise the size and nothing changes".
        // Only trust the painted size when it is genuinely above the floor.
        const sp = tx.querySelector(`.pw-tok[data-wi="${wi}"]`);
        const px = sp ? parseFloat(getComputedStyle(sp).fontSize) : 0;
        cur = (px > 11.01) ? Math.round(px / sc) : baseCfg;
      }
      const next = Math.max(20, Math.min(200, cur - dir * step));
      tok.style.fs = next;
      if (ci === activeCueIdx) {
        const sp = tx.querySelector(`.pw-tok[data-wi="${wi}"]`);
        if (sp) sp.style.setProperty('font-size', `${(next * sc).toFixed(2)}px`, 'important');
      }
    });
    fillBar();
    commitHistDebounced();   // [UNDO-V1] coalesce a pinch/scroll burst into one entry
    // Also invalidate the tickCE cache so the next cue transition repaints
    // from the updated per-token styles instead of stale HTML.
    _lastCECue = '';
  }, { passive: false });

  // Y position + font size are computed in pixels from the stage height, so they
  // must be recomputed whenever the layout changes (window resize / maximize),
  // otherwise the caption drifts out of place. Self-removes once this editor's
  // stage leaves the DOM (overlay closed or reopened for another clip).
  const onResize = () => {
    if (!stage.isConnected || !isCaptionStudioOpen()) { window.removeEventListener('resize', onResize); return; }
    requestAnimationFrame(() => { applyCE(); tickCE(); });
  };
  window.addEventListener('resize', onResize);

  document.getElementById('ce_fs').addEventListener('input', e => {
    exitProxy();
    document.getElementById('ce_fsv').textContent = e.target.value;
    e.target.nextElementSibling.textContent = e.target.value;
    state.cfg.subtitleFontSize = +e.target.value; applyCE();
  });
  document.getElementById('ce_fs').addEventListener('change', e => { saveCfg({ subtitleFontSize: +e.target.value }); commitHist(); });
  document.getElementById('ce_y').addEventListener('input', e => {
    exitProxy();
    document.getElementById('ce_yv').textContent = e.target.value;
    e.target.nextElementSibling.textContent = e.target.value;
    state.cfg.subtitleY = +e.target.value; applyCE();
  });
  document.getElementById('ce_y').addEventListener('change', e => { saveCfg({ subtitleY: +e.target.value }); commitHist(); });
  document.getElementById('ce_x').addEventListener('input', e => {
    exitProxy();
    document.getElementById('ce_xv').textContent = e.target.value;
    e.target.nextElementSibling.textContent = e.target.value;
    state.cfg.subtitleX = +e.target.value; applyCE();
  });
  document.getElementById('ce_x').addEventListener('change', e => { saveCfg({ subtitleX: +e.target.value }); commitHist(); });
  // Recenter buttons: snap caption to the frame centre (X=540, Y=960), live.
  function setCaptionPos(axis, value) {
    exitProxy();
    const sl = document.getElementById(axis === 'y' ? 'ce_y' : 'ce_x');
    sl.value = value;
    document.getElementById(axis === 'y' ? 'ce_yv' : 'ce_xv').textContent = value;
    sl.nextElementSibling.textContent = value;
    if (axis === 'y') state.cfg.subtitleY = value; else state.cfg.subtitleX = value;
    applyCE();
    saveCfg(axis === 'y' ? { subtitleY: value } : { subtitleX: value });
    commitHist();   // [UNDO-V1] recenter
  }
  document.getElementById('ce_yc').addEventListener('click', () => setCaptionPos('y', 960));
  document.getElementById('ce_xc').addEventListener('click', () => setCaptionPos('x', 540));
  function selectCaptionStyle(style) {
    exitProxy();
    state.cfg.subtitleStyle = style;
    state.cfg.captionKinetic = '';
    _ceKinCap = null;
    _lastCECue = '';
    applyCE(); tickCE(); tickTitleLayer();
    saveCfg({ subtitleStyle: style, captionKinetic: '' });
    commitHist();
  }
  function selectSoclCaptionControls(patch) {
    exitProxy();
    Object.assign(state.cfg, patch, { captionKinetic: '' });
    _ceKinCap = null;
    _lastCECue = '';
    saveCfg({ ...patch, captionKinetic: '' });
    applyCE(); tickCE(); tickTitleLayer();
  }
  document.querySelectorAll('#ce_style .swatch').forEach(sw => sw.addEventListener('click', () => {
    document.querySelectorAll('#ce_style .swatch').forEach(x => x.classList.remove('active'));
    sw.classList.add('active');
    selectCaptionStyle(sw.dataset.v);
  }));
  // [CUSTOM-CHUNKS] After any re-chunk (fixed N or custom rules) the cue
  // array is rebuilt from scratch, so selection/timeline indices, the words
  // list, the lane, and the preview all need the same refresh either way.
  function afterRechunk() {
    commitHist();              // [UNDO-V1] re-chunk rewrites clip.cueWords
    sel = [];                  // selection invalid after regroup
    tlSelCue = -1;             // cue indexes changed — reset timeline selection
    renderWords(); fillBar(); renderLane(); fillChip();
    requestAnimationFrame(() => { applyCE(); tickCE(); });
  }
  const wpcCustomBox = document.getElementById('ce_wpcCustom');
  const wpcRulesEl = document.getElementById('ce_wpcRules');
  const wpcAddBtn = document.getElementById('ce_wpcAddRule');
  function renderWpcRules() {
    if (!wpcRulesEl) return;
    const rules = clip.customChunkRules;
    if (!rules.length) {
      wpcRulesEl.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:6px 2px">Belum ada rentang custom. Klik "+ Tambah rentang" untuk mengatur words-per-chunk (dan font) di bagian klip tertentu.</div>`;
      return;
    }
    const rowInp = 'padding:4px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.3);color:#fff;font-size:11px';
    wpcRulesEl.innerHTML = rules.map(r => `
      <div class="wpc-rule" data-id="${r.id}" style="display:flex;gap:6px;align-items:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:6px 8px">
        <input type="number" class="wpc-start" step="0.1" min="0" value="${(+r.start).toFixed(2)}" title="Mulai (detik)" style="${rowInp};width:56px">
        <span style="color:var(--muted);font-size:11px">–</span>
        <input type="number" class="wpc-end" step="0.1" min="0" value="${(+r.end).toFixed(2)}" title="Selesai (detik)" style="${rowInp};width:56px">
        <input type="number" class="wpc-words" min="1" max="15" value="${r.words}" title="Words per chunk di rentang ini" style="${rowInp};width:44px">
        <select class="wpc-font" title="Font khusus rentang ini" style="${rowInp};flex:1;min-width:100px">${fontOpts(r.font || '')}</select>
        <button type="button" class="mini-btn wpc-del" title="Hapus rentang" style="color:#ff8080">✕</button>
      </div>`).join('');
    wpcRulesEl.querySelectorAll('.wpc-rule').forEach(row => {
      const id = row.dataset.id;
      const rule = () => clip.customChunkRules.find(r => r.id === id);
      const commitRule = () => {
        exitProxy();
        clip.customChunkRules = window.CustomChunks.sanitizeRules(clip.customChunkRules, clip.end - clip.start);
        rechunkCuesCustom(clip, wpcNumR());
        afterRechunk();
      };
      row.querySelector('.wpc-start').addEventListener('change', e => { const r = rule(); if (r) r.start = +e.target.value || 0; commitRule(); });
      row.querySelector('.wpc-end').addEventListener('change', e => { const r = rule(); if (r) r.end = +e.target.value || 0; commitRule(); });
      row.querySelector('.wpc-words').addEventListener('change', e => { const r = rule(); if (r) r.words = +e.target.value || 3; commitRule(); });
      row.querySelector('.wpc-font').addEventListener('change', e => { const r = rule(); if (r) r.font = e.target.value || ''; commitRule(); });
      row.querySelector('.wpc-del').addEventListener('click', () => {
        clip.customChunkRules = clip.customChunkRules.filter(r => r.id !== id);
        renderWpcRules();
        exitProxy();
        rechunkCuesCustom(clip, wpcNumR());
        afterRechunk();
      });
    });
  }
  wpcAddBtn?.addEventListener('click', () => {
    // Seed a short 3s rule at the playhead — the same "at the current moment"
    // convenience the Titles tab's own "+ Add title @ current time" uses.
    const t0 = vid.currentTime || 0;
    const dur = vidDur();
    clip.customChunkRules.push({
      id: 'wpc_' + Math.random().toString(36).slice(2, 8),
      start: +t0.toFixed(2),
      end: +Math.min(dur, t0 + 3).toFixed(2),
      words: wpcNumR(),
      font: '',
    });
    renderWpcRules();
    exitProxy();
    rechunkCuesCustom(clip, wpcNumR());
    afterRechunk();
  });
  renderWpcRules();
  document.querySelectorAll('#ce_wpc button').forEach(b => b.addEventListener('click', () => {
    exitProxy();
    document.querySelectorAll('#ce_wpc button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (b.dataset.v === 'custom') {
      clip.chunkMode = 'custom';
      if (wpcCustomBox) wpcCustomBox.hidden = false;
      rechunkCuesCustom(clip, wpcNumR());
      afterRechunk();
      return;
    }
    clip.chunkMode = 'fixed';
    if (wpcCustomBox) wpcCustomBox.hidden = true;
    const n = +b.dataset.v;
    saveCfg({ subtitleWordsPerChunk: n });
    rechunkCues(clip, n);
    afterRechunk();
  }));
  // [SUBS-TOGGLE] toolbar switch + the Style-tab segment drive the same flag
  const setSubs = (on) => {
    exitProxy();
    saveCfg({ burnSubtitles: on });
    document.querySelectorAll('#ce_burn button').forEach(x => x.classList.toggle('active', (x.dataset.v === 'on') === on));
    const tg = document.getElementById('ce_subToggle');
    if (tg) { tg.classList.toggle('on', on); tg.textContent = on ? 'Subtitle: ON' : 'Subtitle: OFF'; }
    _lastCECue = ''; tx.textContent = '';
    requestAnimationFrame(() => { applyCE(); tickCE(); });
    toast(on ? 'Subtitle ON — tampil & ikut di video' : 'Subtitle OFF — video tanpa subtitle');
  };
  document.querySelectorAll('#ce_burn button').forEach(b => b.addEventListener('click', () => setSubs(b.dataset.v === 'on')));
  document.getElementById('ce_subToggle')?.addEventListener('click', () => setSubs(!subsOn()));
  document.querySelectorAll('#ce_glow button').forEach(b => b.addEventListener('click', () => {
    exitProxy();
    document.querySelectorAll('#ce_glow button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.cfg.subtitleGlow = b.dataset.v === 'on';
    saveCfg({ subtitleGlow: b.dataset.v === 'on' });
    applyCE();
  }));
  document.querySelectorAll('#ce_box button').forEach(b => b.addEventListener('click', () => {
    exitProxy();
    document.querySelectorAll('#ce_box button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const on = b.dataset.v === 'on';
    const colorInput = document.getElementById('ce_boxColor');
    const row = document.getElementById('ce_boxColorRow');
    const color = on ? (colorInput?.value || '#F1FF00') : '';
    if (row) row.hidden = !on;
    const rotationRow = document.getElementById('ce_boxRotationRow');
    if (rotationRow) rotationRow.hidden = !on;
    selectSoclCaptionControls({ subtitleBoxColor: color });
  }));
  document.getElementById('ce_boxColor')?.addEventListener('input', (e) => {
    // Hanya berarti kalau toggle sedang ON — pengguna tidak bisa mengubah
    // warna sebelum menyalakan box, jadi tidak perlu guard tambahan di sini.
    selectSoclCaptionControls({ subtitleBoxColor: e.target.value });
  });
  const setBoxRotation = (value) => {
    exitProxy();
    const angle = window.CaptionBox.boxRotation(value);
    document.getElementById('ce_boxRotation').value = angle;
    document.getElementById('ce_boxRotationValue').value = angle;
    selectSoclCaptionControls({ subtitleBoxRotation: angle });
  };
  document.getElementById('ce_boxRotation')?.addEventListener('input', e => setBoxRotation(e.target.value));
  document.getElementById('ce_boxRotationValue')?.addEventListener('change', e => setBoxRotation(e.target.value));
  document.getElementById('ce_boxRotationReset')?.addEventListener('click', () => setBoxRotation(0));
  document.querySelectorAll('#ce_anim button').forEach(b => b.addEventListener('click', () => {
    exitProxy();
    document.querySelectorAll('#ce_anim button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _ceReplayAnim = true;   // [CAP-NO-REPLAY] picking an animation should show it
    selectSoclCaptionControls({ subtitleAnim: b.dataset.v });
    restartCaptionAnim(tx);
    replayCaptionAnim();
    commitHist();   // [UNDO-V1] global animation change
  }));
  // [CASE-V1] Text-case segment → state + preview repaint. Render honours it
  // via style.subtitleCase in buildCePayload (applied in pipeline renderClipEdit).
  document.querySelectorAll('#ce_case button').forEach(b => b.addEventListener('click', () => {
    exitProxy();
    document.querySelectorAll('#ce_case button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.cfg.subtitleCase = b.dataset.v;
    saveCfg({ subtitleCase: b.dataset.v });
    applyCE();
    commitHist();   // [UNDO-V1] global text-case change
  }));
  // [REVEAL-CLIP] Highlight this clip's delivered file, not the export root
  // (which, with a custom export folder, is a folder of every session).
  document.getElementById('ce_reveal').addEventListener('click', async () => {
    const r = await window.socl.revealClip({ file: clip.file, clipIndex: clipIdx }).catch(() => null);
    if (!r || !r.ok) {
      window.socl.openOutput(null);
      toast('Berkas klip ini tidak ditemukan — membuka folder hasil.', 'err');
    }
  });

  // ── Per-word styling editor ──────────────────────────────
  // proxyMode is now declared near the top of the setup so [TITLE-V1] handlers
  // above can reference it without hitting TDZ. See ~line 1849.
  // Leaving proxy playback → restore the raw clip so live overlay edits show
  // again. Any live control (font size, X/Y, style, glow, word select) calls
  // this first; without it tickCE keeps the overlay hidden and edits look dead
  // after a "Preview export". Hoisted, so the input handlers above can use it.
  function exitProxy() {
    if (!proxyMode) return;
    if (clip.subsBurned && clip.rawFile === clip.file) {
      const status = document.getElementById('ce_status');
      if (status) status.textContent = 'Sumber video bersih belum tersedia. Caption live disembunyikan agar tidak bertumpuk dengan subtitle pada video.';
      return;
    }
    proxyMode = false;
    // [RAW-SRC] Restore the RAW source, not clip.file — after a full "Render
    // edit", clip.file points at the burned output, and painting live overlay
    // edits on top of that would show captions doubled. clip.rawFile is the
    // untouched pre-edit plate captured once at editor open (see openCaptionEditor).
    cleanSourceLoading = true; ov.style.visibility = 'hidden';
    MediaLifecycle.setMediaSourcePreservingTime(vid,toFileURL(clip.rawFile || clip.file),()=>{
      cleanSourceLoading = false; _lastCECue=''; applyCE(); tickCE();
    });
  }
  // Live edits must leave the burned proxy BEFORE their own handlers repaint.
  // Metadata/resize events can still lay out the proxy without adding text.
  const liveCaptionRoot = captionStudio.body.firstElementChild;
  const leaveProxyForLiveEdit = event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('input,select,textarea') || (event.type === 'click' && target.closest('.cap-panel') && target.closest('button'))) exitProxy();
  };
  ['input','change','click'].forEach(type => liveCaptionRoot?.addEventListener(type,leaveProxyForLiveEdit,true));
  const pwWords = document.getElementById('pw_words');
  const pwBar   = document.getElementById('pw_bar');
  const elFont  = document.getElementById('pw_font');
  const elAnim  = document.getElementById('pw_anim');
  const elBold  = document.getElementById('pw_bold');
  const elItal  = document.getElementById('pw_ital');
  const elColor = document.getElementById('pw_color');
  const elColorOff = document.getElementById('pw_colorOff');
  const elSize  = document.getElementById('pw_size');
  const elText  = document.getElementById('pw_text');
  // Selection model: array of {ci,wi}. Plain click selects one; Cmd/Ctrl-click
  // toggles a word; Shift-click extends a range from the last-selected word
  // through every word between them (across cues).
  let sel = [];
  const selKey = (ci, wi) => `${ci}:${wi}`;
  const isSelected = (ci, wi) => sel.some(s => s.ci === ci && s.wi === wi);
  const lastSel = () => sel.length ? sel[sel.length - 1] : null;
  const tokAt = (ci, wi) => { const cue = (clip.cueWords || [])[ci]; if (!cue) return null; return ensureTokens(cue)[wi] || null; };
  const selectedToks = () => sel.map(s => tokAt(s.ci, s.wi)).filter(Boolean);
  const syncCueText = (cue) => { if (Array.isArray(cue.tokens) && cue.tokens.length) cue.text = cue.tokens.map(t => t.text).join(' '); };
  // Linear word index across all cues — used by Shift-click to compute a range.
  function flatIndex(ci, wi) {
    const cues = clip.cueWords || []; let n = 0;
    for (let i = 0; i < ci && i < cues.length; i++) n += ensureTokens(cues[i]).length;
    return n + wi;
  }
  function fromFlat(idx) {
    const cues = clip.cueWords || []; let n = 0;
    for (let ci = 0; ci < cues.length; ci++) {
      const len = ensureTokens(cues[ci]).length;
      if (idx < n + len) return { ci, wi: idx - n };
      n += len;
    }
    return null;
  }

  function renderWords() {
    const cues = clip.cueWords || [];
    if (!cues.length) { pwWords.innerHTML = '<div class="pw-empty">No cues for this clip.</div>'; return; }
    pwWords.innerHTML = cues.map((cue, ci) => {
      const toks = ensureTokens(cue);
      return `<div class="pw-cue">${toks.map((t, wi) => {
        const styled = (t.style && Object.keys(t.style).length) ? ' is-styled' : '';
        const a = isSelected(ci, wi) ? ' sel' : '';
        return `<span class="pw-word${styled}${a}" data-ci="${ci}" data-wi="${wi}">${esc(t.text)}</span>`;
      }).join('')}</div>`;
    }).join('');
    pwWords.querySelectorAll('.pw-word').forEach(el => {
      el.addEventListener('click', (ev) => {
        const ci = +el.dataset.ci, wi = +el.dataset.wi;
        if (ev.shiftKey && lastSel()) {
          const a = flatIndex(lastSel().ci, lastSel().wi);
          const b = flatIndex(ci, wi);
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const range = [];
          for (let k = lo; k <= hi; k++) { const p = fromFlat(k); if (p) range.push(p); }
          sel = range;
        } else if (ev.metaKey || ev.ctrlKey) {
          const k = selKey(ci, wi);
          sel = isSelected(ci, wi) ? sel.filter(s => selKey(s.ci, s.wi) !== k) : sel.concat({ ci, wi });
        } else {
          sel = [{ ci, wi }];
        }
        afterSelectionChange();
      });
    });
  }
  function afterSelectionChange() {
    exitProxy();
    const last = lastSel();
    if (last) {
      const cue = (clip.cueWords || [])[last.ci];
      if (cue) vid.currentTime = (cue.start || 0) + 0.01;
    }
    renderWords(); fillBar();
    requestAnimationFrame(() => { applyCE(); tickCE(); });
  }
  function fillBar() {
    const toks = selectedToks();
    const any = toks.length > 0;
    const one = toks.length === 1;
    pwBar.dataset.empty = any ? '0' : '1';
    const elPosReset = document.getElementById('pw_posReset');
    [elFont, elAnim, elBold, elItal, elColor, elColorOff, elSize, elPosReset].forEach(e => { if (e) e.disabled = !any; });
    elText.disabled = !one;                       // text edit only for single-word selection
    elText.placeholder = one ? 'edit word text' : (any ? 'multiple words selected' : 'edit word text');
    // fillBar() is the single downstream sync point every selection path
    // funnels through (words-tab click, stage click via endTokDrag, and the
    // stage wheel/pinch resize handler) — anchoring the chip sync here, rather
    // than in afterSelectionChange(), covers all of them including wheel
    // resizes that never call afterSelectionChange(). Called before the
    // early-return below so the chip also resets when selection is cleared.
    fillChipStyle();
    if (!any) return;
    // Show single-word values when one selected; for multi, show shared values
    // or blank if mixed. Toggle buttons reflect "all selected have this on".
    const st = one ? (toks[0].style || {}) : null;
    const allHave = (pred) => toks.every(t => pred(t.style || {}));
    elFont.value  = st ? (st.fn || '')   : (allHave(s => s.fn === (toks[0].style?.fn || '')) ? (toks[0].style?.fn || '') : '');
    elAnim.value  = st ? (st.an || '')   : (allHave(s => (s.an || '') === (toks[0].style?.an || '')) ? (toks[0].style?.an || '') : '');
    elBold.classList.toggle('on', allHave(s => !!s.b));
    elItal.classList.toggle('on', allHave(s => !!s.i));
    elColor.value = st ? (st.color || '#ffffff') : '#ffffff';
    elSize.value  = st ? (st.fs || '')   : '';
    elText.value  = one ? (toks[0].text || '') : '';
  }
  // Apply a mutation to every selected token. `mut(tokenStyleObj, token)` is
  // called for each — return value ignored; mutate in place.
  // [UNDO-V1] `rapid` = true for continuous sources (word text typing, colour
  // drag) so their bursts coalesce into one undo entry via commitHistDebounced.
  function applyToSelection(mut, rapid) {
    const toks = selectedToks(); if (!toks.length) return;
    // Single-point exit-proxy for every per-word mutation route (font, anim,
    // bold/italic, colour, size, text, pos-reset, AI-fix-typo) — mirrors the
    // saveTitles() pattern that fixed the titles realtime bug: any edit here
    // means the burned preview is stale, so drop back to the raw clip so the
    // DOM overlay is what the user sees.
    exitProxy();
    const touchedCues = new Set();
    sel.forEach(({ci, wi}) => {
      const tok = tokAt(ci, wi); if (!tok) return;
      tok.style = tok.style || {};
      mut(tok);
      if (tok.style && Object.keys(tok.style).length === 0) delete tok.style;
      touchedCues.add(ci);
    });
    touchedCues.forEach(ci => syncCueText((clip.cueWords || [])[ci]));
    // Invalidate the tickCE cache so per-word mutations (font/anim/color/dx/dy)
    // repaint during PLAYBACK too, not just while paused. Without this, tickCE
    // keeps the stale HTML because cue.start/text haven't changed → the "edits
    // look dead" symptom returns even after exitProxy.
    _lastCECue = '';
    (rapid ? commitHistDebounced : commitHist)();   // [UNDO-V1]
    renderWords(); fillBar();
    requestAnimationFrame(() => { applyCE(); tickCE(); });
  }
  elFont.addEventListener('change', () => {
    const fam = elFont.value;
    applyToSelection(t => { if (fam) t.style.fn = fam; else delete t.style.fn; });
    // First use of a family triggers its @font-face load; until it resolves the
    // span renders in the fallback font and the change looks "dead". Force the
    // load and repaint once the face is ready so the preview swap is instant
    // and deterministic.
    if (fam && document.fonts?.load) {
      document.fonts.load(`24px "${fam}"`).then(() => {
        _lastCECue = '';
        applyCE(); tickCE();
      }).catch(() => {});
    }
  });
  elAnim.addEventListener('change', () => { _ceReplayAnim = true; applyToSelection(t => { if (elAnim.value) t.style.an = elAnim.value; else delete t.style.an; }); });   // [CAP-NO-REPLAY] show the picked word animation
  // For toggles in multi-select: turn ON for all if any is OFF; otherwise turn OFF for all.
  elBold.addEventListener('click', () => {
    const toks = selectedToks(); if (!toks.length) return;
    const allOn = toks.every(t => (t.style || {}).b);
    applyToSelection(t => { if (allOn) delete t.style.b; else t.style.b = 1; });
  });
  elItal.addEventListener('click', () => {
    const toks = selectedToks(); if (!toks.length) return;
    const allOn = toks.every(t => (t.style || {}).i);
    applyToSelection(t => { if (allOn) delete t.style.i; else t.style.i = 1; });
  });
  elColor.addEventListener('input',  () => applyToSelection(t => { t.style.color = elColor.value; }, true));
  elColorOff.addEventListener('click', () => applyToSelection(t => { delete t.style.color; }));
  elSize.addEventListener('change',  () => applyToSelection(t => { const v = parseInt(elSize.value); if (v) t.style.fs = v; else delete t.style.fs; }));
  elText.addEventListener('input',   () => { if (sel.length !== 1) return; applyToSelection(t => { t.text = elText.value; }, true); });
  document.getElementById('pw_posReset').addEventListener('click', () => applyToSelection(t => { if (t.style) { delete t.style.dx; delete t.style.dy; } }));
  renderWords(); fillBar();

  // ── AI Fix Typo ──────────────────────────────────────────
  // With a selection → fix only those words (style preserved). Otherwise fix
  // every cue line; per-word style survives when the word count is unchanged.
  function detectCaptionLang() {
    const txt = (clip.cueWords || []).map(c => c.text).join(' ').toLowerCase();
    const enHits = (txt.match(/\b(the|and|of|to|is|you|that|with|this|are|was)\b/g) || []).length;
    return enHits >= 5 ? 'en' : 'id';
  }
  document.getElementById('ce_fixtypo').addEventListener('click', async () => {
    const btn = document.getElementById('ce_fixtypo');
    if (btn.disabled) return;
    exitProxy();
    const lang = detectCaptionLang();
    btn.disabled = true; const label = btn.textContent; btn.textContent = '✦ Fixing…';
    try {
      if (sel.length) {
        const refs = sel.map(s => tokAt(s.ci, s.wi)).filter(Boolean);
        const words = refs.map(t => t.text);
        const res = await window.socl.fixTypos({ words, lang });
        if (res?.error) { toast(res.error, 'err'); return; }
        if (!Array.isArray(res.words) || res.words.length !== refs.length) { toast('Respons AI tidak sesuai', 'err'); return; }
        let n = 0;
        refs.forEach((t, i) => { if (res.words[i] && res.words[i] !== t.text) { t.text = res.words[i]; n++; } });
        new Set(sel.map(s => s.ci)).forEach(ci => syncCueText((clip.cueWords || [])[ci]));
        toast(n ? `✓ ${n} kata diperbaiki` : 'Tidak ada typo ditemukan');
      } else {
        const cues = clip.cueWords || [];
        const lines = cues.map(c => c.text);
        const res = await window.socl.fixTypos({ lines, lang });
        if (res?.error) { toast(res.error, 'err'); return; }
        if (!Array.isArray(res.lines) || res.lines.length !== cues.length) { toast('Respons AI tidak sesuai', 'err'); return; }
        let n = 0;
        cues.forEach((cue, ci) => {
          const corrected = String(res.lines[ci] || '').trim();
          if (!corrected || corrected === cue.text) return;
          const toks = ensureTokens(cue);
          const cw = corrected.split(/\s+/).filter(Boolean);
          if (cw.length === toks.length) {
            cw.forEach((w, wi) => { if (w !== toks[wi].text) { toks[wi].text = w; n++; } });
          } else {
            // Word count changed → replace flat text (per-word style for this cue resets).
            cue.text = corrected;
            cue.tokens = cw.map(w => ({ text: w }));
            n++;
          }
          syncCueText(cue);
        });
        toast(n ? `✓ Caption diperbaiki (${n} perubahan)` : 'Tidak ada typo ditemukan');
      }
      commitHist();                               // [UNDO-V1] typo fix is destructive
      sel = sel.filter(s => tokAt(s.ci, s.wi));   // drop selections past rebuilt cues
      renderWords(); fillBar(); renderLane();     // lane labels reflect fixed text
      requestAnimationFrame(() => { applyCE(); tickCE(); });
    } catch (e) {
      toast(`Fix typo gagal: ${e.message || e}`, 'err');
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });

  // ── [WORD-OFFSETS] Bake natural per-word layout offsets for rise/drop ──
  // Data contract with the burn pipeline: any cue containing at least one
  // INLINE (no style.dx/dy) token whose style.an is 'rise' or 'drop' gets
  // tok.ax / tok.ay written on EVERY non-positioned token — the word's natural
  // offset from the cue anchor in canonical 1080x1920 ASS units, using the
  // exact drag-seed formulas (word-center X from tx center, word top from tx
  // top, divided by sc, rounded). Measured on a hidden CLONE of the overlay so
  // the real ov/tx never repaint (no CSS animation restart, no flicker).
  function bakeCueWordOffsets() {
    const cues = Array.isArray(clip.cueWords) ? clip.cueWords : [];
    // [AR-FIT] Same height accessor as applyCE/paintCue — a stale clientHeight
    // here would bake ax/ay against a layout the user never saw, scattering the
    // exploded words in the burn. The clone below is painted with stageH() too,
    // so its font-size and this sc share one height.
    const sc = stageH() / 1920;
    const isPositioned = t => !!(t && t.style && (t.style.dx || t.style.dy));
    for (const cue of cues) {
      let toks;
      try { toks = ensureTokens(cue); } catch { toks = null; }
      if (!Array.isArray(toks) || !toks.length) continue;
      // Mirror the pipeline's explode condition EXACTLY: the burn only enters
      // the per-word path when some token has an an-override, and then
      // explodes when any inline word's EFFECTIVE anim (override OR the
      // cue-level anim) is rise/drop. E.g. main anim = Rise + one word = Pop
      // must bake too — the inherit words still need real \move coordinates.
      const cueAnim = state.cfg.subtitleAnim || 'pop';
      const hasOverride = toks.some(t => t && t.style && t.style.an);
      const needsBake = hasOverride && toks.some(t => {
        if (!t || isPositioned(t)) return false;
        const a = (t.style && t.style.an) || cueAnim;
        return a === 'rise' || a === 'drop';
      });
      // [EMOJI-INLINE] Independent of the rise/drop gate above: which tokens
      // (if any) get an emoji anchored directly above THEM, rather than the
      // row-above-the-whole-cue placement stickerJobs falls back to. Scoped
      // to non-positioned words for now — a rise/drop word already moves via
      // \move, and a static emoji anchor above its rest position would not
      // track it; combining the two is a real follow-up, not attempted here.
      const emojiHits = (state.cfg.emojiStickers === true && window.EmojiMap)
        ? window.EmojiMap.nounTokenIndices(cue).filter(h => !isPositioned(toks[h.index]))
        : [];
      if (!needsBake && !emojiHits.length) {
        // Drop stale offsets so the pipeline never sees leftovers from a
        // previous rise/drop or emoji assignment.
        for (const t of toks) { if (t) { delete t.ax; delete t.ay; delete t.emoji; delete t.eax; delete t.eay; } }
        continue;
      }
      let clone = null;
      try {
        // Clone the real overlay (never touch ov/tx — keeps the visible
        // animation from restarting). Copy className + inline style so the
        // clone lays out with the exact width/left/top/transform applyCE set.
        clone = ov.cloneNode(false);
        clone.className = ov.className;
        clone.style.cssText = ov.style.cssText;
        clone.style.visibility = 'hidden';
        clone.style.pointerEvents = 'none';
        clone.removeAttribute('id');
        const inner = document.createElement('span');
        // Mirror the live tx inline styles: font-size / text-transform /
        // letter-spacing / font-family must match or measurements drift.
        inner.style.cssText = tx.style.cssText;
        clone.appendChild(inner);
        stage.appendChild(clone);
        // [HL-PALETTE] No cue index passed on purpose: this is a hidden clone used
        // only to MEASURE geometry, and the accent colour cannot move a glyph.
        paintCue(inner, cue, state.cfg.subtitleStyle, stageH(), state.cfg.subtitleAnim || 'pop', 0, state.cfg.subtitleFont || '');
        // [BAKE-ANIM-FIX] Kill every animation inside the measurement clone.
        // The anim-* keyframes (capRise 0% = translateY(38px), capDrop -38px,
        // capPop scale(.64)) apply their 0% transform the instant the clone
        // paints, and getBoundingClientRect() INCLUDES transforms — so ay/ax
        // baked with a live animation were biased by the entry offset (~38px
        // preview px ≈ hundreds of canonical px), scattering exploded words in
        // the burn far from their preview spots. We need the NATURAL layout
        // (the \move destination), so measure with animations off.
        inner.querySelectorAll('.pw-tok, .cap-tw-char').forEach(el2 => {
          el2.style.setProperty('animation', 'none', 'important');
        });
        const innerRect = inner.getBoundingClientRect();
        // [EMOJI-INLINE] Which word indices (if any) want an emoji anchor —
        // computed once per cue, outside the per-span loop below.
        const emojiByIndex = new Map(emojiHits.map(h => [h.index, h.emoji]));
        inner.querySelectorAll('.pw-tok:not(.is-pos)').forEach(sp => {
          const wi = +sp.dataset.wi;
          const t = toks[wi];
          if (!t) return;
          const r = sp.getBoundingClientRect();
          if (!isPositioned(t)) {
            t.ax = Math.round(((r.left + r.width / 2) - (innerRect.left + innerRect.width / 2)) / sc);
            t.ay = Math.round((r.top - innerRect.top) / sc);
          }
          // [EMOJI-INLINE] Anchor point directly above THIS word — same
          // canonical frame (cue-box centre/top) ax/ay already use, so the
          // burn can reuse baseX/baseY + the SAME scale factors without a new
          // reference system. Pure arithmetic lives in EmojiMap.inlineAnchor;
          // only the DOM measurement (font-shaping this app has no other way
          // to reproduce headlessly) happens here.
          //
          // relTop is RELATIVE TO THE CUE BOX's own top (innerRect.top), same
          // as ax/ay above — for an ordinary single-line caption this is a
          // small number near 0, NOT the caption's absolute canonical Y
          // (e.g. subtitleY=960). Feeding the absolute Y here once sent a
          // sticker off the bottom of the frame during manual verification.
          if (emojiByIndex.has(wi) && window.EmojiMap) {
            const relTop = (r.top - innerRect.top) / sc;
            const relCenterX = ((r.left + r.width / 2) - (innerRect.left + innerRect.width / 2)) / sc;
            const a = window.EmojiMap.inlineAnchor({
              tokenTop: relTop, tokenCenterX: relCenterX,
              fontSize: state.cfg.subtitleFontSize || 64,
            });
            t.emoji = emojiByIndex.get(wi);
            t.eax = a.ax; t.eay = a.ay; t.esize = a.size;
          } else {
            delete t.emoji; delete t.eax; delete t.eay; delete t.esize;
          }
        });
      } catch {
        /* baking must never break a render — worst case pipeline gets no ax/ay */
      } finally {
        if (clone) { try { clone.remove(); } catch {} }
      }
    }
  }

  // ── Shared render payload (preview proxy + full render share this) ──
  function buildCePayload() {
    // [SUBS-SELFHEAL] Rebuild cueWords from clip.words when empty so an
    // otherwise-recoverable clip doesn't silently render without subs. See
    // ensureCueWords near the top of the file.
    ensureCueWords(clip, state.cfg?.subtitleWordsPerChunk);
    for (const cue of clip.cueWords || []) {
      if (cue.textMotion?.mark && cue.textMotion.mark.kind !== 'none') {
        const words = cue.textMotion.mark.words || [];
        cue.textMotion.mark.rects = captureCaptionExtraRects(cue).filter(r => !words.length || words.includes(r.word));
      }
    }
    return {
      clipIndex:      clipIdx,
      // [RAW-SRC] Always send the pre-edit file, never a previously-burned one —
      // see the clip.rawFile note near the top of openCaptionEditor.
      clipFile:       clip.rawFile || clip.file,
      // [SPLIT-BAKED] srcVideo + clipFormat come from renderSourceFor so a
      // baked Split Screen clip burns ONTO its composite instead of being
      // re-cut from the pre-split master. See render-source.js.
      ...renderSourceFor(clip, formatForAspect(clip.cropAspect, state.cfg.format)),
      clipStart:      clip.start,
      clipEnd:        clip.end,
      clipResolution: state.cfg.resolution,
      cropX:          clip.cropX ?? 50,
      cropY:          clip.cropY ?? 50,
      cropScale:      clip.cropScale,
      cropAspect:     clip.cropAspect || null,
      cropRect:       clip.cropRect || null,
      cropKeyframes:  (clip.cropKF && clip.cropKF.length >= 2)
        ? clip.cropKF.map(k => {
          const out = { t: k.t, x: k.x * 100, y: k.y * 100 };
          if (Number.isFinite(k.w) && Number.isFinite(k.h)) {   // [FREE-KF-WH]
            out.w = k.w * 100; out.h = k.h * 100;
          }
          return out;
        }) : undefined,
      cueWords:       subsOn() ? (clip.cueWords || []) : [],   // [SUBS-TOGGLE]
      broll:          clip.broll || null,   // [COLLAGE-BROLL]
      timeline:       clip.timeline || null,   // [CLIP-TIMELINE]
      /* [SMART-TRACK-REUSE] pass the tracked plan captured during runPipeline
         so Editor Apply/Preview re-cuts from source with the SAME tracking.
         Without this, re-render falls back to centre crop (regression). */
      trackPlan:      clip.trackPlan || null,
      /* [TITLE-V1] persistent titles ride the same payload → ASS burn. */
      titles:         Array.isArray(clip.titles) ? clip.titles : [],
      manualCaptions: Array.isArray(clip.manualCaptions) ? clip.manualCaptions : [],   // [MANUAL-CAPTION]
      /* [AI-STICKER-CACHE] Per-clip, like trackPlan/titles: the AI's prior
         sticker resolutions for THIS clip's cues, so clicking Preview again
         (or Apply, right after) never re-asks for a cue it already resolved. */
      aiStickerCache: clip.aiStickerCache || {},
      style: {
        subtitleStyle:    state.cfg.subtitleStyle,
        subtitleFont:     state.cfg.subtitleFont || '',
        subtitleOffsetMs: state.cfg.subtitleOffsetMs || 0,
        subtitleFontSize: state.cfg.subtitleFontSize,
        subtitleY:        state.cfg.subtitleY,
        subtitleX:        state.cfg.subtitleX || 540,
        subtitleAnim:     state.cfg.subtitleAnim || 'pop',
        subtitleGlow:     state.cfg.subtitleGlow !== false,
        subtitleBoxColor: state.cfg.subtitleBoxColor || '',
        subtitleBoxRotation: window.CaptionBox.boxRotation(state.cfg.subtitleBoxRotation),
        subtitleCase:     state.cfg.subtitleCase || 'none',   // [CASE-V1]
        // [EMOJI-STICKER] Carried on all THREE style builders from the start.
        // The audit before this feature found subtitleFont and subtitleCase
        // present in one payload and missing from another, which is how a
        // setting ends up working in the editor and nowhere else.
        emojiStickers:     state.cfg.emojiStickers === true,
      },
      // [WM-V1] Watermark resolved from project default + this clip's override.
      watermark: currentWatermark(clip),
    };
  }

  // ── Preview export: render the real result (fast proxy) and play it back ──
  // [SPLIT-VS-CAPTION] This used to be a confirm() warning that burning
  // captions would DESTROY an active split, because renderClipEdit always
  // re-cut from srcVideo — a plate that predates the split. It no longer
  // does: renderSourceFor withholds srcVideo for a baked split clip, which
  // puts the burn on renderClipEdit's burn-onto-this-file path and composes
  // the captions over the composite (see render-source.js). The warning went
  // with the limitation; keeping it would train the user to click through a
  // dialog that is no longer true.
  document.getElementById('ce_preview').addEventListener('click', async () => {
    const btn = document.getElementById('ce_preview');
    const stat = document.getElementById('ce_status');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Rendering…';
    stat.innerHTML = `Rendering accurate preview proxy (480p)… <b id="ce_pct2">0%</b> <button id="ce_cancel2" class="ghost-btn" style="margin-left:8px;padding:2px 10px;font-size:11px">Cancel</button>`;
    const offPvProg = window.socl.onRenderProgress?.((d) => {   // [RENDER-PROGRESS]
      if (!d || !d.preview || d.clipIndex !== clipIdx) return;
      const el = document.getElementById('ce_pct2'); if (el) el.textContent = `${d.pct}%`;
    }) || null;
    const cb2 = document.getElementById('ce_cancel2');
    if (cb2) cb2.addEventListener('click', () => { try { window.socl.cancel(); } catch {} cb2.disabled = true; cb2.textContent = 'Cancelling…'; });
    try {
      // [WORD-OFFSETS] bake tok.ax/ay for rise/drop cues before the payload snapshot
      bakeCueWordOffsets();
      let res;
      try { res = await trackRender(window.socl.renderPreview(buildCePayload())); }
      finally { try { offPvProg?.(); } catch {} }
      { const out = BatchRender.interpretRenderResult(res); if (!out.ok) throw new Error(out.error); }
      // [AI-STICKER-CACHE] Persist even from a Preview render — the very next
      // click (Preview again, or Apply) reuses whatever the AI just resolved.
      if (res.aiStickerCache) clip.aiStickerCache = res.aiStickerCache;
      proxyMode = true;
      ov.style.visibility = 'hidden';
      vid.src = `${toFileURL(res.file)}?t=${Date.now()}`;
      vid.load(); vid.play().catch(() => {});
      stat.innerHTML = '▷ <b>Preview proxy</b> — captions/crop burned in. Looks right? Click <b>Render edit</b> for full quality.';
    } catch (e) {
      stat.textContent = `✗ Preview failed: ${e.message || e}`;
      toast(`Preview failed: ${e.message || e}`, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '▷ Preview';
    }
  });

  // Render-with-edits → new file in the same session, raw preserved
  document.getElementById('ce_render').addEventListener('click', async () => {
    const btn = document.getElementById('ce_render');
    const stat = document.getElementById('ce_status');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Applying…';
    // Live Cancel button — clicking it kills the ffmpeg child so a hung render
    // (e.g. ffmpeg.exe stuck on Windows) can be aborted without restarting the app.
    stat.innerHTML = `ffmpeg baking styling into clip… <b id="ce_pct">0%</b> <button id="ce_cancel" class="ghost-btn" style="margin-left:8px;padding:2px 10px;font-size:11px">Cancel</button>`;
    // [RENDER-PROGRESS] live percent from ffmpeg for THIS clip's Apply
    const offCeProg = window.socl.onRenderProgress?.((d) => {
      if (!d || d.preview || d.clipIndex !== clipIdx) return;
      const el = document.getElementById('ce_pct'); if (el) el.textContent = `${d.pct}%`;
      btn.textContent = `Applying… ${d.pct}%`;
    }) || null;
    const cancelBtn = document.getElementById('ce_cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      try { window.socl.cancel(); } catch {}
      cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…';
    });
    try {
      // [WORD-OFFSETS] bake tok.ax/ay for rise/drop cues before the payload snapshot
      bakeCueWordOffsets();
      let res;
      try { res = await trackRender(window.socl.renderEdit(buildCePayload())); }
      finally { try { offCeProg?.(); } catch {} }
      { const out = BatchRender.interpretRenderResult(res); if (!out.ok) throw new Error(out.error); }
      // [AI-STICKER-CACHE] Same persistence as Preview above.
      if (res.aiStickerCache) clip.aiStickerCache = res.aiStickerCache;
      // [EXPORT-PATH] The render succeeded; a failed copy to the user's export
      // folder must be visible (it used to be swallowed entirely) without
      // failing the Apply.
      if (res && res.exportWarning) toast(res.exportWarning, 'err');
      // [RAW-SRC] Full render burns captions/titles into the output pixels, just
      // like the preview proxy — so treat playback the same way: stay in
      // proxyMode (this also hides the title layer, via tickTitleLayer's own
      // proxyMode check) and hide the live subtitle overlay, otherwise the
      // editor draws a second (live) caption pass on top of the burned one.
      // exitProxy() (below) is what takes the editor back out of this state,
      // and it restores clip.rawFile rather than clip.file so the next live
      // edit isn't painted over already-burned pixels either.
      proxyMode = true;
      ov.style.visibility = 'hidden';
      stat.innerHTML = `✓ Applied to gallery: <b>${res.fileName}</b>`;
      toast(`✓ Applied: ${res.fileName}`);
      // Replace this clip's playable file with the new one so the editor reflects it
      // AND so the Detected Clips gallery card shows the newly-styled version
      // (renderGallery reads clip.file → <video src="file://…">).
      clip.file = res.file;
      if (res.thumbnail) clip.thumbnail = res.thumbnail;
      // Editor Apply bakes captions into the file when there ARE captions
      // to bake. If cueWords was empty (rare, but happens for imports with
      // no transcript that even ensureCueWords couldn't rebuild), the
      // renderClipEdit pipeline returns a caption-less file — marking
      // subsBurned=true unconditionally would then hide the JS overlay in
      // the main preview for a clip that has neither burned nor overlaid
      // subs. Anchor on the actual burn condition instead.
      clip.subsBurned = Array.isArray(clip.cueWords) && clip.cueWords.length > 0;
      clip.fxBurned = !!(state.cfg && state.cfg.videoFx);
      // [TITLE-DOUBLE] Same anchor-on-the-actual-burn-condition reasoning as
      // subsBurned above — renderClipEdit only burns titles that were passed
      // in buildCePayload's `titles`, which is exactly clip.titles here.
      clip.titlesBurned = Array.isArray(clip.titles) && clip.titles.length > 0;
      // [WM-DOUBLE] renderClipEdit burns buildCePayload's `watermark`, which
      // was currentWatermark(clip) at click time — recomputing it now still
      // matches unless settings changed mid-render (same narrow staleness
      // window editDirty already accepts elsewhere).
      clip.watermarkBurnedSnapshot = JSON.stringify(currentWatermark(clip));
      // Flag this clip as edited so the gallery batch-bar surfaces the
      // "N edit di Caption Editor · re-render pakai styling terbaru?" prompt.
      clip.editDirty = true;
      // Apply establishes the new checkpoint; later un-applied edits are discarded.
      await persistCaptionSettings({ ...state.cfg });
      savedCfg = structuredClone(state.cfg);
      savedClip = structuredClone(clip);
      state.batchBarDismissed = false;
      if (state.selectMode) setSelectMode(false);
      vid.src = `${toFileURL(res.file)}?t=${Date.now()}`;
      vid.load(); vid.play().catch(() => {});
      // Refresh the gallery card so the thumbnail/video reflects the applied
      // styling immediately — no need to close the editor.
      try { renderGallery(); } catch {}
      // [APPLY-RESYNC] The dashboard preview (els.preview) is a DIFFERENT
      // <video> from the editor's, and its caption state lives in
      // state.previewSubsBurned / state.cueWords — both of which are ONLY ever
      // written by loadPreview(). Apply rewrites clip.file to a freshly BURNED
      // file and flips clip.subsBurned, but without re-running loadPreview the
      // dashboard keeps the pre-edit src AND keeps drawing the live JS caption
      // overlay (previewSubsBurned still false) — so the moment its src does
      // catch up, burned pixels and the live overlay stack: the "subtitle
      // double / tidak auto-update" report. Closing the editor doesn't fix it
      // either; the close handlers only tear down the editor's own rAF.
      // openCaptionEditor is always preceded by loadPreview(idx) with the same
      // index, so clipIdx === state.activeClip holds here and this re-syncs
      // exactly the clip that was edited. autoplay:false so re-syncing behind
      // the open editor never starts a second soundtrack.
      try { loadPreview(clipIdx, { autoplay: false }); } catch (e) { console.error('[apply] preview resync', e); }
    } catch (e) {
      stat.textContent = `✗ ${e.message || e}`;
      toast(`Apply failed: ${e.message || e}`, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '✓ Apply';
    }
  });

  // ── [MOMO-TL] Cue timeline ────────────────────────────────
  const tlScroll = document.getElementById('tl_scroll');
  const tlTrack  = document.getElementById('tl_track');
  const tlRuler  = document.getElementById('tl_ruler');
  const tlFilm   = document.getElementById('tl_film');
  const tlLane   = document.getElementById('tl_lane');
  const tlTitleLane = document.getElementById('tl_titlelane');
  const tlPh     = document.getElementById('tl_ph');
  const tlPhT    = document.getElementById('tl_phT');
  const tlCur    = document.getElementById('tl_cur');
  const tlMeta   = document.getElementById('tl_meta');
  const tlZoom   = document.getElementById('tl_zoom');
  const tlPlayBtn = document.getElementById('tl_play');
  let tlSelCue = -1;           // selected cue index (timeline-side)
  let tlSelMc = -1;            // selected manual-caption index (timeline-side)
  let tlSelTitle = null;       // selected title id (timeline-side) — independent
                                // of `selTitle` (word-inside-a-title selection
                                // used by the per-word style bar in the Titles tab)
  let tlZoomF = 1;

  const fmtT = (t) => {
    t = Math.max(0, +t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const vidDur = () => (Number.isFinite(vid.duration) && vid.duration > 0) ? vid.duration : (Math.max(1, (clip.end - clip.start) || 60));
  const trackW = () => Math.max(1, tlScroll.clientWidth * tlZoomF);

  // ── [FILM-V1] Thumbnail filmstrip ──────────────────────────
  // Extracts a fixed number of frames from an OFFSCREEN clone of the clip
  // (never the visible #capVideo) so generating thumbnails never flickers
  // the live preview. Tile COUNT scales with clip duration (~1 tile/sec,
  // capped) instead of a flat 28 — a short flat count looked fine at the
  // default zoom but turned into a handful of frames blown up big and blurry
  // once the user zoomed in to line thumbnails up against per-word cues.
  // Each tile is positioned by TIME PERCENTAGE (left/width, same coordinate
  // system as .tl-ruler ticks and .tl-lane cues) rather than flex-equal-
  // division, so it stays pixel-aligned with the cue lane at any zoom level
  // — zooming just spreads the existing tiles further apart along with
  // everything else on the same time axis, no regeneration needed.
  function filmFrameCount(dur) { return Math.min(80, Math.max(16, Math.round(dur))); }
  let _filmToken = 0;   // invalidates a stale in-flight build if the editor closes/reopens
  function seekOnce(v, t) { return MediaLifecycle.seekFrame(v,t); }
  async function buildFilmstrip() {
    const myToken = ++_filmToken;
    const dur = vidDur();
    if (!(dur > 0) || !vid.currentSrc) return;
    tlFilm.className = 'tl-film loading';
    tlFilm.textContent = 'Memuat filmstrip…';

    const off = document.createElement('video');
    try { await MediaLifecycle.loadCanvasVideo(off,vid.currentSrc); }
    catch {
      MediaLifecycle.releaseMedia(off);
      if (myToken === _filmToken) { tlFilm.className='tl-film'; tlFilm.textContent='Filmstrip gagal dimuat. Tutup lalu buka kembali editor.'; }
      return;
    }
    if (myToken !== _filmToken) { MediaLifecycle.releaseMedia(off); return; }   // superseded — bail quietly

    const aspect = (off.videoWidth && off.videoHeight) ? off.videoWidth / off.videoHeight : 9 / 16;
    const H = 60;
    const canvas = document.createElement('canvas');
    canvas.height = H; canvas.width = Math.max(1, Math.round(H * aspect));
    const ctx = canvas.getContext('2d');

    const N = filmFrameCount(dur);
    const urls = [];
    let failedFrames = 0;
    for (let i = 0; i < N; i++) {
      if (myToken !== _filmToken) { MediaLifecycle.releaseMedia(off); return; }
      const t = ((i + 0.5) / N) * dur;   // midpoint of this tile's time segment
      try {
        await seekOnce(off, t);
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
        urls.push(canvas.toDataURL('image/jpeg', 0.55));
        failedFrames = 0;
      } catch { if (++failedFrames >= 3) break; }
    }
    MediaLifecycle.releaseMedia(off);
    if (myToken !== _filmToken) return;

    tlFilm.className = 'tl-film';
    if (!urls.length) { tlFilm.textContent='Frame video tidak dapat dibaca. Tutup lalu buka kembali editor.'; return; }
    tlFilm.innerHTML = urls.map((u, i) => {
      const left = (i / N) * 100, width = (1 / N) * 100;
      return `<img src="${u}" style="left:${left}%;width:${width}%" draggable="false">`;
    }).join('');
  }

  function renderRuler() {
    const dur = vidDur(), W = trackW();
    tlTrack.style.width = W + 'px';
    const pxPerSec = W / dur;
    let step = pxPerSec > 60 ? 1 : pxPerSec > 25 ? 2 : pxPerSec > 12 ? 5 : 10;
    // Guard: never emit more than ~200 ticks (huge durations / tiny steps).
    if (dur / step > 200) step = Math.ceil(dur / 200);
    let html = '';
    for (let t = 0; t <= dur; t += step) html += `<span class="tick" style="left:${(t / dur) * 100}%">${fmtT(t).replace(/\.\d+$/, '')}</span>`;
    tlRuler.innerHTML = html;
  }

  function renderCueGutter() {
    const host = document.getElementById('ceGutterCues');
    if (!host) return;
    const cues = clip.cueWords || [];
    host.innerHTML = cues.length
      ? cues.map((c, i) => {
          const on = i === tlSelCue ? ' on' : '';
          return `<div class="cg-row${on}" data-ci="${i}"><time>${fmtT(+c.start || 0)}</time><p>${esc((c.text || '').slice(0, 60))}</p></div>`;
        }).join('')
      : `<div class="cg-empty">No cues for this clip.</div>`;
    host.querySelectorAll('.cg-row').forEach(row => {
      row.addEventListener('click', () => selectCueFromTimeline(+row.dataset.ci));
    });
  }

  const TITLE_ROW_H = 20, TITLE_ROW_GAP = 3;
  function renderTitleLane() {
    if (!tlTitleLane) return;
    const dur = vidDur();
    const { rows, rowCount } = window.TitleLane.assignRows(clip.titles || []);
    tlTitleLane.style.height = (Math.max(1, rowCount) * TITLE_ROW_H + Math.max(0, rowCount - 1) * TITLE_ROW_GAP) + 'px';
    tlTitleLane.innerHTML = rows.map(t => {
      const s = +t.start || 0, e = Number.isFinite(+t.end) ? +t.end : s;
      const l = (s / dur) * 100;
      const w = Math.max(0.4, ((e - s) / dur) * 100);
      const top = t._row * (TITLE_ROW_H + TITLE_ROW_GAP);
      const on = t.id === tlSelTitle ? ' on' : '';
      const label = esc((t.text || '').slice(0, 40));
      return `<div class="tl-title${on}" data-tid="${t.id}" style="left:${l}%;width:${w}%;top:${top}px;height:${TITLE_ROW_H}px" title="${label}">` +
             `<span class="hnd l" data-h="l"></span>${label}<span class="hnd r" data-h="r"></span></div>`;
    }).join('');
    bindTitleLane();
  }

  // [TITLE-LANE] Clicking empty space in the Title lane USED to create a new
  // title there. That made a title appear from an ordinary click anywhere in
  // the lane — including a click meant only to deselect, scrub, or just look
  // around — with no confirmation and no visible "you just added something"
  // moment. Title creation now happens ONLY through the explicit "+ Add
  // title" button (ce_addTitle); the lane is click-to-select / drag-to-move
  // only. See bindTitleLane() below for per-bar selection and drag.

  // Selecting a title from the timeline: highlight it in the lane, switch to
  // the Titles tab, and scroll its card into view — mirrors selectCueFromTimeline
  // for the cue lane, but titles have no per-word "Words" tab equivalent to sync.
  function selectTitleFromTimeline(id, opts) {
    tlSelTitle = id;
    showTab('titles');
    renderTitleLane();
    renderTitlesList();
    requestAnimationFrame(() => {
      titlesListEl.querySelector(`.title-card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  function applyTitleDrag(id, ns, ne, el) {
    const T = clip.titles.find(x => x.id === id);
    if (!T) return;
    T.start = ns; T.end = ne;
    if (el) {
      const dur = vidDur();
      el.style.left  = (ns / dur) * 100 + '%';
      el.style.width = Math.max(0.4, ((ne - ns) / dur) * 100) + '%';
    }
    tickTitleLayer();
  }
  function commitTitleDrag() {
    exitProxy();
    commitHist();   // [UNDO-V1] title move/resize via the timeline
    renderTitleLane(); renderTitlesList();
  }

  function bindTitleLane() {
    tlTitleLane.querySelectorAll('.tl-title').forEach(el => {
      const tid = el.dataset.tid;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('hnd')) return;
        if (el.dataset.dragged === '1') { el.dataset.dragged = ''; return; }
        selectTitleFromTimeline(tid);
      });
      el.addEventListener('pointerdown', (e) => {
        const T = clip.titles.find(x => x.id === tid); if (!T) return;
        const mode = e.target.dataset.h || 'move';   // 'l' | 'r' | 'move'
        const dur = vidDur();
        const secPerPx = dur / trackW();
        const s0 = +T.start || 0, e0 = Number.isFinite(+T.end) ? +T.end : s0, x0 = e.clientX;
        if (tid !== tlSelTitle) selectTitleFromTimeline(tid);
        const dragEl = tlTitleLane.querySelector(`.tl-title[data-tid="${tid}"]`) || el;
        dragEl.setPointerCapture(e.pointerId);
        let ns = s0, ne = e0;
        let dragRaf = 0;
        const onMove = (ev) => {
          const dt = (ev.clientX - x0) * secPerPx;
          if (Math.abs(ev.clientX - x0) > 3) dragEl.dataset.dragged = '1';
          const MIN_DUR = 0.3;
          if (mode === 'move') {
            const rawS = s0 + dt, rawE = e0 + dt;
            // Clamp the whole span to [0, dur] without changing its length.
            const clampedS = Math.max(0, Math.min(rawS, dur - (e0 - s0)));
            ns = clampedS; ne = clampedS + (e0 - s0);
          } else if (mode === 'l') {
            ns = Math.max(0, Math.min(s0 + dt, e0 - MIN_DUR));
            ne = e0;
          } else {
            ns = s0;
            ne = Math.min(dur, Math.max(e0 + dt, s0 + MIN_DUR));
          }
          if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; applyTitleDrag(tid, ns, ne, dragEl); });
        };
        const cleanup = () => {
          if (dragRaf) cancelAnimationFrame(dragRaf);
          dragEl.removeEventListener('pointermove', onMove);
          dragEl.removeEventListener('pointerup', onUp);
          dragEl.removeEventListener('pointercancel', onCancel);
        };
        const onUp = () => { cleanup(); commitTitleDrag(); };
        const onCancel = () => { applyTitleDrag(tid, s0, e0, dragEl); cleanup(); commitTitleDrag(); };
        dragEl.addEventListener('pointermove', onMove);
        dragEl.addEventListener('pointerup', onUp);
        dragEl.addEventListener('pointercancel', onCancel);
        e.preventDefault();
      });
    });
  }

  // [TITLE-DEL-KEY] Delete/Backspace removes the title currently selected in
  // the timeline lane (tlSelTitle) — the keyboard equivalent of the Titles
  // tab's ✕ button, and the same shortcut per-word editing already trains the
  // user to expect. Ignored while typing in any field so it never eats a
  // real Backspace in the title-text input. Named + torn down alongside
  // onHistKey below so reopening the editor for another clip doesn't stack a
  // second copy of this listener.
  function onTitleDeleteKey(e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!tlSelTitle) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    const id = tlSelTitle;
    clip.titles = clip.titles.filter(x => x.id !== id);
    if (selTitle.id === id) selTitle = { id: null, wi: -1 };
    tlSelTitle = null;
    renderTitlesList();
    saveTitles();
  }
  document.addEventListener('keydown', onTitleDeleteKey);

  function renderLane() {
    const cues = clip.cueWords || [];
    const dur = vidDur();
    tlLane.innerHTML = cues.map((c, i) => {
      const l = ((+c.start || 0) / dur) * 100;
      const w = Math.max(0.4, (((+c.end || 0) - (+c.start || 0)) / dur) * 100);
      const on = i === tlSelCue ? ' on' : '';
      const label = esc((c.text || '').slice(0, 40));
      return `<div class="tl-cue${on}" data-ci="${i}" style="left:${l}%;width:${w}%" title="${label}">` +
             `<span class="hnd l" data-h="l"></span>${label}<span class="hnd r" data-h="r"></span></div>`;
    }).join('');
    bindLane();
    renderCueGutter();
    renderTitleLane();
    renderMcLane();
  }

  function selectCueFromTimeline(ci, opts) {
    tlSelCue = ci;
    const cue = (clip.cueWords || [])[ci];
    if (!cue) return;
    const toks = ensureTokens(cue);
    sel = toks.map((_, wi) => ({ ci, wi }));   // select the whole chunk in Words tab
    // The chip's implicit-selection fallback (ensureChipSelection) passes
    // keepTab so a chip edit doesn't yank the user off whatever tab they're
    // on; direct timeline-lane clicks/prev/next keep the normal tab-switch.
    if (!(opts && opts.keepTab)) showTab('words');
    afterSelectionChange();                    // seeks to cue.start + repaints
    renderLane(); fillChip();
  }

  // ── Cue retiming ───────────────────────────────────────────
  // MID-DRAG REBUILD FLAW & FIX:
  //   renderLane() replaces tlLane.innerHTML, which destroys the very element
  //   being dragged (killing its pointer capture + move/up listeners) after the
  //   first pixel. Fix = split the work:
  //     • applyRetime(): live path used on every pointermove. Writes
  //       clip.cueWords, then updates ONLY the dragged element's inline
  //       left/width and the chip number inputs, plus a rAF-throttled preview
  //       repaint (applyCE/tickCE/tickTL). It NEVER rebuilds the lane, so the
  //       dragged element and its capture survive the whole gesture.
  //     • commitRetime(): heavy path used once on pointerup (and by the chip
  //       inputs). Does the full renderLane()+fillChip()+renderWords() rebuild
  //       and invalidates the burned proxy (exitProxy) — expensive things we
  //       must not run per-move.
  let _retimeRaf = 0;
  function _retimePreview() {
    _retimeRaf = 0;
    _lastCECue = '';          // force tickCE repaint of the retimed cue
    applyCE(); tickCE(); tickTL();
  }
  function applyRetime(ci, ns, ne, el) {
    const out = window.CueRetime.retimeCue(clip.cueWords || [], ci, ns, ne, { videoDur: vidDur() });
    clip.cueWords = out;
    const cue = out[ci];
    if (cue) {
      if (el) {
        const dur = vidDur();
        el.style.left  = ((+cue.start || 0) / dur) * 100 + '%';
        el.style.width = Math.max(0.4, (((+cue.end || 0) - (+cue.start || 0)) / dur) * 100) + '%';
      }
      tlCs.value = (+cue.start || 0).toFixed(2);
      tlCe.value = (+cue.end || 0).toFixed(2);
    }
    if (!_retimeRaf) _retimeRaf = requestAnimationFrame(_retimePreview);
  }
  function commitRetime(ci, ns, ne) {
    const out = window.CueRetime.retimeCue(clip.cueWords || [], ci, ns, ne, { videoDur: vidDur() });
    clip.cueWords = out;
    exitProxy();            // edited timing invalidates any burned preview proxy
    commitHist();           // [UNDO-V1] cue retime (chip inputs + drag release)
    _lastCECue = '';        // force tickCE repaint
    renderLane(); fillChip(); renderWords();
    requestAnimationFrame(() => { applyCE(); tickCE(); tickTL(); });
  }

  function bindLane() {
    tlLane.querySelectorAll('.tl-cue').forEach(el => {
      const ci = +el.dataset.ci;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('hnd')) return;
        if (el.dataset.dragged === '1') { el.dataset.dragged = ''; return; }
        selectCueFromTimeline(ci);
      });
      el.addEventListener('pointerdown', (e) => {
        const cues = clip.cueWords || []; const cue = cues[ci]; if (!cue) return;
        const mode = e.target.dataset.h || 'move';       // 'l' | 'r' | 'move'
        const secPerPx = vidDur() / trackW();
        const s0 = +cue.start || 0, e0 = +cue.end || 0, x0 = e.clientX;
        // Selecting rebuilds the lane (destroying `el`); do it first, then
        // re-acquire the FRESH element and capture the pointer on that one so
        // the drag survives.
        if (ci !== tlSelCue) selectCueFromTimeline(ci);
        const dragEl = tlLane.querySelector(`.tl-cue[data-ci="${ci}"]`) || el;
        dragEl.setPointerCapture(e.pointerId);
        let ns = s0, ne = e0;
        // [SMOOTH-DRAG] pointermove fires far faster than the display can
        // paint (often 120Hz+ on a trackpad); running the cue-array clone in
        // retimeCue on every raw event did more work than any frame could
        // show. Coalesce to one retimeCue+repaint per animation frame — the
        // pointer position is still sampled every event (ns/ne always hold
        // the latest), only the (expensive) apply is throttled.
        let dragRaf = 0;
        const onMove = (ev) => {
          const dt = (ev.clientX - x0) * secPerPx;
          if (Math.abs(ev.clientX - x0) > 3) dragEl.dataset.dragged = '1';
          if (mode === 'move')      { ns = s0 + dt; ne = e0 + dt; }
          else if (mode === 'l')    { ns = s0 + dt; ne = e0; }
          else                      { ns = s0;      ne = e0 + dt; }
          if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; applyRetime(ci, ns, ne, dragEl); });
        };
        const cleanup = () => {
          if (dragRaf) cancelAnimationFrame(dragRaf);
          dragEl.removeEventListener('pointermove', onMove);
          dragEl.removeEventListener('pointerup', onUp);
          dragEl.removeEventListener('pointercancel', onCancel);
        };
        const onUp = () => { cleanup(); commitRetime(ci, ns, ne); };
        const onCancel = () => { cleanup(); commitRetime(ci, s0, e0); };  // revert
        dragEl.addEventListener('pointermove', onMove);
        dragEl.addEventListener('pointerup', onUp);
        dragEl.addEventListener('pointercancel', onCancel);
        e.preventDefault();
      });
    });
  }

  // [MANUAL-CAPTION] Timeline lane — shows EVERY manual caption (inline and
  // layer both), tinted to distinguish from auto-caption cues. Drag-retime
  // reuses the identical move/left-handle/right-handle mechanics as bindLane().
  function renderMcLane() {
    const mcLaneEl = document.getElementById('tl_mclane');
    if (!mcLaneEl) return;
    const entries = clip.manualCaptions || [];
    const dur = vidDur();
    mcLaneEl.innerHTML = entries.map((m, i) => {
      const l = ((+m.start || 0) / dur) * 100;
      const w = Math.max(0.4, (((+m.end || 0) - (+m.start || 0)) / dur) * 100);
      const on = i === tlSelMc ? ' on' : '';
      const label = esc((m.text || '(kosong)').slice(0, 40)) + (m.mode === 'layer' ? ' [layer]' : '');
      return `<div class="tl-mc${on}" data-mi="${i}" style="left:${l}%;width:${w}%" title="${label}">` +
             `<span class="hnd l" data-h="l"></span>${label}<span class="hnd r" data-h="r"></span></div>`;
    }).join('');
    bindMcLane();
  }

  function bindMcLane() {
    const mcLaneEl = document.getElementById('tl_mclane');
    if (!mcLaneEl) return;
    mcLaneEl.querySelectorAll('.tl-mc').forEach(el => {
      const mi = +el.dataset.mi;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('hnd')) return;
        if (el.dataset.dragged === '1') { el.dataset.dragged = ''; return; }
        tlSelMc = mi;
        renderMcLane(); fillChip(); fillMcChip();
      });
      el.addEventListener('pointerdown', (e) => {
        const entries = clip.manualCaptions || []; const m = entries[mi]; if (!m) return;
        const mode = e.target.dataset.h || 'move';
        const secPerPx = vidDur() / trackW();
        const s0 = +m.start || 0, e0 = +m.end || 0, x0 = e.clientX;
        if (mi !== tlSelMc) { tlSelMc = mi; renderMcLane(); fillChip(); fillMcChip(); }
        const dragEl = mcLaneEl.querySelector(`.tl-mc[data-mi="${mi}"]`) || el;
        dragEl.setPointerCapture(e.pointerId);
        let ns = s0, ne = e0, dragRaf = 0;
        const apply = () => {
          m.start = Math.max(0, ns); m.end = Math.max(m.start + 0.1, ne);
          dragEl.style.left = ((m.start / vidDur()) * 100) + '%';
          dragEl.style.width = Math.max(0.4, ((m.end - m.start) / vidDur()) * 100) + '%';
          fillChip();
        };
        const onMove = (ev) => {
          const dt = (ev.clientX - x0) * secPerPx;
          if (Math.abs(ev.clientX - x0) > 3) dragEl.dataset.dragged = '1';
          if (mode === 'move')      { ns = s0 + dt; ne = e0 + dt; }
          else if (mode === 'l')    { ns = s0 + dt; ne = e0; }
          else                      { ns = s0;      ne = e0 + dt; }
          if (!dragRaf) dragRaf = requestAnimationFrame(() => { dragRaf = 0; apply(); });
        };
        const cleanup = () => {
          if (dragRaf) cancelAnimationFrame(dragRaf);
          dragEl.removeEventListener('pointermove', onMove);
          dragEl.removeEventListener('pointerup', onUp);
          dragEl.removeEventListener('pointercancel', onCancel);
        };
        const onUp = () => { cleanup(); renderMcList(); saveManualCaptions(); };
        const onCancel = () => { m.start = s0; m.end = e0; cleanup(); renderMcLane(); };
        dragEl.addEventListener('pointermove', onMove);
        dragEl.addEventListener('pointerup', onUp);
        dragEl.addEventListener('pointercancel', onCancel);
        e.preventDefault();
      });
    });
  }

  document.getElementById('tl_mcdel')?.addEventListener('click', () => {
    const m = (clip.manualCaptions || [])[tlSelMc];
    if (!m) return;
    clip.manualCaptions = clip.manualCaptions.filter(x => x.id !== m.id);
    tlSelMc = -1;
    renderMcList(); renderMcLane(); fillMcChip();
    saveManualCaptions();
  });

  // Playhead + time readout — rAF while playing, timeupdate as fallback.
  function tickTL() {
    const dur = vidDur();
    const x = ((vid.currentTime || 0) / dur) * 100;
    tlPh.style.left = x + '%';
    tlPhT.textContent = fmtT(vid.currentTime);
    tlCur.textContent = fmtT(vid.currentTime);
    tlMeta.textContent = ` / ${fmtT(dur)} · klip ${Math.round(dur)}s @ ${fmtT(clip.start || 0)} sumber`;
    if (!vid.paused && tlZoomF > 1) {
      const phPx = (x / 100) * trackW();
      if (phPx < tlScroll.scrollLeft + 40 || phPx > tlScroll.scrollLeft + tlScroll.clientWidth - 40)
        tlScroll.scrollLeft = Math.max(0, phPx - tlScroll.clientWidth / 2);
    }
  }
  let tlRaf = 0;
  function tlLoop() { if (!vid.isConnected) { tlRaf = 0; return; } tickTL(); tlRaf = vid.paused ? 0 : requestAnimationFrame(tlLoop); }
  vid.addEventListener('play',  () => { tlPlayBtn.textContent = '❚❚'; if (!tlRaf) tlLoop(); });
  vid.addEventListener('pause', () => { tlPlayBtn.textContent = '▶'; tlRaf = 0; tickTL(); });
  vid.addEventListener('timeupdate', tickTL);
  vid.addEventListener('loadedmetadata', () => { renderRuler(); renderLane(); tickTL(); buildFilmstrip(); });

  // Transport
  tlPlayBtn.addEventListener('click', () => { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); });
  document.getElementById('tl_prev').addEventListener('click', () => {
    const cues = clip.cueWords || [];
    const t = vid.currentTime - 0.05;
    for (let i = cues.length - 1; i >= 0; i--) if ((+cues[i].start || 0) < t) { selectCueFromTimeline(i); return; }
  });
  document.getElementById('tl_next').addEventListener('click', () => {
    const cues = clip.cueWords || [];
    for (let i = 0; i < cues.length; i++) if ((+cues[i].start || 0) > vid.currentTime + 0.05) { selectCueFromTimeline(i); return; }
  });

  // Click on ruler/empty lane = seek
  tlTrack.addEventListener('click', (e) => {
    // [TITLE-LANE] #tl_titlelane is a child of #tl_track, so a click on a title
    // bar (or the tail of a move/resize drag — preventDefault on pointerdown
    // does not suppress the click) bubbled here and ALSO yanked the playhead.
    // The cue lane was already excluded; the newer title lane was not.
    if (e.target.closest('.tl-cue') || e.target.closest('.tl-title')) return;
    const r = tlTrack.getBoundingClientRect();
    vid.currentTime = ((e.clientX - r.left) / r.width) * vidDur();
  });

  // Zoom
  tlZoom.addEventListener('input', () => { tlZoomF = +tlZoom.value || 1; renderRuler(); renderLane(); tickTL(); });

  const tlChip = document.getElementById('tl_chip');
  const tlCs = document.getElementById('tl_cs'), tlCe = document.getElementById('tl_ce');
  function fillChip() {
    const cue = (clip.cueWords || [])[tlSelCue];
    tlChip.hidden = !cue;
    if (!cue) return;
    tlCs.value = (+cue.start || 0).toFixed(2);
    tlCe.value = (+cue.end || 0).toFixed(2);
    fillChipStyle();
  }

  // [MANUAL-CAPTION] Separate mini-chip (not tl_chip) since Manual Caption has
  // no font/anim/box controls to show — just start/end (read-only summary;
  // editing happens via drag on the lane or the list card's own inputs) and a
  // delete shortcut. Kept minimal on purpose: the list card is the primary
  // editing surface, this chip is a fast delete/preview-glance while scrubbing.
  function fillMcChip() {
    const mcChip = document.getElementById('tl_mcchip');
    if (!mcChip) return;
    const m = (clip.manualCaptions || [])[tlSelMc];
    mcChip.hidden = !m;
    if (!m) return;
    document.getElementById('tl_mctext').textContent = m.text || '(kosong)';
  }
  tlCs.addEventListener('change', () => {
    const c = (clip.cueWords || [])[tlSelCue]; if (!c) return;
    const v = parseFloat(tlCs.value);
    if (!Number.isFinite(v)) { fillChip(); return; }
    commitRetime(tlSelCue, v, +c.end);
  });
  tlCe.addEventListener('change', () => {
    const c = (clip.cueWords || [])[tlSelCue]; if (!c) return;
    const v = parseFloat(tlCe.value);
    if (!Number.isFinite(v)) { fillChip(); return; }
    commitRetime(tlSelCue, +c.start, v);
  });

  // [CUE-DELETE] Hapus cue terpilih. Juga buang kata-kata sumber (clip.words)
  // di rentang cue itu supaya "Words per chunk" / re-chunk tidak menghidupkan
  // subtitle yang sudah dihapus.
  document.getElementById('tl_del').addEventListener('click', () => {
    const cues = clip.cueWords || [];
    const cue = cues[tlSelCue];
    if (!cue) { toast('Pilih cue di timeline dulu.', 'err'); return; }
    if (Array.isArray(clip.words)) {
      const s0 = (+cue.start || 0) - 0.001, e0 = (+cue.end || 0) + 0.001;
      clip.words = clip.words.filter(w => !((+w.start || 0) >= s0 && (+w.end || 0) <= e0));
    }
    cues.splice(tlSelCue, 1);
    commitHist();              // [UNDO-V1] cue delete
    tlSelCue = -1; sel = [];
    _lastCECue = ''; _lastCECueIdx = -1;
    exitProxy();               // burned proxy no longer matches the cue list
    renderLane(); fillChip(); renderWords();
    requestAnimationFrame(() => { applyCE(); tickCE(); tickTL(); });
  });

  // [CUE-SHIFT] Geser SEMUA cue (start+end) sebesar d detik — perbaikan cepat
  // saat seluruh subtitle telat/kecepetan terhadap audio hasil render.
  function shiftAllCues(d) {
    const cues = clip.cueWords || [];
    if (!cues.length || !d) return;
    // Jangan sampai cue paling awal terdorong ke waktu negatif.
    const minS = Math.min(...cues.map(c2 => +c2.start || 0));
    if (minS + d < 0) d = -minS;
    if (!d) return;
    cues.forEach(c2 => {
      c2.start = Math.max(0, (+c2.start || 0) + d);
      c2.end   = Math.max(c2.start + 0.05, (+c2.end || 0) + d);
      if (Array.isArray(c2.tokens)) c2.tokens.forEach(t => {
        if (t && t.start != null) t.start = +t.start + d;
        if (t && t.end   != null) t.end   = +t.end + d;
      });
    });
    if (Array.isArray(clip.words)) clip.words.forEach(w => {
      if (w) { w.start = (+w.start || 0) + d; w.end = (+w.end || 0) + d; }
    });
    _lastCECue = '';
    exitProxy();
    commitHistDebounced();   // [UNDO-V1] coalesce rapid ±0.1s nudges into one entry
    renderLane(); fillChip();
    requestAnimationFrame(() => { applyCE(); tickCE(); tickTL(); });
  }
  document.getElementById('tl_shL').addEventListener('click', () => shiftAllCues(-0.1));
  document.getElementById('tl_shR').addEventListener('click', () => shiftAllCues(+0.1));
  // ── Chip quick styling: font / anim / size ──
  // These do NOT hold their own state — they proxy the existing per-word
  // (pw_*) controls by setting the control's value and dispatching a
  // synthetic 'change' event, so all the mutation/apply logic lives in one
  // place (avoids a second source of truth for word styling).
  const tlFont = document.getElementById('tl_font');
  const tlAnim = document.getElementById('tl_anim');
  tlFont.innerHTML = CAPTION_FONTS.map(f => `<option value="${f.value}">${f.label}</option>`).join('');
  tlAnim.innerHTML = CAPTION_ANIMS.map(a => `<option value="${a.value}">${a.label}</option>`).join('');

  // If nothing is selected in the pw subsystem, treat the chip's active cue
  // as an implicit whole-cue selection so chip edits have somewhere to land.
  function ensureChipSelection() {
    if (!sel.length && tlSelCue >= 0) selectCueFromTimeline(tlSelCue, { keepTab: true });
    return sel.length > 0;
  }
  const proxyChange = (el, value) => { el.value = value; el.dispatchEvent(new Event('change')); };

  // Capture the chosen value BEFORE ensureChipSelection: its fallback runs
  // fillChipStyle(), which resets the select to the cue's shared value and
  // would silently drop the user's pick.
  tlFont.addEventListener('change', () => { const v = tlFont.value; if (ensureChipSelection()) proxyChange(document.getElementById('pw_font'), v); });
  tlAnim.addEventListener('change', () => { const v = tlAnim.value; if (ensureChipSelection()) proxyChange(document.getElementById('pw_anim'), v); });

  const tlSzVal = document.getElementById('tl_szVal');
  // Effective size shown on the chip AND used as the stepper base: the value
  // shared by every selected word, else the first word's effective value,
  // else the cfg default. Single source of truth so the displayed number and
  // the value +/- steps from can never disagree.
  function chipSizeBase() {
    const toks = selectedToks();
    const dflt = state.cfg.subtitleFontSize || DEFAULT_SUB_FS;
    if (!toks.length) return dflt;
    // Mixed sizes intentionally resolve to the first word's effective value.
    const eff = t => (t.style && t.style.fs) || dflt;
    return eff(toks[0]);
  }
  function stepSize(d) {
    if (!ensureChipSelection()) return;
    const cur = chipSizeBase();
    proxyChange(document.getElementById('pw_size'), String(Math.max(20, Math.min(200, cur + d))));
    fillChipStyle();
  }
  document.getElementById('tl_szDown').addEventListener('click', () => stepSize(-4));
  document.getElementById('tl_szUp').addEventListener('click', () => stepSize(4));

  function fillChipStyle() {
    // Looked up per-call, NOT via the tlFont/tlAnim/tlSzVal consts above:
    // fillBar() calls this during editor setup (line ~3168), which executes
    // BEFORE those const declarations — touching them there is a TDZ
    // ReferenceError that aborts the rest of openCaptionEditor.
    const szEl = document.getElementById('tl_szVal');
    const fEl  = document.getElementById('tl_font');
    const aEl  = document.getElementById('tl_anim');
    if (!szEl || !fEl || !aEl) return;
    const toks = selectedToks();
    const sharedVal = (get) => toks.length && toks.every(t => get(t.style || {}) === get(toks[0].style || {})) ? get(toks[0].style || {}) : '';
    szEl.textContent = chipSizeBase();
    fEl.value = sharedVal(s => s.fn || '');
    aEl.value = sharedVal(s => s.an || '');
  }
  renderRuler(); renderLane(); tickTL();

  // ── [MOMO-TL] Teardown: stop video + rAF when the overlay closes ──
  // Closing the editor detaches #capVideo but the element keeps playing
  // audio and the tlLoop rAF keeps running. Watch the overlay's `hidden`
  // attribute and tear down when it flips true. Also disconnect if a new
  // editor instance has replaced this one's DOM (vid no longer connected).
  function captureCaptionExtraRects(cue) {
    const oldTransform = ov.style.transform, clone = tx.cloneNode(false);
    clone.removeAttribute('id');
    Object.assign(clone.style, {position:'absolute',left:'0',top:'0',width:'100%',visibility:'hidden',animation:'none'});
    try {
      ov.style.transform = 'translateX(-50%)'; ov.append(clone);
      paintCue(clone, cue, c.subtitleStyle, stageH(), 'none', 0, c.subtitleFont || '');
      clone.querySelectorAll('*').forEach(node => { node.style.animation = 'none'; });
      const bounds = stage.getBoundingClientRect(), words = [...clone.querySelectorAll('.pw-tok')];
      return (words.length ? words : [clone]).map((word,index) => {
        const r = word.getBoundingClientRect();
        return {word:index,x:(r.left-bounds.left)/bounds.width*1080,y:(r.top-bounds.top)/bounds.height*1920,width:r.width/bounds.width*1080,height:r.height/bounds.height*1920};
      }).filter(r => [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>0 && r.height>0);
    } finally { clone.remove(); ov.style.transform = oldTransform; }
  }
  const disposeCaptionExtras = window.CaptionExtrasUI?.mount(document.querySelector('[data-page="textmotion"]'), {
    stage, overlay:ov, cues:()=>clip.cueWords || [], time:()=>vid.currentTime || 0, activeIndex:()=>_lastCECueIdx,
    selection:()=>sel.map(s=>s.ci), hidden:()=>proxyMode || cleanSourceLoading || !subsOn() || ov.style.visibility==='hidden',
    capture:captureCaptionExtraRects, signature:()=>JSON.stringify([c.subtitleStyle,c.subtitleFont,c.subtitleFontSize,c.subtitleY,c.subtitleX,c.subtitleCase,c.subtitleBoxColor,stageH(),stageW()]),
    changed:()=>{ clip.captionProject=null; exitProxy(); _lastCECue=''; applyCE(); tickCE(); commitHist(); },
    persist:async()=>{
      for (const cue of clip.cueWords || []) {
        if (cue.textMotion?.mark && cue.textMotion.mark.kind !== 'none') {
          const words = cue.textMotion.mark.words || [];
          cue.textMotion.mark.rects = captureCaptionExtraRects(cue).filter(r => !words.length || words.includes(r.word));
        }
      }
      // Text & Motion shares the caption draft; only Apply persists it.
    },
  });
  const tlTeardown = new MutationObserver(() => {
    if (!vid.isConnected) { tlTeardown.disconnect(); document.removeEventListener('keydown', onHistKey, true); document.removeEventListener('keydown', onTitleDeleteKey); return; }   // [UNDO-V1] [TITLE-DEL-KEY]
    if (!isCaptionStudioOpen()) {
      disposeCaptionExtras?.();
      ++_filmToken;
      try { vid.pause(); } catch {}
      if (tlRaf) cancelAnimationFrame(tlRaf);
      tlRaf = 0;
      // [UNDO-V1] Drop the document keydown handler + any pending debounced push
      // so a closed editor never intercepts Cmd/Ctrl+Z or fires a stale commit.
      document.removeEventListener('keydown', onHistKey, true);
      document.removeEventListener('keydown', onTitleDeleteKey);   // [TITLE-DEL-KEY]
      if (_histTimer) { clearTimeout(_histTimer); _histTimer = 0; }
      tlTeardown.disconnect();
    }
  });
  tlTeardown.observe(captionStudio.root, { attributes: true, attributeFilter: ['hidden'] });
}

// ─── Batch render ───────────────────────────────────────
// [SUBS-ASK] Small promise-based choice dialog (no native confirm: it cannot
// show three clear options). Resolves with the chosen button's value, or null.
function choiceDialog(title, bodyHtml, buttons) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'choice-dlg';
    wrap.innerHTML = `<div class="choice-box" role="dialog" aria-modal="true"><div class="choice-title">${esc(title)}</div><div class="choice-body">${bodyHtml}</div><div class="choice-btns">${
      buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.primary ? 'primary-btn' : 'ghost-btn'}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    wrap.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) done(buttons[+b.dataset.i].value); else if (e.target === wrap) done(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('.primary-btn')?.focus();
  });
}
// [SUBS-ASK] Render with Subtitle OFF on clips that HAVE a transcript: ask,
// instead of silently delivering a video without captions (reported: preview
// showed captions, the render came out bare). Returns false to cancel.
async function confirmSubsForRender(indices) {
  if (subsOn()) return true;
  const hasText = (indices || []).some((i) => { const c = state.clips[i]; return c && ((c.cueWords || []).length || (c.words || []).length); });
  if (!hasText) return true;
  const v = await choiceDialog('Subtitle sedang OFF',
    'Video akan dirender <b>tanpa subtitle</b>. Mau subtitle ikut tampil di video hasil?',
    [{ label: 'Nyalakan subtitle & render', value: 'on', primary: true }, { label: 'Render tanpa subtitle', value: 'off' }, { label: 'Batal', value: null }]);
  if (v === 'on') {
    await saveCfg({ burnSubtitles: true });
    const q = document.getElementById('f_burnQ'); if (q) q.checked = true;
    const h = document.getElementById('f_burnHelp'); if (h) h.innerHTML = burnHelpHtml(true);
    _lastPreviewCue = ''; try { tickCaptionPreview(); } catch {}
    return true;
  }
  return v === 'off';
}
async function batchRenderClips(indices) {
  // [GALLERY-RENDER] Re-entrancy guard. selRenderBtn was never disabled, so a
  // second click while the first batch was still running started a concurrent
  // pass over the same clips.
  if (batchRunning) { toast('Batch render sedang berjalan.', 'err'); return; }
  if (!(await confirmSubsForRender(indices))) return;   // [SUBS-ASK]
  const plan = BatchRender.planBatch({
    clips: state.clips,
    indices,
    pipelineRunning: state.running,
  });
  if (!plan.ok) {
    if (plan.reason === 'pipeline-running') {
      toast('Tunggu pipeline selesai sebelum menjalankan batch render.', 'err');
    } else if (plan.reason === 'no-usable-clips') {
      toast('Belum ada klip dengan sumber video yang bisa di-render.', 'err');
    }
    return;
  }
  indices = plan.indices;
  // [SPLIT-VS-CAPTION] Same silent loss as the single-clip Caption Editor
  // path, but a batch touches many clips — so it warned once up front instead
  // of confirm()-ing per clip. Both are gone: renderSourceFor now keeps a
  // baked split intact through a batch exactly as it does through the Caption
  // Editor, so there is nothing left to warn about.
  batchRunning = true;
  let pipeCancelBtn = null;
  let statusEl = null;
  let allBtns = [];
  let offRenderProgress = null;   // [RENDER-PROGRESS]
  try {
  // [BATCH-CANCEL] Cancel and Log are the SAME status-bar controls a pipeline
  // run uses, but a batch is a plain JS for-loop over renderEdit() calls with
  // no cancellation hook of its own — Cancel used to check only `state.running`
  // (the pipeline flag) and silently do nothing during a batch. Between-clip
  // cancellation is the honest scope here: a single renderEdit() call is one
  // ffmpeg invocation with no cancel plumbing threaded through it, so this
  // stops the batch from STARTING its next clip rather than killing one
  // mid-encode. `cancelled` is read at the top of the loop below.
  let cancelled = false;
  batchCancelRequest = () => {
    cancelled = true;
    toast('Membatalkan setelah klip yang sedang jalan selesai…');
  };
  pipeCancelBtn = document.getElementById('pipeCancel');
  if (pipeCancelBtn) { pipeCancelBtn.hidden = false; pipeCancelBtn.disabled = false; pipeCancelBtn.textContent = 'Cancel'; }
  // [GALLERY-RENDER] renderClipEdit emits no pipeline-log/pipeline-progress
  // (only runPipeline gets the onLog/onProgress callbacks), and the status-bar
  // consolidation dropped the old #gb_status span — so a multi-minute batch was
  // completely silent and looked like the button had done nothing. Drive the
  // status bar's own text directly; the 5-step card machine stays untouched
  // because no pipeline is running during a batch.
  statusEl = document.getElementById('gb_status');
  const noteEl   = document.getElementById('gb_note');
  const dismissEl = document.getElementById('gb_dismiss');
  const zoneEl   = document.getElementById('sbarEditAct');
  if (zoneEl)    zoneEl.hidden = false;
  if (noteEl)    noteEl.hidden = true;
  if (dismissEl) dismissEl.hidden = true;
  if (statusEl)  statusEl.hidden = false;
  // [RENDER-PROGRESS] What the bar said before the FIRST of back-to-back
  // batches — a batch started within the 4 s hand-back below used to save the
  // previous batch's own "✓ N rendered" and restore that afterwards.
  if (!batchPrevStatus) batchPrevStatus = { step: els.pipeStep ? els.pipeStep.textContent : '', line: els.statusLine ? els.statusLine.textContent : '' };
  // [BATCH-LOG] The ▾ Log panel (els.log) is filled ONLY by window.socl.onLog,
  // which — like onProgress above — never fires for a batch. Opening Log
  // during "Render all" showed either nothing or stale lines from the last
  // actual pipeline run, which is the second half of the bug report ("kita
  // tidak bisa melihat log aktualnya juga"). Markers (▶✓✗) are load-bearing:
  // shouldShowLog() silently drops any line without one.
  logLine(`▶ Batch render dimulai: ${indices.length} klip`, 'lime');
  if (plan.skipped) logLine(`⚠ ${plan.skipped} kandidat belum punya sumber dan dilewati`, 'yellow');
  const setBatchStatus = (txt, pct) => {
    if (statusEl)       statusEl.textContent = txt;
    if (els.statusLine) els.statusLine.textContent = txt;
    if (els.pipeStep)   els.pipeStep.textContent = 'Render';
    if (els.pipeDot)    els.pipeDot.className = 'sbar-dot active';
    if (typeof pct === 'number') {
      if (els.progressFill) els.progressFill.style.width = `${pct}%`;
      if (els.pipePct)      els.pipePct.textContent = `${Math.round(pct)}%`;
    }
  };
  allBtns = ['gb_renderAll','gb_renderHot','selRenderBtn','selAllBtn','selClearBtn']
    .map(id => document.getElementById(id)).filter(Boolean);
  allBtns.forEach(b => { b.disabled = true; });
  // [RENDER-PROGRESS] Say so the moment the batch starts — the bar used to keep
  // the previous run's text ("Render … 5 rendered") until the FIRST clip had
  // completely finished, minutes later — then move with ffmpeg's own progress.
  setBatchStatus(`Menyiapkan render ${indices.length} klip…`, 0);
  if (els.pipePct) els.pipePct.textContent = '0%';
  // [SUBS-SELFHEAL] Self-heal cueWords from words[] for every clip in the
  // batch before we count what's still missing — otherwise a batch from a
  // pre-cueWords-persistence session would look like every clip lost its
  // subs even when the per-word list is right there in the report.
  for (const i of indices) {
    const c = state.clips[i];
    if (c) ensureCueWords(c, state.cfg?.subtitleWordsPerChunk);
  }
  if (state.cfg.burnSubtitles !== false) {
    const missing = indices.filter(i => {
      const c = state.clips[i];
      return c && !(Array.isArray(c.cueWords) && c.cueWords.length > 0);
    });
    if (missing.length) {
      console.warn('[batch-render] Burn subs ON but', missing.length,
                   'of', indices.length, 'clips STILL have no cueWords AND no words to rebuild from → subs won\'t burn on those.',
                   missing.map(i => state.clips[i]?.file));
      toast(`⚠︎ ${missing.length}/${indices.length} klip tanpa transkrip — subs tidak ke-burn di klip itu.`, 'err');
    }
  }
  const style = {
    subtitleStyle:    state.cfg.subtitleStyle,
    // [BATCH-FONT] This object was missing subtitleFont and subtitleOffsetMs —
    // both present in buildCePayload()'s style, which is what the Caption
    // Editor's own Apply/Preview send. Render all / Render terpilih silently
    // fell back to each style preset's own default face, ignoring whatever
    // font the user picked in Clip Options, and any manual caption-offset
    // calibration was lost on every batch render.
    subtitleFont:     state.cfg.subtitleFont || '',
    subtitleOffsetMs: state.cfg.subtitleOffsetMs || 0,
    subtitleFontSize: state.cfg.subtitleFontSize,
    subtitleY:        state.cfg.subtitleY,
    subtitleX:        state.cfg.subtitleX || 540,
    subtitleAnim:     state.cfg.subtitleAnim || 'pop',
    subtitleGlow:     state.cfg.subtitleGlow !== false,
    subtitleBoxColor: state.cfg.subtitleBoxColor || '',
    subtitleBoxRotation: window.CaptionBox.boxRotation(state.cfg.subtitleBoxRotation),
    subtitleCase:     state.cfg.subtitleCase || 'none',   // [CASE-V1]
    // [EMOJI-STICKER] Carried on all THREE style builders from the start.
    // The audit before this feature found subtitleFont and subtitleCase
    // present in one payload and missing from another, which is how a
    // setting ends up working in the editor and nowhere else.
    emojiStickers:     state.cfg.emojiStickers === true,
  };
  // [BATCH-CONCURRENCY] Ask main.js for a RAM/CPU-aware concurrency cap
  // (the SAME measured decision runPipeline's own initial batch already
  // relies on) rather than the previous hardcoded 1-at-a-time. A failure to
  // reach main.js (should never happen — it's the same process) falls back
  // to 1, i.e. today's exact serial behavior.
  let workers = 1;
  try {
    const batchPlan = await window.socl.batchRenderPlan({ clipCount: indices.length, resolution: state.cfg.resolution });
    if (batchPlan?.workers > 0) workers = batchPlan.workers;
  } catch { /* fall back to serial */ }
  if (workers > 1) logLine(`⏵ ${workers} klip sekaligus (RAM/CPU tercukupi)`, 'lime');

  let done = 0, failed = 0, firstError = '', completedCount = 0;
  // [RENDER-PROGRESS] clip index → fraction (0..1) of the clips running now.
  const live = new Map();
  const shortTitle = (i) => { const t = state.clips[i]?.title || `Clip ${i + 1}`; return t.length > 32 ? `${t.slice(0, 31)}…` : t; };
  const paintBatch = () => {
    let inflight = 0;
    for (const f of live.values()) inflight += f;
    const running = [...live.entries()].map(([i, f]) => `${shortTitle(i)} ${Math.round(f * 100)}%`).join(' · ');
    // which clips are running: "Render 3/5" alone, "Render 3–4/5" with two workers
    const first = Math.min(indices.length, completedCount + 1);
    const last = Math.min(indices.length, completedCount + Math.max(1, live.size));
    setBatchStatus(`Render ${first === last ? first : `${first}–${last}`}/${indices.length}${running ? ` — ${running}` : '…'}`,
      Math.min(100, ((completedCount + inflight) / indices.length) * 100));
  };
  offRenderProgress = window.socl.onRenderProgress?.((d) => {
    if (!d || d.preview || !live.has(d.clipIndex)) return;
    live.set(d.clipIndex, Math.max(live.get(d.clipIndex), (Number(d.pct) || 0) / 100));
    paintBatch();
  }) || null;
  const { cancelledAt: startedCount } = await BatchRender.runWithConcurrency(indices, workers, async (idx, n) => {
    const clip = state.clips[idx];
    if (!clip) return { skipped: true };
    const label = clip.title || `Clip ${idx + 1}`;
    logLine(`▶ Render ${n + 1}/${indices.length}: ${label}`, 'lime');
    live.set(idx, 0);
    paintBatch();
    const res = await window.socl.renderEdit({
      clipIndex:      idx,
      // [RAW-SRC] The clean pre-edit plate, exactly like buildCePayload and
      // Crop Studio send. This used to be clip.file — which after a
      // burn-subtitles run IS the already-burned deliverable. It only
      // escaped a double burn while resolveEditInput could still re-cut from
      // srcVideo; whenever it falls back to legacy mode (source moved or
      // deleted), "Render all" burned a second caption pass onto burned
      // pixels while the Caption Editor's Apply did not.
      clipFile:       clip.rawFile || clip.file || clip.srcVideo,
      // [SPLIT-BAKED] Same rule as buildCePayload — a batch must not silently
      // discard a split that the Caption Editor now preserves.
      ...renderSourceFor(clip, formatForAspect(clip.cropAspect, state.cfg.format)),
      clipStart:      clip.start,
      clipEnd:        clip.end,
      clipResolution: state.cfg.resolution,
      cropX:          clip.cropX ?? 50,
      cropY:          clip.cropY ?? 50,
      cropScale:      clip.cropScale,
      cropAspect:     clip.cropAspect || null,
      cropRect:       clip.cropRect || null,
      cropKeyframes:  (clip.cropKF && clip.cropKF.length >= 2)
        ? clip.cropKF.map(k => {
        const out = { t: k.t, x: k.x * 100, y: k.y * 100 };
        if (Number.isFinite(k.w) && Number.isFinite(k.h)) {   // [FREE-KF-WH]
          out.w = k.w * 100; out.h = k.h * 100;
        }
        return out;
      }) : undefined,
      // [RENDER-BURN-OFF] Burn subtitle OFF means no captions in the render —
      // this path (gallery Render after a crop Apply) used to burn them anyway.
      cueWords:       subsOn() ? (clip.cueWords || []) : [],   // [RENDER-BURN-OFF] [SUBS-TOGGLE]
      broll:          clip.broll || null,   // [COLLAGE-BROLL]
      timeline:       clip.timeline || null,   // [CLIP-TIMELINE]
      /* [SMART-TRACK-REUSE] reuse the trackPlan captured during runPipeline */
      trackPlan:      clip.trackPlan || null,
      titles:         Array.isArray(clip.titles) ? clip.titles : [],   // [TITLE-V1]
      manualCaptions: Array.isArray(clip.manualCaptions) ? clip.manualCaptions : [],   // [MANUAL-CAPTION]
      style,
      /* [WM-V1] Project default merged with per-clip override */
      watermark:      currentWatermark(clip),
      /* [AI-STICKER-CACHE] Per-clip, like trackPlan/titles above. */
      aiStickerCache: clip.aiStickerCache || {},
    });
    // [GALLERY-RENDER] main.js's render-edit handler catches everything and
    // RESOLVES with { error }, so the bare `await` in a try/catch used to
    // count a render that never happened as a success — a batch where every
    // clip failed still toasted "✓ N rendered".
    const out = BatchRender.interpretRenderResult(res);
    if (!out.ok) throw new Error(out.error);
    if (out.exportWarning) toast(out.exportWarning, 'err');
    // [GALLERY-RENDER] Carry the render back into the gallery, the way the
    // Caption Editor's Apply does. Without this the card kept playing the
    // pre-render file, so a batch that genuinely succeeded still looked like
    // nothing had happened.
    clip.file       = out.file;
    if (out.thumbnail) clip.thumbnail = out.thumbnail;
    clip.subsBurned = Array.isArray(clip.cueWords) && clip.cueWords.length > 0;
    clip.fxBurned = !!(state.cfg && state.cfg.videoFx);
    // [TITLE-DOUBLE] See the same flag set on Caption Editor's Apply above.
    clip.titlesBurned = Array.isArray(clip.titles) && clip.titles.length > 0;
    // [WM-DOUBLE] See the same flag set on Caption Editor's Apply above —
    // this call's payload also sent watermark: currentWatermark(clip).
    clip.watermarkBurnedSnapshot = JSON.stringify(currentWatermark(clip));
    // [AI-STICKER-CACHE] Persist whatever this batch render resolved.
    if (out.aiStickerCache) clip.aiStickerCache = out.aiStickerCache;
    // This clip is now rendered with the current styling — it no longer owes
    // the "N edit di Caption Editor · re-render?" nag.
    clip.editDirty  = false;
    return { label };
  }, {
    isCancelled: () => cancelled,
    onSettled: (idx, n, outcome) => {
      const clip = state.clips[idx];
      const label = clip?.title || `Clip ${idx + 1}`;
      completedCount++;
      live.delete(idx);
      paintBatch();
      if (outcome.ok) {
        if (outcome.value?.skipped) return;   // clip vanished from state mid-batch — not a failure
        done++;
        logLine(`✓ ${label} selesai`, 'ok');
      } else {
        failed++;
        const msg = outcome.error?.message || String(outcome.error);
        firstError = firstError || `${label}: ${msg}`;
        logLine(`✗ ${label}: ${msg}`, 'err');
        console.error('Batch render clip', idx, outcome.error);
      }
    },
  });
  // cancelledAt from runWithConcurrency is the COUNT of items started before
  // cancellation, i.e. an index into `indices` — same shape the old serial
  // loop's own `n` had at the moment it broke, so the "X sisa dilewati"
  // message below needs no change.
  const cancelledAt = startedCount;
  const msg = cancelledAt >= 0
    ? `Dibatalkan — ${done} rendered, ${indices.length - cancelledAt} sisa dilewati`
    : failed
      ? `${done} rendered, ${failed} gagal`
      : `✓ ${done} rendered`;
  setBatchStatus(msg, 100);
  if (els.pipeDot) els.pipeDot.className = `sbar-dot ${failed ? 'error' : 'done'}`;
  toast(failed ? `${msg} — ${firstError}` : msg, failed ? 'err' : undefined);
  if (cancelledAt >= 0) logLine(`✗ Batch render dibatalkan setelah ${done} klip`, 'err');
  else if (failed)      logLine(`✗ Batch render: ${failed} gagal — ${firstError}`, 'err');
  else                  logLine(`✓ Batch render: ${done} klip selesai`, 'ok');
  // Repaint the cards against the new files, then hand the status slot back.
  renderGallery();
  // [BATCH-RESYNC] state.previewSubsBurned/cueWords are written only by
  // loadPreview() — the Caption Editor's Apply and Crop Studio's Apply both
  // re-call it for this reason. Without it, if the dashboard was already
  // showing the clip this batch just rendered, the <video> keeps the
  // pre-render src and the JS caption overlay keeps drawing on top of it,
  // so a batch render that genuinely succeeded looks like nothing happened.
  if (state.activeClip >= 0 && indices.includes(state.activeClip)) {
    loadPreview(state.activeClip, { autoplay: false });
  }
  setTimeout(() => {
    // A new batch or a pipeline run has taken the status slot — leave it alone.
    if (batchRunning || state.running) return;
    if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; }
    const prev = batchPrevStatus || {};
    batchPrevStatus = null;
    if (els.pipeStep)   els.pipeStep.textContent = prev.step || 'Idle';
    if (els.statusLine) els.statusLine.textContent = prev.line || '';
    if (els.pipeDot)    els.pipeDot.className = 'sbar-dot';
    if (els.pipePct)    els.pipePct.textContent = '';
    if (els.progressFill) els.progressFill.style.width = '0%';
    renderGallery();
  }, 4000);
  } catch (error) {
    const message = error?.message || String(error);
    logLine(`✗ Batch render gagal: ${message}`, 'err');
    toast(`Batch render gagal: ${message}`, 'err');
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = `Batch render gagal: ${message}`; }
    if (els.pipeDot) els.pipeDot.className = 'sbar-dot error';
    try { renderGallery(); } catch {}
  } finally {
    try { offRenderProgress?.(); } catch {}
    batchRunning = false;
    batchCancelRequest = null;
    if (pipeCancelBtn) {
      pipeCancelBtn.hidden = true;
      pipeCancelBtn.disabled = false;
      pipeCancelBtn.textContent = 'Cancel';
    }
    allBtns.forEach((button) => { button.disabled = false; });
  }
}

// ─── Transport controls ─────────────────────────────────
els.playBtn.addEventListener('click', () => {
  if (els.preview.paused) {
    els.preview.play().catch(() => {});
    els.playBtn.textContent = '❚❚';
  } else {
    els.preview.pause();
    els.playBtn.textContent = '▶';
  }
});
els.prevClip.addEventListener('click', () => {
  if (state.clips.length === 0) return;
  loadPreview((state.currentPreviewIdx - 1 + state.clips.length) % state.clips.length);
});
els.nextClip.addEventListener('click', () => {
  if (state.clips.length === 0) return;
  loadPreview((state.currentPreviewIdx + 1) % state.clips.length);
});
els.cropBtn.addEventListener('click', () => {
  state.cropMode = !state.cropMode;
  els.preview.style.objectFit = state.cropMode ? 'contain' : 'cover';
  els.cropBtn.style.background = state.cropMode ? 'var(--lime)' : '';
  els.cropBtn.style.color = state.cropMode ? '#111' : '';
  toast(state.cropMode ? 'Crop preview: fit' : 'Crop preview: fill');
});
els.preview.addEventListener('timeupdate', tickCaptionPreview);
els.preview.addEventListener('loadedmetadata', () => { applyCaptionStyle(); tickCaptionPreview(); });
els.preview.addEventListener('play',  () => els.playBtn.textContent = '❚❚');
els.preview.addEventListener('pause', () => els.playBtn.textContent = '▶');
window.addEventListener('resize', () => { applyStageAspect(state.cfg?.format); applyCaptionStyle(); });
// [FS-RESTORE] applyStageAspect() bakes pixel sizes from the card, so it must
// run once the card has its final size. Leaving fullscreen, the one call in
// togglePreviewFullscreen() lands while macOS is still animating the window
// back and measures the fullscreen card, and an Esc exit skips it entirely —
// the clip then stayed oversized and spilled out of the card. The card's grid
// track fixes its size, so resizing the stage cannot feed back into this.
(() => {
  const previewCard = document.querySelector('.preview-card');
  if (!previewCard || typeof ResizeObserver !== 'function') return;
  new ResizeObserver(() => applyStageAspect(state.cfg?.format)).observe(previewCard);
})();
// The stage animates width/height (.22s CSS transition): re-sync the caption
// overlay once the box settles so font/position always match the final size.
els.stage?.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'width' || e.propertyName === 'height') applyCaptionStyle();
});

// Hide / show transport + scene tag (so they don't cover the picture)
document.getElementById('uiToggle').addEventListener('click', () => {
  document.querySelector('.preview-card').classList.toggle('ui-hidden');
});

// ─── Maximize / minimize preview ────────────────────────
// Expands the preview card to fill the window (and hides the rest of the
// chrome). Re-runs the stage-aspect math so the video + caption overlay stay
// correctly sized at the new dimensions.
function setPreviewMaximized(on) {
  const card = document.querySelector('.preview-card');
  if (!card) return;
  card.classList.toggle('maximized', on);
  document.body.classList.toggle('preview-maxed', on);
  const btn = document.getElementById('maxBtn');
  if (btn) btn.classList.toggle('is-on', on);
  // Stage size changed — recompute aspect box + caption scaling on next frame.
  requestAnimationFrame(() => { applyStageAspect(state.cfg?.format); applyCaptionStyle(); });
}
// #maxBtn removed from transport bar in v3 (fullscreen consolidated into
// floating #fsBtn top-right). Guard preserved in case the button returns.
document.getElementById('maxBtn')?.addEventListener('click', () => {
  const card = document.querySelector('.preview-card');
  setPreviewMaximized(!card.classList.contains('maximized'));
});
// Native fullscreen — floating #fsBtn top-right of preview + F shortcut.
async function togglePreviewFullscreen() {
  const card = document.querySelector('.preview-card');
  if (!card) return;
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      await (card.requestFullscreen || card.webkitRequestFullscreen).call(card);
    }
    requestAnimationFrame(() => { applyStageAspect(state.cfg?.format); applyCaptionStyle(); });
  } catch (e) { console.warn('fullscreen failed:', e); }
}
document.getElementById('fsBtn')?.addEventListener('click', togglePreviewFullscreen);
// ─── Prev/Next chevrons + swipe navigation on preview ─────
function gotoClip(delta) {
  const n = state.clips.length;
  if (!n) return;
  const cur = state.currentPreviewIdx >= 0 ? state.currentPreviewIdx : 0;
  const next = Math.max(0, Math.min(n - 1, cur + delta));
  if (next !== cur) loadPreview(next);
}
document.getElementById('prevArrow')?.addEventListener('click', () => gotoClip(-1));
document.getElementById('nextArrow')?.addEventListener('click', () => gotoClip(+1));
// Horizontal swipe on the preview stage → prev / next clip (Reels-style)
(() => {
  const stage = document.getElementById('previewStage');
  if (!stage) return;
  let x0 = null, y0 = null, dx = 0, active = false;
  const THRESH = 60;      // px to commit a swipe
  const REJECT_Y = 40;    // vertical intent — cancel
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; active = true;
    stage.classList.remove('snap-back');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - x0;
    const dy = Math.abs(e.clientY - y0);
    if (dy > REJECT_Y) { active = false; stage.style.transform=''; return; }
    stage.classList.add('swiping');
    stage.style.transform = `translateX(${Math.max(-120, Math.min(120, dx))}px)`;
  });
  const finish = () => {
    if (!active) return;
    active = false;
    stage.classList.remove('swiping');
    stage.classList.add('snap-back');
    stage.style.transform = '';
    if (dx <= -THRESH) gotoClip(+1);
    else if (dx >= THRESH) gotoClip(-1);
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  stage.addEventListener('pointerleave', finish);
})();
// Esc exits maximized preview (native fullscreen handled by browser).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const card = document.querySelector('.preview-card');
    if (card && card.classList.contains('maximized')) setPreviewMaximized(false);
  }
  // F key toggles native fullscreen (ignore when typing in inputs)
  if ((e.key === 'f' || e.key === 'F') && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    if (isCaptionStudioOpen()) return;   // don't hijack when the editor is open
    togglePreviewFullscreen();
  }
  // Space toggles play/pause on whichever video is actually in view — Caption
  // Studio's capVideo, Crop Studio's csVideo, or the main dashboard preview —
  // instead of doing the browser default (scroll the page / re-click a
  // focused button). Skipped while typing so it doesn't eat a literal space.
  if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) {
    e.preventDefault();
    if (isCaptionStudioOpen()) {
      const v = document.getElementById('capVideo');
      if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); }
      return;
    }
    const cropStudio = document.getElementById('cropStudio');
    if (cropStudio && !cropStudio.hidden) {
      const v = document.getElementById('csVideo'), o = document.getElementById('csOutVideo');
      if (v) {
        if (v.paused) { v.play().catch(() => {}); o?.play().catch(() => {}); }
        else { v.pause(); o?.pause(); }
      }
      return;
    }
    if (els.preview) {
      if (els.preview.paused) { els.preview.play().catch(() => {}); if (els.playBtn) els.playBtn.textContent = '❚❚'; }
      else { els.preview.pause(); if (els.playBtn) els.playBtn.textContent = '▶'; }
    }
  }
});

// ─── Boot ──────────────────────────────────────────────
loadSettings();

// ─── Gaming Split Studio ─────────────────────────────────────
// Completely self-contained — does NOT touch Crop Studio code.
// Follows the same architectural patterns: AbortController for event cleanup,
// MediaLifecycle for video, canvas-based live preview, timeline + keyframes.

function openGamingSplitStudio(idx) {
  const clip = state.clips[idx];
  if (!clip) { toast('Select a clip first', 'err'); return; }
  const srcUrl = clip.srcVideo || clip.rawFile || clip.file;
  if (!srcUrl) { toast('No source video for this clip', 'err'); return; }

  const $id = s => document.getElementById(s);
  const studio   = $id('splitStudio');
  const vid      = $id('ssVideo');
  const vid2     = $id('ssVideo2');
  const canvas   = $id('ssCanvas');
  const wrap     = $id('ssSourceWrap');
  const source   = $id('ssSource');
  const faceBox  = $id('ssFaceBox');
  const gameBox  = $id('ssGameBox');
  const timeline = $id('ssTimeline');
  const progress = $id('ssProgress');
  const playhead = $id('ssPlayhead');
  const playBtn  = $id('ssPlay');
  const timeLbl  = $id('ssTime');
  const kfList   = $id('ssKfList');
  const kfCount  = $id('ssKfCount');
  const statusEl = $id('ssStatus');
  $id('ssTitle').textContent = (clip.title || 'Clip').slice(0, 40);

  let clipStart = clip.start || 0;
  let clipEnd   = clip.end || (clipStart + (clip.dur || 5));
  const clipDur = Math.max(0.1, clipEnd - clipStart);

  let splitY = clip.splitCrop?.splitY ?? 50;
  let faceTop = clip.splitCrop?.faceTop ?? true;
  let file2 = clip.splitCrop?.file2 || null;
  // [SPLIT-MUTE] Per-source audio mute, persisted on clip.splitCrop like every
  // other split setting — `?? false` (not `||`) so a saved `false` stays false
  // and a clip saved before this feature simply starts unmuted.
  let mute1 = clip.splitCrop?.mute1 ?? false;
  let mute2 = clip.splitCrop?.mute2 ?? false;

  let activeSource = 1; // 1 or 2

  let faceRect = clip.splitCrop?.faceRect ? { ...clip.splitCrop.faceRect } : { x: 25, y: 5, w: 30, h: 40 };
  let gameRect = clip.splitCrop?.gameRect ? { ...clip.splitCrop.gameRect } : { x: 25, y: 50, w: 30, h: 40 };
  let kf = clip.splitCrop?.kf ? JSON.parse(JSON.stringify(clip.splitCrop.kf)) : [];

  const ac = new AbortController();
  const sig = { signal: ac.signal };
  let rafId = 0;
  const fmt = s => `${s.toFixed(1)}s`;
  const timeRel = () => Math.max(0, Math.min(clipDur, (vid.currentTime || 0) - clipStart));
  // [SPLIT-SRC2-TIME] The preview used to mirror source 2's playhead to
  // vid.currentTime — an ABSOLUTE position in the master file. The render side
  // (getFile2Args in pipeline-inverse-v1.js) always starts source 2 at 0:00 and
  // loops it, since it's an independent background asset with no relation to
  // where the clip was cut from the master. For a clip cut at 5:30, preview
  // showed source 2's footage from 5:30 while the export showed it from 0:00 —
  // a different picture entirely. Match the render: clip-relative time, looped.
  function file2TimeFor(tRel) {
    const dur = vid2.duration;
    if (!Number.isFinite(dur) || dur <= 0) return tRel;
    return tRel % dur;
  }

  // ── Fallback handling ──
  let usingSrc = srcUrl;
  let fellBackToClipFile = false;
  if (srcUrl === clip.file && clip.file !== clip.srcVideo) {
    fellBackToClipFile = true;
    clipStart = 0; clipEnd = clipDur;
  }
  const onSrcErr = () => {
    if (usingSrc === clip.srcVideo && clip.file && clip.file !== usingSrc) {
      usingSrc = clip.file;
      fellBackToClipFile = true;
      clipStart = 0; clipEnd = clipDur;
      toast('Master source tidak ditemukan — pakai file klip', 'err');
      MediaLifecycle.setMediaSource(vid, toFileURL(clip.file));
    } else {
      toast('Video 1 tidak bisa dimuat: file mungkin sudah dihapus/dipindah.', 'err');
    }
  };

  // ── Open studio ──
  releaseDashboardPreview();
  studio.hidden = false;
  vid.addEventListener('error', onSrcErr, sig);
  vid.muted = true;
  MediaLifecycle.setMediaSource(vid, toFileURL(usingSrc));
  
  if (file2) {
    vid2.muted = true;
    MediaLifecycle.setMediaSource(vid2, toFileURL(file2));
  } else {
    vid2.removeAttribute('src');
  }

  // ── Source Toggling ──
  // [SPLIT-MUTE] The S2 button only means anything once a second source exists,
  // so it tracks file2 exactly the way the remove button does.
  function updateMuteView() {
    const paint = (el, muted, label) => {
      el.textContent = `${muted ? '🔇' : '🔊'} ${label}`;
      el.style.opacity = muted ? '0.55' : '1';
      el.title = muted
        ? `Audio ${label} DIMATIKAN — klik untuk menghidupkan`
        : `Audio ${label} aktif — klik untuk mematikan`;
    };
    paint($id('ssMute1'), mute1, 'S1');
    paint($id('ssMute2'), mute2, 'S2');
    $id('ssMute2').style.display = file2 ? '' : 'none';
  }
  function updateSourceView() {
    $id('ssRemoveV2').style.display = file2 ? '' : 'none';
    updateMuteView();
    if (activeSource === 1) {
      vid.hidden = false;
      vid2.hidden = true;
      faceBox.style.display = 'block';
      gameBox.style.display = file2 ? 'none' : 'block';
      $id('ssToggleV1').className = 'primary-btn';
      $id('ssToggleV2').className = 'ghost-btn';
      if (file2) $id('ssToggleV2').textContent = 'Source 2';
    } else {
      vid.hidden = true;
      vid2.hidden = false;
      faceBox.style.display = 'none';
      gameBox.style.display = 'block';
      $id('ssToggleV1').className = 'ghost-btn';
      $id('ssToggleV2').className = 'primary-btn';
      $id('ssToggleV2').textContent = 'Source 2';
    }
    layoutSource();
  }
  
  $id('ssMute1').addEventListener('click', () => {
    mute1 = !mute1;
    updateMuteView();
    toast(mute1 ? 'Audio Source 1 dimatikan' : 'Audio Source 1 dihidupkan');
  }, sig);
  $id('ssMute2').addEventListener('click', () => {
    mute2 = !mute2;
    updateMuteView();
    toast(mute2 ? 'Audio Source 2 dimatikan' : 'Audio Source 2 dihidupkan');
  }, sig);
  $id('ssToggleV1').addEventListener('click', () => { activeSource = 1; updateSourceView(); }, sig);
  $id('ssToggleV2').addEventListener('click', async () => {
    if (!file2) {
      const p = await window.socl.pickVideo();
      if (p) {
        file2 = p;
        vid2.muted = true;
        MediaLifecycle.setMediaSource(vid2, toFileURL(file2));
        activeSource = 2;
        updateSourceView();
      }
    } else {
      activeSource = 2;
      updateSourceView();
    }
  }, sig);
  // [SS-REMOVE-V2] There was no way to undo picking source 2 short of closing
  // the whole studio and losing every other edit — ssReset clears rects and
  // keyframes but never file2.
  $id('ssRemoveV2').addEventListener('click', () => {
    file2 = null;
    MediaLifecycle.releaseMedia(vid2);
    activeSource = 1;
    updateSourceView();
    updateAllARs();
    toast('Source 2 dihapus');
  }, sig);

  // ── Layout ──
  function getActiveVid() { return activeSource === 1 ? vid : (file2 ? vid2 : vid); }
  function layoutSource() {
    const v = getActiveVid();
    const availW = wrap.clientWidth - 28, availH = wrap.clientHeight - 28;
    const a = (v.videoWidth || 16) / (v.videoHeight || 9);
    let w = availW, h = w / a;
    if (h > availH) { h = availH; w = h * a; }
    source.style.width = w + 'px';
    source.style.height = h + 'px';
  }

  // ── Dynamic Aspect Ratio ──
  function getTargetAR(forFace) {
    const isTop = forFace ? faceTop : !faceTop;
    const ratio = isTop ? (splitY / 100) : ((100 - splitY) / 100);
    return 9 / (16 * ratio);
  }

  // [SS-RATCHET] This used to shrink r.w whenever the required height didn't
  // fit below r.y. r.w was therefore monotonically non-increasing across
  // updateAllARs calls and nothing ever restored it, so every sweep of the
  // split slider permanently destroyed crop area — measured: dragging 50 -> 15
  // and back to 50 left a 30%-wide box at 18.6%, losing 61.5% of the area, and
  // it hit every keyframe too. It also made the resize handle go completely
  // dead once a box was bottom-pinned (identical rects no matter how far the
  // pointer moved). Slide the box to fit instead; only clamp width when the
  // box genuinely cannot fit the frame at any position.
  function enforceAR(r, targetAR, forVideo2) {
    const v = forVideo2 && file2 ? vid2 : vid;
    if (!v.videoWidth || !v.videoHeight) return r;
    const k = (v.videoWidth / v.videoHeight) / targetAR;
    if (!Number.isFinite(k) || k <= 0) return r;
    let h = r.w * k;
    if (h > 100) { h = 100; r.w = h / k; }
    r.h = h;
    r.y = Math.max(0, Math.min(100 - r.h, r.y));
    r.x = Math.max(0, Math.min(100 - r.w, r.x));
    return r;
  }
  
  function updateAllARs() {
    faceRect = enforceAR(faceRect, getTargetAR(true), false);
    gameRect = enforceAR(gameRect, getTargetAR(false), true);
    kf.forEach(k => {
      k.face = enforceAR(k.face, getTargetAR(true), false);
      k.game = enforceAR(k.game, getTargetAR(false), true);
    });
    applyBoxes();
    renderKfs();
  }

  // ── Split Slider & Swap ──
  const splitSlider = $id('ssSplitRatio');
  splitSlider.value = splitY;
  splitSlider.addEventListener('input', (e) => {
    splitY = parseInt(e.target.value, 10);
    updateAllARs();
  }, sig);

  $id('ssSwapBtn').addEventListener('click', () => {
    faceTop = !faceTop;
    $id('ssFaceLabel').textContent = faceTop ? 'Facecam (Top)' : 'Facecam (Bottom)';
    $id('ssGameLabel').textContent = faceTop ? 'Gameplay (Bottom)' : 'Gameplay (Top)';
    updateAllARs();
  }, sig);
  $id('ssFaceLabel').textContent = faceTop ? 'Facecam (Top)' : 'Facecam (Bottom)';
  $id('ssGameLabel').textContent = faceTop ? 'Gameplay (Bottom)' : 'Gameplay (Top)';

  // ── Apply box positions to DOM ──
  function applyBoxes() {
    layoutSource();
    faceBox.style.left   = faceRect.x + '%';
    faceBox.style.top    = faceRect.y + '%';
    faceBox.style.width  = faceRect.w + '%';
    faceBox.style.height = faceRect.h + '%';
    gameBox.style.left   = gameRect.x + '%';
    gameBox.style.top    = gameRect.y + '%';
    gameBox.style.width  = gameRect.w + '%';
    gameBox.style.height = gameRect.h + '%';
  }

  // ── Canvas preview ──
  const ctx = canvas.getContext('2d');
  function paintPreview() {
    if (studio.hidden || !vid.videoWidth) return;
    const cw = canvas.width = 360;
    const ch = canvas.height = 640;
    const topH = Math.round(ch * (splitY / 100));
    const botH = ch - topH;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    const drawBox = (r, yOff, drawH, v) => {
      if (!v || !v.videoWidth) return;
      const sx = (r.x / 100) * v.videoWidth, sy = (r.y / 100) * v.videoHeight;
      const sw = (r.w / 100) * v.videoWidth, sh = (r.h / 100) * v.videoHeight;
      if (sw > 0 && sh > 0) {
        try { ctx.drawImage(v, sx, sy, sw, sh, 0, yOff, cw, drawH); } catch {}
      }
    };

    if (faceTop) {
      drawBox(faceRect, 0, topH, vid);
      drawBox(gameRect, topH, botH, file2 ? vid2 : vid);
    } else {
      drawBox(gameRect, 0, topH, file2 ? vid2 : vid);
      drawBox(faceRect, topH, botH, vid);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, topH); ctx.lineTo(cw, topH); ctx.stroke();
  }

  // ── Dragging logic ──
  function setupDrag(boxEl, getRectFn, setRectFn, forVideo2) {
    let dragging = false, resizing = false;
    let sx, sy, startRect;

    boxEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      boxEl.setPointerCapture?.(e.pointerId);
      startRect = { ...getRectFn() };
      sx = e.clientX; sy = e.clientY;
      resizing = e.target.classList.contains('ss-resize-handle');
      dragging = !resizing;
      if (!vid.paused) togglePlay();
    }, sig);

    boxEl.addEventListener('pointermove', (e) => {
      if (!dragging && !resizing) return;
      const bounds = source.getBoundingClientRect();
      const dx = ((e.clientX - sx) / bounds.width) * 100;
      const dy = ((e.clientY - sy) / bounds.height) * 100;
      let r = { ...startRect };
      if (dragging) {
        r.x = Math.max(0, Math.min(100 - r.w, startRect.x + dx));
        r.y = Math.max(0, Math.min(100 - r.h, startRect.y + dy));
      } else {
        r.w = Math.max(5, Math.min(100 - r.x, startRect.w + dx));
        // [SS-SWAP-AR] getTargetAR takes "is this the FACE rect", and does the
        // faceTop indirection itself. Passing faceTop here applied it twice, so
        // after Swap (faceTop === false) with any splitY other than 50 the
        // resize handle enforced the OTHER pane's aspect ratio — stretching the
        // crop by up to 5.7x in the exported file, and making the box jump the
        // next time the slider moved. Correct by coincidence at splitY 50,
        // which is why it survived. Face is video 1, game is video 2, so
        // !forVideo2 IS "is face".
        r = enforceAR(r, getTargetAR(!forVideo2), forVideo2);
      }
      setRectFn(r);
      applyBoxes();
    }, sig);

    const endDrag = () => { dragging = false; resizing = false; };
    boxEl.addEventListener('pointerup', endDrag, sig);
    boxEl.addEventListener('lostpointercapture', endDrag, sig);
  }
  // Setup: Face is always Video 1 (!forVideo2), Game is Video 2 (forVideo2)
  setupDrag(faceBox, () => faceRect, r => { faceRect = r; }, false);
  setupDrag(gameBox, () => gameRect, r => { gameRect = r; }, true);

  // ── Timeline scrub ──
  timeline.addEventListener('click', (e) => {
    if (e.target.classList.contains('cs-kf-marker')) return;
    const r = timeline.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * clipDur);
  }, sig);

  function seekTo(tRel) {
    vid.currentTime = clipStart + Math.max(0, Math.min(clipDur, tRel));
    if (file2) vid2.currentTime = file2TimeFor(timeRel());
    if (vid.paused) { interpKf(tRel); applyBoxes(); updatePlayhead(); }
  }
  function updatePlayhead() {
    const t = timeRel();
    const pct = clipDur > 0 ? (t / clipDur) * 100 : 0;
    playhead.style.left = pct + '%';
    progress.style.width = pct + '%';
    timeLbl.textContent = `${fmt(t)} / ${fmt(clipDur)}`;
  }

  // ── Play / Pause ──
  function togglePlay() {
    if (vid.paused) {
      if (vid.currentTime < clipStart || vid.currentTime >= clipEnd - 0.03) vid.currentTime = clipStart;
      if (file2) vid2.currentTime = file2TimeFor(timeRel());
      vid.play().catch(() => {});
      if (file2) vid2.play().catch(() => {});
      playBtn.textContent = '❚❚';
    } else {
      vid.pause();
      if (file2) vid2.pause();
      playBtn.textContent = '▶';
    }
  }
  playBtn.addEventListener('click', togglePlay, sig);

  // ── Keyframe system ──
  function interpKf(t) {
    if (!kf.length) return;
    let prev = kf[0], next = kf[kf.length - 1];
    for (let i = 0; i < kf.length - 1; i++) {
      if (t >= kf[i].t && t <= kf[i + 1].t) { prev = kf[i]; next = kf[i + 1]; break; }
    }
    if (t <= kf[0].t) { prev = next = kf[0]; }
    if (t >= kf[kf.length - 1].t) { prev = next = kf[kf.length - 1]; }
    const span = next.t - prev.t;
    const pct = span === 0 ? 0 : (t - prev.t) / span;
    const lerp = (a, b) => a + (b - a) * pct;
    // [SPLIT-KF-SIZE] Only position animates. ffmpeg's crop evaluates w/h once
    // at config time (t is NAN there, and crop has no `eval` option), so the
    // burn physically cannot animate box size. This used to lerp w/h as well,
    // so the user keyframed a zoom, watched it work here, and got a static-size
    // export — the preview was the thing lying. Size comes from the first
    // keyframe on both sides now, so what is drawn is what is burned.
    faceRect = {
      x: lerp(prev.face.x, next.face.x),
      y: lerp(prev.face.y, next.face.y),
      w: kf[0].face.w,
      h: kf[0].face.h,
    };
    gameRect = {
      x: lerp(prev.game.x, next.game.x),
      y: lerp(prev.game.y, next.game.y),
      w: kf[0].game.w,
      h: kf[0].game.h,
    };
  }

  function renderKfs() {
    kfCount.textContent = kf.length;
    timeline.querySelectorAll('.cs-kf-marker').forEach(m => m.remove());
    kf.forEach((k) => {
      const m = document.createElement('div');
      m.className = 'cs-kf-marker';
      m.style.left = `${(k.t / clipDur) * 100}%`;
      m.title = `Keyframe @ ${fmt(k.t)}`;
      m.addEventListener('click', () => seekTo(k.t), sig);
      timeline.appendChild(m);
    });
    if (!kf.length) {
      kfList.innerHTML = '<div class="cs-kf-empty">No keyframes — static split. Add keyframes to animate box positions.</div>';
      return;
    }
    kfList.innerHTML = kf.map((k, i) =>
      `<div class="cs-kf-row" data-i="${i}">
        <span class="kf-t">${fmt(k.t)}</span>
        <span class="kf-xy">Face ${Math.round(k.face.x)}%,${Math.round(k.face.y)}% · Game ${Math.round(k.game.x)}%,${Math.round(k.game.y)}%</span>
        <button class="kf-go" data-go="${i}">Go</button>
        <button class="kf-del" data-del="${i}">✕</button>
      </div>`).join('');
    kfList.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => seekTo(kf[+b.dataset.go].t), sig));
    kfList.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { kf.splice(+b.dataset.del, 1); renderKfs(); }, sig));
  }

  $id('ssAddKf').addEventListener('click', () => {
    const t = timeRel();
    const entry = { t, face: { ...faceRect }, game: { ...gameRect } };
    const ex = kf.findIndex(k => Math.abs(k.t - t) < 0.15);
    if (ex >= 0) kf[ex] = entry;
    else kf.push(entry);
    kf.sort((a, b) => a.t - b.t);
    renderKfs();
    toast(`Keyframe @ ${fmt(t)}`);
  }, sig);

  $id('ssDelKf').addEventListener('click', () => {
    if (!kf.length) return;
    const t = timeRel();
    let bi = 0, bd = 1e9;
    kf.forEach((k, i) => { const d = Math.abs(k.t - t); if (d < bd) { bd = d; bi = i; } });
    kf.splice(bi, 1);
    renderKfs();
  }, sig);

  $id('ssReset').addEventListener('click', () => {
    // [SS-RESET-KF] The button is labelled "Reset boxes" but silently wiped
    // every keyframe too, with no confirmation and a toast that never
    // mentioned it. Combined with the ratchet bug this used to be the only
    // way to un-stick a shrunken box, which meant fixing one problem
    // destroyed unrelated animation work with no warning.
    if (kf.length && !confirm(`Reset juga akan menghapus ${kf.length} keyframe. Lanjutkan?`)) return;
    const hadKf = kf.length;
    kf = [];
    faceRect = { x: 25, y: 5, w: 30, h: 40 };
    gameRect = { x: 25, y: 50, w: 30, h: 40 };
    updateAllARs();
    toast(hadKf ? `Reset — ${hadKf} keyframe dihapus` : 'Reset to defaults');
  }, sig);

  // ── RAF loop ──
  function loop() {
    if (studio.hidden) return;
    if (vid.currentTime >= clipEnd - 0.03) vid.currentTime = clipStart;
    if (file2 && !vid.paused) {
      const want = file2TimeFor(timeRel());
      if (Math.abs(vid2.currentTime - want) > 0.3) vid2.currentTime = want;
    }
    if (!vid.paused && kf.length > 0) {
      interpKf(timeRel());
      applyBoxes();
    }
    updatePlayhead();
    paintPreview();
    rafId = requestAnimationFrame(loop);
  }

  // ── Video loaded ──
  // [SS-RESTORE-RACE] faceRect/gameRect are already initialised from
  // clip.splitCrop (or defaults) synchronously at open, before any drag
  // listener is wired — re-checking clip.splitCrop here was at best a no-op
  // and at worst a race: on a slow-loading master the boxes are draggable
  // immediately, so a user who dragged them before loadedmetadata fired had
  // their edit silently discarded back to the default the moment metadata
  // arrived. clip.splitCrop never changes between open and here, so this
  // reset added a race for no behaviour it didn't already have.
  vid.addEventListener('loadedmetadata', () => {
    vid.currentTime = clipStart;
    updateAllARs();
    updateSourceView();
    renderKfs();
    updatePlayhead();
    statusEl.textContent = '';
  }, sig);
  vid2.addEventListener('loadedmetadata', () => {
    if (file2) {
      vid2.currentTime = file2TimeFor(timeRel());
      updateAllARs();
    }
  }, sig);
  // [SPLIT-SRC2-ERROR] vid had an 'error' listener; vid2 never did. A moved,
  // deleted, or undecodable source 2 failed completely silently — the game
  // panel just stayed black with no message, enforceAR never ran on gameRect
  // (its early-return on videoWidth===0), and the persisted rect kept an
  // arbitrary aspect ratio that the burn would stretch.
  vid2.addEventListener('error', () => {
    if (!file2) return;
    toast('Source 2 tidak bisa dimuat — file mungkin sudah dihapus/dipindah.', 'err');
    file2 = null;
    vid2.removeAttribute('src');
    if (activeSource === 2) { activeSource = 1; updateSourceView(); }
    updateAllARs();
  }, sig);
  window.addEventListener('resize', () => { layoutSource(); applyBoxes(); }, sig);

  // ── Keyboard ──
  document.addEventListener('keydown', (e) => {
    if (studio.hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === ' ' && !e.target.closest('input,textarea,button')) { e.preventDefault(); togglePlay(); }
  }, sig);

  // ── Close ──
  function close() {
    cancelAnimationFrame(rafId);
    MediaLifecycle.releaseMedia(vid);
    MediaLifecycle.releaseMedia(vid2);
    ac.abort();
    studio.hidden = true;
    restoreDashboardPreview();
  }
  $id('ssClose').addEventListener('click', close, sig);

  // ── Apply Split ──
  $id('ssApply').addEventListener('click', async () => {
    const btn = $id('ssApply');
    if (btn.disabled) return;
    // [SPLIT-SRC2-ERROR] file2 set but never decoded (still loading, or the
    // 'error' listener above hasn't cleared it yet) means gameRect's aspect
    // ratio was never enforced against real dimensions — applying now would
    // burn a distorted, arbitrary-AR crop with no indication why.
    if (file2 && !vid2.videoWidth) {
      toast('Source 2 belum selesai dimuat — coba lagi sebentar.', 'err');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Applying…';
    statusEl.textContent = 'Rendering split screen…';

    const cleanSrc = clip.rawFile || clip.file;
    const payload = {
      clipIndex: idx,
      clipFile: cleanSrc,
      srcVideo: fellBackToClipFile ? null : (clip.srcVideo || null),
      clipStart, clipEnd,
      clipFormat: state.cfg.format || 'face',
      clipResolution: state.cfg.resolution,
      splitCrop: {
        faceRect: { ...faceRect },
        gameRect: { ...gameRect },
        kf: kf.length ? JSON.parse(JSON.stringify(kf)) : null,
        splitY,
        faceTop,
        file2,
        // [SPLIT-MUTE] Rides the payload because the payload is what gets
        // written onto clip.splitCrop on success — a flag left out here is a
        // setting that silently resets every time the studio is reopened.
        mute1,
        mute2,
      },
    };

    try {
      const res = await window.socl.applyCrop(payload);
      // [SPLIT-ENVELOPE] This used to hand-check only res.error, missing the
      // case Crop Studio's own apply already guards against (a resolved-but-
      // empty envelope: no error, no file) — that would fall through both
      // checks with no state change and "Applying…" frozen forever. Use the
      // same helper every other apply-crop/render-edit call site uses.
      { const out = BatchRender.interpretRenderResult(res); if (!out.ok) throw new Error(out.error); }
      if (res?.file) {
        clip.file = res.file;
        // [SPLIT-RAWFILE] This used to keep the PRE-split plate as rawFile
        // (`if (!clip.rawFile) clip.rawFile = cleanSrc`), while the persisted
        // apply-crop patch and Crop Studio's own apply both set rawFile to the
        // POST-crop output — a three-way disagreement where in-session and
        // post-restart behaviour differed for the same clip. Match Crop Studio.
        clip.rawFile = res.file;
        clip.splitCrop = payload.splitCrop;
        clip.cropAspect = null;
        clip.cropRect = null;
        clip.cropKF = null;
        clip.trackPlan = null;
        clip.smartTracked = false;
        if (res.thumbnail) clip.thumbnail = res.thumbnail;
        renderGallery();
        statusEl.innerHTML = `✓ Split applied · <b>${res.fileName}</b>`;
        toast(`✓ Split applied: ${res.fileName}`);
        setTimeout(() => {
          if (!studio.hidden) close();
          if (state.activeClip >= 0) loadPreview(state.activeClip);
        }, 1200);
      }
    } catch (e) {
      statusEl.textContent = `✗ ${e.message || e}`;
      toast(`Apply failed: ${e.message || e}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Apply Split';
    }
  }, sig);

  // ── Start ──
  rafId = requestAnimationFrame(loop);
  // [SS-DEAD-READYSTATE] MediaLifecycle.setMediaSource() (called just above,
  // synchronously, to load `usingSrc`) always calls releaseMedia() first,
  // which calls vid.load() and resets readyState to 0 — so this branch's
  // condition could never be true here. The 'loadedmetadata' listener above
  // is what actually does this work once the video is ready.
}


let effectsClippingBookmark = null;
function prepareClippingForEffects() {
 const clip = window.__soclCurrentClip();
 if (!clip) { toast('Pilih klip yang sudah selesai dirender sebelum membuka Effects.'); return null; }
 effectsClippingBookmark = {index:clip.clipIndex,path:clip.path,time:els.preview.currentTime || 0,snapshot:LivePreviewState.snapshot(state)};
 try { sessionStorage.setItem('socl-effects-return-v1',JSON.stringify(effectsClippingBookmark)); } catch {}
 try { els.preview.pause(); } catch {}
 return clip;
}
function resumeClippingAfterEffects() {
 let saved = effectsClippingBookmark;
 if (!saved) { try { saved=JSON.parse(sessionStorage.getItem('socl-effects-return-v1') || 'null'); } catch {} }
 if (!state.clips?.length && saved?.snapshot) {
   const previous=LivePreviewState.restoreSnapshot(saved.snapshot);
   if (previous?.clips?.length) {
     state.clips=previous.clips;state.activeClip=previous.activeClip;state.currentPreviewIdx=previous.currentPreviewIdx;
     state.sourcePreview=previous.sourcePreview;
   }
 }
 renderGallery();
 const index = saved && state.clips[saved.index]?.file ? saved.index : state.clips.findIndex(c=>c.file);
 if (index >= 0) {
   const time = saved?.path === state.clips[index].file ? saved.time : 0;
   els.preview.addEventListener('loadedmetadata',()=>{
     try { els.preview.currentTime = Math.max(0,Math.min(time,Number.isFinite(els.preview.duration)?Math.max(0,els.preview.duration-.01):time)); } catch {}
   },{once:true});
   loadPreview(index,{autoplay:false});
 } else if (state.sourcePreview) showPosterPreview(state.sourcePreview,'Preview sumber');
 effectsClippingBookmark = null;
 try { sessionStorage.removeItem('socl-effects-return-v1'); } catch {}
}
window.__soclPrepareEffects = prepareClippingForEffects;
window.__soclResumeClipping = resumeClippingAfterEffects;

window.__soclApplyEffects = async ({ originalPath, clipIndex, path, captionProject, cleanFile }) => {
 const clip = state.clips[clipIndex];
 if (!clip || clip.file !== originalPath) throw new Error('Klip asal berubah. Buka ulang klip dari Clipping.');
 clip.effectsReportFile = clip.effectsReportFile || originalPath;
 clip.file = path;
 clip.rawFile = captionProject ? cleanFile : path;
 clip.captionProject = captionProject || null;
 if (!captionProject) clip.effectsBaked = true;
 clip.subsBurned = !!captionProject;
 clip.titlesBurned = false;
 renderGallery();
 loadPreview(clipIndex);
 toast(captionProject ? 'Caption diterapkan. Pengaturan Teks & Motion tersimpan untuk klip ini.' : 'Efek diterapkan. Caption tetap dapat diedit lewat menu Edit.');
};

window.__soclCurrentClip = () => {
 const preferred = [state.currentPreviewIdx,state.activeClip,...(state.selection?.list?.() || [])];
 const selected = preferred.find(index=>Number.isInteger(index) && state.clips[index]?.file);
 const index = selected === undefined ? state.clips.findIndex(clip=>clip?.file) : selected;
 const clip = state.clips[index];
 if (clip) ensureCueWords(clip);
 return clip?.file ? {
   path: clip.file, cleanPath: clip.rawFile && clip.rawFile !== clip.file ? clip.rawFile : undefined,
   clipIndex: index, reportFile: clip.effectsReportFile || clip.file,
   captionProject: clip.captionProject,
   title: clip.title || 'Clip', subsBurned: !!clip.subsBurned,
   captions: (Array.isArray(clip.cueWords) ? clip.cueWords : []).filter(c => c && typeof c.text === 'string').map(c => ({ text: c.text, start: c.start, end: c.end })),
 } : null;
};
