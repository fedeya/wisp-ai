import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    globalSetup: './evals/setup.ts',
    tags: [{ name: 'dungeons' }, { name: 'gear' }, { name: 'tiers' }],
    maxWorkers: 2,
    testTimeout: 330_000,
    reporters: ['vitest-evals/reporter', 'json'],
    outputFile: { json: 'eval-replies/results.json' },
  },
});
