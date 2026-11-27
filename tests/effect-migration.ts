import { Effect, FileSystem, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

/**
 * Effect migration scoreboard: how often each workspace's shipped TypeScript
 * still uses a pattern that Effect replaces. Counts are a ratchet against the
 * checked-in baseline, not an exact parse, so the checks are plain regexes over
 * source lines and skip lines that are only comments.
 */

/** A path relative to this module's folder. */
const fromHere = Effect.fnUntraced(function* (relative: string) {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL(relative, import.meta.url));
});

export const repositoryRoot = fromHere('..');
const baselineFile = fromHere('./effect-migration-baseline.json');
/** Each workspace and the folder that holds its shipped code. */
const workspaces = [
  { workspace: 'apps/server', folder: 'apps/server/src', recursive: true },
  { workspace: 'apps/agent', folder: 'apps/agent/src', recursive: true },
  { workspace: 'apps/desktop', folder: 'apps/desktop/src', recursive: true },
  { workspace: 'packages/protocol', folder: 'packages/protocol/src', recursive: true },
  { workspace: 'packages/wow-bridge', folder: 'packages/wow-bridge/src', recursive: true },
  { workspace: 'packages/db', folder: 'packages/db/src', recursive: true },
  { workspace: 'packages/game-data', folder: 'packages/game-data/src', recursive: true },
  { workspace: 'packages/releases', folder: 'packages/releases/src', recursive: true },
  { workspace: 'scripts', folder: 'scripts', recursive: true },
] as const;

const importPatternNames = ['zodImports', 'honoImports', 'nodeIoImports'] as const;
const codePatternNames = [
  'fetchCalls',
  'timers',
  'processEnv',
  'newPromise',
  'asyncFunctions',
  'effectRuns',
  'effectPromises',
  'throwStatements',
  'tryBlocks',
] as const;

/** Every pattern, in the order reports list them. */
export const patternNames = [...importPatternNames, ...codePatternNames] as const;

type ImportPattern = (typeof importPatternNames)[number];
type CodePattern = (typeof codePatternNames)[number];
export type PatternName = ImportPattern | CodePattern;
export type Counts = Record<PatternName, number>;

const nodeIoModules = new Set(['fs', 'child_process', 'http', 'https']);

/** Matches a module specifier, counted once per import or re-export. */
const importPatterns: Record<ImportPattern, (specifier: string) => boolean> = {
  zodImports: (specifier) => specifier === 'zod' || specifier.startsWith('zod/'),
  honoImports: (specifier) =>
    specifier === 'hono' || specifier.startsWith('hono/') || specifier.startsWith('@hono/'),
  nodeIoImports: (specifier) =>
    nodeIoModules.has(specifier.replace(/^node:/, '').split('/')[0] ?? ''),
};

/** Matches code, counted once per occurrence. */
const codePatterns: Record<CodePattern, RegExp> = {
  // Plain `fetch(...)`, not a method such as `app.fetch(...)`.
  fetchCalls: /(?<![\w$.])fetch\s*\(/g,
  timers: /\b(?:setTimeout|setInterval)\s*\(/g,
  processEnv: /\bprocess\.env\b/g,
  newPromise: /\bnew\s+Promise\b/g,
  asyncFunctions: /\basync\b(?=\s*(?:function\b|\(|\*|<|[\w$]+\s*(?:=>|\()))/g,
  effectRuns: /\bEffect\.run\w*|(?<![\w$])run\w*With\b|\bManagedRuntime\.make\b/g,
  effectPromises: /\bEffect\.(?:promise|tryPromise)\s*\(/g,
  throwStatements: /\bthrow\b/g,
  tryBlocks: /\btry\s*\{/g,
};

const specifierPattern = /(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
const commentLine = /^\s*(?:\/\/|\/\*|\*)/;
const excludedFile = /\.(?:test|spec)\.|test-helpers?\.|\.d\.ts$|\.generated\./;
const excludedFolders = new Set(['node_modules', 'dist', 'tests', '__tests__']);

/** The scored source files in a folder, in name order. */
const sourceFiles = Effect.fnUntraced(function* (
  folder: string,
  recursive: boolean,
): Effect.fn.Return<string[], PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectoryEntries(folder);
  const nested = yield* Effect.forEach(
    [...entries].sort((a, b) => a.name.localeCompare(b.name)),
    (entry) => {
      const file = path.join(folder, entry.name);
      if (entry.type === 'Directory') {
        return recursive && !excludedFolders.has(entry.name)
          ? sourceFiles(file, recursive)
          : Effect.succeed([]);
      }
      return Effect.succeed(
        /\.tsx?$/.test(entry.name) && !excludedFile.test(entry.name) ? [file] : [],
      );
    },
  );
  return nested.flat();
});

const emptyCounts = (): Counts => ({
  zodImports: 0,
  honoImports: 0,
  nodeIoImports: 0,
  fetchCalls: 0,
  timers: 0,
  processEnv: 0,
  newPromise: 0,
  asyncFunctions: 0,
  effectRuns: 0,
  effectPromises: 0,
  throwStatements: 0,
  tryBlocks: 0,
});

/** Counts every pattern in one source text, adding to `counts`. */
export const countSource = (source: string, counts: Counts = emptyCounts()): Counts => {
  for (const line of source.split('\n')) {
    if (commentLine.test(line)) {
      continue;
    }
    for (const [, specifier = ''] of line.matchAll(specifierPattern)) {
      for (const name of importPatternNames) {
        if (importPatterns[name](specifier)) {
          counts[name] += 1;
        }
      }
    }
    for (const name of codePatternNames) {
      counts[name] += line.match(codePatterns[name])?.length ?? 0;
    }
  }
  return counts;
};

/** Counts every pattern in one source file. */
export const countFile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return countSource(yield* fs.readFileString(file));
});

/** The shipped source files the scoreboard counts, by workspace. */
export const scoredFiles = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const root = yield* repositoryRoot;
  return yield* Effect.forEach(workspaces, ({ workspace, folder, recursive }) =>
    Effect.map(sourceFiles(path.join(root, folder), recursive), (files) => ({
      workspace,
      files,
    })),
  );
});

/** Counts every pattern in every workspace's shipped sources. */
export const scoreboard = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const board: Record<string, Counts> = {};
  for (const { workspace, files } of yield* scoredFiles()) {
    const counts = emptyCounts();
    for (const file of files) {
      countSource(yield* fs.readFileString(file), counts);
    }
    board[workspace] = counts;
  }
  return board;
});

/** The patterns a file still contains, with their counts. */
export const presentPatterns = (counts: Counts) =>
  patternNames.flatMap((pattern) =>
    counts[pattern] > 0 ? [{ pattern, count: counts[pattern] }] : [],
  );

const ScoreboardSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int));
/** Pattern counts by workspace, as stored in the baseline file. */
export type Scoreboard = typeof ScoreboardSchema.Type;

/** The baseline file's text: the scoreboard as JSON indented by two spaces. */
const BaselineJson = Schema.fromJsonString(ScoreboardSchema, { space: 2 });

export const readBaseline = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(yield* baselineFile);
  return yield* Schema.decodeEffect(BaselineJson)(text);
});

/**
 * A migrated file says so in a comment: `// @effect-migrated`, or
 * `// @effect-migrated allow=effectPromises: adapter around the MCP SDK` to
 * keep patterns for a stated reason.
 */
const markerLine = /^\/\/ @effect-migrated\b(.*)$/m;
const allowance = /^ allow=([\w,]+): *(\S.*)$/;
const isPatternName = Schema.is(Schema.Literals(patternNames));

export const markerFormat = '// @effect-migrated [allow=<pattern>[,<pattern>]: <reason>]';

export type Marker =
  | { readonly kind: 'unmarked' }
  | { readonly kind: 'migrated'; readonly allow: readonly PatternName[] }
  | { readonly kind: 'invalid'; readonly problem: string };

/** Reads a source file's migration marker. */
export const readMarker = (source: string): Marker => {
  const marker = markerLine.exec(source);
  if (!marker) {
    return { kind: 'unmarked' };
  }
  const rest = marker[1]?.trimEnd() ?? '';
  if (rest === '') {
    return { kind: 'migrated', allow: [] };
  }
  const [, names = '', reason = ''] = allowance.exec(rest) ?? [];
  if (reason === '') {
    return { kind: 'invalid', problem: `its marker must read \`${markerFormat}\`` };
  }
  const unknown = names.split(',').filter((name) => !isPatternName(name));
  if (unknown.length > 0) {
    return {
      kind: 'invalid',
      problem: `its marker allows unknown patterns (${unknown.join(', ')}); use names from tests/effect-migration.ts`,
    };
  }
  return { kind: 'migrated', allow: names.split(',').filter(isPatternName) };
};

export const writeBaseline = Effect.fnUntraced(function* (board: Scoreboard) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* Schema.encodeEffect(BaselineJson)(board);
  yield* fs.writeFileString(yield* baselineFile, `${text}\n`);
});

export type Change = {
  readonly workspace: string;
  readonly pattern: string;
  readonly baseline: number;
  readonly current: number;
};

/** Every count that differs from the baseline; a missing entry counts as zero. */
export const compare = (baseline: Scoreboard, current: Scoreboard) => {
  const changes = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].flatMap(
    (workspace) => {
      const before = baseline[workspace] ?? {};
      const after = current[workspace] ?? {};
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].map(
        (pattern): Change => ({
          workspace,
          pattern,
          baseline: before[pattern] ?? 0,
          current: after[pattern] ?? 0,
        }),
      );
    },
  );
  return {
    rises: changes.filter((change) => change.current > change.baseline),
    drops: changes.filter((change) => change.current < change.baseline),
  };
};
