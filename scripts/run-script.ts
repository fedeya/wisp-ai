// @effect-migrated
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Cause, Effect, Logger, Runtime } from 'effect';

/**
 * Runs a script as the process entry point, with Node's services. A failure is
 * reported on stderr and exits with 1, so stdout only carries what the script
 * prints for its callers, as it did before the scripts ran on Effect.
 */
export const runScript = <A, E>(script: Effect.Effect<A, E, NodeServices.NodeServices>): void =>
  script.pipe(
    // runMain reports a failure outside the script, where it would go to stdout.
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
        ? Effect.void
        : Effect.logError(cause),
    ),
    Effect.provide(NodeServices.layer),
    Effect.provideService(Logger.LogToStderr, true),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
