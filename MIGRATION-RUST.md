# Migrasi backend SOCL ke Rust

Target akhir: aplikasi desktop Tauri 2 dengan backend Rust, frontend React 19 / TypeScript / Vite / Tailwind / Zustand, tanpa runtime Node dalam aplikasi terpasang. Node/pnpm tetap merupakan alat development/build frontend.

## Mode development

`pnpm tauri dev` mengaktifkan auto-restart Rust dan reload frontend secara default. `--watch` tetap diterima untuk kompatibilitas. Gunakan `pnpm tauri dev --no-watch` untuk mode stabil saat menguji download/render tanpa restart akibat perubahan kode. Dalam mode stabil, jalankan ulang perintah secara manual untuk memuat perubahan kode. `pnpm dev` tetap menyediakan watcher frontend untuk pengembangan UI.

## Sudah dipindahkan

- 22 channel IPC ditangani Rust: impor video/subtitle/folder, settings, DPAPI Windows, metadata clip, History, watermark, cookies, thumbnail, lokasi tool, pembukaan folder hasil, reveal clip dan pengelola Whisper lokal. Daftar aktual ada di MIGRATION-STATUS.json.
- Whisper lokal: status, ensure dan remove ditangani Rust dengan manifest dan folder instalasi yang sama. Unduhan baru diperiksa ukuran dan checksum SHA-256 ketika tersedia dalam manifest. Model lama tetap dikenali. VAD opsional; kegagalan unduh VAD tidak menggagalkan transkripsi. Permintaan instalasi dari pipeline juga didelegasikan langsung ke Rust, dengan progress kembali ke log pipeline dan UI. Handler pemasangan Node tidak terdaftar dalam mode desktop. Eksekusi/transkripsi dan orkestrasi pipeline lama masih belum sepenuhnya native.
- Preview clipping dan Effects berbagi server Rust di semua desktop: token lokal, file scope, HEAD dan byte ranges/seek. Mode desktop tidak lagi membuat server HTTP Node.
- Metrik font caption dilayani Rust dari metadata hasil pengukuran font saat build (293 alias, 14 gaya). Fixture membandingkan hasil dengan implementasi lama.
- Settings mempertahankan 58 default lama dan normalisasi pengaturan lama, field tambahan dan workRoots. API key tetap memakai format secrets.bin yang kompatibel; enkripsi/dekripsi Windows berjalan langsung melalui DPAPI, tanpa PowerShell pada layanan Rust ini.
- Penulisan settings/report memakai temp file + rename. Settings/secrets yang rusak tidak ditimpa oleh operasi save. Key plaintext lama dipindahkan sebelum field-nya dikosongkan.
- History membaca data/report.json dan format lama report.json, hanya folder sesi bertimestamp. Pemindaian volume dibatasi deadline dan worker per root.
- Node standalone dipertahankan sebagai oracle regresi. Empat handler settings/secrets dinonaktifkan pada mode desktop.

## Status target penuh

Sumber backend Node sekarang dipelihara sebagai TypeScript di `backend/` (53 modul, termasuk kontrak IPC baru). File runtime JS/CJS dikompilasi otomatis sebelum dev/build; lihat `backend/README.md`. Ini belum menghilangkan Node dan belum memberikan tipe strict pada seluruh pipeline lama. Server dan kontrak IPC sudah diperiksa strict; modul lama diperiksa sintaks dan diuji regresi.

BELUM selesai. Node masih wajib untuk bootstrap dan pipeline clipping asli. Masih ada 26 channel Node, termasuk download/update tool, model konteks/tracker, transkripsi/seleksi momen SOCL, AI provider, crop dan render lama. Jumlah channel bukan persentase penyelesaian: pipeline video adalah bagian yang paling besar.

UI Clipping/Edit SOCL sekarang memiliki sumber TypeScript: 30 script browser melalui `frontend/legacy-modules.json`, terdiri dari 19 sumber UI dan 11 sumber bersama backend. Lima modul UI inti diperiksa strict; renderer besar dan modul dinamis lain masih diperiksa sintaks. UI tersebut masih DOM yang di-host React, belum seluruhnya berupa komponen React. Editor Effects sudah React/Zustand dengan backend Rust. Backend Rust penuh tidak otomatis berarti semua panel UI clipping sudah ditulis ulang ke React.

Cek daftar terbaru:

```powershell
node scripts/migration-status.cjs
```

## Urutan lanjutan

1. Tool/model manager: yt-dlp, Deno, FFmpeg/ffprobe, Whisper, context model dan tracker; validasi unduhan, progress/cancel dan path binary aktif.
2. AI provider adapters serta catalog/preset; menjaga bentuk respons dan pemilihan provider.
3. Orkestrasi pipeline SOCL: download/import, transcript, pemilihan clip, crop/tracking, silence removal, captions/hooks, watermark dan export. Pertahankan event progress/cancel serta nama/path hasil.
4. Uji kesetaraan hasil untuk input lokal dan URL; jangan menghapus fitur atau mengganti operasi dengan respons kosong.
5. Hapus spawn engine/server.cjs, runtime/node.exe dan resource staging Node setelah semua channel dan startup native.
6. Migrasikan panel clipping lama ke komponen React dan store Zustand dengan tampilan SOCL dipertahankan.

FFmpeg, yt-dlp/Deno dan worker segmentasi tetap merupakan tool eksternal. Menulis ulang backend ke Rust tidak berarti menulis ulang codec atau model ML.

## Validasi

Tes native mencakup DPAPI, migrasi key plaintext, preservasi data/field, penolakan JSON rusak, metadata/report lama, cookie HttpOnly/BOM/header, batas folder watermark, lokasi ekspor kustom, dan HTTP Range/HEAD/token/file scope. Tes Node tetap mencakup render MP4 manual, redirect download dan preview, dengan satu tes khusus delegasi desktop ke Rust. Build native diperiksa lewat mirror C: karena keterbatasan canonicalization drive D: pada sandbox. Installer dan seluruh kombinasi efek belum diuji.

## Pemilik penulisan selama transisi

Patch report setelah crop/render dan perubahan settings internal dari pipeline Node sekarang dikirim balik ke layanan Rust dan ditunggu sebelum operasi selesai. Jalur ini memakai mutex/penulisan atomik yang sama dengan IPC native untuk menghindari read-modify-write lintas runtime. Pembuatan report awal pipeline masih merupakan bagian backend lama yang belum dipindahkan.

Validasi terakhir: 18 tes Rust terfilter dan 2 tes HTTP media lulus; 8 tes Node lulus. Seluruh 91 kasus frontend tercakup oleh run utama dan rerun terarah: satu worker freeze-highlight mengalami timeout startup saat build bersamaan, lalu 21 tes freeze-highlight/bridge lulus saat diulang. TypeScript dan build frontend/native lulus. Startup UI clipping dengan layanan settings/media Rust berhasil dibuka; uji preview GUI menyeluruh dan installer belum selesai.
