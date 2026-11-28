import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path } from 'effect';
import { moduleSpecifiers, readMarker, repositoryRoot } from './effect-migration.ts';

/**
 * Domain boundaries in `apps/server/src`, from "Target structure" in
 * docs/effect-migration.md. A domain is a top-level folder of `src/`, or a
 * folder under `integrations/`. A domain with an `index.ts` has a door: other
 * domains import only that file, as `#/<domain>`. Every file in `platform/` is
 * a door of its own, imported as `#/platform/<name>`. Domains without a door
 * and the files at the `src/` root are not checked yet; they move later.
 */

const sourceFolder = 'apps/server/src';

/** Today's files at the `src/` root. A file may leave this list, never join it. */
const rootFiles = new Set([
  'account-operations.ts',
  'application-database.ts',
  'errors.ts',
  'json-file.ts',
  'logger.ts',
  'loopback-server.ts',
  'main.ts',
  'runtime-resources.ts',
  'runtime.ts',
]);

/** The composition root wires every domain's internals until phase 5 replaces it. */
const compositionRoot = new Set(['main.ts', 'runtime.ts']);

type SourceFile = {
  /** The path relative to `src/`, with `/` separators. */
  readonly file: string;
  readonly marked: boolean;
  readonly specifiers: readonly string[];
};

/** What another domain may import of a file. */
type Access =
  /** A root file, or a file of a domain that has no door yet. */
  | { readonly kind: 'open' }
  /** A door, imported as `specifier`. */
  | { readonly kind: 'door'; readonly domain: string; readonly specifier: string }
  /** A private file of a domain whose door is `specifier`. */
  | { readonly kind: 'private'; readonly domain: string; readonly specifier: string };

type CrossDomainImport = {
  readonly from: SourceFile;
  readonly fromDomain: string | undefined;
  readonly specifier: string;
  readonly access: Exclude<Access, { kind: 'open' }>;
};

/** The domain a file belongs to, or `undefined` for a file at the `src/` root. */
const domainOf = (file: string): string | undefined => {
  const [top, sub, ...rest] = file.split('/');
  if (sub === undefined) {
    return undefined;
  }
  return top === 'integrations' && rest.length > 0 ? `integrations/${sub}` : top;
};

/** The `src/` file a specifier names, or `undefined` for a package or a path outside `src/`. */
const resolve = (file: string, specifier: string): string | undefined => {
  if (specifier.startsWith('#/platform/')) {
    return `platform/${specifier.slice('#/platform/'.length)}.ts`;
  }
  if (specifier.startsWith('#/')) {
    return `${specifier.slice('#/'.length)}/index.ts`;
  }
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const segments = file.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') {
      if (segments.pop() === undefined) {
        return undefined;
      }
    } else if (segment !== '.') {
      segments.push(segment);
    }
  }
  return segments.join('/');
};

const hasDoor = (domain: string, files: ReadonlySet<string>) =>
  domain === 'platform' || files.has(`${domain}/index.ts`);

const accessOf = (target: string, files: ReadonlySet<string>): Access => {
  const domain = domainOf(target);
  if (domain === undefined || !hasDoor(domain, files)) {
    return { kind: 'open' };
  }
  if (domain === 'platform') {
    const name = target.slice('platform/'.length).replace(/\.ts$/, '');
    return { kind: 'door', domain, specifier: `#/platform/${name}` };
  }
  const door = `${domain}/index.ts`;
  return { kind: target === door ? 'door' : 'private', domain, specifier: `#/${domain}` };
};

/** Every import of a file in another domain that has a door. */
const crossDomainImports = (sources: readonly SourceFile[]): CrossDomainImport[] => {
  const files = new Set(sources.map(({ file }) => file));
  return sources.flatMap((from) => {
    const fromDomain = domainOf(from.file);
    return from.specifiers.flatMap((specifier) => {
      const target = resolve(from.file, specifier);
      if (target === undefined || !files.has(target) || domainOf(target) === fromDomain) {
        return [];
      }
      const access = accessOf(target, files);
      return access.kind === 'open' ? [] : [{ from, fromDomain, specifier, access }];
    });
  });
};

const describeImport = ({ from, specifier }: CrossDomainImport) =>
  `src/${from.file} imports '${specifier}'`;

/** Marked files reach a domain with a door through `#/`, not a relative path. */
const relativeDoorImports = (sources: readonly SourceFile[]) =>
  crossDomainImports(sources)
    .filter((edge) => edge.from.marked && !edge.specifier.startsWith('#/'))
    .map(
      (edge) =>
        `${describeImport(edge)}, a relative path into ${edge.access.domain}/ from a file marked // @effect-migrated; import '${edge.access.specifier}' instead`,
    );

/** Only a domain's door is imported from outside it. */
const privateImports = (sources: readonly SourceFile[]) =>
  crossDomainImports(sources)
    .filter((edge) => edge.access.kind === 'private' && !compositionRoot.has(edge.from.file))
    .map(
      (edge) =>
        `${describeImport(edge)}, a private file of ${edge.access.domain}/; import '${edge.access.specifier}' instead, exporting what you need from src/${edge.access.domain}/index.ts`,
    );

/** The shortest chain of imports from `start` back to itself, or `[]` when there is none. */
const shortestCycle = (
  start: string,
  edges: ReadonlyMap<string, ReadonlyMap<string, CrossDomainImport>>,
): CrossDomainImport[] => {
  const queue: CrossDomainImport[][] = [[]];
  const visited = new Set<string>();
  for (let chain = queue.shift(); chain !== undefined; chain = queue.shift()) {
    const at = chain.at(-1)?.access.domain ?? start;
    for (const [to, edge] of edges.get(at) ?? []) {
      if (to === start) {
        return [...chain, edge];
      }
      if (!visited.has(to)) {
        visited.add(to);
        queue.push([...chain, edge]);
      }
    }
  }
  return [];
};

/** Domains with a door that import each other in a cycle, each named once. */
const domainCycles = (sources: readonly SourceFile[]) => {
  const files = new Set(sources.map(({ file }) => file));
  const edges = new Map<string, Map<string, CrossDomainImport>>();
  for (const edge of crossDomainImports(sources)) {
    const from = edge.fromDomain;
    if (from === undefined || !hasDoor(from, files)) {
      continue;
    }
    const targets = edges.get(from) ?? new Map<string, CrossDomainImport>();
    if (!targets.has(edge.access.domain)) {
      targets.set(edge.access.domain, edge);
    }
    edges.set(from, targets);
  }
  const reported = new Set<string>();
  const cycles: string[] = [];
  for (const start of [...edges.keys()].sort()) {
    const path = shortestCycle(start, edges);
    const key = path
      .map(({ access }) => access.domain)
      .sort()
      .join(' ');
    if (path.length === 0 || reported.has(key)) {
      continue;
    }
    reported.add(key);
    const loop = [start, ...path.map(({ access }) => access.domain)].join(' -> ');
    cycles.push(
      `${loop} is a cycle: ${path.map(describeImport).join('; ')}. Move what they share into one of them so imports go one way`,
    );
  }
  return cycles;
};

/** Files at the `src/` root that are not in today's list. */
const newRootFiles = (sources: readonly SourceFile[]) =>
  sources.flatMap(({ file }) =>
    domainOf(file) === undefined && !rootFiles.has(file)
      ? [
          `src/${file} is a new file at the src/ root, which only keeps the entry point and the layer graph; put it in its domain folder, or in platform/ if it is an adapter`,
        ]
      : [],
  );

const readSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(yield* repositoryRoot, sourceFolder);
  const entries = yield* fs.readDirectory(folder, { recursive: true });
  return yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith('.ts')),
    (entry) =>
      Effect.map(fs.readFileString(path.join(folder, entry)), (text): SourceFile => ({
        file: entry.split(path.sep).join('/'),
        marked: readMarker(text).kind !== 'unmarked',
        specifiers: moduleSpecifiers(text),
      })),
  );
});

layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))((it) => {
  it.effect('marked files reach other domains through their doors', () =>
    Effect.gen(function* () {
      expect(relativeDoorImports(yield* readSources)).toEqual([]);
    }),
  );

  it.effect("no file imports another domain's private files", () =>
    Effect.gen(function* () {
      expect(privateImports(yield* readSources)).toEqual([]);
    }),
  );

  it.effect('domains with a door do not import each other in a cycle', () =>
    Effect.gen(function* () {
      expect(domainCycles(yield* readSources)).toEqual([]);
    }),
  );

  it.effect('no new files at the src/ root', () =>
    Effect.gen(function* () {
      expect(newRootFiles(yield* readSources)).toEqual([]);
    }),
  );
});
