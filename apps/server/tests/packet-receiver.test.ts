import { test, expect, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Deferred, Effect, Latch, Layer } from 'effect';
import type { EngineEvent, EngineResult, TurnInput } from '@wisp/agent/engine';
import { captureLogs, runBridgeEffect } from './capture-logs.ts';
import { createPacketReceiver } from '../src/game/packet-receiver.ts';
import { SnapshotPublisher } from '../src/game/snapshot-publisher.ts';
import { bridgeLogging } from '../src/logger.ts';
import { ModelConnections } from '../src/models/connections.ts';
import { ModelFailures } from '../src/models/model-failures.ts';
import type { Chat } from '../src/chat/events.ts';
import { CapabilitySettings } from '#/capabilities';
import { initialSession, SessionState } from '#/session';
import { UsageTelemetry } from '#/telemetry';
import * as Turns from '#/turns';
import type { TurnRequest } from '#/turns';
import { current, sessionState } from './session-fixture.ts';
import { unsavedCapabilities } from './capabilities/fixture.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { ApplicationDatabase } from '../src/application-database.ts';
import { PanelStore } from '../src/panels/panel-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { gameEvent } from './game-event-fixture.ts';
import type { AccountModel } from '../src/chat/chat-model.ts';

function fixture(
  overrides: Partial<Parameters<typeof createPacketReceiver>[0]> = {},
  session = sessionState({
    ...initialSession([{ ...newChat('old', 'one'), agentSession: 'eve', status: 'working' }]),
    activeTransport: 'one',
    currentCharacterKey: 'old-character',
    inlineChat: 'old-inline',
    panelCommand: { seq: 1, id: 'panel', characterKey: 'old-character', action: 'show' },
  }),
) {
  const database = new ApplicationDatabase('unused');
  const capabilities = unsavedCapabilities();
  const end = vi.fn(async (_session: string) => {});
  // The turns the packets start, run, interrupt and cancel.
  const start = vi.fn((_turn: TurnRequest) => Effect.void);
  const run = vi.fn((_turn: TurnRequest) => Effect.void);
  const interrupt = vi.fn((_chat: Chat) => Effect.void);
  const cancel = vi.fn((_chat: Chat) => Effect.void);
  const models = vi.fn(async (): Promise<AccountModel[]> => []);
  const receiveEffect = runBridgeEffect(
    createPacketReceiver({
      request: () => Effect.void,
      capabilitySettings: capabilities.settings,
      integrationState: capabilities.integrations,
      engine: { end },
      models: { models: Effect.promise(() => models()) },
      routineStore: new RoutineStore(database),
      panelStore: new PanelStore(database),
      memoryRepository: { read: () => Effect.succeed([]), update: () => Effect.succeed([]) },
      catalog: { refresh: Effect.void },
      setCapability: () => Effect.void,
      memorySnapshot: () => Effect.succeed({ status: 'available', entries: [] }),
      turns: { start, run, interrupt, cancel },
      runtime: 'unused',
      snapshot: { invalidate: Effect.void },
      ...overrides,
    }).pipe(Effect.provideService(SessionState, session)),
  );
  const receive = (packet: Parameters<typeof receiveEffect>[0]) =>
    runBridgeEffect(receiveEffect(packet));
  const state = () => current(session);
  return { state, receive, receiveEffect, cancel, end, interrupt, start, run, models };
}

it.effect('Stop during first-turn model preparation prevents engine dispatch', () =>
  Effect.gen(function* () {
    const chat = newChat('chat', 'one');
    const session = sessionState({
      ...initialSession([chat]),
      activeTransport: 'one',
      activeChat: chat.id,
    });
    const preparing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const prepare = vi.fn((_model: string) =>
      Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const send = vi.fn((_session: string, _input: TurnInput, _signal: AbortSignal) => ({
      events: (async function* (): AsyncGenerator<EngineEvent> {})(),
      result: Promise.resolve<EngineResult>({ status: 'completed' }),
    }));
    const newSessionId = vi.fn(() => 'session');
    const engine = { newSessionId, send, end: vi.fn(async (_session: string) => {}) };
    const capabilities = unsavedCapabilities();
    const turns = yield* Turns.make({
      engine,
      ready: yield* Latch.make(true),
      stopping: yield* Latch.make(),
      defaultModel: Effect.succeed('model'),
      accountBusy: Effect.succeed(false),
      modelFailures: new ModelFailures(),
      isCustomMcpConnection: () => false,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SessionState, session),
          Layer.mock(ModelConnections, {
            prepare,
            models: Effect.succeed([{ slug: 'model', displayName: 'Model', efforts: [] }]),
            complete: () => Effect.succeed('Unused title'),
            hasProvider: Effect.succeed(true),
            provider: () => Effect.succeed(undefined),
          }),
          // Publishing would write the agent's capability file.
          Layer.succeed(
            CapabilitySettings,
            CapabilitySettings.of({ ...capabilities.settings, publish: Effect.void }),
          ),
          Layer.mock(UsageTelemetry, {
            chat: () => Effect.void,
            toolObserver: () => Effect.succeed({ observe: () => Effect.void }),
            usageObserver: Effect.succeed({
              observe: () => Effect.void,
              usage: Effect.succeed({
                modelCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
              }),
            }),
          }),
          Layer.mock(SnapshotPublisher, { flush: Effect.void, invalidate: Effect.void }),
        ),
      ),
    );
    const { receiveEffect } = fixture(
      {
        engine,
        capabilitySettings: capabilities.settings,
        integrationState: capabilities.integrations,
        turns,
      },
      session,
    );
    yield* receiveEffect(
      gameEvent({ type: 'say', session: 'one', chat: chat.id, text: 'Question', seq: 1, at: 1 }),
    );
    yield* Deferred.await(preparing);
    expect(prepare).toHaveBeenCalledWith('model');
    expect(chat.status).toBe('working');
    expect(chat.agentSession).toBeUndefined();
    expect(newSessionId).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    yield* receiveEffect(
      gameEvent({ type: 'cancel', session: 'one', chat: chat.id, seq: 2, at: 2 }),
    );
    yield* Deferred.succeed(release, undefined);
    expect(send).not.toHaveBeenCalled();
    expect(newSessionId).not.toHaveBeenCalled();
    expect(chat.status).toBe('cancelled');
  }).pipe(Effect.provide(bridgeLogging)),
);

test('Stop cancels the turn in the bridge and keeps its session', () => {
  const f = fixture();
  f.receive(gameEvent({ type: 'cancel', session: 'one', chat: 'old', seq: 1, at: 1 }));
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(f.state().chats[0]);
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
});

test('a stale-session cancel cannot interrupt or cancel the current chat', () => {
  const f = fixture();
  f.receive(gameEvent({ type: 'cancel', session: 'stale', chat: 'old', seq: 1, at: 1 }));
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.state().chats[0].status).toBe('working');
});

test('leaving a new empty conversation discards it while keeping conversations with activity', () => {
  const f = fixture();
  f.receive(gameEvent({ type: 'new', chat: 'draft', session: 'one', seq: 20, at: 1 }));
  expect(f.state().chats.some((chat) => chat.id === 'draft')).toBe(true);
  f.receive(gameEvent({ type: 'select', chat: 'old', session: 'one', seq: 21, at: 2 }));
  expect(f.state().chats.map((chat) => chat.id)).toEqual(['old']);
  f.receive(gameEvent({ type: 'new', chat: 'used', session: 'one', seq: 22, at: 3 }));
  f.state()
    .chats.find((chat) => chat.id === 'used')!
    .messages.push({ role: 'user', text: 'Hi' });
  f.receive(gameEvent({ type: 'new', chat: 'next', session: 'one', seq: 23, at: 4 }));
  expect(f.state().chats.map((chat) => chat.id)).toEqual(['old', 'used', 'next']);
});

test('a player message starts a turn with the original chat message ID', () => {
  const f = fixture();
  const packet = gameEvent({
    type: 'say',
    chat: 'old',
    session: 'one',
    seq: 11,
    at: 1,
    text: 'Hello',
    messageId: 'message',
  });
  f.receive(packet);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledWith({
    chat: expect.objectContaining({ id: 'old' }),
    text: 'Hello',
    messageId: 'message',
    context: undefined,
  });
});

test('quest sync primes turn context but a new addon session cannot reuse its revision', () => {
  const f = fixture();
  f.state().chats[0]!.status = 'done';
  const character = { status: 'available', data: { name: 'Mage', realm: 'Realm' } };
  const quests = {
    status: 'available',
    data: {
      quests: [{ id: 1492, title: 'Delivery', objectives: [], complete: true }],
      count: 1,
      truncated: false,
    },
  };
  f.receive(
    gameEvent({
      type: 'quest_sync',
      session: 'one',
      seq: 10,
      at: 1,
      context: { questRevision: 1, sections: { character, quests } },
    }),
  );
  f.receive(
    gameEvent({
      type: 'say',
      session: 'one',
      seq: 11,
      at: 2,
      chat: 'old',
      text: 'What next?',
      context: { questRevision: 1, sections: { character } },
    }),
  );
  expect(f.start.mock.calls.at(-1)?.[0].context).toMatchObject({ sections: { quests } });
  f.receive(gameEvent({ type: 'hello', session: 'two', seq: 1, at: 3 }));
  f.receive(
    gameEvent({
      type: 'say',
      session: 'two',
      seq: 2,
      at: 4,
      chat: 'fresh',
      text: 'What next?',
      context: { questRevision: 1, sections: { character } },
    }),
  );
  const context = f.start.mock.calls.at(-1)?.[0].context;
  expect(context).toMatchObject({ sections: { character } });
  expect(context).not.toMatchObject({ sections: { quests: expect.anything() } });
});

test("changing models keeps the chat's agent session and its visible conversation", async () => {
  const f = fixture();
  const chat = f.state().chats[0]!;
  chat.status = 'done';
  chat.modelSettings = { model: 'chatgpt-model', effort: 'medium' };
  chat.messages.push({ role: 'user', text: 'Keep this conversation' });
  const first = 'connection:35302f8c-128a-48fb-98a1-9eb03bb71f72:anthropic/claude';
  const second = 'connection:35302f8c-128a-48fb-98a1-9eb03bb71f72:google/gemini';
  f.models.mockResolvedValue(
    [first, second].map((slug) => ({ slug, displayName: slug, efforts: [] })),
  );
  f.receive(
    gameEvent({
      type: 'chat_model_set',
      requestId: 'model-change',
      session: 'one',
      seq: 1,
      at: 1,
      chat: 'old',
      data: { model: first },
    }),
  );
  await vi.waitFor(() => expect(chat.modelSettings?.model).toBe(first));
  const session = chat.agentSession;
  expect(session).toBeDefined();
  expect(chat.messages[0]?.text).toBe('Keep this conversation');
  f.receive(
    gameEvent({
      type: 'chat_model_set',
      requestId: 'model-change',
      session: 'one',
      seq: 2,
      at: 2,
      chat: 'old',
      data: { model: second },
    }),
  );
  await vi.waitFor(() => expect(chat.modelSettings?.model).toBe(second));
  expect(chat.agentSession).toBe(session);
  expect(f.end).not.toHaveBeenCalled();
});

test('reload interrupts old turns and clears character-specific commands', async () => {
  const f = fixture();
  f.receive(gameEvent({ type: 'hello', session: 'two', seq: 1, at: 1 }));
  expect(f.state().chats[0].status).toBe('interrupted');
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  expect(f.state().currentCharacterKey).toBeUndefined();
  expect(f.state().panelCommand).toBeUndefined();
  expect(f.state().inlineChat).toBe('');
  f.receive(gameEvent({ type: 'say', session: 'one', chat: 'old', text: 'stale', seq: 2, at: 2 }));
  expect(f.start).not.toHaveBeenCalled();
});

test('deleting an active conversation prevents delayed messages from recreating it', async () => {
  const f = fixture();
  f.receive(gameEvent({ type: 'delete', session: 'one', chat: 'old', seq: 2, at: 2 }));
  f.receive(gameEvent({ type: 'say', session: 'one', chat: 'old', text: 'late', seq: 3, at: 3 }));
  expect(f.state().chats).toEqual([]);
  expect(f.end).toHaveBeenCalledTimes(1);
  expect(f.start).not.toHaveBeenCalled();
});

test('retry reuses the failed question and ignores retries while working', () => {
  const f = fixture();
  const chat = f.state().chats[0]!;
  chat.messages.push({ role: 'user', id: 'question', text: 'Which quest?' });
  chat.status = 'error';
  f.receive(gameEvent({ type: 'retry', chat: 'old', session: 'one', seq: 11, at: 1 }));
  expect(f.start).toHaveBeenCalledWith({
    chat,
    text: 'Which quest?',
    messageId: 'question',
    context: undefined,
  });
  chat.status = 'working';
  f.receive(gameEvent({ type: 'retry', chat: 'old', session: 'one', seq: 12, at: 1 }));
  expect(f.start).toHaveBeenCalledTimes(1);
});

test('a packet waits for character adoption before handling its routine event', async () => {
  const calls: string[] = [];
  const started = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const adoptCharacter = vi.fn(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      calls.push('adopt');
    }),
  );
  const observe = vi.fn(async () => void calls.push('observe'));
  // Routines are on in the default catalog.
  const f = fixture({
    adoptCharacter,
    routineStore: { observe } as unknown as RoutineStore,
  });
  const character = {
    status: 'available',
    data: { name: 'Fedrath', realm: '', game: 'WoW Forever', guid: 'Player-1-00A' },
  };
  const handled = Effect.runPromise(
    f.receiveEffect(
      gameEvent({
        type: 'routine_event',
        session: 'one',
        seq: 30,
        at: Math.floor(Date.now() / 1000),
        context: { sections: { character } },
        data: { ready: true, event: 'level_up', values: { level: 20 } },
      }),
    ),
  );
  await Effect.runPromise(Deferred.await(started));
  expect(observe).not.toHaveBeenCalled();
  expect(f.state().currentCharacterKey).toBe('old-character');
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await handled;
  const key = JSON.stringify(['WoW Forever', 'Player-1-00A']);
  expect(adoptCharacter).toHaveBeenCalledWith(
    expect.objectContaining({ key, name: 'Fedrath', guid: 'Player-1-00A' }),
  );
  expect(observe).toHaveBeenCalledWith(key, expect.anything());
  expect(calls).toEqual(['adopt', 'observe']);
});

test('a new game window logs why it took the bridge and how long the old one was idle', () => {
  let clock = 1_000_000;
  const logs = captureLogs();
  const f = fixture({ now: () => clock });
  f.receive(gameEvent({ type: 'poll', session: 'one', seq: 1, at: 1 }));
  clock += 30_000;
  f.receive(
    gameEvent({
      type: 'hello',
      session: 'two',
      seq: 1,
      at: 2,
      heartbeat: true,
      takeover: true,
    }),
  );
  expect(f.state().activeTransport).toBe('two');
  expect(logs('transport.session_changed')).toContainEqual(
    expect.objectContaining({ reason: 'takeover', previousIdleMs: 30_000 }),
  );
});
