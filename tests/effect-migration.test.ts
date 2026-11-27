import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, layer } from '@effect/vitest';
import { Console, Effect, Layer } from 'effect';
import { compare, readBaseline, scoreboard } from './effect-migration.ts';
import type { Change } from './effect-migration.ts';

const formatChanges = (changes: readonly Change[]) =>
  changes
    .map(
      ({ workspace, pattern, baseline, current }) =>
        `  ${workspace} ${pattern}: ${baseline} -> ${current}`,
    )
    .join('\n');

// Without the test services, so the note about drops goes to the real console.
layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer), { excludeTestServices: true })((it) => {
  // Only rises fail. Migration PRs leave the baseline alone so they don't
  // conflict with each other, and it is lowered after they merge.
  it.effect('no workspace adds non-Effect patterns', () =>
    Effect.gen(function* () {
      const { rises, drops } = compare(yield* readBaseline, yield* scoreboard());
      expect(
        rises,
        `New code must use Effect, see docs/effect-migration.md. These counts rose:\n${formatChanges(rises)}`,
      ).toEqual([]);
      if (drops.length > 0) {
        yield* Console.log(
          `Effect migration counts are below the baseline; lower it after merging with \`pnpm --filter @wisp/tests effect:baseline\`:\n${formatChanges(drops)}`,
        );
      }
    }),
  );
});
