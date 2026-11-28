// @effect-migrated
// Fingerprints what the optimized native executable is built from, and keeps
// one executable per fingerprint so a release build can reuse it.
import { createHash } from 'node:crypto';
import { Console, Effect, FileSystem, Option, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { output } from './child-process.ts';
import { environmentVariable, environmentVariables } from './environment.ts';

export interface NativeBuildContext {
  readonly platform: string;
  readonly arch: string;
  readonly rustc: string;
  readonly cargo: string;
  readonly image: string;
  readonly flags: Readonly<Record<string, string>>;
}

export class UnsupportedBuildInput extends Schema.TaggedError<UnsupportedBuildInput>()(
  'UnsupportedBuildInput',
  { message: Schema.String },
) {}

const flagNames = new Set([
  'RUSTC',
  'RUSTFLAGS',
  'SOURCE_DATE_EPOCH',
  'CARGO_ENCODED_RUSTFLAGS',
  'CARGO_BUILD_RUSTFLAGS',
  'CARGO_BUILD_TARGET',
  'CARGO_INCREMENTAL',
  'RUSTC_WRAPPER',
  'RUSTC_WORKSPACE_WRAPPER',
  'TAURI_CONFIG',
  'CC',
  'CXX',
  'CFLAGS',
  'CXXFLAGS',
  'LDFLAGS',
  'LIB',
  'INCLUDE',
  'LIBPATH',
]);

const isBuildFlag = (name: string) =>
  flagNames.has(name) ||
  name.startsWith('CARGO_PROFILE_RELEASE_') ||
  /^CARGO_TARGET_.*_(RUSTFLAGS|LINKER)$/.test(name);

/** The compiler, platform, runner image and flags the native executable is built with. */
export const nativeBuildContext = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path;
  const flags = Object.fromEntries(
    (yield* environmentVariables)
      .filter(([name]) => isBuildFlag(name))
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  const cwd = path.join(root, 'apps/desktop/src-tauri');
  const rustc = (yield* environmentVariable('RUSTC')) || 'rustc';
  const image = [yield* environmentVariable('ImageOS'), yield* environmentVariable('ImageVersion')];
  const context: NativeBuildContext = {
    platform: process.platform,
    arch: process.arch,
    rustc: (yield* output(rustc, ['-vV'], { cwd })).trim(),
    cargo: (yield* output('cargo', ['-V'], { cwd })).trim(),
    image: image.join('/'),
    flags,
  };
  return context;
});

const sourceFiles = (
  root: string,
  relative: string,
): Effect.Effect<
  string[],
  UnsupportedBuildInput | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: string[] = [];
    for (const entry of yield* fs.readDirectoryEntries(path.join(root, relative))) {
      if (
        relative === 'apps/desktop/src-tauri' &&
        ['target', 'resources', 'gen'].includes(entry.name)
      ) {
        continue;
      }
      const child = relative + '/' + entry.name;
      if (entry.type === 'Directory') {
        files.push(...(yield* sourceFiles(root, child)));
      } else if (entry.type === 'File') {
        files.push(child);
      } else {
        return yield* new UnsupportedBuildInput({
          message: 'Unsupported native build input: ' + child,
        });
      }
    }
    return files;
  });

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Whether `file` can be read; only a missing file is not. */
const readable = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(file).pipe(
    Effect.as(true),
    Effect.catchTag('PlatformError', (error) =>
      error.reason._tag === 'NotFound' ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
});

/** The fingerprint of the native executable's inputs in `root`, built in `context`. */
export const nativeBuildKey = Effect.fnUntraced(function* (
  root: string,
  context: NativeBuildContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const optional: string[] = [];
  for (const file of [
    'Cargo.toml',
    'Cargo.lock',
    '.cargo/config',
    '.cargo/config.toml',
    'rust-toolchain',
    'rust-toolchain.toml',
  ]) {
    if (yield* readable(path.join(root, file))) {
      optional.push(file);
    }
  }
  const inputs = [
    ...(yield* sourceFiles(root, 'apps/desktop/src-tauri')),
    ...(yield* sourceFiles(root, 'apps/desktop/dist')),
    'pnpm-lock.yaml',
    'package.json',
    'apps/desktop/package.json',
    'scripts/build-desktop.ts',
    'scripts/native-cache.ts',
    'scripts/native-cache-key.ts',
    ...optional,
  ].toSorted();
  const files = yield* Effect.forEach(
    inputs,
    (file) =>
      Effect.map(fs.readFile(path.join(root, file)), (bytes) => ({ file, sha256: sha256(bytes) })),
    { concurrency: 'unbounded' },
  );
  return createHash('sha256')
    .update(JSON.stringify({ schema: 1, context, files }))
    .digest('hex');
});

/** The cache's record of the executable it holds. */
const CacheManifest = Schema.fromJsonString(
  Schema.Struct({ schema: Schema.Literal(1), key: Schema.String, sha256: Schema.String }),
);

/**
 * Copies the cached executable to `destination` when it was built from `key`'s
 * inputs and is intact. A missing, malformed or different cache is a miss.
 */
export const restoreNativeBinary = Effect.fnUntraced(function* (
  cache: string,
  key: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const restored = Effect.gen(function* () {
    const text = yield* fs.readFileString(path.join(cache, 'build.json'));
    const manifest = yield* Schema.decodeEffect(CacheManifest)(text).pipe(Effect.option);
    if (Option.isNone(manifest) || manifest.value.key !== key) {
      return false;
    }
    const binary = yield* fs.readFile(path.join(cache, 'wisp.exe'));
    if (!binary.length || sha256(binary) !== manifest.value.sha256) {
      return false;
    }
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.writeFile(destination, binary);
    yield* Console.log('Native binary reused; SHA-256: ' + manifest.value.sha256);
    return true;
  });
  return yield* restored.pipe(
    Effect.catchTag('PlatformError', (error) =>
      error.reason._tag === 'NotFound' ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
});

/** Keeps `executable` in the cache as the build of `key`'s inputs. */
export const saveNativeBinary = Effect.fnUntraced(function* (
  cache: string,
  key: string,
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = sha256(yield* fs.readFile(executable));
  yield* fs.makeDirectory(cache, { recursive: true });
  yield* fs.copyFile(executable, path.join(cache, 'wisp.exe'));
  yield* fs.writeFileString(
    path.join(cache, 'build.json'),
    JSON.stringify({ schema: 1, key, sha256: digest }),
  );
  yield* Console.log('Optimized native binary cached; SHA-256: ' + digest);
});
