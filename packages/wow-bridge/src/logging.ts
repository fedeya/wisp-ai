import { Effect } from 'effect';

export function logTransportError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
  return Effect.logError('Game transport failed').pipe(
    Effect.annotateLogs({ event: 'transport.failed', error: message }),
  );
}
