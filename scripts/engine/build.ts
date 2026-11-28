// @effect-migrated allow=effectPromises: adapter around esbuild's build
// Builds the packaged engine, dist/wisp-engine.exe: the server, its installer
// and the agent's content bundled with esbuild, packaged as one executable by
// pkg, then checked by the packaged-engine tests.
//   node scripts/engine/build.ts
import { build } from 'esbuild';
import { Effect, FileSystem, Path, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Command } from 'effect/cli';
import { inherit } from '../child-process.ts';
import { runScript } from '../run-script.ts';
import { findNpmDirectory, resolveModule } from './node-runtime.ts';

export class EngineBuildFailed extends Schema.TaggedError<EngineBuildFailed>()(
  'EngineBuildFailed',
  { message: Schema.String },
) {}

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

/** Copies `from` to `to` recursively, copying what symbolic links point at instead of the links. */
const copyResolvingLinks = (
  from: string,
  to: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if ((yield* fs.stat(from)).type !== 'Directory') {
      return yield* fs.copyFile(from, to);
    }
    yield* fs.makeDirectory(to, { recursive: true });
    for (const name of yield* fs.readDirectory(from)) {
      yield* copyResolvingLinks(path.join(from, name), path.join(to, name));
    }
  });

/** Builds and tests the packaged engine; returns the executable's path. */
export const buildEngine = Effect.gen(function* () {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return yield* new EngineBuildFailed({
      message: 'Engine packaging currently supports Windows x64.',
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('../../', import.meta.url));
  const directory = path.join(root, 'dist/engine-build');
  if (directory !== path.resolve(root, 'dist', 'engine-build')) {
    return yield* new EngineBuildFailed({ message: 'Invalid engine build directory.' });
  }
  // fs.cp overwrites by default; FileSystem.copy only when asked.
  const copy = (from: string, to: string) => fs.copy(from, to, { overwrite: true });
  yield* fs.remove(directory, { recursive: true, force: true });
  yield* fs.makeDirectory(directory, { recursive: true });
  // The agent's authored instructions and skills ship as assets; its tools are bundled.
  yield* copy(
    path.join(root, 'apps/agent/src/wisp/instructions.md'),
    path.join(directory, 'agent/instructions.md'),
  );
  yield* copy(path.join(root, 'apps/agent/src/wisp/skills'), path.join(directory, 'agent/skills'));
  yield* copy(yield* findNpmDirectory, path.join(directory, 'npm'));
  // impit (web_fetch's TLS client) loads a native addon, so it ships beside the
  // bundle instead of inside it.
  const impit = path.dirname(
    yield* resolveModule(path.join(root, 'apps/agent/package.json'), 'impit/package.json'),
  );
  const impitNative = path.dirname(
    yield* resolveModule(path.join(impit, 'package.json'), 'impit-win32-x64-msvc/package.json'),
  );
  for (const { source, name } of [
    { source: impit, name: 'impit' },
    { source: impitNative, name: 'impit-win32-x64-msvc' },
  ]) {
    yield* copyResolvingLinks(source, path.join(directory, 'node_modules', name));
  }
  yield* Effect.tryPromise({
    try: () =>
      build({
        absWorkingDir: root,
        entryPoints: {
          server: 'apps/server/src/main.ts',
          install: 'apps/server/scripts/install.ts',
          'migrate-desktop': 'apps/server/scripts/migrate-desktop.ts',
          // The self-test reads the agent's content with the code the bridge uses.
          'agent-content': 'scripts/engine/content.ts',
        },
        outdir: directory,
        outExtension: { '.js': '.mjs' },
        platform: 'node',
        target: 'node24',
        format: 'esm',
        bundle: true,
        external: ['impit'],
        banner: {
          js: "import { createRequire as __wispCreateRequire } from 'node:module'; const require = __wispCreateRequire(import.meta.url);",
        },
      }),
    catch: (cause) =>
      new EngineBuildFailed({
        message:
          'Cannot bundle the engine: ' + (Predicate.isError(cause) ? cause.message : String(cause)),
      }),
  });
  yield* copy(path.join(root, 'scripts/engine/entry.mjs'), path.join(directory, 'engine.mjs'));
  yield* copy(path.join(root, 'packages/db/src/migrations'), path.join(directory, 'migrations'));
  const { version } = yield* Schema.decodeEffect(PackageJson)(
    yield* fs.readFileString(path.join(root, 'package.json')),
  );
  yield* fs.writeFileString(
    path.join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'wisp-engine',
        version,
        private: true,
        type: 'module',
        bin: 'engine.mjs',
        pkg: {
          assets: ['*.mjs', 'migrations/**/*', 'agent/**/*', 'node_modules/**/*', 'npm/**/*'],
          sea: true,
          compress: 'GZip',
          targets: [`node${process.versions.node}-win-x64`],
        },
      },
      null,
      2,
    ),
  );
  const executable = path.join(root, 'dist/wisp-engine.exe');
  yield* inherit(
    process.execPath,
    [
      yield* resolveModule(import.meta.url, '@yao-pkg/pkg/lib-es5/bin.js'),
      '.',
      '--output',
      executable,
    ],
    {
      // pkg embeds absolute asset paths; use the physical directory when dist
      // is a Windows junction so the entry point and assets share one root.
      cwd: yield* fs.realPath(directory),
    },
  );
  yield* inherit(
    process.execPath,
    [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'tests/vitest.config.ts',
      'tests/agent-integration.test.ts',
      'tests/packaged-engine.test.ts',
    ],
    { cwd: root, env: { WISP_TEST_ENGINE_EXECUTABLE: executable } },
  );
  return executable;
});

if (import.meta.main) {
  Command.make('build', {}, () => buildEngine).pipe(
    Command.withDescription('Build and test the packaged engine'),
    Command.run({ version: '1.0.0' }),
    runScript,
  );
}
