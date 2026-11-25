// The package index also loads NodeRedis, which needs redis; import the module itself.
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { Cause, Deferred, Effect, Exit } from 'effect';
import { AppLayer } from './app-runtime.ts';
import { makeBridge } from './runtime.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogger as logger } from './logger.ts';

/** How long a crashing bridge may spend releasing SQLite and the agent before it exits. */
const CRASH_SHUTDOWN_MS = 5000;

/** Fails with the uncaught exception that ends the bridge. */
const crashed = Deferred.makeUnsafe<never, unknown>();

// Node ends the process on an unhandled rejection by default, so one missing
// `.catch` anywhere would take Wisp down without a log line. A rejection is
// local to the promise that failed: record it and keep serving.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { event: 'bridge.unhandled_rejection', error: errorMessage(reason) },
    'Unhandled promise rejection',
  );
});

// A synchronous throw that reached the event loop may have left state half
// updated, so the bridge does not keep running. It logs the cause, ends the
// main program, which releases the agent and SQLite, and exits non-zero so the
// desktop app can start a fresh one.
process.on('uncaughtException', (error) => {
  logger.fatal(
    { event: 'bridge.uncaught_exception', error: errorMessage(error) },
    'Uncaught exception; stopping the bridge',
  );
  process.exitCode = 1;
  setTimeout(() => process.exit(1), CRASH_SHUTDOWN_MS).unref();
  Deferred.doneUnsafe(crashed, Exit.die(error));
});

/**
 * The bridge process: it runs until the desktop app asks it to stop, a signal
 * interrupts it or an uncaught exception ends it. Leaving the scope releases
 * the bridge, then AppLayer.
 */
const main = Effect.raceFirst(
  Effect.gen(function* () {
    const bridge = yield* makeBridge().pipe(
      Effect.tapCause((cause) =>
        Effect.logError('Bridge startup failed').pipe(
          Effect.annotateLogs({
            event: 'bridge.startup_failed',
            error: errorMessage(Cause.squash(cause)),
          }),
        ),
      ),
    );
    yield* bridge.stopRequested;
  }),
  Deferred.await(crashed),
).pipe(Effect.scoped, Effect.provide(AppLayer));

// Failures are logged above and by each cleanup step; runMain sets the exit code.
NodeRuntime.runMain(main, { disableErrorReporting: true });
