import { startBridge } from './runtime.ts';
import { errorMessage } from './errors.ts';
import { log } from './logger.ts';
try {
  const bridge = await startBridge();
  const stop = () => {
    void bridge.stop().catch((error) => {
      log(
        'Bridge shutdown failed',
        { event: 'bridge.shutdown_failed', error: errorMessage(error) },
        'error',
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  log(
    'Bridge startup failed',
    { event: 'bridge.startup_failed', error: errorMessage(error) },
    'error',
  );
  process.exitCode = 1;
}
