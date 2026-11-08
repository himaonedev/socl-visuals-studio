'use strict';
// [FS-EM-SCALE] libass and CSS disagree about what a "font size" is, and the
// disagreement is per-font.
//
//   CSS   `font-size: N px`  →  em square = N px
//   libass `Fontsize: N`     →  ascender − descender = N px
//
// So libass renders at an em of N / ((asc − desc) / upem). Measured against the
// app's own bundled ffmpeg (libass 0.17.0), cap-height of "H" at Fontsize 100:
//
//   Open Sauce Two Bold  (asc−desc)/upem = 1.2370 → ink 62px, predicted 61.7 ✓
//   Times New Roman MT C (asc−desc)/upem = 1.1700 → ink 59px, predicted 58.3 ✓
//
// The ratio across the bundled faces runs from 1.0000 (Cooper) to 1.5054
// (Anton), so a caption the preview draws at 85px burns anywhere from 85px down
// to 56px depending only on which face it uses. That is the long-standing
// "ukuran preview ≠ ukuran hasil render", and it is also why per-word mixed
// fonts drift apart: each word shrinks by a DIFFERENT amount.
//
// It also silently broke word-by-word rise/drop. The renderer bakes each word's
// centre from the preview layout (bakeCueWordOffsets), then the burn pins each
// word at that centre — but draws it ~19% narrower. Half of every word's missing
// width turns into gap on each side, so the words visibly drift apart. Measured
// on the reported clip: preview gap 7px vs burned gap 57px.
//
// Multiplying the emitted Fontsize by this ratio makes libass's em equal the
// preview's CSS px, which is the only way the two layouts can agree.
const fs = require('fs');
const path = require('path');

// Reading a name table is cheap but there are ~40 faces; parse once, lazily.
let _cache = null;

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function i16(b, o) { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

// Every name a user (or a saved clip) might have stored for this face: family,
// full name, PostScript name and typographic family. The ASS `Fontname` is
// whatever libass resolved, and the app's own font lists mix all four forms.
const NAME_IDS = [1, 4, 6, 16];

function parseFace(buf) {
  if (buf.length < 12) return null;
  const tag = u32(buf, 0);
  // 0x74746366 = 'ttcf' (collection) — not shipped here, and its header differs.
  if (tag === 0x74746366) return null;
  const numTables = u16(buf, 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    if (o + 16 > buf.length) return null;
    tables[buf.toString('latin1', o, o + 4)] = u32(buf, o + 8);
  }
  const head = tables['head'], hhea = tables['hhea'], name = tables['name'];
  if (head == null || hhea == null || name == null) return null;
  if (head + 20 > buf.length || hhea + 8 > buf.length) return null;

  const upem = u16(buf, head + 18);
  const asc = i16(buf, hhea + 4);
  const desc = i16(buf, hhea + 6);
  const lineGap = i16(buf, hhea + 8);
  if (!upem) return null;
  // [FS-EM-WIN] The height libass actually fills is OS/2 usWinAscent +
  // usWinDescent, NOT hhea ascender − descender. The two agree on most faces,
  // which is why the original hhea reading passed its spot-check — Open Sauce
  // and Times New Roman MT Condensed are both faces where they happen to be
  // identical. On the faces where they differ, hhea was wrong by a lot.
  // Measured with the bundled ffmpeg (libass), "H" at Fontsize 1000, cap-height
  // ink compared against the OS/2 sCapHeight the same size in CSS px would give:
  //
  //   face                     needed   hhea      win
  //   Open Sauce Two Bold      1.2386   1.2370    1.2370   (agree)
  //   Anton                    1.7326   1.5054 ✗  1.7334 ✓  hhea 13% small
  //   Poppins Bold             1.7714   1.4000 ✗  1.7620 ✓  hhea 21% small
  //   Times MT Std BoldCond    1.1180   1.0000 ✗  1.1680    hhea 11% small
  //   Cooper Black             1.5041   1.0000 ✗  1.5200 ✓  hhea 33% small
  //
  // A caption set in Cooper burned a THIRD smaller than the preview drew it,
  // and mixing fonts per word made each word shrink by a different amount.
  const os2 = tables['OS/2'];
  const winAsc  = os2 != null && os2 + 78 <= buf.length ? u16(buf, os2 + 74) : 0;
  const winDesc = os2 != null && os2 + 78 <= buf.length ? u16(buf, os2 + 76) : 0;
  const winSum = winAsc + winDesc;
  // hhea stays the fallback for a face with no usable OS/2 table (bare CFF, some
  // very old TTFs) — a slightly wrong scale still beats no scale at all.
  const ratio = winSum > 0 ? winSum / upem : (asc - desc) / upem;
  if (!ratio) return null;
  // [FS-EM-FACE] head.macStyle bit0 = bold, bit1 = italic. Needed because the
  // ratio is a property of the FACE, not the family: Apple Garamond ships
  // Bold 1.115 / Italic 1.140 / Regular 1.152 under one family name, and libass
  // swaps to the real sibling on \b1/\i1 (measured: +12.1% / +3.6% ink width).
  // Keying the cache on family alone handed every state the first file read.
  const macStyle = head + 44 + 2 <= buf.length ? u16(buf, head + 44) : 0;
  const bold = !!(macStyle & 1), italic = !!(macStyle & 2);
  // A face claiming a wildly out-of-range ratio is more likely a parse error
  // than a real design; ignore it rather than resizing captions by garbage.
  if (!(ratio > 0.5 && ratio < 3)) return null;
  // [BOX-CSS-LINEHEIGHT] The box's height must match the PREVIEW's content-box
  // height, not libass's rendered text height (`ratio` above, OS/2 win — the
  // right number for the Style Fontsize conversion, the WRONG number here).
  // Measured against real Chrome layout (getBoundingClientRect) for three
  // bundled faces, `(hhea.ascender - hhea.descender + hhea.lineGap) / upem`
  // matched to within 0.2%: Open Sauce Two Bold 1.2344 (predicted 1.237),
  // Anton 1.5078 (predicted 1.5054), Poppins Bold 1.5000 (predicted 1.5000
  // exactly — its OS/2 win ratio 1.762 was 17.5% too tall). That is the CSS
  // "line-height: normal" formula; browsers use hhea (+lineGap) for inline
  // content-box height, not the OS/2 win metrics libass reads.
  const cssRatio = (asc - desc + lineGap) / upem;
  // [BOX-VCENTER-INK] Where the glyph INK actually sits, measured from the
  // \an7 (top-left) anchor libass positions the line at, in em units.
  //
  // libass lays a line out so that OS/2 usWinAscent+usWinDescent fills the
  // Fontsize, which puts the BASELINE `winAsc` below that top anchor. The ink
  // of a normal word runs from roughly `hhea.ascender` above the baseline to
  // `hhea.descender` below it — and those two spans are NOT symmetric about
  // the line box's own midpoint, because usWinAscent carries extra internal
  // leading that varies wildly per face (Anton and Cooper are the extremes
  // among the bundled set). Centring the highlight box on the LINE BOX
  // midpoint therefore floats it above the ink by a different amount for
  // every font: measured over all 23 bundled faces, the gap above ran
  // 13-34px while the descender was clipped up to 22px below the box
  // (Anton worst — that is the "anton tidak presisi" report). Centring on
  // THIS number instead puts the box on the ink itself.
  const baselineEm = winSum > 0 ? winAsc / upem : asc / upem;
  // Ink-top proxy: the MIDPOINT of hhea.ascender and OS/2 sCapHeight.
  // `ascender` alone overshoots on faces that carry leading above the real
  // letter tops (box rides high, descender clipped); `sCapHeight` alone
  // undershoots, since 'b'/'h'/'k' ascenders do sit above cap height. All
  // three candidates were rendered through libass and pixel-measured across
  // the 23 bundled faces (single-word cue, ink scanned over the full frame):
  //
  //   proxy    total |padT-padB|   total ink spilling below the box
  //   ascender        222 px                 13 px
  //   capHeight       156 px                  0 px
  //   midpoint        124 px   <- best        0 px   <- best
  //
  // sCapHeight only exists in OS/2 v2+; fall back to the ascender when the
  // table is older or too short to hold it.
  const capHOs2 = (os2 != null && u16(buf, os2) >= 2 && os2 + 90 <= buf.length)
    ? i16(buf, os2 + 88) : 0;
  // [TITLE-INK-LEADING] OS/2 lebih tua dari v2 tidak punya sCapHeight sama
  // sekali. Dulu itu jatuh ke hhea.ascender — ascender PENUH, bukan tinggi
  // kapital — dan untuk dua face bundled keduanya kebetulan identik dengan
  // usWinAscent (0.9160), jadi "lead" tinta jadi nol dan perapatan baris
  // menolak bekerja untuk face itu. Sementara PREVIEW mengukur tinta 'H'
  // dengan canvas dan tetap merapatkan → selisih sepihak ~37px.
  //
  // Jalan keluarnya bukan menebak: ukur saja glyph 'H'-nya, yaitu benda yang
  // sama yang diukur canvas Chrome. Terverifikasi persis terhadap Chrome:
  //   Apple Garamond      glyf yMax 0.6300 em  <-> measureText 0.6300
  //   Times NR Cond Bold  glyf yMax 0.6821 em  <-> measureText 0.6821
  // DUA proxy, dan mereka TIDAK boleh disatukan:
  //
  //   topUnits (pusat KOTAK highlight) — OS/2 sCapHeight saja, cadangan asc.
  //     Ini hasil kalibrasi |padT-padB| atas 23 face lewat render nyata, dan
  //     cadangan `asc` itu BAGIAN dari kalibrasi itu. Terukur saat mencoba
  //     menyatukannya: memberi capH-dari-glyf ke sini memperburuk kotak Apple
  //     Garamond dari |padT-padB| 4px jadi 18px, dan Times NR Condensed dari
  //     0px jadi 14px. Face lain tidak berubah. Jadi dikembalikan.
  //
  //   capHInk (jarak antar BARIS) — capHeight sungguhan, diukur dari glyph 'H'
  //     kalau OS/2 tidak menyediakannya. Di sini `asc` justru salah: ia bikin
  //     lead nol dan perapatan menolak bekerja, sementara preview tetap
  //     merapatkan (selisih sepihak ~37px).
  const topUnits = capHOs2 > 0 ? (asc + capHOs2) / 2 : asc;
  const capHInk = capHOs2 > 0 ? capHOs2 : capHeightFromGlyf(buf, tables, upem);
  const inkCenterEm = baselineEm - (topUnits + desc) / (2 * upem);

  // [TITLE-INK-LEADING] Rentang tinta untuk JARAK ANTAR BARIS. Sengaja TIDAK
  // memakai `topUnits` milik inkCenterEm di atas — keduanya menjawab pertanyaan
  // berbeda, dan itu terukur:
  //
  //   Open Sauce Two Bold (upem 1000): hhea.asc 1000, capH 763, winAsc 1000.
  //   topUnits = (1000+763)/2 = 881.5  ->  0.8815 em
  //
  // Burn nyata 1080x1920, \an8\pos(540,305), \fs98 (px 79) lalu \fs247 (px 200),
  // dipindai pikselnya:
  //
  //   "Fbal Ini" px79   : tinta 323..384  -> naik dari baseline 0.772 em
  //   "Ternyata" px79   : tinta 422..497  -> naik 0.759 em, turun 0.190 em
  //   "Ternyata" px200  : tinta 450..642  -> naik 0.765 em, turun 0.195 em
  //
  // Tinta NYATA naik 0.759-0.772 em. capH/upem = 0.7630 memprediksinya dalam
  // 1%; topUnits (0.8815) meleset 0.11 em — pada px200 itu 22px, dan justru
  // ke arah yang salah untuk perapatan baris.
  //
  // topUnits tetap benar untuk KOTAK highlight: ia dipilih lewat kalibrasi
  // |padT-padB| atas 23 face (lihat [BOX-VCENTER-INK]), yaitu kompromi supaya
  // kotak tidak memotong descender maupun mengapung. Menyetel kotak ke capH
  // akan membatalkan kalibrasi itu. Jadi: capH untuk jarak baris, topUnits
  // untuk pusat kotak — dua proxy, dua alasan terukur, keduanya didokumentasi.
  const inkAscEm  = capHInk > 0 ? capHInk / upem : asc / upem;
  // `desc` mentah dan NEGATIF (hhea.descender), seperti dipakai inkCenterEm.
  // Dibalik tandanya supaya pemanggil dapat jarak turun yang positif. Sedikit
  // lebih longgar dari descender 'y' yang terukur (0.237 vs 0.195) — ke arah
  // aman: jarak baris jadi sedikit lega, bukan bertumbukan.
  const inkDescEm = -desc / upem;
  // Baseline di bawah jangkar atas \an7/\an8, dalam em ukuran px kanonik.
  // libass memenuhi Fontsize dengan usWinAscent+usWinDescent, jadi baseline
  // duduk winAsc di bawah atas kotak-baris. Terverifikasi: baris tanpa
  // descender ("Fbal Ini") berakhir tepat di 384 = 305 + 1.000 x 79.
  const baselineOffsetEm = baselineEm;

  const count = u16(buf, name + 2);
  const strOff = name + u16(buf, name + 4);
  const names = [];
  for (let i = 0; i < count; i++) {
    const r = name + 6 + 12 * i;
    if (r + 12 > buf.length) break;
    const pid = u16(buf, r), nid = u16(buf, r + 6);
    const len = u16(buf, r + 8), off = u16(buf, r + 10);
    if (!NAME_IDS.includes(nid)) continue;
    const s = buf.subarray(strOff + off, strOff + off + len);
    if (!s.length) continue;
    let str;
    try { str = pid === 3 || pid === 0 ? s.toString('utf16le').split('').length && Buffer.from(s).swap16().toString('utf16le') : s.toString('latin1'); }
    catch { continue; }
    if (str) names.push(str);
  }
  return { ratio, cssRatio, inkCenterEm, inkAscEm, inkDescEm, baselineOffsetEm, names, bold, italic };
}

// [TITLE-INK-LEADING] Tinggi kapital dari garis besar glyph 'H', untuk face
// yang OS/2-nya tidak punya sCapHeight (versi < 2).
//
// Membaca yMax dari header glyph di tabel `glyf` — angka yang sama yang
// dilaporkan canvas sebagai actualBoundingBoxAscent untuk 'H'. Font CFF/OTF
// tidak punya `glyf`; di situ fungsi ini mengembalikan 0 dan pemanggilnya
// kembali ke cadangan hhea seperti sebelumnya.
function capHeightFromGlyf(buf, tables, upem) {
  try {
    const head = tables['head'], glyf = tables['glyf'], loca = tables['loca'];
    const cmap = tables['cmap'], maxp = tables['maxp'];
    if (head == null || glyf == null || loca == null || cmap == null || maxp == null) return 0;
    if (head + 52 > buf.length || maxp + 6 > buf.length) return 0;
    // pickCmap mengembalikan OFFSET subtabel, bukan fungsi — parseCmap4 yang
    // mengubahnya jadi pencari. (Memanggil offset itu sebagai fungsi melempar,
    // dan try/catch di bawah akan menelannya jadi "face ini tak punya capHeight"
    // secara diam-diam. Terjadi saat menulis ini.)
    const sub = pickCmap(buf, cmap);
    if (!sub) return 0;
    const gid = parseCmap4(buf, sub)(0x48);   // 'H'
    if (!gid) return 0;
    const numGlyphs = u16(buf, maxp + 4);
    if (gid >= numGlyphs) return 0;
    const longLoca = i16(buf, head + 50) === 1;
    const at = longLoca
      ? (i) => (loca + i * 4 + 4 <= buf.length ? u32(buf, loca + i * 4) : null)
      : (i) => (loca + i * 2 + 2 <= buf.length ? u16(buf, loca + i * 2) * 2 : null);
    const o0 = at(gid), o1 = at(gid + 1);
    // o0 === o1 berarti glyph kosong (tanpa garis besar) — bukan 'H' yang sah.
    if (o0 == null || o1 == null || o1 <= o0) return 0;
    const g = glyf + o0;
    if (g + 10 > buf.length) return 0;
    const yMax = i16(buf, g + 8);
    // Sanity: kapital yang masuk akal ada di 0,4-1,0 em. Angka di luar itu
    // berarti tabelnya tidak seperti dugaan; lebih baik menolak daripada
    // memposisikan baris dari angka sampah.
    if (!(yMax > 0.4 * upem && yMax <= upem)) return 0;
    return yMax;
  } catch { return 0; }
}

// [BOX-WIDTH] Advance widths, untuk menggambar kotak highlight sebagai vector.
// parseFace() di atas hanya membaca tinggi; kotak butuh LEBAR, yang berarti dua
// tabel lagi: cmap (karakter → glyph id) dan hmtx (advance per glyph).

// cmap format 4 — satu-satunya format yang dibutuhkan untuk teks Latin BMP.
function parseCmap4(buf, off) {
  const segCountX2 = u16(buf, off + 6);
  const segCount = segCountX2 / 2;
  const endO   = off + 14;
  const startO = endO + segCountX2 + 2;   // +2 = reservedPad
  const deltaO = startO + segCountX2;
  const rangeO = deltaO + segCountX2;
  return (code) => {
    for (let i = 0; i < segCount; i++) {
      const end = u16(buf, endO + i * 2);
      if (code > end) continue;
      const start = u16(buf, startO + i * 2);
      if (code < start) return 0;
      const delta = i16(buf, deltaO + i * 2);
      const ro    = u16(buf, rangeO + i * 2);
      if (ro === 0) return (code + delta) & 0xffff;
      const gO = rangeO + i * 2 + ro + (code - start) * 2;
      if (gO + 2 > buf.length) return 0;
      const g = u16(buf, gO);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}

// Pilih subtable Windows Unicode BMP (3,1); jatuh ke Unicode (0,x) kalau tidak ada.
function pickCmap(buf, cmapOff) {
  const n = u16(buf, cmapOff + 2);
  let best = 0;
  for (let i = 0; i < n; i++) {
    const r = cmapOff + 4 + i * 8;
    if (r + 8 > buf.length) break;
    const pid = u16(buf, r), eid = u16(buf, r + 2);
    const sub = cmapOff + u32(buf, r + 4);
    if (sub + 4 > buf.length) continue;
    if (u16(buf, sub) !== 4) continue;          // hanya format 4
    if (pid === 3 && eid === 1) return sub;      // pilihan utama
    if (!best && (pid === 0 || pid === 3)) best = sub;
  }
  return best;
}

// Mengembalikan { advanceOf(charCode) → lebar dalam satuan em } atau null.
function parseWidths(buf) {
  if (buf.length < 12) return null;
  const numTables = u16(buf, 4);
  const t = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    if (o + 16 > buf.length) return null;
    t[buf.toString('latin1', o, o + 4)] = u32(buf, o + 8);
  }
  const { head, hhea, hmtx, maxp, cmap } = {
    head: t['head'], hhea: t['hhea'], hmtx: t['hmtx'], maxp: t['maxp'], cmap: t['cmap'],
  };
  if (head == null || hhea == null || hmtx == null || maxp == null || cmap == null) return null;
  if (head + 20 > buf.length || hhea + 36 > buf.length || maxp + 6 > buf.length) return null;

  const upem = u16(buf, head + 18);
  const numHMetrics = u16(buf, hhea + 34);
  const numGlyphs = u16(buf, maxp + 4);
  if (!upem || !numHMetrics || !numGlyphs) return null;

  const sub = pickCmap(buf, cmap);
  if (!sub) return null;
  const gidOf = parseCmap4(buf, sub);

  // hmtx: numHMetrics entri {advance u16, lsb i16}; glyph sesudahnya memakai
  // advance terakhir (monospace tail — spesifikasi OpenType).
  const advanceOfGid = (gid) => {
    const i = Math.min(gid, numHMetrics - 1);
    const o = hmtx + i * 4;
    if (o + 2 > buf.length) return 0;
    return u16(buf, o);
  };

  return (code) => {
    const gid = gidOf(code);
    if (!gid || gid >= numGlyphs) return null;   // glyph tidak ada di font ini
    return advanceOfGid(gid) / upem;
  };
}

// Cache kedua, terpisah dari cache ratio: kunci sama (nama|bold|italic), isi
// berbeda (fungsi advance, bukan angka).
let _wCache = null;

function buildWidthCache(dir) {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return map; }
  for (const f of files) {
    if (!/\.(ttf|otf)$/i.test(f)) continue;
    let buf, face, widths;
    try {
      buf = fs.readFileSync(path.join(dir, f));
      face = parseFace(buf);
      widths = parseWidths(buf);
    } catch { continue; }
    if (!face || !widths) continue;
    for (const n of face.names) {
      const k = normKey(n);
      if (!k) continue;
      const sk = `${k}|${face.bold ? 'b' : ''}|${face.italic ? 'i' : ''}`;
      if (!map.has(sk)) map.set(sk, widths);
      if (!map.has(k)) map.set(k, widths);
    }
  }
  return map;
}

/**
 * Lebar `text` dalam satuan **em** untuk sebuah face bundled.
 *
 * Kalikan dengan ukuran em dalam px (= ukuran CSS px yang dipakai preview) untuk
 * mendapat lebar piksel.
 *
 * HANYA menjumlahkan advance glyph. Tracking TIDAK termasuk: pemanggil wajib
 * menambahkan `(text.length - 1) * fspPx` — lihat "Burn proofing" butir 1, di
 * mana rumus itu diverifikasi eksak terhadap libass. Dipisah karena `\fsp`
 * hidup di satuan piksel ASS, sedangkan fungsi ini bekerja di satuan em.
 *
 * Mengembalikan `null` — BUKAN angka tebakan — kalau font tidak dikenal atau
 * ada glyph yang tidak dimiliki font itu. Pemanggil WAJIB menangani null;
 * lihat [BOX-WIDTH-STRICT]. Ini sengaja berbeda dari fontEmScale(), yang
 * mengembalikan 1 diam-diam dan karena itu pernah menyembunyikan bug.
 */
function textWidthEm(text, fontName, fontsDir, bold = false, italic = false) {
  if (text === '') return 0;
  if (!fontName) return null;
  if (!_wCache) _wCache = buildWidthCache(fontsDir || path.join(__dirname, '..', 'assets', 'fonts'));
  const state = `|${bold ? 'b' : ''}|${italic ? 'i' : ''}`;
  const direct = normKey(fontName);
  const loose = normKey(String(fontName).replace(/[-_]+/g, ' '));
  const w = _wCache.get(direct + state) || _wCache.get(loose + state)
         || _wCache.get(direct)        || _wCache.get(loose);
  if (!w) return null;
  let sum = 0;
  for (const ch of String(text)) {
    const a = w(ch.codePointAt(0));
    if (a == null) return null;
    sum += a;
  }
  return sum;
}

function normKey(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function buildCache(dir) {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return map; }
  for (const f of files) {
    if (!/\.(ttf|otf)$/i.test(f)) continue;
    let face;
    try { face = parseFace(fs.readFileSync(path.join(dir, f))); } catch { face = null; }
    if (!face) continue;
    for (const n of face.names) {
      const k = normKey(n);
      if (!k) continue;
      // [FS-EM-FACE] Two keys per name. The STATE-qualified one ('name|b|i') is
      // what a bold/italic request looks up, so a family with real siblings gets
      // that sibling's own ratio. The bare name stays as the family fallback for
      // a state the family has no face for — which is exactly when libass
      // synthesizes from the upright, so the upright's ratio is the right answer.
      const sk = `${k}|${face.bold ? 'b' : ''}|${face.italic ? 'i' : ''}`;
      const entry = {
        ratio: face.ratio, cssRatio: face.cssRatio, inkCenterEm: face.inkCenterEm,
        inkAscEm: face.inkAscEm, inkDescEm: face.inkDescEm,
        baselineOffsetEm: face.baselineOffsetEm,
      };
      if (!map.has(sk)) map.set(sk, entry);
      // First writer wins for the bare name, as before.
      if (!map.has(k)) map.set(k, entry);
    }
  }
  return map;
}

/**
 * (ascender − descender) / unitsPerEm for a bundled face.
 *
 * `bold`/`italic` describe the state the burn is about to request (\b1/\i1), not
 * the name: pass them and you get the ratio of the face libass will ACTUALLY
 * render, falling back to the family's upright when the family has no such
 * sibling (libass then synthesizes, which keeps the upright's metrics).
 *
 * Returns 1 for anything we cannot resolve — an unknown name means libass will
 * be substituting a system font we did not measure, and scaling by a guess
 * would be worse than leaving the size alone.
 */
function fontEmScale(fontName, fontsDir, bold = false, italic = false) {
  if (!fontName) return 1;
  if (!_cache) _cache = buildCache(fontsDir || path.join(__dirname, '..', 'assets', 'fonts'));
  const state = `|${bold ? 'b' : ''}|${italic ? 'i' : ''}`;
  const direct = normKey(fontName);
  // Saved clips carry PostScript-ish spellings ("Poppins-Bold",
  // "TimesNewRomanMTStd-BoldCond") that the name table lists in spaced form.
  const loose = normKey(String(fontName).replace(/[-_]+/g, ' '));
  const e = _cache.get(direct + state) || _cache.get(loose + state)
         || _cache.get(direct)        || _cache.get(loose);
  return e ? e.ratio : 1;
}

/**
 * CSS content-box line-height ratio — `(hhea.ascender - hhea.descender +
 * hhea.lineGap) / unitsPerEm` — for a bundled face. This is what a browser
 * actually renders as an inline element's height at `font-size: N px`, and
 * it is what the box-highlight preview's height is really measuring. It is
 * NOT the same number as fontEmScale()'s OS/2-win ratio (that one is for
 * matching libass's Fontsize, a separate, unrelated quirk) — using
 * fontEmScale for box height was measured against real Chrome layout (15 Agu
 * 2026) to overshoot by 13-17.5% on faces where hhea and OS/2 win diverge
 * (Anton, Poppins Bold), making the burned box visibly taller than preview.
 *
 * Returns 1 for anything we cannot resolve, matching fontEmScale's contract.
 */
function cssLineHeightEm(fontName, fontsDir, bold = false, italic = false) {
  if (!fontName) return 1;
  if (!_cache) _cache = buildCache(fontsDir || path.join(__dirname, '..', 'assets', 'fonts'));
  const state = `|${bold ? 'b' : ''}|${italic ? 'i' : ''}`;
  const direct = normKey(fontName);
  const loose = normKey(String(fontName).replace(/[-_]+/g, ' '));
  const e = _cache.get(direct + state) || _cache.get(loose + state)
         || _cache.get(direct)        || _cache.get(loose);
  return e ? e.cssRatio : 1;
}

/**
 * Distance from the \an7 top anchor down to the vertical CENTRE of the glyph
 * ink, in em units — see [BOX-VCENTER-INK] in parseFace for the derivation.
 * Multiply by the canonical font size to get pixels.
 *
 * Returns null when the face cannot be resolved, so the caller can fall back
 * to its previous line-box maths rather than silently centring on a guess.
 */
function fontInkCenterEm(fontName, fontsDir, bold = false, italic = false) {
  if (!fontName) return null;
  if (!_cache) _cache = buildCache(fontsDir || path.join(__dirname, '..', 'assets', 'fonts'));
  const state = `|${bold ? 'b' : ''}|${italic ? 'i' : ''}`;
  const direct = normKey(fontName);
  const loose = normKey(String(fontName).replace(/[-_]+/g, ' '));
  const e = _cache.get(direct + state) || _cache.get(loose + state)
         || _cache.get(direct)        || _cache.get(loose);
  return e && Number.isFinite(e.inkCenterEm) ? e.inkCenterEm : null;
}

/**
 * Rentang tinta satu face relatif BASELINE, dalam em: `{ ascEm, descEm }`.
 * Kalikan dengan ukuran px kanonik (fsw, bukan \fs) untuk dapat piksel.
 *
 * `ascEm` = OS/2 sCapHeight (hhea.ascender kalau face-nya tak punya), yaitu
 * tinggi tinta NYATA satu baris teks — lihat [TITLE-INK-LEADING] di parseFace
 * untuk kenapa ini BUKAN proxy yang dipakai fontInkCenterEm. `descEm` positif
 * ke bawah. `baselineEm` = jarak jangkar atas \an7/\an8 ke baseline.
 *
 * Mengembalikan null kalau face tak terselesaikan, supaya pemanggil bisa jatuh
 * ke perhitungan kotak-baris lamanya alih-alih memakai angka tebakan.
 */
function fontInkExtentEm(fontName, fontsDir, bold = false, italic = false) {
  if (!fontName) return null;
  if (!_cache) _cache = buildCache(fontsDir || path.join(__dirname, '..', 'assets', 'fonts'));
  const state = `|${bold ? 'b' : ''}|${italic ? 'i' : ''}`;
  const direct = normKey(fontName);
  const loose = normKey(String(fontName).replace(/[-_]+/g, ' '));
  const e = _cache.get(direct + state) || _cache.get(loose + state)
         || _cache.get(direct)        || _cache.get(loose);
  if (!e || !Number.isFinite(e.inkAscEm) || !Number.isFinite(e.inkDescEm)) return null;
  return {
    ascEm: e.inkAscEm,
    descEm: e.inkDescEm,
    baselineEm: Number.isFinite(e.baselineOffsetEm) ? e.baselineOffsetEm : null,
  };
}

function __reset() { _cache = null; _wCache = null; }

module.exports = {
  fontEmScale, cssLineHeightEm, fontInkCenterEm, fontInkExtentEm, textWidthEm,
  __reset, __parseFace: parseFace, __capHeightFromGlyf: capHeightFromGlyf,
};
