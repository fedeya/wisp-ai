import { Effect } from 'effect';
import { expect, test } from 'vitest';
import { bridgeLogging, runBridgeLog } from '../src/logger.ts';
import { captureLogs } from './capture-logs.ts';

test('bridge callbacks write JSON with structured fields and no credentials', () => {
  const logs = captureLogs();
  runBridgeLog(
    Effect.logWarning('Test warning').pipe(
      Effect.annotateLogs({
        event: 'bridge.test',
        authorization: 'secret',
        apiKey: 'secret',
        token: 'secret',
        password: 'secret',
        headers: { authorization: 'secret', accept: 'application/json' },
      }),
    ),
  );
  expect(logs()).toEqual([
    {
      level: 'WARN',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      component: 'bridge',
      event: 'bridge.test',
      msg: 'Test warning',
      headers: { accept: 'application/json' },
    },
  ]);
});

test('native Effect logs use the same format and preserve their severity', () => {
  const logs = captureLogs();
  Effect.runSync(
    Effect.gen(function* () {
      yield* Effect.logDebug('Filtered');
      yield* Effect.logError('Agent error').pipe(
        Effect.annotateLogs({ event: 'agent.test', token: 'secret' }),
      );
    }).pipe(Effect.provide(bridgeLogging)),
  );
  expect(logs()).toEqual([
    {
      level: 'ERROR',
      timestamp: expect.any(String),
      component: 'bridge',
      event: 'agent.test',
      msg: 'Agent error',
    },
  ]);
});
