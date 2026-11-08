'use strict';
// [VIDEO-FX] Video effects for the hook window (the clip's first seconds),
// picked in Clip setting → "Efek video", independent of the hook preset.
// One catalog, shared by the burn (pipeline-inverse-v1.js) and the preview
// (renderer.js) so the two cannot disagree about a colour.
//
//   duotone — luma × tint × gain over the whole frame (ffmpeg
//             colorchannelmixer; preview: SVG feColorMatrix, same numbers).
//   cutout  — the speaker cut out in black & white, everything else in the
//             tint duotone (segment-fx.py, mediapipe from the tracker bundle).
//             Falls back to the duotone with the same tint when segmentation
//             cannot run, and in the live preview.
// Every effect opens with a short white flash, like the reference edits.
(function (root) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const FX = [
    { id: 'cut_pink',   label: 'Potong · pink',   kind: 'cutout',  color: '#FF3FA4' },
    { id: 'cut_lime',   label: 'Potong · lime',   kind: 'cutout',  color: '#B8F02A' },
    { id: 'cut_oranye', label: 'Potong · oranye', kind: 'cutout',  color: '#FF7A1A' },
    { id: 'cut_biru',   label: 'Potong · biru',   kind: 'cutout',  color: '#2F7BFF' },
    { id: 'duo_pink',   label: 'Duotone · pink',  kind: 'duotone', color: '#FF3FA4' },
    { id: 'duo_lime',   label: 'Duotone · lime',  kind: 'duotone', color: '#B8F02A' },
  ].map((f) => Object.assign(f, { tint: hex(f.color), gain: 1.45, flashMs: 100 }));
  const byId = {};
  FX.forEach((f) => { byId[f.id] = f; });
  // Ids used before the catalog existed (riot preset, saved clips).
  byId.duotone_pink = byId.duo_pink;
  byId.cutout_pink = byId.cut_pink;
  const get = (id) => byId[id] || null;
  const isCutout = (id) => !!(get(id) && get(id).kind === 'cutout');
  // Seconds the effect covers: the hook window, never past the clip.
  const WINDOW_SEC = 3.5;
  // [PRESET-CATALOG] A colour delivered as data. Never replaces a built-in.
  function register(f) {
    if (!f || byId[f.id] || !/^(cut|duo)_[a-z0-9_]+$/.test(f.id) || !/^#[0-9a-fA-F]{6}$/.test(f.color)) return false;
    const e = { id: f.id, label: f.label, kind: f.kind === 'cutout' ? 'cutout' : 'duotone', color: f.color, tint: hex(f.color), gain: 1.45, flashMs: 100, remote: true };
    FX.push(e); byId[e.id] = e;
    return true;
  }
  const api = { FX, get, isCutout, register, WINDOW_SEC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VideoFx = api;
})(typeof window !== 'undefined' ? window : globalThis);
