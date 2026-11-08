# Sumber backend TypeScript

`backend/` adalah sumber yang diedit untuk seluruh modul backend Node yang saat ini dijangkau engine SOCL, termasuk worker konteks. `modules.json` memetakan sumber TypeScript ke output runtime. Beberapa modul UMD dipakai bersama oleh backend dan UI caption lama; sumbernya juga berada di sini.

`engine/*.cjs` dan modul `src/*.js` yang tercantum dalam manifest adalah hasil kompilasi. Jangan mengeditnya langsung: perubahan akan diganti pada build berikutnya. JSON manifest model, aset, dan worker Python tetap berada di lokasi semula. Sumber UI Clipping/Edit ada di `frontend/legacy-src/`; 11 modul UI bersama memakai sumber backend melalui `frontend/legacy-modules.json`.

- `pnpm build:backend`: kompilasi semua sumber backend, dengan pemeriksaan sintaks TypeScript, ke lokasi runtime lama. Path worker, assets, `require`, `__dirname`, dan packaging tetap kompatibel.
- `pnpm typecheck:backend`: pemeriksaan sintaks seluruh sumber ditambah pemeriksaan tipe strict pada server, kontrak IPC, platform bridge, jaringan dan server media.
- `pnpm tauri dev` dan build installer mengompilasi backend otomatis sebelum engine dijalankan.
- Restart `pnpm tauri dev` setelah perubahan backend, termasuk pada mode `--watch`: modul Node yang sudah dimuat tidak diganti saat proses sedang download/render.

## Batas migrasi tipe saat ini

Semua sumber backend dalam manifest sudah TypeScript, tetapi ini belum berarti seluruh pipeline memiliki tipe strict. Modul pipeline lama masih dinamis dan hanya melalui transpiler serta pemeriksaan sintaks. `tsconfig.json` secara eksplisit memeriksa lima modul inti: server, kontrak IPC, platform bridge, jaringan dan media; modul lain perlu diberi tipe per fungsi sebelum dimasukkan ke pemeriksaan strict. Tidak ada `@ts-nocheck` yang ditambahkan untuk menyamarkan status ini.

Node masih diperlukan untuk menjalankan backend ini. TypeScript dikompilasi menjadi JavaScript/CommonJS; migrasi sumber ke TypeScript berbeda dari pemindahan implementasi ke Rust. Entry development di `scripts/` memakai TypeScript langsung melalui Node 24; helper build sebagian masih CJS.
