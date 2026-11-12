import { startBridge } from './runtime.ts';
import { errorMessage } from './errors.ts';
import { bridgeLogger as logger } from './logger.ts';
try {
  const bridge = await startBridge();
  const stop = () => {
    void bridge.stop().catch((error) => {
      logger.error(
        { event: 'bridge.shutdown_failed', error: errorMessage(error) },
        'Bridge shutdown failed',
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  logger.error(
    { event: 'bridge.startup_failed', error: errorMessage(error) },
    'Bridge startup failed',
  );
  process.exitCode = 1;
}
