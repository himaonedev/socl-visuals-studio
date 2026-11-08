# Fitur CutVii di SOCL

Jalankan dari folder aplikasi dengan `pnpm tauri dev` atau `run-dev.cmd`.

1. Kerjakan clipping seperti biasa di tampilan SOCL.
2. Pilih hasil clip, lalu tekan **Effects (✦)** di sidebar.
3. Clip masuk ke timeline Effects. Pilih layer yang akan diedit untuk menampilkan kontrolnya di inspector.
4. Gunakan panel efek untuk Freeze Highlight/Halftone dan Facecam Styles; panel Motion untuk animasi; panel Text untuk caption, marker dan flicker.
5. Simpan proyek melalui menu File, lalu gunakan Export untuk membuat video hasil edit.

**Kembali ke Clipping** mempertahankan proyek di memori selama aplikasi masih terbuka. Simpan proyek untuk mempertahankan edit setelah aplikasi ditutup. Buat proyek baru sebelum membuka clip berikutnya jika ingin satu proyek untuk setiap clip; membuka clip lain ke proyek yang sama akan menambahkannya ke timeline.

Fitur yang dibawa: freeze/moving highlight, 10 facecam styles, pengaturan subject/background, caption dan box per kata, motion presets dan Copy/Paste Motion, marker/strikethrough, flicker, timeline multi-select/layer, serta New/Open/Recent Project. Voice-over dan AI upscale tidak diaktifkan dalam integrasi ini.

## Caption saat Freeze

Impor dari Clipping memakai rawFile bersih dan membuat layer caption terpisah bila data sumbernya tersedia. Caption pada video/PNG hasil render sudah menjadi piksel dan akan ikut membeku. Proyek lama perlu dibuat ulang dari sumber bersih; edit lama tidak diubah otomatis. Efek/judul/gaya caption yang sebelumnya dibakar pada render belum disalin persis dan perlu diatur ulang di Effects/Text. Menu Appearance sudah dihapus.
