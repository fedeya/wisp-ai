import { test, expect, vi } from 'vitest';
import type { Client } from 'eve/client';
import { createPacketReceiver } from '../src/packet-receiver.ts';
import { createSessionState } from '../src/session-state.ts';
import { GameRequests } from '../src/game-requests.ts';
import { CapabilitySettings } from '../src/capabilities.ts';
import { IntegrationState } from '../src/integration-state.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { RoutineStore } from '../src/routines.ts';
import { ApplicationDatabase } from '../src/db/application-database.ts';
import { PanelStore } from '../src/panels.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import { packetSchema } from '@wisp/protocol/protocol';
import type { AccountModel } from '../src/chat-model.ts';

function fixture() {
  const database = new ApplicationDatabase('unused');
  const chat = { ...newChat('old', 'one'), eveId: 'eve', status: 'working' as const };
  const state = createSessionState([chat]);
  state.activeTransport = 'one';
  state.currentCharacterKey = 'old-character';
  state.inlineChat = 'old-inline';
  state.panelCommand = { seq: 1, id: 'panel', characterKey: 'old-character', action: 'show' };
  const pending = new GameRequests(() => {});
  const capabilitySettings = new CapabilitySettings('unused');
  const cancel = vi.fn(async () => {});
  const end = vi.fn(async () => {});
  const interrupt = vi.fn();
  const run = vi.fn(async (..._args: unknown[]) => {});
  const models = vi.fn(async (): Promise<AccountModel[]> => []);
  const flushAcknowledgment = vi.fn();
  const addonLogger = { info: vi.fn() };
  const receive = createPacketReceiver({
    state,
    pending,
    capabilitySettings,
    integrationState: new IntegrationState(capabilitySettings),
    client: { sessions: { attach: () => ({ cancel, end }) } } as unknown as Pick<
      Client,
      'sessions'
    >,
    models: { models },
    routineStore: new RoutineStore(database),
    panelStore: new PanelStore(database),
    memoryStore: new MemoryStore(database),
    transport: () => ({ resetSession: () => {}, setCursor: () => {} }),
    refreshModelCatalog: async () => {},
    setCapability: async () => {},
    memorySnapshot: async () => ({ status: 'available', entries: [] }),
    run,
    interrupt,
    runtime: 'unused',
    changed: () => {},
    flushAcknowledgment,
    logger: { warn: vi.fn() },
    addonLogger,
  });
  return {
    state,
    pending,
    receive,
    cancel,
    end,
    interrupt,
    run,
    models,
    flushAcknowledgment,
    addonLogger,
  };
}

test('leaving a new empty conversation discards it while keeping conversations with activity', () => {
  const f = fixture();
  f.receive(packetSchema.parse({ type: 'new', chat: 'draft', session: 'one', seq: 20, at: 1 }));
  expect(f.state.chats.some((chat) => chat.id === 'draft')).toBe(true);
  f.receive(packetSchema.parse({ type: 'select', chat: 'old', session: 'one', seq: 21, at: 2 }));
  expect(f.state.chats.map((chat) => chat.id)).toEqual(['old']);
  f.receive(packetSchema.parse({ type: 'new', chat: 'used', session: 'one', seq: 22, at: 3 }));
  f.state.chats.find((chat) => chat.id === 'used')!.messages.push({ role: 'user', text: 'Hi' });
  f.receive(packetSchema.parse({ type: 'new', chat: 'next', session: 'one', seq: 23, at: 4 }));
  expect(f.state.chats.map((chat) => chat.id)).toEqual(['old', 'used', 'next']);
});

test('interactive receipt requests an immediate acknowledgement publish, including duplicate retries', () => {
  const f = fixture();
  const packet = packetSchema.parse({
    type: 'say',
    chat: 'old',
    session: 'one',
    seq: 11,
    at: 1,
    text: 'Hello',
    messageId: 'message',
  });
  f.receive(packet);
  f.receive(packet);
  expect(f.flushAcknowledgment).toHaveBeenCalledTimes(2);
  expect(f.state.acknowledgments).toContain(11);
  expect(f.run).toHaveBeenCalledTimes(1);
});

test('delivery and visible text can be correlated using the addon message ID', () => {
  const f = fixture();
  const delivery = { messageId: 'message', ms: 40, queueMs: 5, retries: 1 };
  const envelope = { session: 'one', at: 1 };
  f.receive(packetSchema.parse({ ...envelope, type: 'poll', seq: 1, transport: { delivery } }));
  f.receive(packetSchema.parse({ ...envelope, type: 'poll', seq: 2, transport: { delivery } }));
  f.receive(
    packetSchema.parse({
      ...envelope,
      type: 'inline_status',
      seq: 3,
      data: { event: 'first_text', messageId: 'message', totalMs: 240, afterSendingMs: 200 },
    }),
  );
  expect(f.addonLogger.info.mock.calls.map(([fields]) => fields)).toEqual([
    { event: 'addon.message_delivery', ...delivery },
    {
      event: 'addon.first_text',
      messageId: 'message',
      totalMs: 240,
      afterSendingMs: 200,
    },
  ]);
});

test('transport profiles log allowlisted timings and handle empty Lua tables', () => {
  const f = fixture();
  const frames = { count: 3, mean: 11, max: 14, p95: 14 };
  const profile = {
    event: 'transport_profile',
    label: 'private fixture',
    elapsedMs: 2000,
    frames,
    work: { reset: frames, unexpected: 'private fixture' },
    downlinkResyncs: 1,
  };
  const envelope = { type: 'inline_status', session: 'one', at: 1 };
  f.receive(packetSchema.parse({ ...envelope, seq: 1, data: profile }));
  f.receive(packetSchema.parse({ ...envelope, seq: 2, data: { ...profile, work: [] } }));
  f.receive(packetSchema.parse({ ...envelope, seq: 3, data: { ...profile, elapsedMs: -1 } }));
  const expected = {
    event: 'addon.transport_profile',
    elapsedMs: 2000,
    frames,
    work: { reset: frames },
    downlinkResyncs: 1,
  };
  expect(f.addonLogger.info.mock.calls.map(([fields]) => fields)).toEqual([
    expected,
    { ...expected, work: {} },
  ]);
});

test('quest sync primes turn context but a new addon session cannot reuse its revision', () => {
  const f = fixture();
  f.state.chats[0]!.status = 'done';
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
    packetSchema.parse({
      type: 'quest_sync',
      session: 'one',
      seq: 10,
      at: 1,
      context: { questRevision: 1, sections: { character, quests } },
    }),
  );
  f.receive(
    packetSchema.parse({
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
  f.receive(packetSchema.parse({ type: 'hello', session: 'two', seq: 1, at: 3 }));
  f.receive(
    packetSchema.parse({
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

test('changing native models resets provider history while preserving the visible chat', async () => {
  const f = fixture();
  const chat = f.state.chats[0]!;
  chat.status = 'done';
  chat.modelSettings = { model: 'chatgpt-model', effort: 'medium' };
  chat.messages.push({ role: 'user', text: 'Keep this conversation' });
  const first = 'connection:35302f8c-128a-48fb-98a1-9eb03bb71f72:anthropic/claude';
  const second = 'connection:35302f8c-128a-48fb-98a1-9eb03bb71f72:google/gemini';
  f.models.mockResolvedValue(
    [first, second].map((slug) => ({ slug, displayName: slug, efforts: [] })),
  );
  f.receive(
    packetSchema.parse({
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
  expect(chat.eveId).toBeUndefined();
  expect(chat.messages[0]?.text).toBe('Keep this conversation');
  chat.eveId = 'native-session';
  f.receive(
    packetSchema.parse({
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
  expect(chat.eveId).toBeUndefined();
  expect(f.end).toHaveBeenCalledTimes(2);
});

test('reload interrupts old turns, rejects outstanding reads and clears character-specific commands', async () => {
  const f = fixture();
  const request = f.pending.request({ chat: 'old', session: 'one' });
  const rejection = expect(request).rejects.toThrow('reloaded');
  f.receive(packetSchema.parse({ type: 'hello', session: 'two', seq: 1, at: 1 }));
  await rejection;
  expect(f.state.chats[0].status).toBe('interrupted');
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  expect(f.state.currentCharacterKey).toBeUndefined();
  expect(f.state.panelCommand).toBeUndefined();
  expect(f.state.inlineChat).toBe('');
  expect(f.pending.snapshot()).toEqual([]);
  f.receive(
    packetSchema.parse({ type: 'say', session: 'one', chat: 'old', text: 'stale', seq: 2, at: 2 }),
  );
  expect(f.run).not.toHaveBeenCalled();
});

test('deleting an active conversation cancels its requests and prevents delayed messages from recreating it', async () => {
  const f = fixture();
  const request = f.pending.request({ chat: 'old', session: 'one' });
  const rejection = expect(request).rejects.toThrow('deleted');
  f.receive(packetSchema.parse({ type: 'delete', session: 'one', chat: 'old', seq: 2, at: 2 }));
  await rejection;
  f.receive(
    packetSchema.parse({ type: 'say', session: 'one', chat: 'old', text: 'late', seq: 3, at: 3 }),
  );
  expect(f.state.chats).toEqual([]);
  expect(f.end).toHaveBeenCalledTimes(1);
  expect(f.run).not.toHaveBeenCalled();
});

test('retry reuses the failed question and ignores retries while working', () => {
  const f = fixture();
  const chat = f.state.chats[0]!;
  chat.messages.push({ role: 'user', id: 'question', text: 'Which quest?' });
  chat.status = 'error';
  f.receive(packetSchema.parse({ type: 'retry', chat: 'old', session: 'one', seq: 11, at: 1 }));
  expect(f.run).toHaveBeenCalledWith(chat, 'Which quest?', 'question', undefined);
  chat.status = 'working';
  f.receive(packetSchema.parse({ type: 'retry', chat: 'old', session: 'one', seq: 12, at: 1 }));
  expect(f.run).toHaveBeenCalledTimes(1);
});
