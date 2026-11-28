import { assert, describe, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Schema,
} from 'effect';
import * as PlatformError from 'effect/PlatformError';
import { TestClock } from 'effect/testing';
import * as JsonFile from '../../src/platform/json-file.ts';

const Saved = Schema.Struct({ name: Schema.String, count: Schema.Finite });
const SavedJson = Schema.fromJsonString(Saved);

/** A fresh folder for one test, removed when it ends. */
const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-json-file-' });
});

/** How a test makes `rename` fail: with `reason`, for the first `times` attempts. */
interface RenameFailure {
  readonly reason: PlatformError.SystemErrorTag;
  readonly times: number;
}

/**
 * The Node file system, except that `rename` fails as `failure` says and
 * reports the virtual time of each attempt on `attempts`.
 */
const failingRename = (failure: RenameFailure, attempts: Queue.Queue<number>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const failed = yield* Ref.make(0);
      return FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            yield* Queue.offer(attempts, yield* Clock.currentTimeMillis);
            if ((yield* Ref.getAndUpdate(failed, (n) => n + 1)) < failure.times) {
              return yield* PlatformError.systemError({
                _tag: failure.reason,
                module: 'FileSystem',
                method: 'rename',
                pathOrDescriptor: from,
              });
            }
            return yield* fs.rename(from, to);
          }),
      });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

/**
 * Runs `write` against a `rename` that fails as `failure` says, letting 30 ms
 * of virtual time pass after each attempt so a retry can run. Returns how the
 * write ended and when each attempt ran, in virtual ms after the write started.
 */
const writeWithFailingRename = <E, R>(failure: RenameFailure, write: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<number>();
    const start = yield* Clock.currentTimeMillis;
    const fiber = yield* write.pipe(
      Effect.exit,
      Effect.provide(failingRename(failure, attempts)),
      Effect.forkChild,
    );
    const times: number[] = [];
    while (true) {
      const attempt = yield* Effect.raceFirst(
        Queue.take(attempts).pipe(Effect.asSome),
        Fiber.await(fiber).pipe(Effect.as(Option.none<number>())),
      );
      if (Option.isNone(attempt)) {
        return { exit: yield* Fiber.join(fiber), times };
      }
      times.push(attempt.value - start);
      // The failed attempt's retry is asleep by now.
      yield* TestClock.adjust('30 millis');
    }
  });

/** The `JsonFileError` reading `file` fails with. */
const decodeFailure = (file: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      JsonFile.read(file, Saved, () => ({ name: 'default', count: 0 })),
    );
    if (error._tag !== 'JsonFileError') {
      return assert.fail(`Expected a JsonFileError, got ${error.message}`);
    }
    return error;
  });

layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layerSecureRandom))(
  'JsonFile',
  (it) => {
    describe('read', () => {
      it.effect('falls back when the file does not exist', () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const file = path.join(yield* folder, 'missing.json');
          const value = yield* JsonFile.read(file, Saved, () => ({ name: 'default', count: 0 }));
          assert.deepStrictEqual(value, { name: 'default', count: 0 });
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(file));
        }),
      );

      it.effect('decodes the file with the schema, dropping unknown keys', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = path.join(yield* folder, 'saved.json');
          yield* fs.writeFileString(file, '{"count":2,"extra":true,"name":"wisp"}');
          let fellBack = false;
          const value = yield* JsonFile.read(file, Saved, () => {
            fellBack = true;
            return { name: 'default', count: 0 };
          });
          assert.deepStrictEqual(value, { name: 'wisp', count: 2 });
          assert.isFalse(fellBack);
        }),
      );

      it.effect('fails on content that does not decode and leaves the file alone', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* folder;
          for (const [name, text] of [
            ['truncated.json', '{"name":"wisp",'],
            ['wrong.json', '{"name":"wisp","count":"two"}'],
            // Node's utf8 reads kept a byte order mark, which JSON does not allow.
            ['bom.json', '\uFEFF{"name":"wisp","count":2}'],
          ] as const) {
            const file = path.join(directory, name);
            yield* fs.writeFileString(file, text);
            const error = yield* decodeFailure(file);
            assert.strictEqual(
              error.message,
              `Cannot load ${name}; the original file was preserved.`,
            );
            assert.strictEqual(error.file, file);
            assert.deepStrictEqual(yield* fs.readFile(file), new TextEncoder().encode(text));
          }
        }),
      );

      it.effect('fails as is when the file cannot be read', () =>
        Effect.gen(function* () {
          const directory = yield* folder;
          const error = yield* Effect.flip(
            JsonFile.read(directory, Saved, () => ({ name: 'default', count: 0 })),
          );
          assert.isTrue(PlatformError.isPlatformError(error));
        }),
      );
    });

    describe('write', () => {
      it.effect('writes two-space JSON in a new folder and replaces the old file', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* folder;
          const file = path.join(directory, 'nested', 'saved.json');
          yield* JsonFile.write(file, Saved, { name: 'wisp', count: 1 });
          yield* JsonFile.write(file, Saved, { name: 'wisp', count: 2 });
          assert.strictEqual(
            yield* fs.readFileString(file),
            JSON.stringify({ name: 'wisp', count: 2 }, null, 2),
          );
          assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(file)), ['saved.json']);
          assert.deepStrictEqual(
            yield* Schema.decodeEffect(SavedJson)(yield* fs.readFileString(file)),
            { name: 'wisp', count: 2 },
          );
        }),
      );

      it.effect.skipIf(process.platform === 'win32')('writes the file owner-only', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = path.join(yield* folder, 'saved.json');
          yield* JsonFile.write(file, Saved, { name: 'wisp', count: 1 });
          assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
        }),
      );

      it.effect('writes the value as the schema encodes it', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = path.join(yield* folder, 'saved.json');
          const Counted = Schema.Struct({ count: Schema.FiniteFromString });
          yield* JsonFile.write(file, Counted, { count: 3 });
          assert.strictEqual(yield* fs.readFileString(file), '{\n  "count": "3"\n}');
        }),
      );

      it.effect('retries a locked rename 5 times, 30 ms apart', () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const directory = yield* folder;
          const file = path.join(directory, 'saved.json');
          const { exit, times } = yield* writeWithFailingRename(
            { reason: 'Busy', times: 3 },
            JsonFile.write(file, Saved, { name: 'wisp', count: 1 }),
          );
          assert.isTrue(Exit.isSuccess(exit));
          assert.deepStrictEqual(times, [0, 30, 60, 90]);
          const fs = yield* FileSystem.FileSystem;
          assert.deepStrictEqual(yield* fs.readDirectory(directory), ['saved.json']);
        }),
      );

      it.effect('gives up after 6 attempts and removes the temporary file', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* folder;
          const file = path.join(directory, 'saved.json');
          yield* fs.writeFileString(file, 'old');
          const { exit, times } = yield* writeWithFailingRename(
            { reason: 'PermissionDenied', times: 10 },
            JsonFile.write(file, Saved, { name: 'wisp', count: 1 }),
          );
          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(times, [0, 30, 60, 90, 120, 150]);
          assert.deepStrictEqual(yield* fs.readDirectory(directory), ['saved.json']);
          assert.strictEqual(yield* fs.readFileString(file), 'old');
        }),
      );

      it.effect('does not retry other rename failures', () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* folder;
          const file = path.join(directory, 'saved.json');
          const { exit, times } = yield* writeWithFailingRename(
            { reason: 'NotFound', times: 1 },
            JsonFile.write(file, Saved, { name: 'wisp', count: 1 }),
          );
          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(times, [0]);
          assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
        }),
      );
    });
  },
);
