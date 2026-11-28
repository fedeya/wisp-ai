import { test, expect, vi } from 'vitest';
import { Deferred, Effect } from 'effect';
import { captureLogs, runBridgeEffect } from './capture-logs.ts';
import { createPacketReceiver } from '../src/game/packet-receiver.ts';
import { createTurnRunner } from '../src/agent/turn-runner.ts';
import { initialSession, SessionState } from '#/session';
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
  const cancel = vi.fn();
  const end = vi.fn(async (_session: string) => {});
  const interrupt = vi.fn();
  const run = vi.fn(async (..._args: unknown[]) => {});
  const models = vi.fn(async (): Promise<AccountModel[]> => []);
  const receiveEffect = runBridgeEffect(
    createPacketReceiver({
      request: () => Effect.void,
      capabilitySettings: capabilities.settings,
      integrationState: capabilities.integrations,
      engine: { end },
      cancel,
      models: { models: Effect.promise(() => models()) },
      routineStore: new RoutineStore(database),
      panelStore: new PanelStore(database),
      memoryRepository: { read: () => Effect.succeed([]), update: () => Effect.succeed([]) },
      catalog: { refresh: Effect.void },
      setCapability: () => Effect.void,
      memorySnapshot: () => Effect.succeed({ status: 'available', entries: [] }),
      run,
      interrupt,
      runtime: 'unused',
      snapshot: { invalidate: Effect.void },
      ...overrides,
    }).pipe(Effect.provideService(SessionState, session)),
  );
  const receive = (packet: Parameters<typeof receiveEffect>[0]) =>
    runBridgeEffect(receiveEffect(packet));
  const state = () => current(session);
  return { state, receive, receiveEffect, cancel, end, interrupt, run, models };
}

test('Stop during first-turn model preparation prevents engine dispatch', async () => {
  const chat = newChat('chat', 'one');
  const session = sessionState({
    ...initialSession([chat]),
    activeTransport: 'one',
    activeChat: chat.id,
  });
  const state = () => current(session);
  let releasePreparation!: () => void;
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const prepare = vi.fn(() => preparation);
  const send = vi.fn(() => ({
    events: (async function* () {})(),
    result: Promise.resolve({ status: 'completed' as const }),
  }));
  const newSessionId = vi.fn(() => 'session');
  const engine = { newSessionId, send, end: vi.fn(async () => {}) };
  const capabilities = unsavedCapabilities();
  const run = runBridgeEffect(
    createTurnRunner({
      engine,
      models: {
        prepare,
        models: async () => [{ slug: 'model', displayName: 'Model', efforts: [] }],
        complete: vi.fn(async () => 'Unused title'),
      },
      capabilitySettings: capabilities.turnCapabilities,
      currentTransport: () => state().activeTransport,
      activeChat: () => state().activeChat,
      defaultModel: () => 'model',
      isReady: () => true,
      isStopping: () => false,
      accountBusy: () => false,
      isCurrent: (candidate) => state().chats.includes(candidate),
    }).pipe(Effect.provideService(SessionState, session)),
  );
  const { receive } = fixture(
    {
      engine,
      capabilitySettings: capabilities.settings,
      integrationState: capabilities.integrations,
      run,
      interrupt: run.interrupt,
      cancel: run.cancel,
    },
    session,
  );
  try {
    receive(
      gameEvent({
        type: 'say',
        session: 'one',
        chat: chat.id,
        text: 'Question',
        seq: 1,
        at: 1,
      }),
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledWith('model'));
    expect(chat.status).toBe('working');
    expect(chat.agentSession).toBeUndefined();
    expect(newSessionId).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    receive(gameEvent({ type: 'cancel', session: 'one', chat: chat.id, seq: 2, at: 2 }));
  } finally {
    releasePreparation();
    await run.drain();
  }
  expect(send).not.toHaveBeenCalled();
  expect(newSessionId).not.toHaveBeenCalled();
  expect(chat.status).toBe('cancelled');
});

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
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.run).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'old' }),
    'Hello',
    'message',
    undefined,
  );
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
  expect(f.run.mock.calls.at(-1)?.[3]).toMatchObject({ sections: { quests } });
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
  expect(f.run.mock.calls.at(-1)?.[3]).toMatchObject({ sections: { character } });
  const context = f.run.mock.calls.at(-1)?.[3] as { sections: { quests?: unknown } } | undefined;
  expect(context?.sections.quests).toBeUndefined();
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
  expect(f.run).not.toHaveBeenCalled();
});

test('deleting an active conversation prevents delayed messages from recreating it', async () => {
  const f = fixture();
  f.receive(gameEvent({ type: 'delete', session: 'one', chat: 'old', seq: 2, at: 2 }));
  f.receive(gameEvent({ type: 'say', session: 'one', chat: 'old', text: 'late', seq: 3, at: 3 }));
  expect(f.state().chats).toEqual([]);
  expect(f.end).toHaveBeenCalledTimes(1);
  expect(f.run).not.toHaveBeenCalled();
});

test('retry reuses the failed question and ignores retries while working', () => {
  const f = fixture();
  const chat = f.state().chats[0]!;
  chat.messages.push({ role: 'user', id: 'question', text: 'Which quest?' });
  chat.status = 'error';
  f.receive(gameEvent({ type: 'retry', chat: 'old', session: 'one', seq: 11, at: 1 }));
  expect(f.run).toHaveBeenCalledWith(chat, 'Which quest?', 'question', undefined);
  chat.status = 'working';
  f.receive(gameEvent({ type: 'retry', chat: 'old', session: 'one', seq: 12, at: 1 }));
  expect(f.run).toHaveBeenCalledTimes(1);
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
