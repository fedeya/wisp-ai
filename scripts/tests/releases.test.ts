import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { stableNotes, validateNotes } from '../release-notes.ts';
import {
  newerStable,
  nightlyBuildVersion,
  StableVersion,
  isNewerStable,
  syncVersion,
} from '../release-version.ts';
import { recordStableRelease } from '../record-stable-release.ts';
import {
  latestStable,
  resolveStableRelease,
  stableFromNightly,
} from '../resolve-stable-release.ts';
import type { GitHubRelease } from '../github-releases.ts';
import { githubReleases, publishedRelease, releasePages } from './github-fixtures.ts';
import { gitIn, temporaryDirectory, writeFiles } from './fixtures.ts';

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const versionOf = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* Schema.decodeEffect(PackageJson)(yield* fs.readFileString(file))).version;
});

const fixture = Effect.gen(function* () {
  const root = yield* temporaryDirectory('wisp-release-');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = '{"version":"0.0.7"}\n';
  yield* writeFiles(root, {
    'package.json': manifest,
    'apps/desktop/package.json': manifest,
    'packages/releases/package.json': manifest,
    'scripts/package.json': manifest,
    'tests/package.json': manifest,
    'addon/package.json': manifest,
    'apps/desktop/src-tauri/tauri.conf.json': manifest,
    'apps/desktop/src-tauri/Cargo.toml': '[package]\nname = "wisp"\nversion = "0.0.7"\n',
    'apps/desktop/src-tauri/Cargo.lock':
      '[[package]]\nname = "other"\nversion = "1.2.3"\n\n[[package]]\nname = "wisp"\nversion = "0.0.7"\n',
    '.changie.yaml': yield* fs.readFileString(path.resolve('.changie.yaml')),
  });
  yield* fs.makeDirectory(path.join(root, 'releases/unreleased'), { recursive: true });
  return root;
});
const fragment = (root: string, name: string, kind: string, body: string, time: string) =>
  writeFiles(root, {
    [`releases/unreleased/${name}.yaml`]: `kind: ${kind}\nbody: ${body}\ntime: ${time}\n`,
  });
const stable = Schema.decodeSync(StableVersion);

layer(NodeServices.layer)((it) => {
  it.effect('nightly builds have unique ordered identities without changing stable versions', () =>
    Effect.gen(function* () {
      expect(yield* nightlyBuildVersion('0.1.9', '123', '2')).toBe('0.1.10-nightly.123.2');
      expect(yield* Effect.flip(nightlyBuildVersion('0.1.9-nightly.1', '123', '1'))).toMatchObject({
        message: 'Invalid nightly build identity.',
      });
    }),
  );

  it.effect(
    'stable notes group Changie fragments by kind and leave them in place',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fixture;
        expect((yield* Effect.flip(stableNotes('0.0.8', root))).message).toContain(
          'pnpm changie new',
        );
        yield* fragment(
          root,
          'Fixed-2',
          'Fixed',
          'Reconnect without restarting.',
          '2026-11-02T00:00:00Z',
        );
        yield* fragment(
          root,
          'Improved-1',
          'Improved',
          'Faster **answers**.',
          '2026-11-01T00:00:00Z',
        );
        yield* fragment(root, 'Fixed-1', 'Fixed', 'Chats keep their font.', '2026-11-01T00:00:00Z');
        expect(yield* stableNotes('0.0.8', root)).toBe(
          "# What's new in Wisp\n\n## Improved\n\n- Faster **answers**.\n\n## Fixed\n\n- Chats keep their font.\n- Reconnect without restarting.\n",
        );
        expect(yield* fs.exists(`${root}/releases/unreleased/Fixed-1.yaml`)).toBe(true);
        expect((yield* Effect.flip(stableNotes('0.0.8-nightly.1.1', root))).message).toContain(
          'X.Y.Z',
        );
      }),
    30_000,
  );

  it.effect('versions synchronize across every app manifest', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fixture;
      yield* syncVersion('0.0.8', root);
      expect(yield* versionOf(`${root}/apps/desktop/package.json`)).toBe('0.0.8');
      const lock = yield* fs.readFileString(`${root}/apps/desktop/src-tauri/Cargo.lock`);
      expect(lock).toContain('name = "wisp"\nversion = "0.0.8"');
      expect(lock).toContain('name = "other"\nversion = "1.2.3"');
      expect(yield* validateNotes('# Next\n\n<!-- comment -->\n\n## New\n\n- Item\n')).toBe(
        '# Next\n\n## New\n\n- Item\n',
      );
      expect((yield* Effect.flip(validateNotes('# Next\n<!-- unfinished -->'))).message).toContain(
        'user-facing',
      );
      expect((yield* Effect.flip(syncVersion('1.2', root))).message).toBe(
        'Unsupported release version: 1.2',
      );
    }),
  );

  it.effect(
    'a stable promotion takes the Nightly version unless one is given, newer than the last',
    () =>
      Effect.gen(function* () {
        expect(yield* stableFromNightly('v0.3.3-nightly.214.1')).toBe('0.3.3');
        expect((yield* Effect.flip(stableFromNightly('v0.3.3'))).message).toContain('Nightly');
        expect(latestStable(['v0.3.10', 'v0.3.9', 'v0.4.0-nightly.1.1', 'nightly', ''])).toBe(
          'v0.3.10',
        );
        expect(latestStable([])).toBeUndefined();
        expect(yield* newerStable('0.3.10', '0.3.9')).toBe(true);
        expect(yield* newerStable('0.3.2', '0.3.2')).toBe(false);
        expect(yield* newerStable('0.4.0', '1.0.0')).toBe(false);
        expect(isNewerStable(stable('1.0.0'), stable('0.9.9'))).toBe(true);
        expect((yield* Effect.flip(newerStable('0.4.0', '1.0'))).message).toBe(
          'Expected stable versions.',
        );
      }),
  );

  it.effect(
    'a stable promotion resolves a published Nightly from main and refuses taken versions',
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory('wisp-promote-');
        const git = gitIn(root);
        const commit = (message: string) => git('commit', '--allow-empty', '-m', message);
        yield* git('init');
        yield* commit('stable');
        yield* git('tag', 'v0.3.2');
        yield* commit('first nightly');
        const promoted = yield* git('rev-parse', 'HEAD');
        yield* git('tag', 'v0.3.3-nightly.1.1');
        yield* commit('second nightly');
        yield* git('tag', 'v0.3.3-nightly.2.1');
        yield* commit('main after the last nightly');
        const main = yield* git('rev-parse', 'HEAD');

        // The second page proves the existing-release check reads every page.
        const pages = (...last: GitHubRelease[]) =>
          githubReleases(
            releasePages(
              [
                publishedRelease('v0.3.3-nightly.2.1'),
                publishedRelease('v0.3.3-nightly.1.1'),
                ...Array.from({ length: 98 }, (_, index) =>
                  publishedRelease(`v0.2.0-nightly.${index}.1`),
                ),
              ],
              [publishedRelease('v0.3.2'), ...last],
            ),
          ).layer;
        const resolve = (
          requested: { nightly?: string; version?: string },
          ...last: GitHubRelease[]
        ) => resolveStableRelease(main, requested, root).pipe(Effect.provide(pages(...last)));
        const failure = (
          requested: { nightly?: string; version?: string },
          ...last: GitHubRelease[]
        ) => Effect.map(Effect.flip(resolve(requested, ...last)), (error) => error.message);

        expect(yield* resolve({})).toEqual({
          sha: yield* git('rev-parse', 'v0.3.3-nightly.2.1^{commit}'),
          version: '0.3.3',
          nightly: 'v0.3.3-nightly.2.1',
        });
        expect(yield* resolve({ nightly: 'v0.3.3-nightly.1.1', version: '0.4.0' })).toEqual({
          sha: promoted,
          version: '0.4.0',
          nightly: 'v0.3.3-nightly.1.1',
        });
        expect(yield* failure({ nightly: 'v0.3.3-nightly.9.1' })).toContain(
          'not a published Nightly built from main',
        );
        expect(yield* failure({ version: '0.3.2' })).toContain('newer than v0.3.2');
        expect(yield* failure({ version: '0.4' })).toContain('X.Y.Z');
        expect(
          yield* failure({}, publishedRelease('v0.3.3', { draft: true, published_at: null })),
        ).toContain('existing v0.3.3 draft');
        expect(yield* failure({}, publishedRelease('v0.3.3'))).toContain('already released');
      }),
    30_000,
  );

  it.effect(
    'recording a published release archives its notes and removes only the fragments it shipped',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fixture;
        const git = gitIn(root);
        const commit = Effect.fnUntraced(function* (message: string) {
          yield* git('add', '-A');
          yield* git('commit', '-m', message);
        });
        yield* git('init');
        yield* git('config', 'core.autocrlf', 'false');
        yield* fragment(root, 'Fixed-1', 'Fixed', 'Shipped fix.', '2026-11-01T00:00:00Z');
        yield* commit('fix: shipped');
        yield* git('tag', 'v0.0.8');
        yield* fragment(
          root,
          'New-1',
          'New',
          'Merged after the promoted Nightly.',
          '2026-11-03T00:00:00Z',
        );
        yield* commit('feat: later');

        const published =
          "# What's new in Wisp\r\n\r\n## Fixed\r\n\r\n- Shipped fix, edited on GitHub.\r\n";
        expect(yield* recordStableRelease('v0.0.8', published, root)).toEqual([
          'releases/unreleased/Fixed-1.yaml',
        ]);
        expect(yield* fs.readFileString(`${root}/releases/0.0.8.md`)).toBe(
          "# What's new in Wisp\n\n## Fixed\n\n- Shipped fix, edited on GitHub.\n",
        );
        expect(yield* fs.exists(`${root}/releases/unreleased/Fixed-1.yaml`)).toBe(false);
        expect(yield* fs.exists(`${root}/releases/unreleased/New-1.yaml`)).toBe(true);
        expect(yield* versionOf(`${root}/package.json`)).toBe('0.0.8');

        // Recording an older release never moves main's version back.
        yield* git('tag', 'v0.0.6', 'HEAD');
        yield* recordStableRelease('v0.0.6', published, root);
        expect(yield* versionOf(`${root}/package.json`)).toBe('0.0.8');
        expect(
          (yield* Effect.flip(recordStableRelease('v0.0.9-nightly.1.1', published, root))).message,
        ).toContain('stable tag');
      }),
    30_000,
  );
});
