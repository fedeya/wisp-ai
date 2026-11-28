import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it, layer } from '@effect/vitest';
import { Effect, FileSystem, Path, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { needsAppRelease } from '../release-inputs.ts';
import { gitIn, temporaryDirectory, writeFiles } from './fixtures.ts';

/** Runs the script in `directory` as the release workflow does: its exit, output and GITHUB_OUTPUT. */
const checkInputs = Effect.fnUntraced(function* (
  directory: string,
  environment: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outputs = path.join(directory, 'outputs');
  yield* fs.writeFileString(outputs, '');
  const script = yield* path.fromFileUrl(new URL('../release-inputs.ts', import.meta.url));
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [script], {
      cwd: directory,
      detached: false,
      env: { ...environment, GITHUB_OUTPUT: outputs },
      extendEnv: true,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: 'unbounded' },
  );
  return { exitCode, stderr, stdout, outputs: yield* fs.readFileString(outputs) };
});

/** What a successful run prints and writes when it decides `app`. */
const decided = (app: boolean) => ({
  exitCode: 0,
  stdout: `Build app release: ${app}\n`,
  outputs: `app=${app}\n`,
});

const nonAppFiles = [
  'apps/web/src/app/page.tsx',
  'docs/development.md',
  'releases/unreleased/Fixed-20261123-014627.yaml',
  '.changie.yaml',
  '.agents/skills/visual-pr/SKILL.md',
  '.github/workflows/check.yml',
  'AGENTS.md',
  'apps/agent/AGENTS.md',
  'README.md',
  'addon/README.md',
  'scripts/revalidate-web.ts',
  'scripts/tests/revalidate-web.test.ts',
];

it.each(nonAppFiles)('%s does not require an app release', (file) => {
  expect(needsAppRelease([file])).toBe(false);
});

it('combined non-app changes and empty pushes skip packaging', () => {
  expect(needsAppRelease(nonAppFiles)).toBe(false);
  expect(needsAppRelease([])).toBe(false);
});

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'apps/desktop/src-tauri/Cargo.lock',
  'apps/server/src/runtime.ts',
  'apps/agent/src/wisp/instructions.md',
  'apps/agent/src/wisp/skills/example/SKILL.md',
  'addon/WispAI/Core.lua',
  'packages/wow-bridge/src/wire/mailbox.ts',
  'scripts/engine/build.ts',
  'simulator/manifest.json',
])('%s still requires packaging, including in a mixed push', (file) => {
  expect(needsAppRelease([file])).toBe(true);
  expect(needsAppRelease([...nonAppFiles, file])).toBe(true);
});

layer(NodeServices.layer)((it) => {
  it.effect.each([
    { event: 'workflow_dispatch', ref: 'branch', before: 'unavailable' },
    { event: 'push', ref: 'tag', before: 'unavailable' },
    { event: 'push', ref: 'branch', before: '0'.repeat(40) },
  ])(
    '$event on $ref with base $before always packages',
    ({ event, ref, before }) =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory('wisp-release-inputs-');
        // No Git repository: these events must bypass branch-range inspection.
        expect(
          yield* checkInputs(directory, {
            GITHUB_EVENT_NAME: event,
            GITHUB_REF_TYPE: ref,
            RELEASE_BASE_SHA: before,
          }),
        ).toMatchObject(decided(true));
      }),
    30_000,
  );

  it.effect(
    'branch ranges skip docs with spaces but still package an app file moved into docs',
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory('wisp-release-range-');
        const git = gitIn(directory);
        const commit = Effect.fnUntraced(function* () {
          yield* git('add', '-A', '--', '.', ':!outputs');
          yield* git('commit', '--quiet', '-m', 'fixture');
          return yield* git('rev-parse', 'HEAD');
        });
        yield* git('init', '--quiet');
        yield* writeFiles(directory, { 'app.ts': 'app fixture', 'docs/.keep': '' });
        const first = yield* commit();
        yield* writeFiles(directory, { 'docs/notes with spaces.md': 'docs fixture' });
        const docs = yield* commit();
        const environment = { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch' };
        expect(
          yield* checkInputs(directory, {
            ...environment,
            RELEASE_BASE_SHA: first,
            GITHUB_SHA: docs,
          }),
        ).toMatchObject(decided(false));
        yield* git('mv', 'app.ts', 'docs/archived.ts');
        const moved = yield* commit();
        expect(
          yield* checkInputs(directory, {
            ...environment,
            RELEASE_BASE_SHA: docs,
            GITHUB_SHA: moved,
          }),
        ).toMatchObject(decided(true));
      }),
    30_000,
  );
});
