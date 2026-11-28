// @effect-migrated
import { Deferred, Effect, Fiber, FileSystem, Option, Path, Ref, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

/** The eval model bridge could not start; the message says why. */
export class ModelBridgeError extends Schema.TaggedError<ModelBridgeError>()('ModelBridgeError', {
  message: Schema.String,
}) {}

/** What the bridge prints on its first line once it serves. */
const ServingLine = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String, token: Schema.String, model: Schema.String }),
);

/** The bridge's eval model server (apps/server/src/evals/eval-bridge.ts), from the repository root. */
const bridgeScript = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (yield* fs.exists(path.join(dir, 'pnpm-workspace.yaml'))) {
      return path.join(dir, 'apps', 'server', 'src', 'evals', 'eval-bridge.ts');
    }
    if (path.dirname(dir) === dir) {
      return yield* new ModelBridgeError({ message: 'Run evals from inside the Wisp repository.' });
    }
  }
});

/**
 * Runs `node <script> serve` and returns where the server it starts listens,
 * from the first line it prints. The process runs until the scope
 * closes; one that exits first fails with what it printed on stderr.
 */
export const serveFrom = Effect.fnUntraced(function* (script: readonly [string, ...string[]]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [...script, 'serve'], {
      detached: false,
      stdin: 'ignore',
    }),
  );
  const errors = yield* Ref.make('');
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Ref.update(errors, (collected) => collected + text)),
    Effect.ignore,
    Effect.forkScoped,
  );
  // The first line says where the server listens. The rest of the output is
  // read too, so the bridge never waits on a full pipe.
  const first = yield* Deferred.make<string>();
  const reader = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Deferred.succeed(first, line)),
    Effect.ignore,
    Effect.forkScoped,
  );
  const exited = Effect.gen(function* () {
    yield* Fiber.await(reader);
    const line = yield* Deferred.poll(first);
    if (Option.isSome(line)) {
      return yield* line.value;
    }
    const code = yield* handle.exitCode.pipe(Effect.orElseSucceed(() => null));
    const output = (yield* Ref.get(errors)).trim();
    return yield* new ModelBridgeError({
      message: (output || 'Eval bridge exited') + ' (code ' + code + ')',
    });
  });
  const line = yield* Effect.raceFirst(Deferred.await(first), exited);
  return yield* Schema.decodeEffect(ServingLine)(line);
});

/**
 * Starts the bridge's eval model server, which uses a separate ChatGPT
 * sign-in, and returns where the agent reaches it. The server runs until the
 * scope closes.
 */
export const startModelBridge = Effect.flatMap(bridgeScript, (script) => serveFrom([script]));
