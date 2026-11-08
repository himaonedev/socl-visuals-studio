// app/src/cue-retime.js
// Pure timing math for the caption-editor cue timeline. Loaded BOTH by the
// Electron renderer (script tag → window.CueRetime) and by node tests
// (require). Never touch the DOM here.
(function (root) {
  'use strict';
  const MIN_CUE_DUR = 0.15;

  // Deep-clone cues (and their token arrays) so callers can never mutate the
  // input by touching the returned array. Used by both the no-op and
  // success paths of retimeCue so their immutability guarantees match.
  function cloneCues(cues) {
    return cues.map(c => ({ ...c, tokens: Array.isArray(c.tokens) ? c.tokens.map(t => ({ ...t })) : c.tokens }));
  }

  // Return a NEW cues array with cues[idx] retimed to [newStart, newEnd],
  // clamped to its neighbours, [0, videoDur] and MIN_CUE_DUR. Token start/end
  // times (when present) are linearly rescaled from the old range to the new.
  function retimeCue(cues, idx, newStart, newEnd, opts) {
    const videoDur = (opts && Number.isFinite(opts.videoDur)) ? opts.videoDur : Infinity;
    const cue = cues[idx];
    if (!cue) return cloneCues(cues);
    if (!Number.isFinite(+newStart)) newStart = +cue.start || 0;
    if (!Number.isFinite(+newEnd))   newEnd   = Number.isFinite(+cue.end) ? +cue.end : (+cue.start || 0);
    const oldS = Number.isFinite(+cue.start) ? +cue.start : 0;
    const oldE = Number.isFinite(+cue.end) ? +cue.end : oldS + MIN_CUE_DUR;
    const lo = idx > 0 && Number.isFinite(+cues[idx - 1].end) ? +cues[idx - 1].end : 0;
    // next.start is ALWAYS a hard ceiling (no-overlap invariant) — do not re-add a gap exemption
    const hi = idx < cues.length - 1 && Number.isFinite(+cues[idx + 1].start) ? +cues[idx + 1].start : videoDur;

    // When neighbours are packed tighter than MIN_CUE_DUR, the effective
    // minimum duration shrinks to whatever room is actually available
    // (never negative). s/e are then clamped to [lo, hi] using that
    // minDur, which guarantees e >= s + minDur >= s (never inverted) and
    // lo <= s, e <= hi always.
    const minDur = Math.min(MIN_CUE_DUR, Math.max(0, hi - lo));
    const s = Math.max(lo, Math.min(newStart, hi - minDur));
    const e = Math.min(hi, Math.max(newEnd, s + minDur));

    const scale = (oldE - oldS) > 1e-9 ? (e - s) / (oldE - oldS) : 1;
    const map = (t) => s + (t - oldS) * scale;

    const out = cloneCues(cues);
    const c = out[idx];
    c.start = s; c.end = e;
    if (Array.isArray(c.tokens)) c.tokens.forEach(t => {
      if (Number.isFinite(+t.start)) t.start = map(+t.start);
      if (Number.isFinite(+t.end))   t.end   = map(+t.end);
    });
    // [BOX-HIGHLIGHT] No separate `.words` field to rescale anymore — box
    // highlight derives per-word timing fresh from `.tokens` + the cue's own
    // `.start`/`.end` at use time (deriveWordTiming in caption-box.js), and
    // both of those are already correctly rescaled above. Nothing else to do
    // here; that is the whole point of not maintaining a second array.
    return out;
  }

  const api = { retimeCue, MIN_CUE_DUR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CueRetime = api;
})(typeof self !== 'undefined' ? self : this);
