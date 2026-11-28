import { runMain } from '@effect/platform-node/NodeRuntime';
import { Cause, Deferred, Effect, Exit, Layer, Runtime, Scope } from 'effect';
import { makeServer, ServerLayer } from './runtime.ts';
import { closeRuntimeScope } from './runtime-resources.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogging } from './logger.ts';

/** How long a crashing bridge may spend releasing SQLite and the agent before it exits. */
const CRASH_SHUTDOWN_MS = 5000;
let crashing = false;

const startupFailed = (error: unknown) =>
  Effect.logError('Bridge startup failed').pipe(
    Effect.annotateLogs({ event: 'bridge.startup_failed', error: errorMessage(error) }),
  );

const program = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runSync = Effect.runSyncWith(context);
  const stopRequested = yield* Deferred.make<void, Error>();
  let crashDeadline: ReturnType<typeof setTimeout> | undefined;

  // A rejection is local to the promise that failed: record it and keep serving.
  const onRejection = (reason: unknown) => {
    runFork(
      Effect.logError('Unhandled promise rejection').pipe(
        Effect.annotateLogs({ event: 'bridge.unhandled_rejection', error: errorMessage(reason) }),
      ),
    );
  };

  // An uncaught exception may leave state half updated. Log before cleanup and exit.
  const onCrash = (error: Error) => {
    runSync(
      Effect.logFatal('Uncaught exception; stopping the bridge').pipe(
        Effect.annotateLogs({ event: 'bridge.uncaught_exception', error: errorMessage(error) }),
      ),
    );
    if (crashing) return;
    crashing = true;
    crashDeadline = setTimeout(() => process.exit(1), CRASH_SHUTDOWN_MS).unref();
    Deferred.doneUnsafe(stopRequested, Effect.fail(error));
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onCrash);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onCrash);
      clearTimeout(crashDeadline);
    }),
  );

  yield* Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      makeServer({}, () => {
        Deferred.doneUnsafe(stopRequested, Effect.void);
      }).pipe(
        Scope.provide(scope),
        Effect.tapError(startupFailed),
        Effect.andThen(Deferred.await(stopRequested)),
      ),
    (scope, exit) =>
      closeRuntimeScope(scope, exit).pipe(
        Effect.tapError((error) =>
          Effect.logError('Bridge shutdown failed').pipe(
            Effect.annotateLogs({ event: 'bridge.shutdown_failed', error: errorMessage(error) }),
          ),
        ),
      ),
  );
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.merge(
      // Startup can also fail while the services load, before `makeServer`
      // runs (an unreadable config.local.json): log that the same way.
      ServerLayer.pipe(
        Layer.tapError((error) => startupFailed(error).pipe(Effect.provide(bridgeLogging))),
      ),
      bridgeLogging,
    ),
  ),
);

runMain(program, {
  disableErrorReporting: true,
  teardown(exit, onExit) {
    if (crashing) {
      onExit(1);
    } else if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
      // Keep SIGINT and SIGTERM as successful, graceful stops.
      onExit(0);
    } else {
      Runtime.defaultTeardown(exit, onExit);
    }
  },
});
