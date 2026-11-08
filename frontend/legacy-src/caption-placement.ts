'use strict';
// [CAPTION-PLACEMENT] Angka di balik kontrol posisi & ukuran caption di Clip
// Options — untuk yang tidak mau membuka Caption Editor. Modul MURNI (tanpa
// DOM): rentangnya harus sama dengan slider editor, dan pemetaan pratinjaunya
// harus sama dengan applyCaptionStyle(), atau dua permukaan itu berselisih
// soal di mana caption berada. test/caption-placement.test.js menjaga
// keduanya terhadap source renderer.js.
//
// Satuannya kanvas 1080×1920 (ASS PlayRes), sama seperti cfg.subtitleX /
// subtitleY / subtitleFontSize: Y adalah tepi ATAS teks (Alignment 8), X
// adalah titik tengahnya.
//
// Dual-mode: `require()` di Node/test, `window.CaptionPlacement` di renderer.
(function (root) {
  const RANGE = {
    x:  { min: 0,  max: 1080, def: 540 },
    y:  { min: 50, max: 1850, def: 540 },
    fs: { min: 32, max: 120,  def: 64 },
  };
  const CANVAS_W = 1080;
  const CANVAS_H = 1920;
  // Tengah, plus atas/bawah yang menjauhi tombol-tombol TikTok/Reels.
  const PRESET_Y = { atas: 360, tengah: 960, bawah: 1440 };

  function clampValue(axis, v) {
    const r = RANGE[axis];
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return r.def;
    return Math.min(r.max, Math.max(r.min, n));
  }

  // Same mapping as applyCaptionStyle(). The one deliberate difference: no
  // 10px font floor. The dashboard floors for legibility; in a ~200px frame
  // that floor would make 32 and 64 look identical, and judging the size is
  // the whole point of this preview.
  function previewGeometry({ x, y, fs }, frameW, frameH) {
    return {
      leftPct: ((x ?? RANGE.x.def) / CANVAS_W) * 100,
      topPx: Math.max(0, ((y ?? RANGE.y.def) / CANVAS_H) * frameH),
      fontPx: Math.max(2, ((fs ?? RANGE.fs.def) / CANVAS_H) * frameH),
    };
  }

  // A drag of (dx, dy) frame pixels from a start position, in canvas units.
  function dragTo(start, dx, dy, frameW, frameH) {
    return {
      x: clampValue('x', start.x + (dx / frameW) * CANVAS_W),
      y: clampValue('y', start.y + (dy / frameH) * CANVAS_H),
    };
  }

  const api = { RANGE, PRESET_Y, CANVAS_W, CANVAS_H, clampValue, previewGeometry, dragTo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptionPlacement = api;
})(typeof self !== 'undefined' ? self : this);
