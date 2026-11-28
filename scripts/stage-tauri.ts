// @effect-migrated
// Stages the desktop app's payload (apps/desktop/src-tauri/resources/payload):
// the server or the packaged engine, the addon, the simulator and the Node runtime.
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { addonReleaseVersion, stampAddonReleaseVersion } from './addon-release-version.ts';
import { inherit, output } from './child-process.ts';
import { environmentVariable } from './environment.ts';
import { findNpmDirectory, resolveModule } from './engine/node-runtime.ts';
import { verifySimulator } from './simulator/verify.ts';

export class StagingFailed extends Schema.TaggedError<StagingFailed>()('StagingFailed', {
  message: Schema.String,
}) {}

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

/** The repository root, and the payload folder inside it. */
const payload = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('../', import.meta.url));
  const stage = path.resolve(root, 'apps/desktop/src-tauri/resources/payload');
  if (stage !== path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'payload')) {
    return yield* new StagingFailed({ message: 'Invalid payload directory.' });
  }
  return { root, stage };
});

const packageVersion = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { version } = yield* Schema.decodeEffect(PackageJson)(
    yield* fs.readFileString(path.join(root, 'package.json')),
  );
  return version;
});

const unavailable = () => new StagingFailed({ message: 'Cannot obtain the bundled Node license.' });

/** The license of the Node release this script runs on. */
const nodeLicense = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get('https://raw.githubusercontent.com/nodejs/node/v' + process.versions.node + '/LICENSE')
    .pipe(Effect.mapError(unavailable));
  if (response.status < 200 || response.status > 299) {
    return yield* unavailable();
  }
  return yield* response.text.pipe(Effect.mapError(unavailable));
});

/**
 * Node's fetch without trace headers, for the one request staging makes. Each
 * entry point that stages provides it.
 */
export const stagingHttpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);

/**
 * Stages everything but the engine. A packaged payload gets the addon's release
 * version and leaves the engine to stageEngine, so it can build while the native
 * executable compiles; otherwise the server is deployed with its dependencies.
 */
export const stageTauri = Effect.fnUntraced(function* ({
  packaged = false,
}: { readonly packaged?: boolean } = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root, stage } = yield* payload;
  const addonVersion = packaged ? Option.some(yield* addonReleaseVersion(root)) : Option.none();
  yield* verifySimulator(root);
  yield* fs.remove(stage, { recursive: true, force: true });
  // fs.cp overwrites by default; FileSystem.copy only when asked.
  const copy = (from: string, to: string) => fs.copy(from, to, { overwrite: true });
  // Hoisting is restricted to the standalone deployment: Windows installer resources
  // must contain real directories, without junctions back to the developer's store.
  if (packaged) {
    yield* fs.makeDirectory(stage, { recursive: true });
  } else {
    const executable = (yield* environmentVariable('npm_execpath')) || 'pnpm';
    const args = [
      '--filter',
      '@wisp/server',
      '--prod',
      'deploy',
      '--legacy',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      stage,
    ];
    const javascript = /\.(?:c?js|mjs)$/.test(executable);
    yield* inherit(
      javascript ? process.execPath : executable,
      javascript ? [executable, ...args] : args,
      { cwd: root },
    );
  }
  for (const name of ['addon/WispAI', 'simulator']) {
    yield* copy(path.join(root, name), path.join(stage, name));
  }
  if (Option.isSome(addonVersion)) {
    yield* stampAddonReleaseVersion(
      path.join(stage, 'addon/WispAI/WispAI.toc'),
      addonVersion.value,
    );
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    yield* fs.copyFile(path.join(root, name), path.join(stage, name));
  }
  yield* fs.makeDirectory(path.join(stage, 'runtime'), { recursive: true });
  yield* fs.copyFile(
    process.execPath,
    path.join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  // npm remains available for user-configured npx MCP servers. It is not used
  // to install Wisp or to assemble its dependency graph.
  if (!packaged) {
    yield* copy(yield* findNpmDirectory, path.join(stage, 'runtime/npm'));
  }
  yield* fs.writeFileString(path.join(stage, 'runtime/NODE-LICENSE.txt'), yield* nodeLicense);
  const version = yield* packageVersion(root);
  const commit = (yield* output('git', ['rev-parse', 'HEAD'], { cwd: root })).trim();
  yield* fs.writeFileString(
    path.join(stage, 'BUILD.json'),
    JSON.stringify(
      {
        version,
        commit,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    ),
  );
  yield* Console.log(
    'Staged the Wisp server and its dependencies without personal data or desktop build tools.',
  );
});

/** Adds the packaged engine `executable` to a payload staged with `stageTauri({ packaged: true })`. */
export const stageEngine = Effect.fnUntraced(function* (executable: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root, stage } = yield* payload;
  yield* fs.copyFile(executable, path.join(stage, 'wisp-engine.exe'));
  // The engine bundles Effect, which the agent runs on; ship its license beside it.
  const effect = path.dirname(yield* resolveModule(import.meta.url, 'effect/package.json'));
  yield* fs.copyFile(path.join(effect, 'LICENSE'), path.join(stage, 'EFFECT-LICENSE.txt'));
  yield* fs.writeFileString(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: '@wisp/engine-payload', version: yield* packageVersion(root) }),
  );
});
