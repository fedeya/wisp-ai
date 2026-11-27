import { test, expect } from 'vitest';
import { compare, readBaseline, scoreboard } from './effect-migration.ts';
import type { Change } from './effect-migration.ts';

const formatChanges = (changes: readonly Change[]) =>
  changes
    .map(
      ({ workspace, pattern, baseline, current }) =>
        `  ${workspace} ${pattern}: ${baseline} -> ${current}`,
    )
    .join('\n');

const { rises, drops } = compare(readBaseline(), scoreboard());

// Only rises fail. Migration PRs leave the baseline alone so they don't
// conflict with each other, and it is lowered after they merge.
test('no workspace adds non-Effect patterns', () => {
  expect(
    rises,
    `New code must use Effect, see docs/effect-migration.md. These counts rose:\n${formatChanges(rises)}`,
  ).toEqual([]);
  if (drops.length > 0) {
    process.stdout.write(
      `Effect migration counts are below the baseline; lower it after merging with \`pnpm --filter @wisp/tests effect:baseline\`:\n${formatChanges(drops)}\n`,
    );
  }
});
