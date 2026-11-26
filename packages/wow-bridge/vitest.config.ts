import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./node_modules/.cache/vitest', import.meta.url)),
  test: {
    name: 'wow-bridge',
    environment: 'node',
    include: ['packages/wow-bridge/tests/**/*.test.ts'],
    maxWorkers: 2,
  },
});
