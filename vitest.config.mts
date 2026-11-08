import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./frontend/editor', import.meta.url)) } },
  test: { environment: 'jsdom', setupFiles: ['frontend/editor/test/setup.ts'], globals: true,
    include: ['frontend/editor/timeline/*.test.*', 'frontend/integration/*.test.*'],
    maxWorkers: 1, fileParallelism: false, testTimeout: 30000,
  },
});
