import { expect, test, vi } from 'vitest';
import { Effect } from 'effect';
import { LoggerLive, bridgeLogger, logLine } from '../src/logger.ts';

test('log lines keep the JSON shape and drop credentials', () => {
  const line = JSON.parse(
    logLine({
      level: 'Warn',
      date: new Date('2026-11-24T12:00:00.000Z'),
      annotations: {
        event: 'auth.refresh_failed',
        token: 'secret',
        apiKey: 'key',
        headers: { authorization: 'Bearer secret', accept: 'application/json' },
      },
      message: ['Refresh failed'],
    }),
  );
  expect(line).toEqual({
    level: 'WARN',
    timestamp: '2026-11-24T12:00:00.000Z',
    component: 'bridge',
    event: 'auth.refresh_failed',
    headers: { accept: 'application/json' },
    msg: 'Refresh failed',
  });
});

test('Effect logs and bridgeLogger calls write the same lines', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    bridgeLogger.info({ event: 'bridge.started', version: '1.0.0' }, 'Wisp started');
    bridgeLogger.warn('Plain message');
    bridgeLogger.debug({ event: 'hidden' }, 'Below the default level');
    await Effect.runPromise(
      Effect.logError('Tick failed').pipe(
        Effect.annotateLogs({ event: 'bridge.tick_failed' }),
        Effect.provide(LoggerLive),
      ),
    );
    const lines = write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'INFO',
        event: 'bridge.started',
        version: '1.0.0',
        msg: 'Wisp started',
      }),
      expect.objectContaining({ level: 'WARN', msg: 'Plain message' }),
      expect.objectContaining({ level: 'ERROR', event: 'bridge.tick_failed', msg: 'Tick failed' }),
    ]);
  } finally {
    write.mockRestore();
  }
});
