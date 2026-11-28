import { expect, it } from '@effect/vitest';
import { APICallError, RetryError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Effect, Layer, Stream } from 'effect';
import { z } from 'zod';
import {
  AgentEngine,
  EngineConfig,
  SessionHistory,
  SessionModels,
  TurnToolbox,
  WispAgent,
} from '../src/engine.ts';
import { modelError } from '../src/execution/engine-errors.ts';
import * as MemoryHistory from '../src/session/memory-history.ts';
import { defineTool, type ToolDefinition } from '../src/tools/tool.ts';
import type { DeferredTool } from '../src/tools/turn-tools.ts';

const apiError = (statusCode: number) =>
  new APICallError({
    message: 'HTTP ' + statusCode,
    url: 'https://model',
    requestBodyValues: {},
    statusCode,
  });

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * The engine with its host replaced by layers: no bridge, no HTTP. The
 * session's log is kept in memory, where the test reads it back.
 */
function engineLayer(
  model: MockLanguageModelV4,
  direct: Record<string, ToolDefinition> = {},
  deferred: DeferredTool[] = [],
) {
  return AgentEngine.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SessionHistory.layer,
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
          TurnToolbox.of({ tools: () => Effect.succeed({ direct, deferred, memory: '' }) }),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(EngineConfig, EngineConfig.of({ origin: () => '', token: '' }))),
    // The tests read the log back through MemoryHistory.Service.
    Layer.provideMerge(MemoryHistory.layer),
  );
}

it.effect('a request the provider refuses fails the turn as a rejected model call', () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw apiError(400);
    },
  });
  return Effect.gen(function* () {
    const engine = yield* AgentEngine;
    const failure = yield* Effect.flip(Stream.runDrain(engine.send('s', 'chat', { text: 'Hi' })));
    expect(failure).toMatchObject({ _tag: 'ModelError', reason: 'rejected', status: 400 });
    // The player's message was logged before the model was called.
    const logged = yield* (yield* MemoryHistory.Service).entries('s');
    expect(logged.map(({ entry }) => entry.type)).toEqual(['user']);
  }).pipe(Effect.provide(engineLayer(model)));
});

it.effect('text parts a provider reuses an ID for in a later step stream as separate parts', () => {
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
  return Effect.gen(function* () {
    const engine = yield* AgentEngine;
    const events = yield* Stream.runCollect(engine.send('s', 'chat', { text: 'Where?' }));
    const texts = Array.from(events).flatMap((event) =>
      event.type === 'content.completed' ? [event.data as { partId: string; value: string }] : [],
    );
    // The AI SDK gives a reused provider ID a new one, so the bridge never merges the two.
    expect(texts.map((text) => text.value)).toEqual(['Looking.', 'Found it.']);
    expect(new Set(texts.map((text) => text.partId)).size).toBe(2);
  }).pipe(Effect.provide(engineLayer(model)));
});

it.effect('an endsTurn tool run through tool_call ends the turn', () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            {
              type: 'tool-call' as const,
              toolCallId: 'c' + calls,
              toolName: 'tool_call',
              input: JSON.stringify({ name: 'skip_tip', input: {} }),
            },
            {
              type: 'finish' as const,
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage,
            },
          ],
        }),
      };
    },
  });
  const skipTip = defineTool({
    description: 'Skip the tip.',
    inputSchema: z.object({}),
    endsTurn: true,
    execute: () => ({ skipped: true }),
  });
  return Effect.gen(function* () {
    const engine = yield* AgentEngine;
    yield* Stream.runDrain(engine.send('s', 'chat', { text: 'Tip?' }));
    expect(calls).toBe(1);
  }).pipe(
    Effect.provide(
      engineLayer(model, { skip_tip: skipTip }, [
        // tool_call is offered when the turn has deferred tools, as every real turn does.
        { name: 'map', description: 'Map.', inputSchema: {}, run: async () => ({}) },
      ]),
    ),
  );
});

it('model errors are classified by the status of their last attempt', () => {
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
