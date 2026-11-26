import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/cases/*.eval.ts'],
    globalSetup: './evals/runtime/global-setup.ts',
    setupFiles: ['./evals/runtime/worker-setup.ts'],
    tags: [
      { name: 'combat' },
      { name: 'dungeons' },
      { name: 'gear' },
      { name: 'locations' },
      { name: 'pvp' },
      { name: 'tiers' },
    ],
    maxWorkers: 2,
    testTimeout: 330_000,
    reporters: ['vitest-evals/reporter', 'json'],
    outputFile: { json: 'eval-replies/results.json' },
  },
});
