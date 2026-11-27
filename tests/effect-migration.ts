import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';

/**
 * Effect migration scoreboard: how often each workspace's shipped TypeScript
 * still uses a pattern that Effect replaces. Counts are a ratchet against the
 * checked-in baseline, not an exact parse, so the checks are plain regexes over
 * source lines and skip lines that are only comments.
 */

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const baselineFile = fileURLToPath(new URL('./effect-migration-baseline.json', import.meta.url));
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
  { workspace: 'scripts', folder: 'scripts', recursive: false },
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
/** Pattern counts by workspace, as stored in the baseline file. */
export type Scoreboard = Readonly<Record<string, Readonly<Record<string, number>>>>;

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

const sourceFiles = (folder: string, recursive: boolean): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      return recursive && !excludedFolders.has(entry.name) ? sourceFiles(file, recursive) : [];
    }
    return /\.tsx?$/.test(entry.name) && !excludedFile.test(entry.name) ? [file] : [];
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

const countSource = (source: string, counts: Counts) => {
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
};

/** Counts every pattern in one source file. */
export const countFile = (file: string): Counts => {
  const counts = emptyCounts();
  countSource(readFileSync(file, 'utf8'), counts);
  return counts;
};

/** The shipped source files the scoreboard counts, by workspace. */
export const scoredFiles = (root = repositoryRoot) =>
  workspaces.map(({ workspace, folder, recursive }) => ({
    workspace,
    files: sourceFiles(path.join(root, folder), recursive),
  }));

/** Counts every pattern in every workspace's shipped sources. */
export const scoreboard = (root = repositoryRoot): Scoreboard =>
  Object.fromEntries(
    scoredFiles(root).map(({ workspace, files }) => {
      const counts = emptyCounts();
      for (const file of files) {
        countSource(readFileSync(file, 'utf8'), counts);
      }
      return [workspace, counts];
    }),
  );

/** The patterns a file still contains, with their counts. */
export const presentPatterns = (counts: Counts) =>
  patternNames.flatMap((pattern) =>
    counts[pattern] > 0 ? [{ pattern, count: counts[pattern] }] : [],
  );

const BaselineSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number));

export const readBaseline = (): Scoreboard =>
  Schema.decodeUnknownSync(BaselineSchema)(JSON.parse(readFileSync(baselineFile, 'utf8')));

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

export const writeBaseline = (board: Scoreboard = scoreboard()) =>
  writeFileSync(baselineFile, `${JSON.stringify(board, null, 2)}\n`);

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
