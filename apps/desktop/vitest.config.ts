import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./node_modules/.cache/vitest', import.meta.url)),
  resolve: { conditions: ['browser'] },
  server: { watch: { ignored: ['**/src-tauri/**', '**/dist/**'] } },
  test: {
    name: 'desktop',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    maxWorkers: 2,
  },
});
