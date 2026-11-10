import { test, expect, vi } from 'vitest';
import type { Client } from 'eve/client';
import { createTurnRunner } from '../src/turn-runner.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import { queryCharacterSections } from '../src/context.ts';
import { projectChats } from '../src/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';
import { SnapshotGate } from '../src/snapshots.ts';
import { PRESENT_UI_TOOL } from '@wisp/protocol/reply-presentation';

function fixture(titlesEnabled = true) {
  const chat = newChat('chat', 'one');
  let transport = 'one';
  let current = true;
  const send = vi.fn(async (_input: string) => ({
    stream: async function* (): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
      yield {
        type: 'content.delta',
        data: { partId: 'reply', kind: 'text', delta: 'Hello' },
      };
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  }));
  const session = { id: 'eve', send };
  const client = {
    sessions: { create: vi.fn(async () => ({ session })), attach: () => session },
  } as unknown as Pick<Client, 'sessions'>;
  const models = vi.fn(async () => [{ slug: 'model', displayName: 'Model', efforts: ['medium'] }]);
  const log = vi.fn();
  const flushFirstText = vi.fn();
  const changed = vi.fn();
  const run = createTurnRunner({
    client,
    models: { models, prepare: async () => {} },
    capabilitySettings: {
      publish: async () => {},
      enabled: () => titlesEnabled,
      snapshot: () => [],
    },
    currentTransport: () => transport,
    activeChat: () => 'chat',
    defaultModel: () => 'model',
    isReady: () => true,
    isStopping: () => false,
    accountBusy: () => false,
    isCurrent: () => current,
    changed,
    log,
    flushFirstText,
  });
  return {
    chat,
    run,
    send,
    client,
    models,
    log,
    flushFirstText,
    changed,
    changeCharacter: () => {
      transport = 'two';
    },
    deleteChat: () => {
      current = false;
    },
  };
}

test('a complete turn projects streamed content and settles once', async () => {
  const f = fixture();
  await f.run(f.chat, 'Question');
  expect(f.chat.status).toBe('done');
  expect(
    f.chat.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.text)
      .join(''),
  ).toBe('Hello');
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.flushFirstText).toHaveBeenCalledTimes(1);
  const timing = JSON.parse(
    String(f.log.mock.calls.find(([line]) => line.startsWith('Turn timing: '))?.[0]).slice(
      'Turn timing: '.length,
    ),
  );
  expect(timing.firstTextMs).toBeGreaterThanOrEqual(0);
  await f.run.drain();
});

test('plain source schedules persistence before a reply can be rendered', async () => {
  const f = fixture();
  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {
      const before = f.changed.mock.calls.length;
      yield {
        type: 'content.delta',
        data: { partId: 'reply', kind: 'text', delta: 'Primera parte' },
      };
      expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
        'Primera parte',
      );
      expect(f.changed.mock.calls.length).toBeGreaterThan(before);
      expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
        'Primera parte',
      );
      yield {
        type: 'content.completed',
        data: { partId: 'reply', kind: 'text', value: 'Primera parte completa' },
      };
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  }));
  await f.run(f.chat, 'Question');
  expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
    'Primera parte completa',
  );
  expect(f.send).toHaveBeenCalledTimes(1);
});

test('source persistence through the runner retains time-based preview coalescing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const f = fixture();
    const state = createSessionState([f.chat]);
    state.activeChat = f.chat.id;
    const gate = new SnapshotGate();
    let publications = 0,
      previews = 0,
      completed = 0;
    f.changed.mockImplementation(() => {
      const snapshot = gate.next(projectChats(state));
      if (snapshot) {
        publications++;
        expect(JSON.stringify(snapshot)).not.toContain('rawReply');
      }
    });
    const delta = 'a';
    f.send.mockImplementationOnce(async () => ({
      stream: async function* () {
        const baseline = publications;
        for (let index = 0; index < 100; index++) {
          vi.setSystemTime((index + 1) * 10);
          const changes = f.changed.mock.calls.length;
          yield {
            type: 'content.delta',
            data: { partId: 'reply', kind: 'text', delta },
          };
          expect(f.changed.mock.calls.length).toBeGreaterThan(changes);
        }
        expect(f.chat.messages.find((message) => message.id === 'text-reply')?.text).toBe(
          delta.repeat(100),
        );
        previews = publications - baseline;
        yield {
          type: 'content.completed',
          data: { partId: 'reply', kind: 'text', value: delta.repeat(100) },
        };
        completed = publications - baseline;
        expect(projectChats(state).chats[0].messages?.at(-1)?.text).toBe('a'.repeat(100));
      },
      result: async () => ({ status: 'completed', sessionEnded: false }),
    }));
    await f.run(f.chat, 'Question');
    expect(previews).toBe(2);
    expect(completed).toBe(3);
    expect(f.chat.status).toBe('done');
  } finally {
    vi.useRealTimers();
  }
});

test('the active runner accepts presentation RPCs and rejects them after the turn', async () => {
  const f = fixture();
  const panel = {
    nodes: [{ id: 'level', kind: 'stat' as const, label: 'Level', value: '10' }],
    references: {},
  };
  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {
      // The local RPC may arrive before its requested event reaches the bridge.
      const accepted = f.run.present(f.chat, 'ui', panel, new AbortController().signal);
      yield { type: 'turn.started', data: { turnId: 'turn' } };
      yield {
        type: 'call.requested',
        data: { callId: 'ui', capability: { name: PRESENT_UI_TOOL, kind: 'tool' } },
      };
      const output = await accepted;
      expect(f.chat.messages.at(-1)?.ui).toEqual([]);
      yield { type: 'call.settled', data: { callId: 'ui', outcome: 'completed', output } };
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  }));
  await f.run(f.chat, 'Question');
  expect(f.chat.messages.at(-1)?.ui).toEqual(panel.nodes);
  expect(f.chat.activity).toEqual([]);
  await expect(f.run.present(f.chat, 'late', panel, new AbortController().signal)).rejects.toThrow(
    'no longer active',
  );
});

test.each(['character', 'delete', 'interrupt'] as const)(
  'a %s change rejects a presentation awaiting its requested event',
  async (change) => {
    const f = fixture();
    let rejected: Promise<void> | undefined;
    const panel = {
      nodes: [{ id: 'level', kind: 'stat' as const, label: 'Level', value: '10' }],
      references: {},
    };
    f.send.mockImplementationOnce(async () => ({
      stream: async function* () {
        const accepted = f.run.present(f.chat, 'ui', panel, new AbortController().signal);
        rejected = expect(accepted).rejects.toThrow();
        if (change === 'character') {
          f.changeCharacter();
        } else if (change === 'delete') {
          f.deleteChat();
        } else {
          f.run.interrupt(f.chat);
        }
        yield {
          type: 'call.requested',
          data: { callId: 'ui', capability: { name: PRESENT_UI_TOOL, kind: 'tool' } },
        };
      },
      result: async () => ({ status: 'completed', sessionEnded: false }),
    }));
    await f.run(f.chat, 'Question');
    await rejected;
    expect(f.chat.messages.some((message) => message.ui?.length)).toBe(false);
    expect(f.chat.status).toBe('interrupted');
  },
);

test('old assistant messages cannot count as the first text of a new turn', async () => {
  const f = fixture();
  f.chat.messages.push({ role: 'assistant', text: 'Previous answer' });
  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {
      yield {
        type: 'call.requested',
        data: {
          callId: 'call',
          capability: { name: 'wow__query_character', kind: 'tool', label: 'Reading quests' },
        },
      };
      yield { type: 'call.settled', data: { callId: 'call', outcome: 'completed' } };
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  }));
  await f.run(f.chat, 'Next question');
  const timing = JSON.parse(
    String(f.log.mock.calls.find(([line]) => line.startsWith('Turn timing: '))?.[0]).slice(
      'Turn timing: '.length,
    ),
  );
  expect(timing).not.toHaveProperty('firstTextMs');
});

test('a turn keeps its quest reading available to tools without inserting it into model input', async () => {
  const f = fixture();
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
  await f.run(f.chat, 'What next?', 'message', context);
  expect(f.send.mock.calls[0]?.[0]).not.toContain('Private delivery');
  const live = vi.fn(async () => ({ sections: {} }));
  expect(JSON.stringify(await queryCharacterSections(f.chat, ['quests'], live))).toContain(
    'Private delivery',
  );
  expect(live).not.toHaveBeenCalled();
  await f.run(f.chat, 'Another question', 'message2', undefined);
  await queryCharacterSections(f.chat, ['quests'], live);
  expect(live).toHaveBeenCalledTimes(1);
});

test.each(['character', 'delete'] as const)(
  'a %s change while resolving model settings cannot start an obsolete turn',
  async (change) => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.models.mockImplementationOnce(async () => {
      await gate;
      return [{ slug: 'model', displayName: 'Model', efforts: ['medium'] }];
    });
    const turn = f.run(f.chat, 'Question');
    await vi.waitFor(() => expect(f.models).toHaveBeenCalled());
    if (change === 'character') {
      f.changeCharacter();
    } else {
      f.deleteChat();
    }
    release();
    await turn;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.chat.status).toBe('interrupted');
  },
);

test('interrupting a delivery aborts its stream and drains the runner', async () => {
  const f = fixture();
  let reading = false;
  f.send.mockResolvedValueOnce({
    stream: async function* (options?: { signal?: AbortSignal }) {
      reading = true;
      await new Promise<void>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(Error('Read aborted')), {
          once: true,
        });
      });
      yield { type: 'unused', data: {} };
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  });
  const turn = f.run(f.chat, 'Question');
  await vi.waitFor(() => expect(reading).toBe(true));
  f.run.interrupt(f.chat);
  await turn;
  await f.run.drain();
  expect(f.chat.status).toBe('interrupted');
});

test('retry after failure restores history without duplicating the user message', async () => {
  const f = fixture();
  await f.run(f.chat, 'Earlier question', 'earlier');
  f.send.mockRejectedValueOnce(new Error('Provider unavailable'));
  await f.run(f.chat, 'Explain that quest', 'failed');
  expect(f.chat.status).toBe('error');
  expect(f.chat.eveId).toBeUndefined();
  await f.run(f.chat, 'Explain that quest', 'failed');
  expect(f.chat.status).toBe('done');
  expect(f.chat.messages.filter((m) => m.id === 'failed')).toHaveLength(1);
  const input = f.send.mock.calls.at(-1)![0];
  expect(input).toContain('Earlier question');
  expect(input).toContain('Explain that quest');
  expect(f.client.sessions.create).toHaveBeenCalledTimes(2);
});

test('a follow-up after failure includes the failed question in restored history', async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error('Provider unavailable'));
  await f.run(f.chat, 'Explain that quest', 'failed');
  await f.run(f.chat, 'Try that again', 'follow-up');
  expect(f.send.mock.calls.at(-1)![0]).toContain('Explain that quest');
});

test('requests an AI title without copying the first message and keeps explicit names', async () => {
  const f = fixture();
  const pending = f.run(f.chat, '  Ruta\n por Durotar  ');
  expect(f.chat.title).toBe('New conversation');
  expect(f.chat.titleGenerated).not.toBe(true);
  expect(f.send).not.toHaveBeenCalled();
  await pending;
  expect(f.send.mock.calls[0][0]).toContain('"needsTitle":true');
  f.chat.title = 'Mi ruta';
  f.chat.titleGenerated = true;
  await f.run(f.chat, 'Otra pregunta');
  expect(f.chat.title).toBe('Mi ruta');
  expect(f.send.mock.calls.at(-1)![0]).not.toContain('needsTitle');
});

test('does not automatically name inline or proactive conversations', async () => {
  for (const kind of ['inline', 'proactive'] as const) {
    const f = fixture();
    f.chat[kind] = true;
    await f.run(f.chat, 'A different title');
    expect(f.chat.title).toBe('New conversation');
    expect(f.send.mock.calls[0][0]).not.toContain('needsTitle');
  }
});

test('disabled titles do not request automatic naming', async () => {
  const f = fixture(false);
  await f.run(f.chat, 'Help me choose talents');
  expect(f.chat.titleGenerated).not.toBe(true);
  expect(f.send.mock.calls[0][0]).not.toContain('needsTitle');
});

test('an unnamed greeting can receive a title on a later turn', async () => {
  const f = fixture();
  await f.run(f.chat, 'Hola');
  await f.run(f.chat, 'Quiero una build de mago');
  expect(f.send.mock.calls.at(-1)![0]).toContain('"needsTitle":true');
});
