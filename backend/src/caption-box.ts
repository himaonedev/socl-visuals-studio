'use strict';
// [BOX-HIGHLIGHT] Geometri dan kontras untuk kotak highlight yang mengikuti
// kata aktif. Modul MURNI — tanpa DOM, tanpa filesystem — supaya preview
// (renderer) dan burn (pipeline) memakai angka yang sama persis. Menyalin
// logika ini ke salah satu sisi adalah cara paling pasti membuat preview
// berbohong tentang hasil burn.
//
// Dual-mode: `require()` di Node/test, `window.CaptionBox` di renderer.
// Pola ini mengikuti src/batch-render.js dan src/status-disclosure.js.
(function (root) {
  // Padding kiri-kanan kotak, dalam em. Lebar kata dihitung dari advance
  // width hmtx, yang tidak melihat kerning/ligatur HarfBuzz milik libass —
  // selisihnya <2% untuk teks Latin, cukup ditutup padding sekecil ini.
  // [BOX-PAD-TIGHTEN] 0.25 (nilai lama) dilaporkan langsung (15 Agu 2026,
  // screenshot beranotasi "kelebihan" pada box "dibeli" di antara "bisa"):
  // box terasa terlalu lebar, mepet ke kata tetangga meski secara matematis
  // TIDAK overlap (celah = celah alami tanpa box, lihat [BOX-PAD-INSERT] di
  // pipeline-inverse-v1.js). Diperkecil ke 0.15 supaya box lebih pas ke
  // kata sendiri, menyisakan celah yang lebih terasa ke kata di sampingnya.
  const PAD_EM = 0.15;
  // Tebal border kotak = radius sudut. libass menggambar border dengan
  // sambungan MEMBULAT, jadi rectangle polos + border tebal = rounded rect,
  // tanpa perlu bezier manual.
  // [PREVIEW-BURN-DRIFT] Nilai ini TIDAK PERNAH benar-benar dipakai oleh
  // burn — buildAss mengalikan fontSize dengan angka yang di-hardcode sendiri
  // di titik pemanggilan, bukan membaca konstanta ini. Preview (renderer.js)
  // JUGA menulis angka sendiri, beda dari burn. Dua sisi menggambar aturan
  // visual yang sama dengan angka berbeda — audit 15 Agu 2026 menemukan ini
  // via laporan "preview beda dari hasil render". Sekarang keduanya baca
  // dari sini.
  //
  // [RADIUS-TOO-SMALL] Nilai pertama (0.09) sempat dipakai sebagai "sudah
  // benar" hanya karena dua sisi jadi KONSISTEN satu sama lain — tapi
  // konsisten tidak sama dengan benar. Reproduksi render nyata (15 Agu 2026)
  // membuktikan 0.09 secara teknis membulat tapi PADA SKALA CAPTION
  // SUNGGUHAN terbaca sebagai sudut tajam ke mata (dilaporkan langsung:
  // "sudut kotak tidak membulat"). Dibandingkan 0.09/0.15/0.20/0.28 di
  // render sisi-bersisi pada fontSize=75 (ukuran caption realistis) —
  // 0.20 adalah titik pertama yang jelas terlihat membulat tanpa jadi
  // kapsul berlebihan.
  const RADIUS_EM = 0.20;
  // Kotak sedikit lebih tinggi dari baris supaya huruf turun (g, y, p) tidak
  // menyentuh tepi.
  const VPAD_EM = 0.12;
  // [BOX-H-FIXED] TINGGI kotak, sebagai kelipatan ukuran font — BUKAN turunan
  // metrik per-font.
  //
  // Versi lama memakai cssLineHeightEm (hhea asc−desc+lineGap) + 2×VPAD_EM.
  // Angka itu BENAR untuk mencocokkan tinggi content-box CSS di preview, dan
  // itulah kenapa dulu dipilih — tapi ia adalah tinggi BARIS TEKS, bukan
  // tinggi yang pantas untuk kotak sorot di belakang SATU kata. Diukur dari
  // render Windows sungguhan (720×1280, laporan 16 Agu 2026 "shape terlalu
  // tinggi"): kotak 97px untuk tinta "mana?" ~42px. Rinciannya pada Open
  // Sauce Two Bold: 1.237em itu asc(1.000) − desc(−0.237); dari situ hanya
  // cap+desc (1.000em) yang benar-benar bisa ditempati glyph, sisanya 0.237em
  // adalah headroom untuk diakritik yang teks Latin hampir tidak pernah pakai.
  // Ditambah VPAD 2×0.12 → 1.477em, hampir 1.5× ukuran font.
  //
  // Sekarang konstan. Dua alasan konstanta MENGALAHKAN nilai per-font di sini:
  //   1. Preview (renderer.js) tidak bisa membaca tabel TTF — font-metrics.js
  //      hanya jalan di Node. Nilai per-font mustahil dicerminkan di CSS tanpa
  //      pipa data baru, dan kotak burn≠preview persis kelas bug yang modul
  //      bersama ini ada untuk mencegahnya.
  //   2. Sebagian tabel font berbohong: Apple Garamond melaporkan capHeight
  //      yang memberi rentang tinta 0.493em — kotak setengah tinggi kalau
  //      dipercaya.
  // 1.20em menutup cap+descender SETIAP muka yang dibundel (maksimum nyata:
  // Anton 1.188em), sekaligus ~19% lebih pendek dari rumus lama.
  const BOX_H_EM = 1.20;

  function parseHex(hex) {
    let s = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }

  /**
   * Warna tinta yang terbaca di atas `boxHex`.
   *
   * Bobot per-kanal (Rec. 709) bukan rata-rata: mata jauh lebih peka pada hijau,
   * jadi rata-rata polos akan menyebut hijau murni "gelap" dan menaruh teks
   * putih di atasnya.
   *
   * Warna tak valid → putih: aman di atas kotak apa pun yang mungkin dipakai.
   */
  function contrastInk(boxHex) {
    const c = parseHex(boxHex);
    if (!c) return '#FFFFFF';
    const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return lum > 0.55 ? '#000000' : '#FFFFFF';
  }

  /**
   * Ukuran kotak dalam em, dari lebar kata dalam em.
   * Pemanggil mengalikan dengan ukuran em px untuk mendapat piksel.
   */
  // [BOX-H-FIXED] `lineHeightEm` sengaja TIDAK lagi ikut menentukan tinggi —
  // lihat catatan BOX_H_EM di atas. Parameternya dipertahankan supaya pemanggil
  // lama tidak pecah, tapi diabaikan; tinggi kotak sekarang murni kelipatan
  // ukuran font, sama persis di burn maupun preview.
  // `hEm` (optional): the caller's own height for this box, in em. BOX_H_EM is
  // calibrated against the default face and sits within 3% of its real line
  // box, but a face with taller caps — Anton measures 1.505 against the same
  // 1.20 — overflows a constant-height box, text spilling out the bottom. The
  // caption path keeps the constant on purpose ([BOX-H-FIXED]); the title path
  // passes the face's own metric so a per-title font override still fits.
  function boxRectEm({ wordWidthEm, hEm }) {
    const w = Math.max(0, Number(wordWidthEm) || 0);
    const h = Number(hEm);
    return { wEm: w + PAD_EM * 2, hEm: h > 0 ? h : BOX_H_EM };
  }

  /**
   * Timing per-kata, dihitung LANGSUNG dari `tokens` + batas waktu cue saat
   * dipanggil — tidak pernah disimpan sebagai field terpisah.
   *
   * [ARCH] Sebelumnya timing per-kata disimpan sebagai field `.words` yang
   * terpisah dari `.tokens` (field yang sebenarnya dibakar/ditampilkan).
   * Setiap tempat yang memutasi kata — 4 chunker berbeda, retime drag di
   * timeline, edit teks manual per-kata, AI Fix Typo — harus INGAT
   * menyinkronkan `.words` secara manual. Delapan titik lupa melakukan itu
   * ditemukan dalam satu sesi audit (14 Agu 2026), termasuk satu yang bisa
   * membuat `.words` dan `.tokens` beda PANJANG (AI Fix Typo yang mengubah
   * jumlah kata). Menghitung ulang dari `tokens` setiap kali dibutuhkan
   * membuat desync semacam itu MUSTAHIL secara struktural — tidak ada lagi
   * array kedua yang bisa basi, karena tidak ada array kedua sama sekali.
   *
   * Distribusi rata (bukan timing ASR asli per-kata) — sengaja: begitu kata
   * diedit (typo fix mengganti "gitu ya" jadi "begitu ya sih"), kata baru itu
   * tidak pernah benar-benar diucapkan di audio pada timestamp manapun, jadi
   * tidak ada "timing asli" yang bisa dipertahankan untuknya. Pola yang sama
   * persis sudah dipakai sebagai fallback di flattenClipWords (renderer.js)
   * untuk skenario serupa. Untuk cue yang TIDAK diedit, cue biasanya cuma
   * 2-4 kata dan jendelanya sudah sempit — distribusi rata di situ sudah
   * sangat dekat dengan timing ASR asli.
   */
  function deriveWordTiming(tokens, cueStart, cueEnd) {
    const toks = Array.isArray(tokens) ? tokens : [];
    const n = toks.length;
    if (!n) return [];
    const s = Number(cueStart) || 0;
    const e = Number(cueEnd) || 0;
    const dur = Math.max(0, e - s);
    const per = dur / n;
    // [MC-SIZE-PARITY] Carry the token's per-word style through. The box
    // painter needs it to render a word at its OWN size/face; every existing
    // caller simply ignores the extra field.
    return toks.map((t, i) => ({
      text: String((t && t.text) || ''),
      start: s + i * per,
      end: s + (i + 1) * per,
      style: (t && t.style) || null,
    }));
  }

  // [BOX-ELIGIBLE] Whether a cue gets the box highlight at all — ONE rule for
  // the burn (buildAss) and both previews. The burn skips the box for a cue
  // whose words carry their own animation, mixed sizes, a drag (dx/dy) or any
  // override beyond face/bold/italic/colour, and for inverse_auto; the editor
  // preview used to check only the animation and the dashboard nothing, so the
  // editor showed a box the video never had (found by the 2026-10-06 audit).
  // Uniform `fs` is fine — the box is then measured at that one size
  // ([MC-SIZE-PARITY]).
  const BOX_COMPAT_KEYS = ['fn', 'b', 'i', 'color', 'an'];
  function boxEligible(cue, style) {
    if (style === 'inverse_auto') return false;
    const toks = (cue && Array.isArray(cue.tokens)) ? cue.tokens : null;
    if (!toks) return true;
    if (toks.some(tk => tk && tk.style && tk.style.an)) return false;
    const uniformFs = (() => {
      if (!toks.length) return null;
      const vals = toks.map(tk => (tk && tk.style && tk.style.fs != null) ? +tk.style.fs : null);
      if (vals.some(v => !Number.isFinite(v))) return null;
      return vals.every(v => v === vals[0]) ? vals[0] : null;
    })();
    if (uniformFs == null && toks.some(tk => tk && tk.style && tk.style.fs != null)) return false;
    return !toks.some(tk => tk && tk.style
      && !Object.keys(tk.style).every(k => BOX_COMPAT_KEYS.includes(k) || (k === 'fs' && uniformFs != null)));
  }

  // [CUE-BRIDGE] Close a SMALL gap between two consecutive cues: the earlier
  // one stays on screen until the next appears. Measured over 28 real sessions
  // (6969 cue changes): 98.6% already touch, but 76 sat 0.05-0.5 s apart and
  // each one blinked — fade out, an empty frame or ten, fade back in. Subtitle
  // practice closes gaps under ~12 frames for the same reason. Burn and both
  // previews call this on the cue list they display, so they agree; the
  // stored cues are never mutated (only a bridged cue is shallow-copied, its
  // tokens array shared so per-word edits still land on the real cue).
  const CUE_BRIDGE_MAX_GAP_SEC = 0.5;
  function bridgeCueGaps(cues, maxGap = CUE_BRIDGE_MAX_GAP_SEC) {
    if (!Array.isArray(cues) || cues.length < 2) return cues;
    let out = null;
    for (let i = 0; i < cues.length - 1; i++) {
      const a = cues[i], b = cues[i + 1];
      if (!a || !b) continue;
      const gap = Number(b.start) - Number(a.end);
      if (gap > 1e-6 && gap <= maxGap + 1e-6) {
        if (!out) out = cues.slice();
        out[i] = Object.assign({}, a, { end: Number(b.start) });
      }
    }
    return out || cues;
  }

  function boxRotation(value) {
    const angle = Number(value);
    return Number.isFinite(angle) ? Math.max(-45, Math.min(45, angle)) : 0;
  }
  // Rotate only drawing points, around the box centre. Position/move/scale tags
  // stay intact and text is emitted separately, so entrance animations still match.
  function rotateBoxDrawing(draw, width, height, rotation) {
    const angle = boxRotation(rotation);
    if (!angle) return draw;
    const radians = angle * Math.PI / 180;
    const cos = Math.cos(radians), sin = Math.sin(radians);
    const cx = width / 2, cy = height / 2;
    return draw.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (_, x, y) => {
      const dx = Number(x) - cx, dy = Number(y) - cy;
      return `${(cx + dx * cos - dy * sin).toFixed(3)} ${(cy + dx * sin + dy * cos).toFixed(3)}`;
    });
  }
  const api = { boxRotation, rotateBoxDrawing, contrastInk, boxRectEm, deriveWordTiming, boxEligible, bridgeCueGaps, CUE_BRIDGE_MAX_GAP_SEC, PAD_EM, RADIUS_EM, VPAD_EM, BOX_H_EM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptionBox = api;
})(typeof self !== 'undefined' ? self : this);
