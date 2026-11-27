import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  countFile,
  presentPatterns,
  readMarker,
  repositoryRoot,
  scoredFiles,
} from './effect-migration.ts';
import type { Marker } from './effect-migration.ts';

/** Every scored source file that carries an `// @effect-migrated` marker. */
const markedFiles = scoredFiles().flatMap(({ files }) =>
  files.flatMap((source) => {
    const marker = readMarker(readFileSync(source, 'utf8'));
    const file = path.relative(repositoryRoot, source).split(path.sep).join('/');
    return marker.kind === 'unmarked' ? [] : [{ file, source, marker }];
  }),
);

/** Why a file marked as migrated is not fully Effect. */
const problems = (file: string, source: string, marker: Exclude<Marker, { kind: 'unmarked' }>) => {
  if (marker.kind === 'invalid') {
    return [`${file} is marked as migrated, but ${marker.problem}`];
  }
  return presentPatterns(countFile(source))
    .filter(({ pattern }) => !marker.allow.includes(pattern))
    .map(
      ({ pattern, count }) =>
        `${file} is marked as migrated but still has ${pattern} (${count}): migrate it, or justify an allowance in its // @effect-migrated marker`,
    );
};

test.each(markedFiles)('$file is fully Effect', ({ file, source, marker }) => {
  expect(problems(file, source, marker)).toEqual([]);
});
