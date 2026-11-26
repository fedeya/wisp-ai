import { Effect } from 'effect';
import { startBridgeEffect } from './runtime.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogging } from './logger.ts';

/** How long a crashing bridge may spend releasing SQLite and the agent before it exits. */
const CRASH_SHUTDOWN_MS = 5000;

await Effect.runPromise(
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const runSync = Effect.runSyncWith(context);
    let bridge: Effect.Success<ReturnType<typeof startBridgeEffect>> | undefined;
    let crashing = false;

    // A rejection is local to the promise that failed: record it and keep serving.
    process.on('unhandledRejection', (reason) => {
      runFork(
        Effect.logError('Unhandled promise rejection').pipe(
          Effect.annotateLogs({ event: 'bridge.unhandled_rejection', error: errorMessage(reason) }),
        ),
      );
    });

    // An uncaught exception may leave state half updated. Log before cleanup and exit.
    process.on('uncaughtException', (error) => {
      runSync(
        Effect.logFatal('Uncaught exception; stopping the bridge').pipe(
          Effect.annotateLogs({ event: 'bridge.uncaught_exception', error: errorMessage(error) }),
        ),
      );
      if (crashing) return;
      crashing = true;
      process.exitCode = 1;
      const exit = () => process.exit(1);
      setTimeout(exit, CRASH_SHUTDOWN_MS).unref();
      void (bridge?.stop() ?? Promise.resolve()).catch(() => {}).finally(exit);
    });

    const running = yield* startBridgeEffect().pipe(
      Effect.catch((error) =>
        Effect.logError('Bridge startup failed').pipe(
          Effect.annotateLogs({ event: 'bridge.startup_failed', error: errorMessage(error) }),
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    );
    if (!running) return;
    bridge = running;
    const stop = () => {
      void running.stop().catch((error: unknown) => {
        runFork(
          Effect.logError('Bridge shutdown failed').pipe(
            Effect.annotateLogs({ event: 'bridge.shutdown_failed', error: errorMessage(error) }),
          ),
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).pipe(Effect.provide(bridgeLogging)),
);
