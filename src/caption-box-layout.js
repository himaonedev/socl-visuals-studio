'use strict';
// [BOX-LAYOUT] Offset horizontal tiap kata terhadap PUSAT baris cue.
//
// libass memusatkan satu baris Dialogue sebagai satu blok utuh. Box highlight
// menggambar rectangle `\p1` di baris TERPISAH yang tidak ikut alur teks itu,
// jadi satu-satunya hal yang perlu dihitung manual di sini adalah: dengan
// asumsi baris dipusatkan, di titik X mana (relatif ke pusat baris) tiap kata
// jatuh? Teks itu sendiri TIDAK disusun ulang oleh modul ini — pewarnaan
// per-kata yang sudah ada di buildAss tetap memakai satu baris teks utuh.
//
// Spasi antar-kata dihitung sebagai satu karakter spasi biasa (bukan lebar
// kustom) — konsisten dengan bagaimana libass sendiri me-layout teks dengan
// spasi literal di antara kata.
const { textWidthEm } = require('./font-metrics');

function wordCenterOffsetsEm(words, fontName, fontsDir, bold = false, italic = false) {
  if (!Array.isArray(words) || !words.length) return [];
  const widths = [];
  for (const w of words) {
    const wEm = textWidthEm(String(w), fontName, fontsDir, bold, italic);
    if (wEm == null) return null;
    widths.push(wEm);
  }
  const spaceEm = textWidthEm(' ', fontName, fontsDir, bold, italic);
  if (spaceEm == null) return null;

  // Posisi kiri tiap kata, menjumlahkan lebar kata+spasi sebelumnya.
  const lefts = [];
  let cursor = 0;
  for (let i = 0; i < widths.length; i++) {
    lefts.push(cursor);
    cursor += widths[i] + (i < widths.length - 1 ? spaceEm : 0);
  }
  const totalWidth = cursor;
  const lineCenter = totalWidth / 2;

  // Pusat tiap kata relatif terhadap pusat BARIS (bukan terhadap kata itu
  // sendiri) — inilah delta yang dipakai untuk \pos kotak.
  return widths.map((w, i) => (lefts[i] + w / 2) - lineCenter);
}

module.exports = { wordCenterOffsetsEm };
