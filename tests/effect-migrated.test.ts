import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';
import {
  countSource,
  lintFindings,
  presentPatterns,
  readMarker,
  repositoryRoot,
  scoredFiles,
} from './effect-migration.ts';
import type { LintFinding, Marker } from './effect-migration.ts';

type MarkedFile = {
  readonly file: string;
  readonly source: string;
  readonly marker: Exclude<Marker, { kind: 'unmarked' }>;
};

const allowanceHint = 'or justify an allowance in its // @effect-migrated marker';

/** Why a file marked as migrated is not fully Effect. */
const problems = ({ file, source, marker }: MarkedFile, findings: readonly LintFinding[]) => {
  if (marker.kind === 'invalid') {
    return [`${file} is marked as migrated, but ${marker.problem}`];
  }
  const patterns = presentPatterns(countSource(source))
    .filter(({ pattern }) => !marker.allow.includes(pattern))
    .map(
      ({ pattern, count }) =>
        `${file} is marked as migrated but still has ${pattern} (${count}): migrate it, ${allowanceHint}`,
    );
  const lines = new Map<string, number[]>();
  for (const { rule, line, ...finding } of findings) {
    if (finding.file === file && !marker.allow.includes(rule)) {
      lines.set(rule, [...(lines.get(rule) ?? []), line]);
    }
  }
  const lint = Array.from(
    lines,
    ([rule, at]) =>
      `${file} is marked as migrated but oxlint reports ${rule} on lines ${at.join(', ')}: fix the type or decode with Schema, ${allowanceHint}`,
  );
  return [...patterns, ...lint];
};

layer(NodeServices.layer)((it) => {
  // The marked files are only known once the sources are read, so one test
  // checks them all and lists every problem it finds. oxlint runs once over
  // all of them with type information, which takes a few seconds.
  it.effect(
    'every file marked // @effect-migrated is fully Effect',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* repositoryRoot;
        const marked: MarkedFile[] = [];
        for (const { files } of yield* scoredFiles()) {
          for (const absolute of files) {
            const source = yield* fs.readFileString(absolute);
            const marker = readMarker(source);
            if (marker.kind !== 'unmarked') {
              const file = path.relative(root, absolute).split(path.sep).join('/');
              marked.push({ file, source, marker });
            }
          }
        }
        const findings = yield* lintFindings(marked.map(({ file }) => file));
        expect(marked.flatMap((entry) => problems(entry, findings))).toEqual([]);
      }),
    60_000,
  );
});
