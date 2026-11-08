# Tooling

Entry utama sekarang TypeScript: `tauri.ts`, `dev-frontend.ts`, dan `build-frontend.ts`. Node 24 menjalankannya langsung dengan dukungan TypeScript bawaan, tanpa file CJS peluncur perantara. `pnpm typecheck:tooling` memeriksa ketiganya dalam mode strict dan membatasi sintaks ke tipe yang bisa dihapus oleh Node.

Helper build/kompilasi di folder ini sebagian masih CommonJS. Pipeline aplikasi yang belum dipindahkan ke Rust juga masih memakai runtime Node dan file hasil kompilasi. Perubahan entry ke `.ts` tidak mengubah fakta itu, dan tidak mengubah format video hasil render.
