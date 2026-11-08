// Watermark: project-wide default + per-clip overrides.
//
// Data model kept intentionally flat so it round-trips as JSON through
// electron IPC without any special serialization. Everything else in the app
// (renderer state, IPC payloads, ffmpeg filter builder, CSS preview) reads
// from the SAME resolved object shape returned by resolveWatermark().
//
// Loaded two ways:
//   - main / pipeline: `require('./watermark')` (CommonJS)
//   - renderer:        `<script src="watermark.js">` — contextIsolation is on
//                      so require() is unavailable. This file attaches a
//                      `window.wmMod` global for renderer.js to consume.
// Pure module — no fs / electron / ffmpeg dependencies.

'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.wmMod = api;
}(typeof self !== 'undefined' ? self : this, function () {

const ANCHORS = ['tl','tc','tr','ml','mc','mr','bl','bc','br'];

const DEFAULT_WATERMARK = {
  enabled: false,
  image: null,          // { path, filename, width, height, ext } | null
  // Typography watermark, rendered via libass (.ass sidecar) at the SAME
  // layer as the image (under captions). Image and text may coexist —
  // they share the anchor/position, so users typically pick one or move
  // them apart with different anchors when both are active.
  text: null,           // { content, font, color, sizePct, opacity, scales? } | null
  anchor: 'br',         // corner/edge on the OUTPUT frame
  xPct: 4,              // horizontal padding from the anchor edge, % of output width
  yPct: 4,              // vertical padding from the anchor edge, % of output height
  sizePct: 15,          // image width, % of output width
  opacity: 0.55,        // image opacity, 0..1
};

// Curated set of bundled fonts good for a small watermark line — heavy
// display faces and readable sans. Filenames must match app/assets/fonts/.
//
// [WM-LINES] lineEm is the distance libass puts between two stacked lines, in
// em: its line box is OS/2 winAscent+winDescent, which is exactly the number
// font-metrics.js's fontEmScale() measures. The preview cannot read font
// tables (renderer has no fs), and CSS `line-height: normal` uses hhea
// instead — for Anton that is 13% tighter, so a two-line watermark would sit
// visibly closer together in the preview than in the burn. The preview sets
// line-height to this number; test/watermark-lines.test.js recomputes it from
// the font files so the table cannot drift.
//
// [WM-FONT-FACE] css is the @font-face family in styles.css whose src is this
// exact file. The preview used to ask for `label`, which only Anton and Apple
// Garamond declare — Arial Cond, Cooper Black and both Editors Note faces fell
// back to a system sans while the burn used the real font. Pinned against
// styles.css by test/watermark-lines.test.js.
const TEXT_FONTS = [
  { label: 'Anton',          file: 'Anton-Regular.ttf',          lineEm: 1.7334, css: 'Anton' },
  { label: 'Cooper Black',   file: 'CooperBlkBT-Regular.ttf',    lineEm: 1.5200, css: 'CooperBlkBT-Regular' },
  { label: 'Editors Note',   file: 'EditorsNote-Bold.otf',       lineEm: 1.2800, css: "Editor'sNote-Bold" },
  { label: 'Editors Italic', file: 'EditorsNote-BoldItalic.otf', lineEm: 1.2800, css: "Editor'sNote-BoldItalic" },
  { label: 'Arial Cond',     file: 'ArialNova-Condensed.ttf',    lineEm: 1.2095, css: 'Arial Nova Cond' },
  { label: 'Apple Garamond', file: 'AppleGaramond-Bold.ttf',     lineEm: 1.1150, css: 'Apple Garamond Bold' },
];

// [WM-LINES] The text watermark may stack several lines ("socialvisuals" over
// "@nizar"), each with its own size as a percentage of the shared sizePct.
const MAX_TEXT_LINES = 5;
const LINE_SCALE_MIN = 30;
const LINE_SCALE_MAX = 200;

const DEFAULT_TEXT = {
  content: '',
  font:    TEXT_FONTS[0].file,
  color:   '#ffffff',
  sizePct: 5,       // text height as % of output width
  opacity: 0.75,
};

function clamp(n, lo, hi) {
  const v = Number.isFinite(+n) ? +n : lo;
  return Math.max(lo, Math.min(hi, v));
}

// [WM-LINES] Lines in, as either the panel's `lines: [{ text, scale }]` or the
// stored form (`content` joined by "\n" plus an optional parallel `scales`).
// Empty lines are dropped together with their scale so the two never shift
// out of step.
function rawLines(t) {
  if (Array.isArray(t.lines)) {
    return t.lines.map(l => ({ text: l && l.text, scale: l && l.scale }));
  }
  const scales = Array.isArray(t.scales) ? t.scales : [];
  return String(t.content == null ? '' : t.content).split(/\r?\n/)
    .map((text, i) => ({ text, scale: scales[i] }));
}

function sanitizeText(t) {
  if (!t || typeof t !== 'object') return null;
  const lines = rawLines(t)
    .map(l => ({
      text:  String(l.text == null ? '' : l.text).slice(0, 200).trim(),
      scale: Math.round(clamp(l.scale == null ? 100 : l.scale, LINE_SCALE_MIN, LINE_SCALE_MAX)),
    }))
    .filter(l => l.text)
    .slice(0, MAX_TEXT_LINES);
  if (!lines.length) return null;
  const fontOk = TEXT_FONTS.some(f => f.file === t.font);
  const out = {
    content: lines.map(l => l.text).join('\n'),
    font:    fontOk ? t.font : DEFAULT_TEXT.font,
    color:   /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : DEFAULT_TEXT.color,
    sizePct: clamp(t.sizePct, 1, 20),
    opacity: clamp(t.opacity, 0, 1),
  };
  // Only when some line is not at 100%: a single-line watermark must keep the
  // exact shape it had before lines existed, because [WM-DOUBLE] compares
  // JSON.stringify of this object against the snapshot persisted in History.
  if (lines.some(l => l.scale !== 100)) out.scales = lines.map(l => l.scale);
  return out;
}

// [WM-LINES] Read side for the preview and the burn: [{ text, scale }].
function textLines(text) {
  if (!text || !text.content) return [];
  const scales = Array.isArray(text.scales) ? text.scales : [];
  return String(text.content).split('\n')
    .map((t, i) => ({ text: t, scale: Number.isFinite(+scales[i]) ? +scales[i] : 100 }));
}
function sanitize(wm) {
  if (!wm || typeof wm !== 'object') return { ...DEFAULT_WATERMARK };
  const anchor = ANCHORS.includes(wm.anchor) ? wm.anchor : DEFAULT_WATERMARK.anchor;
  return {
    enabled: !!wm.enabled,
    image:   wm.image && wm.image.path ? { ...wm.image } : null,
    text:    sanitizeText(wm.text),
    anchor,
    xPct:    clamp(wm.xPct,    0, 40),
    yPct:    clamp(wm.yPct,    0, 40),
    sizePct: clamp(wm.sizePct, 3, 40),
    opacity: clamp(wm.opacity, 0, 1),
  };
}

// Merge project default with a per-clip override.
// - override === null / undefined  → use project default
// - override.enabled === false     → force off for this clip
// - otherwise the two are shallow-merged (override wins on set keys)
function resolveWatermark(projectWm, clipOverride) {
  const base = sanitize(projectWm);
  if (!clipOverride) return base;
  if (clipOverride.enabled === false) return { ...base, enabled: false };
  const merged = { ...base, ...clipOverride };
  if (clipOverride.image) merged.image = { ...clipOverride.image };
  return sanitize(merged);
}

// Ready-to-render checks. isActive is any-active (image OR text); the two
// finer-grained checks let the ffmpeg builder skip filter chains that
// wouldn't do anything.
function isImageActive(wm) {
  return !!(wm && wm.enabled && wm.image && wm.image.path);
}
function isTextActive(wm) {
  return !!(wm && wm.enabled && wm.text && wm.text.content);
}
function isActive(wm) {
  return isImageActive(wm) || isTextActive(wm);
}

// ffmpeg overlay X/Y expressions. `main_w` and `main_h` refer to the main
// video; `overlay_w` and `overlay_h` to the scaled watermark image.
function overlayXY(wm) {
  const dx = `main_w*${(wm.xPct / 100).toFixed(4)}`;
  const dy = `main_h*${(wm.yPct / 100).toFixed(4)}`;
  const A = wm.anchor;
  let x, y;
  switch (A[0]) {
    case 't': y = dy; break;
    case 'm': y = `(main_h-overlay_h)/2`; break;
    case 'b': y = `main_h-overlay_h-${dy}`; break;
  }
  switch (A[1]) {
    case 'l': x = dx; break;
    case 'c': x = `(main_w-overlay_w)/2`; break;
    case 'r': x = `main_w-overlay_w-${dx}`; break;
  }
  return { x, y };
}

// drawtextXY() lived here until the text watermark moved to libass; that
// geometry is now owned by buildWatermarkAss / wmAssPos in src/pipeline-inverse-v1.js.

// CSS position for WYSIWYG preview overlay in the renderer. Returns
// { top, right, bottom, left, transform } — only two of top/bottom and two of
// left/right will be set. The video preview <img> uses `width` derived from
// sizePct against the actual displayed video width.
function previewCSS(wm) {
  const css = { top: '', right: '', bottom: '', left: '', transform: '' };
  const dx = `${wm.xPct}%`;
  const dy = `${wm.yPct}%`;
  const A = wm.anchor;
  switch (A[0]) {
    case 't': css.top = dy; break;
    case 'm': css.top = '50%'; css.transform += 'translateY(-50%)'; break;
    case 'b': css.bottom = dy; break;
  }
  switch (A[1]) {
    case 'l': css.left = dx; break;
    case 'c': css.left = '50%'; css.transform = (css.transform + ' translateX(-50%)').trim(); break;
    case 'r': css.right = dx; break;
  }
  return css;
}

// [WM-DOUBLE] Decide the "what was baked into clip.file" snapshot the live
// dashboard overlay guard compares against (updateWatermarkOverlay). A clip
// reopened from History carries a PERSISTED snapshot (report.json) recording
// the watermark actually burned at render time — that must win, even when the
// user has since changed the project watermark; recomputing from the current
// project wm would make the guard think "changed since render" and re-overlay
// the new watermark on top of the already-baked one (double watermark). Only a
// fresh pipeline emit (no persisted snapshot) computes from the project wm.
// Mirrors the `subsBurned`/`titlesBurned` "only fill when undefined" rule.
function resolveBurnedWmSnapshot(clip, cfg) {
  if (clip && clip.watermarkBurnedSnapshot !== undefined) return clip.watermarkBurnedSnapshot;
  return JSON.stringify(resolveWatermark(cfg && cfg.watermark, null));
}

// Escape a file path for ffmpeg's `-i` argument. Unlike libass filter paths
// (which need backslash escaping), `-i` takes the raw path — but Windows
// backslashes still need to be forward-slashed to avoid quoting headaches.
function ffmpegInputPath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/');
}

return {
  DEFAULT_WATERMARK,
  DEFAULT_TEXT,
  TEXT_FONTS,
  MAX_TEXT_LINES,
  LINE_SCALE_MIN,
  LINE_SCALE_MAX,
  ANCHORS,
  sanitize,
  sanitizeText,
  textLines,
  resolveWatermark,
  resolveBurnedWmSnapshot,
  isActive,
  isImageActive,
  isTextActive,
  overlayXY,
  previewCSS,
  ffmpegInputPath,
};
}));
