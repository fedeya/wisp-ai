import { expect, test } from 'vitest';
import { APICallError, RetryError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Effect, Layer, Stream } from 'effect';
import {
  AgentEngine,
  EngineConfig,
  SessionHistory,
  SessionModels,
  TurnToolbox,
  WispAgent,
  hostLayer,
} from '../src/engine.ts';
import { modelError } from '../src/engine-errors.ts';
import { MemoryHistory } from '../src/memory-history.ts';

const apiError = (statusCode: number) =>
  new APICallError({
    message: 'HTTP ' + statusCode,
    url: 'https://model',
    requestBodyValues: {},
    statusCode,
  });

/** The engine with its host replaced by layers: no bridge, no HTTP. */
function engineLayer(model: MockLanguageModelV4, history: MemoryHistory) {
  return AgentEngine.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SessionHistory.layer(history),
        Layer.succeed(
          WispAgent,
          WispAgent.of({ content: Effect.succeed({ system: 'You are Wisp.', skills: [] }) }),
        ),
        Layer.succeed(
          SessionModels,
          SessionModels.of({
            selected: () => Effect.succeed({ model: 'mock', effort: 'medium' }),
            model: () => model,
          }),
        ),
        Layer.succeed(
          TurnToolbox,
          TurnToolbox.of({ tools: () => Effect.succeed({ direct: {}, deferred: [], memory: '' }) }),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(EngineConfig, EngineConfig.of({ origin: () => '', token: '' }))),
  );
}

test('a request the provider refuses fails the turn as a rejected model call', async () => {
  const history = new MemoryHistory();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw apiError(400);
    },
  });
  const failure = await Effect.runPromise(
    Effect.flatMap(AgentEngine, (engine) =>
      Stream.runDrain(engine.send('s', 'chat', { text: 'Hi' })),
    ).pipe(Effect.flip, Effect.provide(engineLayer(model, history))),
  );
  expect(failure).toMatchObject({ _tag: 'ModelError', reason: 'rejected', status: 400 });
  // The player's message was logged before the model was called.
  expect(history.entries('s').map(({ entry }) => entry.type)).toEqual(['user']);
});

test('text parts a provider reuses an ID for in a later step stream as separate parts', async () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const first = call === 1;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 'txt' },
            { type: 'text-delta' as const, id: 'txt', delta: first ? 'Looking.' : 'Found it.' },
            { type: 'text-end' as const, id: 'txt' },
            ...(first
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'c1',
                    toolName: 'tool_search',
                    input: JSON.stringify({ query: 'map' }),
                  },
                ]
              : []),
            {
              type: 'finish' as const,
              finishReason: {
                unified: first ? ('tool-calls' as const) : ('stop' as const),
                raw: undefined,
              },
              usage,
            },
          ],
        }),
      };
    },
  });
  const events = await Effect.runPromise(
    Effect.flatMap(AgentEngine, (engine) =>
      Stream.runCollect(engine.send('s', 'chat', { text: 'Where?' })),
    ).pipe(Effect.provide(engineLayer(model, new MemoryHistory()))),
  );
  const texts = Array.from(events).flatMap((event) =>
    event.type === 'content.completed' ? [event.data as { partId: string; value: string }] : [],
  );
  // The AI SDK gives a reused provider ID a new one, so the bridge never merges the two.
  expect(texts.map((text) => text.value)).toEqual(['Looking.', 'Found it.']);
  expect(new Set(texts.map((text) => text.partId)).size).toBe(2);
});

test('model errors are classified by the status of their last attempt', () => {
  expect(modelError(apiError(401))).toMatchObject({ reason: 'auth', status: 401 });
  expect(modelError(apiError(503))).toMatchObject({ reason: 'unavailable', status: 503 });
  const retried = new RetryError({
    message: 'Failed after 3 attempts',
    reason: 'maxRetriesExceeded',
    errors: [apiError(500), apiError(429)],
  });
  expect(modelError(retried)).toMatchObject({ reason: 'rate-limited', status: 429 });
  expect(modelError(Error('socket hang up'))).toMatchObject({ reason: 'other' });
  expect(modelError(Error('socket hang up'))).not.toHaveProperty('status');
});

test("Effect's logs reach the host logger with their annotations", async () => {
  const lines: [string, object, string][] = [];
  const logger = {
    info: (data: object, message: string) => lines.push(['info', data, message]),
    warn: (data: object, message: string) => lines.push(['warn', data, message]),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.logInfo('Turn started');
      yield* Effect.logWarning('Compaction failed').pipe(
        Effect.annotateLogs({ event: 'agent.compaction_failed' }),
      );
    }).pipe(Effect.provide(hostLayer({ origin: () => '', token: '', logger }))),
  );
  expect(lines).toEqual([
    ['info', {}, 'Turn started'],
    ['warn', { event: 'agent.compaction_failed' }, 'Compaction failed'],
  ]);
});
