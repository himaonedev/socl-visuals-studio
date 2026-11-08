# Clipping/Edit TypeScript

Seluruh 30 script browser aktif memiliki sumber TypeScript. `frontend/legacy-modules.json` menentukan satu sumber untuk tiap script: 19 modul UI ada di folder ini, sedangkan 11 modul bersama tetap di `backend/src/` supaya browser dan render tidak memiliki dua implementasi berbeda.

Edit `renderer.ts` untuk UI Clipping/caption, bukan `src/renderer.js` atau `public/legacy/renderer.js`. File JS dalam manifest adalah hasil kompilasi dan memiliki header sumbernya. Script browser masih berupa script global/UMD agar tampilan dan urutan pemuatan SOCL tetap kompatibel; ini belum merupakan penulisan ulang UI tersebut menjadi komponen React.

- `pnpm build:legacy` mengompilasi 30 script ke lokasi runtime yang kompatibel.
- `pnpm typecheck:legacy` memeriksa sintaks seluruh script dan tipe strict untuk bridge IPC, tema, undo/redo, pengungkapan log dan pengelolaan media.
- `pnpm tauri dev` memantau sumber TS UI dan modul bersama, mengompilasinya sebelum reload. Mode `--no-watch` memerlukan restart manual.
- Build installer dan `pnpm test` mengompilasi sumber ini otomatis.

Renderer utama dan modul legacy dinamis lainnya sudah berupa sumber TS, tetapi belum seluruhnya masuk pemeriksaan tipe strict. Konfigurasi strict di folder ini mencantumkan modul yang benar-benar diperiksa; tidak memakai `@ts-nocheck` untuk menyembunyikan sisanya. Frontend React tetap menggunakan `tsconfig.json` utama, dan backend menggunakan `backend/tsconfig.json`.

Peluncur utama pada `scripts/` sudah TypeScript dan berjalan langsung dengan Node 24; sebagian helper build masih CommonJS. Node tetap diperlukan selama pipeline backend belum sepenuhnya dipindahkan ke Rust. File JavaScript di luar manifest yang berasal dari entry Electron lama bukan bagian runtime Tauri aktif.
