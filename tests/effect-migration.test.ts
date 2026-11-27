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

test('no workspace adds non-Effect patterns', () => {
  expect(
    rises,
    `New code must use Effect, see docs/effect-migration.md. These counts rose:\n${formatChanges(rises)}`,
  ).toEqual([]);
});

test('the baseline records migration progress', () => {
  expect(
    drops,
    `These counts dropped. Record the progress with \`pnpm --filter @wisp/tests effect:baseline\` and commit tests/effect-migration-baseline.json:\n${formatChanges(drops)}`,
  ).toEqual([]);
});
