import { startBridge } from './runtime.ts';
import { errorMessage } from './errors.ts';
import { Effect } from 'effect';
import { runBridgeLog } from './logger.ts';

/** How long a crashing bridge may spend releasing SQLite and the agent before it exits. */
const CRASH_SHUTDOWN_MS = 5000;

let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
let crashing = false;

// Node ends the process on an unhandled rejection by default, so one missing
// `.catch` anywhere would take Wisp down without a log line. A rejection is
// local to the promise that failed: record it and keep serving.
process.on('unhandledRejection', (reason) => {
  runBridgeLog(
    Effect.logError('Unhandled promise rejection').pipe(
      Effect.annotateLogs({ event: 'bridge.unhandled_rejection', error: errorMessage(reason) }),
    ),
  );
});

// A synchronous throw that reached the event loop may have left state half
// updated, so the bridge does not keep running. It logs the cause, releases
// the agent and SQLite when it can, and exits non-zero so the desktop app can start
// a fresh one.
process.on('uncaughtException', (error) => {
  runBridgeLog(
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

try {
  bridge = await startBridge();
  const running = bridge;
  const stop = () => {
    void running.stop().catch((error) => {
      runBridgeLog(
        Effect.logError('Bridge shutdown failed').pipe(
          Effect.annotateLogs({ event: 'bridge.shutdown_failed', error: errorMessage(error) }),
        ),
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  runBridgeLog(
    Effect.logError('Bridge startup failed').pipe(
      Effect.annotateLogs({ event: 'bridge.startup_failed', error: errorMessage(error) }),
    ),
  );
  process.exitCode = 1;
}
