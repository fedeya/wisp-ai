import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path } from 'effect';
import {
  countSource,
  presentPatterns,
  readMarker,
  repositoryRoot,
  scoredFiles,
} from './effect-migration.ts';
import type { Marker } from './effect-migration.ts';

/** Why a file marked as migrated is not fully Effect. */
const problems = (file: string, source: string, marker: Exclude<Marker, { kind: 'unmarked' }>) => {
  if (marker.kind === 'invalid') {
    return [`${file} is marked as migrated, but ${marker.problem}`];
  }
  return presentPatterns(countSource(source))
    .filter(({ pattern }) => !marker.allow.includes(pattern))
    .map(
      ({ pattern, count }) =>
        `${file} is marked as migrated but still has ${pattern} (${count}): migrate it, or justify an allowance in its // @effect-migrated marker`,
    );
};

layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))((it) => {
  // The marked files are only known once the sources are read, so one test
  // checks them all and lists every problem it finds.
  it.effect('every file marked // @effect-migrated is fully Effect', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* repositoryRoot;
      const found: string[] = [];
      for (const { files } of yield* scoredFiles()) {
        for (const source of files) {
          const text = yield* fs.readFileString(source);
          const marker = readMarker(text);
          if (marker.kind !== 'unmarked') {
            const file = path.relative(root, source).split(path.sep).join('/');
            found.push(...problems(file, text, marker));
          }
        }
      }
      expect(found).toEqual([]);
    }),
  );
});
