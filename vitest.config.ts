import { readdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    watch: {
      ignored: [
        '**/runtime/**',
        '**/.eve/**',
        '**/dist/**',
        '**/dist-ui/**',
        '**/src-tauri/target/**',
        '**/src-tauri/resources/**',
        '**/src-tauri/gen/**',
      ],
    },
  },
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'scripts/vitest.config.ts',
      'tests/vitest.config.ts',
    ],
    watchTriggerPatterns: [
      {
        pattern: /(?:^|\/)addon\/(?:WispAI\/.*|tests\/.*)\.lua$/,
        testsToRun: () =>
          readdirSync('tests/addon')
            .filter((file) => file.endsWith('.test.ts'))
            .map((file) => 'tests/addon/' + file),
      },
    ],
  },
});
