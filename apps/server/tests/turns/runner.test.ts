import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Deferred, Effect, Exit, Fiber, Latch, Layer, Scope } from 'effect';
import type { Duration } from 'effect';
import { TestClock } from 'effect/testing';
import type { EngineEvent, EngineResult, TurnInput } from '@wisp/agent/engine';
import { PRESENT_UI_TOOL } from '@wisp/agent/contract/reply-presentation';
import type { CapabilityView } from '@wisp/protocol/capabilities';
import { SnapshotGate } from '@wisp/wow-bridge/snapshots';
import { ChatGPTAuthError, ChatGPTRequestError } from '#/auth';
import { CapabilitySettings } from '#/capabilities';
import { initialSession, SessionState } from '#/session';
import { UsageTelemetry } from '#/telemetry';
import { make } from '#/turns';
import type { TurnRunner } from '#/turns';
import { newChat } from '../../src/chat/chat-lifecycle.ts';
import type { AccountModel } from '../../src/chat/chat-model.ts';
import { projectChats } from '../../src/chat/chat-projection.ts';
import { queryCharacterSections } from '../../src/chat/context.ts';
import { SnapshotPublisher } from '../../src/game/snapshot-publisher.ts';
import { bridgeLogging } from '../../src/logger.ts';
import { ModelConnections } from '../../src/models/connections.ts';
import type { ModelProvider } from '../../src/models/connections.ts';
import { ModelConnectionError, ModelRequestError } from '../../src/models/errors.ts';
import { ModelFailures, httpFailureKind } from '../../src/models/model-failures.ts';
import { logged } from '../logged.ts';
import { sessionState } from '../session-fixture.ts';

type ChatTelemetry = Parameters<UsageTelemetry['Service']['chat']>[0];

const noUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

/** What the engine streams for one turn and how it settles, as tests script it. */
interface Delivery {
  /** `signal` aborts when the turn is interrupted or stalls. */
  readonly stream: (signal: AbortSignal) => AsyncGenerator<EngineEvent>;
  readonly result: () => Promise<EngineResult>;
}

const completed: EngineResult = { status: 'completed' };

const delivered = (events: readonly EngineEvent[], result: EngineResult = completed): Delivery => ({
  async *stream() {
    yield* events;
  },
  result: async () => result,
});

const failedWith = (error: Error, reason?: 'rejected'): Delivery =>
  delivered([], { status: 'failed', error, ...(reason ? { reason } : {}) });

const providerError = (message: string, fields: { name?: string; code?: string } = {}) =>
  Object.assign(new Error(message), fields);

const text = (delta: string): EngineEvent => ({
  type: 'content.delta',
  data: { partId: 'reply', kind: 'text', delta },
});

/** Rejects once `signal` aborts, as a read the engine aborts does. */
const abortedRead = (signal: AbortSignal) =>
  new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => reject(Error('Read aborted')), { once: true });
  });

/**
 * A delivery that never sends another event after `events`; its stream fails
 * once the turn aborts it. `reading` runs once it waits, and may interrupt.
 */
const silentAfter = (events: readonly EngineEvent[], reading?: () => void): Delivery => ({
  async *stream(signal) {
    yield* events;
    const read = abortedRead(signal);
    reading?.();
    await read;
  },
  result: async () => completed,
});

const model: AccountModel = { slug: 'model', displayName: 'Model', efforts: ['medium'] };

/** Lets fibers woken by settled Promises run. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));

interface FixtureOptions {
  readonly titlesEnabled?: boolean;
  readonly defaultModel?: string;
  readonly idleTimeout?: Duration.Input;
  readonly modelFailures?: ModelFailures;
  readonly provider?: (model: string) => ModelProvider | undefined;
}

/**
 * A turn runner on one chat of the game session `one`, over an engine that
 * plays the deliveries `send` returns. The runner lives in its own scope:
 * `drain` closes it, which waits for the turns and titles still running.
 */
const fixture = Effect.fnUntraced(function* (options: FixtureOptions = {}) {
  const chat = newChat('chat', 'one');
  const send = vi.fn(async (_input: string): Promise<Delivery> => delivered([text('Hello')]));
  const end = vi.fn(async (_session: string) => {});
  const newSessionId = vi.fn(() => 'eve');
  // The engine records each turn as JSON, so tests can look for what it carries.
  const engine = {
    newSessionId,
    end,
    send: (_session: string, input: TurnInput, signal: AbortSignal, _chatId: string) => {
      const sent = send(JSON.stringify(input));
      const result = sent.then((delivery) => delivery.result());
      result.catch(() => {});
      return {
        events: (async function* () {
          yield* (await sent).stream(signal);
        })(),
        result,
      };
    },
  };
  const models = vi.fn((): Effect.Effect<AccountModel[], ChatGPTAuthError | ChatGPTRequestError> =>
    Effect.succeed([model]),
  );
  const prepare = vi.fn(
    (_model: string): Effect.Effect<void, ModelConnectionError | ChatGPTAuthError> => Effect.void,
  );
  const complete = vi.fn(
    (
      _model: string,
      _instructions: string,
      _text: string,
    ): Effect.Effect<string, ModelRequestError> => Effect.succeed('Generated title'),
  );
  const hasProvider = vi.fn(() => true);
  const accountBusy = vi.fn(() => false);
  const flushSnapshot = vi.fn<() => void>();
  const changed = vi.fn<() => void>();
  const observeTool = vi.fn<(event: unknown) => void>();
  const chats: ChatTelemetry[] = [];
  // Each commit is a change the publisher and chat persistence hear about.
  const session = sessionState(
    { ...initialSession([chat]), activeTransport: 'one', activeChat: 'chat' },
    () => void changed(),
  );
  const ready = yield* Latch.make(true);
  const stopping = yield* Latch.make();
  const services = Layer.mergeAll(
    Layer.succeed(SessionState, session),
    Layer.mock(ModelConnections, {
      models: Effect.suspend(() => models()),
      prepare: (name) => prepare(name),
      complete: (name, instructions, input) => complete(name, instructions, input),
      hasProvider: Effect.sync(() => hasProvider()),
      provider: (name) => Effect.sync(() => options.provider?.(name)),
    }),
    Layer.mock(CapabilitySettings, {
      agentFile: 'agent-capabilities.json',
      publish: Effect.void,
      enabled: () => Effect.succeed(options.titlesEnabled ?? true),
      snapshot: Effect.succeed<CapabilityView[]>([]),
    }),
    Layer.mock(UsageTelemetry, {
      chat: (turn) => Effect.sync(() => void chats.push(turn)),
      toolObserver: () =>
        Effect.succeed({ observe: (event: unknown) => Effect.sync(() => observeTool(event)) }),
      usageObserver: Effect.succeed({ observe: () => Effect.void, usage: Effect.succeed(noUsage) }),
    }),
    Layer.mock(SnapshotPublisher, {
      flush: Effect.sync(() => flushSnapshot()),
      invalidate: Effect.void,
    }),
  );
  const scope = yield* Scope.make();
  const turns = yield* make({
    engine,
    ready,
    stopping,
    defaultModel: Effect.succeed(options.defaultModel ?? 'model'),
    accountBusy: Effect.sync(() => accountBusy()),
    modelFailures: options.modelFailures ?? new ModelFailures(),
    isCustomMcpConnection: () => false,
    ...(options.idleTimeout ? { idleTimeout: options.idleTimeout } : {}),
  }).pipe(Scope.provide(scope), Effect.provide(services));
  // For the engine's callbacks, which run outside the test's Effect.
  const testContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(testContext);
  return {
    chat,
    session,
    turns,
    runPromise,
    runFork: Effect.runForkWith(testContext),
    runSync: Effect.runSyncWith(testContext),
    run: (input: string, messageId?: string, context?: unknown) =>
      turns.run({ chat, text: input, messageId, context }),
    /** Runs `present` from outside the turn, as the agent server does. */
    present: (callId: string, input: Parameters<TurnRunner['Service']['present']>[2]) =>
      runPromise(turns.present(chat, callId, input)),
    drain: Scope.close(scope, Exit.void),
    send,
    end,
    newSessionId,
    models,
    prepare,
    complete,
    hasProvider,
    accountBusy,
    ready,
    stopping,
    flushSnapshot,
    changed,
    observeTool,
    chats,
    lastChat: () => chats.at(-1),
    changeCharacter: session.update((state) => ({ ...state, activeTransport: 'two' })),
    deleteChat: session.update((state) => ({ ...state, chats: [] })),
  };
});

const panel = {
  nodes: [{ id: 'level', kind: 'stat' as const, label: 'Level', value: '10' }],
  references: {},
};

describe('TurnRunner', () => {
  it.effect('a complete turn projects streamed content and settles once', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run('Question');
      expect(f.chat.status).toBe('done');
      expect(
        f.chat.messages
          .filter((m) => m.role === 'assistant')
          .map((m) => m.text)
          .join(''),
      ).toBe('Hello');
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.flushSnapshot).toHaveBeenCalledTimes(1);
      const [timing] = yield* logged('chat.turn_timing');
      expect(timing?.firstTextMs).toBeGreaterThanOrEqual(0);
      yield* f.drain;
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a second turn on a working chat does nothing', () =>
    Effect.gen(function* () {
      const f = yield* fixture({ titlesEnabled: false });
      const reading = yield* Deferred.make<void>();
      f.send.mockResolvedValueOnce(silentAfter([], () => Deferred.doneUnsafe(reading, Exit.void)));
      const first = yield* Effect.forkChild(f.run('First'));
      yield* Deferred.await(reading);
      yield* f.run('Second');
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.chat.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
        'First',
      ]);
      yield* f.turns.interrupt(f.chat);
      yield* Fiber.join(first);
      expect(f.chat.status).toBe('interrupted');
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a chat starts on the first available model when no default is known yet', () =>
    Effect.gen(function* () {
      const f = yield* fixture({ titlesEnabled: false, defaultModel: '' });
      yield* f.run('Question');
      expect(f.chat.status).toBe('done');
      expect(f.prepare).toHaveBeenCalledWith('model');
      expect(f.chat.modelSettings).toEqual({ model: 'model', effort: 'medium' });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a streamed comparison requests publication before the tool settles', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const state = { ...initialSession([f.chat]), activeChat: f.chat.id };
      const previews: string[] = [];
      f.flushSnapshot.mockImplementation(() => {
        const row = projectChats(state).chats[0]?.messages?.at(-1);
        if (row?.role === 'tool') {
          previews.push(row.text);
        }
      });
      let previewsBeforeSettlement: string[] = [];
      f.send.mockResolvedValueOnce({
        stream: async function* () {
          yield text('I will compare the setups.');
          yield {
            type: 'call.input',
            data: {
              callId: 'comparison',
              name: PRESENT_UI_TOOL,
              delta: '{"nodes":[{"kind":"comparison"',
            },
          };
          previewsBeforeSettlement = [...previews];
          yield { type: 'call.settled', data: { callId: 'comparison', outcome: 'failed' } };
        },
        result: async () => completed,
      });
      yield* f.run('Compare my setups');
      expect(f.chat.status).toBe('done');
      expect(previewsBeforeSettlement).toEqual(['Creating comparison']);
      expect(projectChats(state).chats[0]?.messages?.some((m) => m.role === 'tool')).toBe(false);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('real streamed turns report their mode, outcome and tool lifecycle to telemetry', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.chat.inline = true;
      yield* f.run('Private question');
      expect(f.observeTool).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'content.delta' }),
      );
      const [timing] = yield* logged('chat.turn_timing');
      expect(timing?.firstTextMs).toBeGreaterThanOrEqual(0);
      expect(f.lastChat()).toEqual({
        mode: 'hover',
        outcome: 'completed',
        duration: expect.any(Number),
        errorCode: undefined,
        firstTextMs: timing?.firstTextMs,
        usage: noUsage,
      });
      f.chat.inline = false;
      f.chat.routineId = 'private-routine-id';
      yield* f.run('Private routine');
      expect(f.lastChat()).toMatchObject({
        mode: 'routine',
        outcome: 'completed',
        firstTextMs: expect.any(Number),
        usage: noUsage,
      });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('chat telemetry distinguishes early failures before a turn reaches the engine', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.accountBusy.mockReturnValueOnce(true);
      f.prepare.mockReturnValueOnce(
        Effect.fail(new ChatGPTAuthError({ message: 'Private account details' })),
      );
      f.prepare.mockReturnValueOnce(
        Effect.fail(new ModelConnectionError({ message: 'Private model details' })),
      );
      f.models.mockReturnValueOnce(
        Effect.fail(new ChatGPTRequestError({ cause: new Error('Private model catalog details') })),
      );
      yield* f.ready.close;
      for (const code of [
        'engine_not_ready',
        'account_busy',
        'model_auth_failed',
        'model_preparation_failed',
        'model_catalog_failed',
      ]) {
        yield* f.run('Private question');
        yield* f.ready.open;
        expect(f.lastChat()).toEqual({
          mode: 'chat',
          outcome: 'failed',
          duration: expect.any(Number),
          errorCode: code,
          firstTextMs: undefined,
          usage: noUsage,
        });
      }
      expect(f.chat.messages.at(-1)?.text).toBe('Private model catalog details');
      expect(f.send).not.toHaveBeenCalled();
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('chat telemetry distinguishes failed, timed-out and interrupted turns', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.send.mockRejectedValueOnce(Error('Private provider error'));
      yield* f.run('Private question');
      expect(f.lastChat()).toMatchObject({ outcome: 'failed', errorCode: 'turn_start_failed' });

      f.send.mockResolvedValueOnce(
        failedWith(providerError('Private provider error', { code: 'private-provider-code' })),
      );
      yield* f.run('Private question');
      expect(f.lastChat()).toMatchObject({ outcome: 'failed', errorCode: 'turn_result_failed' });

      f.send.mockResolvedValueOnce(
        failedWith(providerError('Private provider error', { name: 'TimeoutError' })),
      );
      yield* f.run('Private question');
      expect(f.chat.status).toBe('error');
      expect(f.lastChat()).toMatchObject({ outcome: 'timeout', errorCode: 'timeout' });

      // Interrupted while the delivery fails: an interruption, not a failure.
      f.send.mockImplementationOnce(async () => {
        f.runFork(f.turns.interrupt(f.chat));
        throw new DOMException('Private provider error', 'TimeoutError');
      });
      yield* f.run('Private question');
      expect(f.chat.status).toBe('interrupted');
      expect(f.lastChat()).toMatchObject({ outcome: 'cancelled', errorCode: undefined });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('chat telemetry separates plan usage limits from other failures', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.send.mockResolvedValueOnce(
        failedWith(
          providerError('Private plan details', {
            code: 'subscription_sharing_usage_limit_exceeded',
          }),
        ),
      );
      yield* f.run('Private question');
      expect(f.chat.status).toBe('error');
      expect(f.lastChat()).toMatchObject({ outcome: 'failed', errorCode: 'usage_limit' });
      // Routines read this classification; the message alone does not mention a limit.
      expect(yield* f.turns.endedOnUsageLimit(f.chat)).toBe(true);

      f.send.mockRejectedValueOnce(
        Error('You exceeded your current quota, please check your plan.'),
      );
      yield* f.run('Private question');
      expect(f.lastChat()).toMatchObject({ outcome: 'failed', errorCode: 'usage_limit' });

      yield* f.run('Private question');
      expect(yield* f.turns.endedOnUsageLimit(f.chat)).toBe(false);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('plain source schedules persistence before a reply can be rendered', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.send.mockResolvedValueOnce({
        stream: async function* () {
          const before = f.changed.mock.calls.length;
          yield text('Primera parte');
          expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
            'Primera parte',
          );
          expect(f.changed.mock.calls.length).toBeGreaterThan(before);
          yield {
            type: 'content.completed',
            data: { partId: 'reply', kind: 'text', value: 'Primera parte completa' },
          };
        },
        result: async () => completed,
      });
      yield* f.run('Question');
      expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
        'Primera parte completa',
      );
      expect(f.send).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  for (const { interval, expectedPreviews } of [
    { interval: 10, expectedPreviews: 2 },
    { interval: 100, expectedPreviews: 17 },
  ]) {
    it.effect(
      `source persistence retains preview coalescing throughout a reply (${interval} ms)`,
      () =>
        Effect.gen(function* () {
          // The reply projection coalesces previews on `Date.now()`; reply/ is not migrated.
          let now = 0;
          const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
          // Titles would publish mid-stream; this test measures reply previews only.
          const f = yield* fixture({ titlesEnabled: false });
          const state = { ...initialSession([f.chat]), activeChat: f.chat.id };
          const gate = new SnapshotGate();
          let publications = 0,
            previews = 0,
            completions = 0;
          f.changed.mockImplementation(() => {
            const snapshot = gate.next(projectChats(state));
            if (snapshot) {
              publications++;
              expect(JSON.stringify(snapshot)).not.toContain('rawReply');
            }
          });
          f.send.mockResolvedValueOnce({
            stream: async function* () {
              const baseline = publications;
              for (let index = 0; index < 100; index++) {
                now = (index + 1) * interval;
                const changes = f.changed.mock.calls.length;
                yield text('a');
                expect(f.changed.mock.calls.length).toBeGreaterThan(changes);
              }
              expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
                'a'.repeat(100),
              );
              previews = publications - baseline;
              yield {
                type: 'content.completed',
                data: { partId: 'reply', kind: 'text', value: 'a'.repeat(100) },
              };
              completions = publications - baseline;
              expect(projectChats(state).chats[0]?.messages?.at(-1)?.text).toBe('a'.repeat(100));
            },
            result: async () => completed,
          });
          yield* f.run('Question');
          clock.mockRestore();
          expect(previews).toBe(expectedPreviews);
          expect(completions).toBe(expectedPreviews + 1);
          expect(f.chat.status).toBe('done');
        }).pipe(Effect.provide(bridgeLogging)),
    );
  }

  it.effect('the active runner accepts presentation RPCs and rejects them after the turn', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.send.mockResolvedValueOnce({
        stream: async function* () {
          // The local RPC may arrive before its requested event reaches the bridge.
          const accepted = f.present('ui', panel);
          yield { type: 'turn.started', data: { turnId: 'turn' } };
          yield {
            type: 'call.requested',
            data: { callId: 'ui', capability: { name: PRESENT_UI_TOOL, kind: 'tool' } },
          };
          const output = await accepted;
          expect(f.chat.messages.at(-1)?.ui).toEqual([]);
          yield { type: 'call.settled', data: { callId: 'ui', outcome: 'completed', output } };
        },
        result: async () => completed,
      });
      yield* f.run('Question');
      expect(f.chat.messages.at(-1)?.ui).toEqual(panel.nodes);
      expect(f.chat.activity).toEqual([]);
      const late = yield* Effect.flip(f.turns.present(f.chat, 'late', panel));
      expect(late.message).toContain('no longer active');
    }).pipe(Effect.provide(bridgeLogging)),
  );

  for (const change of ['character', 'delete', 'interrupt'] as const) {
    it.effect(`a ${change} change rejects a presentation awaiting its requested event`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let rejected: Promise<void> | undefined;
        f.send.mockResolvedValueOnce({
          stream: async function* () {
            rejected = expect(f.present('ui', panel)).rejects.toThrow();
            if (change === 'character') {
              f.runSync(f.changeCharacter);
            } else if (change === 'delete') {
              f.runSync(f.deleteChat);
            } else {
              f.runFork(f.turns.interrupt(f.chat));
            }
            yield {
              type: 'call.requested',
              data: { callId: 'ui', capability: { name: PRESENT_UI_TOOL, kind: 'tool' } },
            };
          },
          result: async () => completed,
        });
        yield* f.run('Question');
        yield* Effect.promise(() => rejected ?? Promise.resolve());
        expect(f.chat.messages.some((message) => message.ui?.length)).toBe(false);
        expect(f.chat.status).toBe('interrupted');
      }).pipe(Effect.provide(bridgeLogging)),
    );
  }

  it.effect('a presentation for an interrupted turn reports the interruption', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let failure: unknown;
      f.send.mockResolvedValueOnce({
        stream: async function* () {
          const accepted = f.present('ui', panel).catch((error: unknown) => {
            failure = error;
          });
          f.runFork(f.turns.interrupt(f.chat));
          yield { type: 'turn.started', data: { turnId: 'turn' } };
          await accepted;
        },
        result: async () => completed,
      });
      yield* f.run('Question');
      yield* settle;
      expect(failure).toMatchObject({ message: 'This operation was aborted' });
      expect(f.chat.status).toBe('interrupted');
      expect(f.chat.messages.at(-1)).toEqual({
        role: 'system',
        text: 'This operation was aborted',
      });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('old assistant messages cannot count as the first text of a new turn', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.chat.messages.push({ role: 'assistant', text: 'Previous answer' });
      f.send.mockResolvedValueOnce(
        delivered([
          {
            type: 'call.requested',
            data: {
              callId: 'call',
              capability: { name: 'wow__query_character', kind: 'tool', label: 'Reading quests' },
            },
          },
          { type: 'call.settled', data: { callId: 'call', outcome: 'completed' } },
        ]),
      );
      yield* f.run('Next question');
      const [timing] = yield* logged('chat.turn_timing');
      expect(timing).toBeDefined();
      expect(timing?.firstTextMs).toBeUndefined();
      expect(f.lastChat()).toMatchObject({ outcome: 'completed', firstTextMs: undefined });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect(
    'a turn keeps its quest reading available to tools without inserting it into model input',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const context = {
          capturedAt: 123,
          sections: {
            character: { status: 'available', data: { name: 'Mage', realm: 'Realm' } },
            quests: {
              status: 'available',
              data: {
                quests: [{ id: 1492, title: 'Private delivery', objectives: [], complete: true }],
                count: 1,
                truncated: false,
              },
            },
          },
        };
        yield* f.run('What next?', 'message', context);
        expect(f.send.mock.calls[0]?.[0]).not.toContain('Private delivery');
        const live = vi.fn(async () => ({ sections: {} }));
        const sections = yield* Effect.promise(() =>
          queryCharacterSections(f.chat, ['quests'], live),
        );
        expect(JSON.stringify(sections)).toContain('Private delivery');
        expect(live).not.toHaveBeenCalled();
        yield* f.run('Another question', 'message2', undefined);
        yield* Effect.promise(() => queryCharacterSections(f.chat, ['quests'], live));
        expect(live).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(bridgeLogging)),
  );

  for (const change of ['character', 'delete'] as const) {
    it.effect(
      `a ${change} change while resolving model settings cannot start an obsolete turn`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const asked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.models.mockReturnValueOnce(
            Deferred.succeed(asked, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as([model]),
            ),
          );
          const turn = yield* Effect.forkChild(f.run('Question'));
          yield* Deferred.await(asked);
          yield* change === 'character' ? f.changeCharacter : f.deleteChat;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(turn);
          expect(f.send).not.toHaveBeenCalled();
          expect(f.chat.status).toBe('interrupted');
        }).pipe(Effect.provide(bridgeLogging)),
    );
  }

  it.effect('interrupting a delivery aborts its stream and drains the runner', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const reading = yield* Deferred.make<void>();
      let aborted = false;
      f.send.mockResolvedValueOnce({
        stream: async function* (signal) {
          signal.addEventListener('abort', () => (aborted = true), { once: true });
          const read = abortedRead(signal);
          Deferred.doneUnsafe(reading, Exit.void);
          await read;
          yield { type: 'unused', data: {} };
        },
        result: async () => completed,
      });
      const turn = yield* Effect.forkChild(f.run('Question'));
      yield* Deferred.await(reading);
      yield* f.turns.interrupt(f.chat);
      yield* Fiber.join(turn);
      yield* f.drain;
      expect(aborted).toBe(true);
      expect(f.chat.status).toBe('interrupted');
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a cancelled turn settles as cancelled and keeps its message', () =>
    Effect.gen(function* () {
      const f = yield* fixture({ titlesEnabled: false });
      const reading = yield* Deferred.make<void>();
      f.send.mockResolvedValueOnce(
        silentAfter([text('Hal')], () => Deferred.doneUnsafe(reading, Exit.void)),
      );
      const turn = yield* Effect.forkChild(f.run('Question'));
      yield* Deferred.await(reading);
      yield* f.turns.cancel(f.chat);
      yield* Fiber.join(turn);
      expect(f.chat.status).toBe('cancelled');
      expect(f.chat.messages.some((m) => m.role === 'system')).toBe(false);
      expect(f.lastChat()).toMatchObject({ outcome: 'cancelled', errorCode: undefined });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('no turn starts once Wisp is stopping', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.turns.accepting).toBe(true);
      yield* f.stopping.open;
      expect(yield* f.turns.accepting).toBe(false);
      yield* f.run('Question');
      expect(f.chat.status).toBe('idle');
      expect(f.chat.messages).toEqual([]);
      expect(f.chats).toEqual([]);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('closing the runner interrupts its turns and waits for their titles', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const title = yield* Deferred.make<string>();
      const reading = yield* Deferred.make<void>();
      f.complete.mockReturnValueOnce(Deferred.await(title));
      f.send.mockResolvedValueOnce(silentAfter([], () => Deferred.doneUnsafe(reading, Exit.void)));
      const turn = yield* Effect.forkChild(f.run('Ruta por Durotar'));
      yield* Deferred.await(reading);
      const drained = yield* Effect.forkChild(f.drain);
      yield* Fiber.join(turn);
      expect(f.chat.status).toBe('interrupted');
      // The title is still being generated, so closing waits for it.
      yield* settle;
      expect(drained.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(title, 'Ruta por Durotar');
      yield* Fiber.join(drained);
      expect(f.chat.title).toBe('Ruta por Durotar');
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a failed turn keeps its session, so a retry continues it', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run('Earlier question', 'earlier');
      f.send.mockRejectedValueOnce(new Error('Provider unavailable'));
      yield* f.run('Explain that quest', 'failed');
      expect(f.chat.status).toBe('error');
      expect(f.chat.agentSession).toBe('eve');
      expect(f.end).not.toHaveBeenCalled();
      yield* f.run('Explain that quest', 'failed');
      expect(f.chat.status).toBe('done');
      expect(f.chat.messages.filter((m) => m.id === 'failed')).toHaveLength(1);
      // The same session continues; the engine logs the visible history only for a session without a log.
      expect(f.send.mock.calls.at(-1)?.[0]).toContain('"text":"Explain that quest"');
      expect(f.newSessionId).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a request the provider rejected starts a new session from the visible chat', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run('Earlier question', 'earlier');
      f.send.mockResolvedValueOnce(
        failedWith(
          Object.assign(new Error('Invalid request'), { name: 'AI_APICallError' }),
          'rejected',
        ),
      );
      yield* f.run('Explain that quest', 'failed');
      expect(f.end).toHaveBeenCalledWith('eve');
      expect(f.chat.agentSession).toBeUndefined();
      yield* f.run('Try that again', 'follow-up');
      const input = f.send.mock.calls.at(-1)?.[0];
      expect(input).toContain('Earlier question');
      expect(input).toContain('Explain that quest');
      expect(f.newSessionId).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('names a new conversation beside the reply without delaying it', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const title = yield* Deferred.make<string>();
      f.complete.mockReturnValueOnce(Deferred.await(title));
      yield* f.run('  Ruta\n por Durotar  ');
      // The reply finished while the title was still pending.
      expect(f.chat.status).toBe('done');
      expect(f.chat.title).toBe('New conversation');
      expect(f.send.mock.calls[0]?.[0]).not.toContain('needsTitle');
      expect(f.complete).toHaveBeenCalledTimes(1);
      expect(f.complete.mock.calls[0]?.[0]).toBe('model');
      expect(f.complete.mock.calls[0]?.[2]).toContain('Ruta\n por Durotar');
      yield* Deferred.succeed(title, '"Ruta por Durotar."\nExtra line');
      yield* settle;
      expect(f.chat.title).toBe('Ruta por Durotar');
      expect(f.chat.titleGenerated).toBe(true);
      yield* f.run('Otra pregunta');
      expect(f.complete).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a generated title never replaces a name chosen meanwhile', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const title = yield* Deferred.make<string>();
      f.complete.mockReturnValueOnce(Deferred.await(title));
      yield* f.run('Ruta por Durotar');
      f.chat.title = 'Mi ruta';
      f.chat.titleGenerated = true;
      yield* Deferred.succeed(title, 'Ruta por Durotar');
      yield* f.drain;
      expect(f.chat.title).toBe('Mi ruta');
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a title that takes too long is given up after 20 seconds', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.complete.mockReturnValueOnce(Effect.never);
      yield* f.run('Hola');
      yield* TestClock.adjust('19999 millis');
      expect(yield* logged('chat.title_failed')).toEqual([]);
      yield* TestClock.adjust('1 millis');
      expect(yield* logged('chat.title_failed')).toMatchObject([
        { error: 'The operation was aborted due to timeout' },
      ]);
      expect(f.chat.titleGenerated).not.toBe(true);
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a failed title keeps the reply and is retried on a later turn', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.complete.mockReturnValueOnce(
        Effect.fail(new ModelRequestError({ cause: Error('Private provider error') })),
      );
      yield* f.run('Hola');
      expect(f.chat.status).toBe('done');
      expect(f.chat.titleGenerated).not.toBe(true);
      expect(yield* logged('chat.title_failed')).toMatchObject([
        { error: 'Private provider error' },
      ]);
      yield* f.run('Quiero una build de mago');
      yield* f.drain;
      expect(f.complete).toHaveBeenCalledTimes(2);
      expect(f.chat.title).toBe('Generated title');
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('does not automatically name inline or proactive conversations', () =>
    Effect.gen(function* () {
      for (const kind of ['inline', 'proactive'] as const) {
        const f = yield* fixture();
        f.chat[kind] = true;
        yield* f.run('A different title');
        yield* f.drain;
        expect(f.chat.title).toBe('New conversation');
        expect(f.complete).not.toHaveBeenCalled();
      }
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('disabled titles do not request automatic naming', () =>
    Effect.gen(function* () {
      const f = yield* fixture({ titlesEnabled: false });
      yield* f.run('Help me choose talents');
      yield* f.drain;
      expect(f.chat.titleGenerated).not.toBe(true);
      expect(f.complete).not.toHaveBeenCalled();
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a turn with no AI provider stops before the engine and explains the fix', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.hasProvider.mockReturnValueOnce(false);
      yield* f.run('Private question');
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.chat.status).toBe('error');
      expect(f.chat.messages.at(-1)).toEqual({
        role: 'system',
        text: expect.stringContaining('connect ChatGPT or an API key'),
        notice: 'noProvider',
      });
      expect(f.lastChat()).toMatchObject({ outcome: 'failed', errorCode: 'no_provider' });

      // Other failures keep their own message and carry no notice code.
      f.prepare.mockReturnValueOnce(
        Effect.fail(new ModelConnectionError({ message: 'Model is no longer configured.' })),
      );
      yield* f.run('Private question');
      expect(f.chat.messages.at(-1)).toEqual({
        role: 'system',
        text: 'Model is no longer configured.',
      });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('a turn whose engine goes silent fails as a timeout and frees the engine session', () =>
    Effect.gen(function* () {
      const f = yield* fixture({ idleTimeout: '30 millis' });
      const reading = yield* Deferred.make<void>();
      f.send.mockResolvedValueOnce(
        silentAfter([text('Hel')], () => Deferred.doneUnsafe(reading, Exit.void)),
      );
      const turn = yield* Effect.forkChild(f.run('Question'));
      yield* Deferred.await(reading);
      yield* TestClock.adjust('29 millis');
      expect(f.chat.status).toBe('working');
      yield* TestClock.adjust('1 millis');
      yield* Fiber.join(turn);
      expect(f.chat.status).toBe('error');
      expect(f.chat.messages.at(-1)?.text).toMatch(/received nothing from the AI for 1 minutes/);
      // A stall is not the history's fault; the next turn continues the session.
      expect(f.end).not.toHaveBeenCalled();
      expect(f.chat.agentSession).toBe('eve');
      expect(f.lastChat()).toMatchObject({ outcome: 'timeout', errorCode: 'timeout' });
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect('steady engine activity keeps a long turn alive past the idle timeout', () =>
    Effect.gen(function* () {
      const f = yield* fixture({ idleTimeout: '40 millis' });
      const gaps = Array.from({ length: 5 }, () => Deferred.makeUnsafe<void>());
      const waiting = Array.from({ length: 5 }, () => Deferred.makeUnsafe<void>());
      f.send.mockResolvedValueOnce({
        stream: async function* () {
          for (const [index, gap] of gaps.entries()) {
            const next = waiting[index];
            if (next) Deferred.doneUnsafe(next, Exit.void);
            await f.runPromise(Deferred.await(gap));
            yield text('a');
          }
        },
        result: async () => completed,
      });
      const turn = yield* Effect.forkChild(f.run('Question'));
      for (const [index, gap] of gaps.entries()) {
        const next = waiting[index];
        if (next) yield* Deferred.await(next);
        // 100 ms in all, more than twice the idle timeout, 20 ms between events.
        yield* TestClock.adjust('20 millis');
        yield* Deferred.succeed(gap, undefined);
      }
      yield* Fiber.join(turn);
      expect(f.chat.status).toBe('done');
      expect(f.end).not.toHaveBeenCalled();
    }).pipe(Effect.provide(bridgeLogging)),
  );

  it.effect(
    'chat telemetry names the provider and why its own model requests failed during the turn',
    () =>
      Effect.gen(function* () {
        const failures = new ModelFailures();
        const connection = '00000000-0000-4000-8000-000000000001';
        const connectionModel = 'connection:' + connection + ':private-model';
        const f = yield* fixture({
          defaultModel: connectionModel,
          modelFailures: failures,
          provider: (slug) => (slug === connectionModel ? 'google' : 'chatgpt'),
        });
        f.models.mockReturnValue(
          Effect.succeed([{ slug: connectionModel, displayName: 'Private', efforts: ['medium'] }]),
        );
        const failedTurn = failedWith(providerError('Private provider error', { code: 'unknown' }));

        // A failure from an earlier turn is not this turn's cause.
        failures.record('eve', 'rate_limited');
        f.send.mockResolvedValueOnce(failedTurn);
        yield* f.run('Private question');
        expect(f.lastChat()).toMatchObject({
          outcome: 'failed',
          errorCode: 'turn_result_failed',
          provider: 'google',
          failureKind: undefined,
        });

        f.send.mockImplementationOnce(async () => {
          failures.record('eve', httpFailureKind(404));
          // Another chat's failure on the same connection is not this turn's.
          failures.record('other-eve-session', 'rate_limited');
          return failedTurn;
        });
        yield* f.run('Private question');
        expect(f.lastChat()).toMatchObject({
          outcome: 'failed',
          errorCode: 'turn_result_failed',
          provider: 'google',
          failureKind: 'not_found',
        });

        // A retried request that later succeeded does not mark a completed turn.
        f.send.mockImplementationOnce(async () => {
          failures.record('eve', 'provider_error');
          return delivered([]);
        });
        yield* f.run('Private question');
        expect(f.lastChat()).toMatchObject({
          outcome: 'completed',
          errorCode: undefined,
          provider: 'google',
          failureKind: undefined,
        });
      }).pipe(Effect.provide(bridgeLogging)),
  );
});
