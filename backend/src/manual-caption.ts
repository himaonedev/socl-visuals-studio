// app/src/manual-caption.js
// Pure logic for the Manual Caption feature — see
// docs/superpowers/specs/2026-09-04-manual-caption-design.md.
// No DOM, no Electron: loaded BOTH by the Electron renderer (script tag →
// window.ManualCaption) and by node tests (require). Never touch the DOM here.
(function (root) {
  'use strict';

  const SLIVER_MIN_SEC = 0.15;

  function hasText(entry) {
    return !!String(entry?.text || '').trim();
  }

  // Guards against malformed manual-caption entries (older session state,
  // hand-edited reports, etc.) that have a missing or inverted start/end.
  // Without this, NaN/inverted comparisons in mergeInlineManualCaptions'
  // overlap checks are all `false`, so such an entry silently looks like it
  // overlaps EVERY auto cue with no surviving remainder on either side.
  function hasValidRange(entry) {
    const s = +entry?.start, e = +entry?.end;
    return Number.isFinite(s) && Number.isFinite(e) && e > s;
  }

  // Splice inline-mode manual captions into the auto-caption cue list, trimming
  // or splitting any auto cue (or earlier manual cue) whose time range overlaps
  // a later-starting inline manual cue. Returns a flat, time-sorted array in
  // the same {start,end,text,tokens} shape buildAss/paintCue already consume —
  // callers never need to know which cues came from ASR vs. the user.
  function mergeInlineManualCaptions(cueWords, manualCaptions) {
    const inline = (Array.isArray(manualCaptions) ? manualCaptions : [])
      .filter(m => m && m.mode !== 'layer' && hasText(m) && hasValidRange(m))
      .map(m => {
        // [MC-STYLE] Inline mode splices into the running caption's own Style
        // block, so a per-entry visual STYLE (glow colour, box, etc.) can't
        // vary word-by-word — but font/size CAN, via the same per-token
        // {style:{fn,fs}} override every other per-word cue already supports
        // (see pipeline-inverse-v1.js tokOpen / paintCue's baseStyle). Stamp
        // the entry's fs/fn onto every token as the token's OWN default so a
        // hand-authored per-word override (none exist yet for manual captions,
        // but tk.style may already be set) still wins.
        const entryStyle = {};
        if (m.fs) entryStyle.fs = +m.fs;
        if (m.fn) entryStyle.fn = m.fn;
        // [MC-TRACK] Letter spacing rides the same per-token route as size and
        // font: inline mode has no line of its own to carry a setting, so the
        // entry's spacing is stamped onto every token it splices in. Clamped
        // here, once, so both the burn and the preview read the same number.
        if (m.track != null && Number.isFinite(+m.track)) {
          entryStyle.tr = Math.max(-0.2, Math.min(0.4, +m.track));
        }
        const baseTokens = (Array.isArray(m.tokens) && m.tokens.length) ? m.tokens : [{ text: m.text }];
        const tokens = Object.keys(entryStyle).length
          ? baseTokens.map(tk => ({ ...tk, style: { ...entryStyle, ...(tk.style || {}) } }))
          : baseTokens;
        return { start: +m.start, end: +m.end, text: m.text, tokens };
      })
      .sort((a, b) => a.start - b.start);
    let base = (Array.isArray(cueWords) ? cueWords : []).slice();

    for (const m of inline) {
      const next = [];
      for (const c of base) {
        if (c.end <= m.start || c.start >= m.end) {
          // No overlap with this manual cue at all — keep as-is.
          next.push(c);
          continue;
        }
        // Left remainder (before the manual cue starts).
        if (m.start - c.start >= SLIVER_MIN_SEC) {
          next.push({ ...c, end: m.start });
        }
        // Right remainder (after the manual cue ends) — only relevant when the
        // original cue extended past the manual cue's end (the split case).
        if (c.end - m.end >= SLIVER_MIN_SEC) {
          next.push({ ...c, start: m.end });
        }
      }
      base = next;
      base.push(m);
      base.sort((a, b) => a.start - b.start);
    }
    return base;
  }

  // Layer-mode entries render as an independent, freely-positioned overlay —
  // never merged into the auto-caption flow. Just filter + normalize.
  function layerManualCaptions(manualCaptions) {
    return (Array.isArray(manualCaptions) ? manualCaptions : [])
      .filter(m => m && m.mode === 'layer' && hasText(m) && hasValidRange(m));
  }

  const api = { mergeInlineManualCaptions, layerManualCaptions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ManualCaption = api;
})(typeof self !== 'undefined' ? self : this);
