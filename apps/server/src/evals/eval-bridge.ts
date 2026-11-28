// @effect-migrated
// Model bridge for agent evals (apps/agent/evals), see ./bridge.ts.
//
//   node apps/server/src/evals/eval-bridge.ts sign-in   one-time ChatGPT sign-in
//   node apps/server/src/evals/eval-bridge.ts serve     prints {"url","token","model"} and serves
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Cause, Console, Effect, Exit, Option } from 'effect';
import { Argument, Command } from 'effect/cli';
import { bridgeLogging } from '../logger.ts';
import { authLayer, EvalBridgeError, failureMessage, options, serve, signIn } from './bridge.ts';

const evalBridge = Command.make(
  'eval-bridge',
  { command: Argument.String('command').pipe(Argument.optional) },
  Effect.fn(function* ({ command }) {
    const subcommand = Option.getOrUndefined(command);
    if (subcommand !== 'sign-in' && subcommand !== 'serve') {
      return yield* new EvalBridgeError({ message: 'Usage: eval-bridge.ts sign-in | serve' });
    }
    const program =
      subcommand === 'sign-in'
        ? signIn()
        : serve().pipe(
            Effect.tap((server) => Console.log(JSON.stringify(server))),
            // ChatGPTAuth lives as long as its layer: keep serving until the process is stopped.
            Effect.andThen(Effect.never),
            Effect.scoped,
          );
    return yield* program.pipe(Effect.provide(authLayer(yield* options)));
  }),
);

evalBridge.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Console.error(failureMessage(Cause.squash(cause))),
  ),
  Effect.provide([NodeServices.layer, NodeCrypto.layerSecureRandom, bridgeLogging]),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    // A failure exits with 1; stopping it, as the evals do once they finish, exits with 0.
    teardown: (exit, onExit) =>
      onExit(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? 1 : 0),
  }),
);
