import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const watch = process.env.SOCL_DEV_WATCH !== '0';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: { alias: { '@': fileURLToPath(new URL('./frontend/editor', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 1431, strictPort: true, hmr: watch, watch: watch ? { ignored: [
    '**/src-tauri/**', '**/.dev-tools/**', '**/src/**', '**/frontend/legacy-src/**', '**/backend/**',
    '**/public/legacy/**', '**/public/assets/**', '**/frontend/legacy.html', '**/frontend/legacy-scripts.json',
  ] } : null },
  build: { outDir: 'dist', emptyOutDir: true },
});

