// @effect-migrated
// Says whether a newer Forever build than the pinned one is out, so the game
// data can be regenerated after a patch. Exits 1 when the pin is behind.
//   pnpm data:check
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, Runtime, Schema } from 'effect';
import { Command } from 'effect/cli';
import * as HttpClient from './http-client.ts';
import { latestBuild, readPinned } from './index.ts';

const parts = (version: string) => version.split('.').map(Number);
function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) > (y[i] ?? 0);
    }
  }
  return false;
}

/** The check has already said the pin is behind, so only the exit code is left. */
class PinBehind extends Schema.TaggedError<PinBehind>()('PinBehind', {}) {
  override readonly [Runtime.errorReported] = false;
}

const check = Command.make(
  'data:check',
  {},
  Effect.fn(function* () {
    const pinned = yield* readPinned;
    const latest = yield* latestBuild(pinned.product).pipe(Effect.provide(HttpClient.layer));
    if (newer(latest.version, pinned.build)) {
      yield* Console.log(
        `Forever ${latest.version} (${latest.created}) is newer than the pinned ${pinned.build}: ` +
          'set it in packages/game-data/build.json and run pnpm data:generate.',
      );
      return yield* new PinBehind();
    }
    yield* Console.log(`Game data is generated from the latest Forever build, ${pinned.build}.`);
  }),
).pipe(Command.withDescription('Say whether a newer Forever build than the pinned one is out'));

check.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
