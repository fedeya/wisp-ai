// @effect-migrated
// Builds the Windows installer into dist/ with its checksum, build metrics and,
// when signed, its updater manifest. Only the optimized native executable is
// reused from the cache; everything it bundles is staged fresh.
//   node scripts/build-desktop.ts   (apps/desktop's package:windows)
import { createHash } from 'node:crypto';
import { delimiter } from 'node:path';
import { Clock, Console, Effect, FileSystem, Path, Schema } from 'effect';
import { Command } from 'effect/cli';
import { inherit } from './child-process.ts';
import { buildEngine } from './engine/build.ts';
import { resolveModule } from './engine/node-runtime.ts';
import { environmentVariable } from './environment.ts';
import { fetchHttpClient } from './http-client.ts';
import {
  nativeBuildContext,
  nativeBuildKey,
  restoreNativeBinary,
  saveNativeBinary,
} from './native-cache.ts';
import { runScript } from './run-script.ts';
import { stageEngine, stageTauri } from './stage-tauri.ts';
import { writeUpdateManifest } from './update-manifest.ts';

export class DesktopBuildFailed extends Schema.TaggedError<DesktopBuildFailed>()(
  'DesktopBuildFailed',
  { message: Schema.String },
) {}

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Milliseconds on the monotonic clock, as fractions like performance.now. */
const now = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1_000_000);

const buildDesktop = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve();
  const desktop = path.resolve('apps/desktop');
  const desktopPackage = path.join(desktop, 'package.json');
  const cli = yield* resolveModule(desktopPackage, '@tauri-apps/cli/tauri.js');
  // Tauri runs Node tools of its own, so it finds this script's Node first.
  const env = {
    PATH: path.dirname(process.execPath) + delimiter + (yield* environmentVariable('PATH')),
  };
  const tauri = (args: readonly string[]) =>
    inherit(process.execPath, [cli, ...args], { cwd: desktop, env });

  const started = yield* now;
  // Stages everything but the engine, which builds while the native executable compiles.
  yield* stageTauri({ packaged: true });
  const staged = yield* now;
  // Build the frontend first: its actual output, including VITE_* substitutions,
  // belongs to the cache key because Tauri embeds it in the native executable.
  const vite = yield* resolveModule(desktopPackage, 'vite/package.json');
  yield* inherit(process.execPath, [path.join(path.dirname(vite), 'bin/vite.js'), 'build'], {
    cwd: desktop,
  });
  const frontendBuilt = yield* now;
  const context = yield* nativeBuildContext(root);
  const key = yield* nativeBuildKey(root, context);
  const cache = path.resolve('node_modules/.cache/wisp-native');
  const executable = path.join(desktop, 'src-tauri/target/release/wisp.exe');
  // Custom Tauri overrides may reference inputs outside the checked-in project.
  // They always use a fresh build rather than risk reusing the wrong executable.
  const cacheable = !(yield* environmentVariable('TAURI_CONFIG'));
  const reused =
    cacheable &&
    (yield* environmentVariable('WISP_FORCE_NATIVE_BUILD')) !== '1' &&
    (yield* restoreNativeBinary(cache, key, executable));
  // The native executable does not embed the payload: the bundle step reads it from
  // the source tree, as when a cached executable is reused. So the engine builds
  // while Rust compiles, and joins the payload only after the compiler is done with
  // it. Either failing stops the other.
  const [[engine, engineBuilt]] = yield* Effect.all(
    [
      Effect.zip(buildEngine, now),
      reused ? Effect.void : tauri(['build', '--no-bundle', '--', '--locked']),
    ],
    { concurrency: 'unbounded' },
  );
  if (!reused && cacheable) {
    if (key !== (yield* nativeBuildKey(root, context))) {
      return yield* new DesktopBuildFailed({
        message: 'Native build inputs changed during compilation. No binary was cached.',
      });
    }
    yield* saveNativeBinary(cache, key, executable);
  }
  const nativeBuilt = yield* now;
  yield* stageEngine(engine);
  const nativeBinarySha256 = sha256(yield* fs.readFile(executable));
  // Always assemble current bridge/agent/addon/simulator resources. Only the
  // unchanged, fully optimized native executable may be reused.
  const signed = Boolean(yield* environmentVariable('TAURI_SIGNING_PRIVATE_KEY'));
  yield* tauri([
    'bundle',
    '--bundles',
    'nsis',
    '--config',
    JSON.stringify({ bundle: { createUpdaterArtifacts: signed } }),
  ]);
  const bundled = yield* now;
  yield* fs.makeDirectory('dist', { recursive: true });
  yield* fs.writeFileString(
    'dist/build-metrics.json',
    JSON.stringify(
      {
        nativeCacheHit: reused,
        nativeInputsKey: key,
        nativeBinarySha256,
        milliseconds: {
          stage: staged - started,
          frontend: frontendBuilt - staged,
          // The engine and native executable build at the same time.
          engine: engineBuilt - frontendBuilt,
          native: nativeBuilt - frontendBuilt,
          bundle: bundled - nativeBuilt,
          total: bundled - started,
        },
      },
      null,
      2,
    ),
  );
  const { version } = yield* Schema.decodeEffect(PackageJson)(
    yield* fs.readFileString('package.json'),
  );
  const folder = 'apps/desktop/src-tauri/target/release/bundle/nsis';
  const [installer, ...otherInstallers] = (yield* fs.readDirectory(folder)).filter((file) =>
    file.endsWith('-setup.exe'),
  );
  if (installer === undefined || otherInstallers.length > 0) {
    return yield* new DesktopBuildFailed({ message: 'Expected one Windows installer.' });
  }
  const destination = 'dist/WispAI-' + version + '-windows-x64-setup.exe';
  yield* fs.copyFile(path.join(folder, installer), destination);
  if (signed) {
    yield* fs.copyFile(path.join(folder, installer + '.sig'), destination + '.sig');
    yield* writeUpdateManifest(version, destination, root);
  }
  yield* fs.writeFileString(
    destination + '.sha256',
    sha256(yield* fs.readFile(destination)) + '  ' + path.basename(destination) + '\n',
  );
  yield* Console.log(destination);
});

if (import.meta.main) {
  Command.make('build-desktop', {}, () => buildDesktop).pipe(
    Command.withDescription('Build the Windows installer into dist/'),
    Command.run({ version: '1.0.0' }),
    Effect.provide(fetchHttpClient),
    runScript,
  );
}
