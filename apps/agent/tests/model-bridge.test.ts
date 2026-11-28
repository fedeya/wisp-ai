import { assert, describe, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { fileURLToPath } from 'node:url';
import { Effect, Exit, FileSystem, Option, Path, Scope } from 'effect';
import { serveFrom } from '../evals/runtime/model-bridge.ts';

const fixture = fileURLToPath(new URL('./model-bridge-fixture.ts', import.meta.url));

/** Whether the process with this id is still running. */
const running = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** Starts the fixture in `mode`, and the file where it writes its process id. */
const start = Effect.fnUntraced(function* (mode: 'serves' | 'fails' | 'garbles') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-model-bridge-' });
  const pidFile = path.join(folder, 'pid');
  const scope = yield* Scope.make();
  const exit = yield* serveFrom([fixture, mode, pidFile]).pipe(Scope.provide(scope), Effect.exit);
  const pid = Number(yield* fs.readFileString(pidFile));
  return { exit, pid, scope };
});

// Real processes on the real clock.
describe('serveFrom', () => {
  it.live('returns where the bridge serves, and stops it when the scope closes', () =>
    Effect.gen(function* () {
      const { exit, pid, scope } = yield* start('serves');
      assert.deepStrictEqual(
        exit,
        Exit.succeed({ url: 'http://127.0.0.1:4567', token: 'secret', model: 'gpt-eval' }),
      );
      // The bridge keeps logging; reading its output keeps it from blocking.
      yield* Effect.sleep('200 millis');
      assert.isTrue(yield* running(pid));
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* running(pid));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live('fails with what a bridge that exits printed on stderr', () =>
    Effect.gen(function* () {
      const { exit, scope } = yield* start('fails');
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(
        Option.getOrUndefined(Option.map(Exit.findErrorOption(exit), (error) => error.message)),
        'Evals are not signed in to ChatGPT. (code 3)',
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live('stops a bridge whose first line is not where it serves', () =>
    Effect.gen(function* () {
      const { exit, pid, scope } = yield* start('garbles');
      assert.isTrue(Exit.isFailure(exit));
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* running(pid));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
