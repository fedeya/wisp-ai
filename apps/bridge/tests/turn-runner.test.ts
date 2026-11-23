import { test, expect, vi } from 'vitest';
import type { Client } from 'eve/client';
import { createTurnRunner, endedOnUsageLimit } from '../src/agent/turn-runner.ts';
import { ChatGPTAuthError } from '../src/auth/chatgpt-auth.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { queryCharacterSections } from '../src/chat/context.ts';
import { projectChats } from '../src/chat/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';
import { SnapshotGate } from '../src/addon/snapshots.ts';
import { PRESENT_UI_TOOL } from '@wisp/protocol/reply-presentation';
import type { UsageTelemetry } from '../src/telemetry.ts';
import { ModelFailures, httpFailureKind } from '../src/models/model-failures.ts';

const noUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
const usageObserver = () => ({ observe: vi.fn(), usage: () => noUsage });

function fixture(
  titlesEnabled = true,
  telemetry?: Pick<UsageTelemetry, 'chat' | 'toolObserver' | 'usageObserver'>,
  idleTimeoutMs?: number,
  defaultModel = 'model',
  extra: Partial<Parameters<typeof createTurnRunner>[0]> = {},
) {
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
  const cancel = vi.fn(async () => {});
  const session = { id: 'eve', send, cancel };
  const client = {
    sessions: { create: vi.fn(async () => ({ session })), attach: () => session },
  } as unknown as Pick<Client, 'sessions'>;
  const models = vi.fn(async () => [{ slug: 'model', displayName: 'Model', efforts: ['medium'] }]);
  const prepare = vi.fn(async (_model: string) => {});
  const complete = vi.fn(
    async (_model: string, _instructions: string, _text: string, _signal: AbortSignal) =>
      'Generated title',
  );
  const isReady = vi.fn(() => true);
  const accountBusy = vi.fn(() => false);
  const hasProvider = vi.fn(() => true);
  const logger = { info: vi.fn(), error: vi.fn() };
  const flushSnapshot = vi.fn();
  const changed = vi.fn();
  const run = createTurnRunner({
    telemetry,
    client,
    models: { models, prepare, complete },
    capabilitySettings: {
      publish: async () => {},
      enabled: () => titlesEnabled,
      snapshot: () => [],
    },
    currentTransport: () => transport,
    activeChat: () => 'chat',
    defaultModel: () => defaultModel,
    isReady,
    isStopping: () => false,
    accountBusy,
    hasProvider,
    isCurrent: () => current,
    changed,
    logger,
    flushSnapshot,
    idleTimeoutMs,
    ...extra,
  });
  return {
    chat,
    run,
    send,
    cancel,
    client,
    models,
    prepare,
    complete,
    isReady,
    accountBusy,
    hasProvider,
    logger,
    flushSnapshot,
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
  expect(f.flushSnapshot).toHaveBeenCalledTimes(1);
  const timing = f.logger.info.mock.calls.find(
    ([fields]) => fields?.event === 'chat.turn_timing',
  )?.[0];
  expect(timing.firstTextMs).toBeGreaterThanOrEqual(0);
  await f.run.drain();
});

test('a chat starts on the first available model when no default is known yet', async () => {
  const f = fixture(false, undefined, undefined, '');
  await f.run(f.chat, 'Question');
  expect(f.chat.status).toBe('done');
  expect(f.prepare).toHaveBeenCalledWith('model');
  expect(f.chat.modelSettings).toEqual({ model: 'model', effort: 'medium' });
  await f.run.drain();
});

test('a streamed comparison requests publication before the tool settles', async () => {
  const f = fixture();
  const state = createSessionState([f.chat]);
  state.activeChat = f.chat.id;
  const previews: string[] = [];
  f.flushSnapshot.mockImplementation(() => {
    const row = projectChats(state).chats[0].messages?.at(-1);
    if (row?.role === 'tool') {
      previews.push(row.text);
    }
  });
  let previewsBeforeSettlement: string[] = [];
  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {
      yield {
        type: 'content.delta',
        data: { partId: 'reply', kind: 'text', delta: 'I will compare the setups.' },
      };
      yield {
        type: 'call.input',
        data: {
          callId: 'comparison',
          name: PRESENT_UI_TOOL,
          delta: '{"nodes":[{"kind":"comparison"',
        },
      };
      previewsBeforeSettlement = [...previews];
      yield {
        type: 'call.settled',
        data: { callId: 'comparison', outcome: 'failed' },
      };
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  }));
  await f.run(f.chat, 'Compare my setups');
  expect(f.chat.status).toBe('done');
  expect(previewsBeforeSettlement).toEqual(['Creating comparison']);
  expect(projectChats(state).chats[0].messages?.some((m) => m.role === 'tool')).toBe(false);
});

test('real streamed turns report their mode, outcome and tool lifecycle to telemetry', async () => {
  const observe = vi.fn();
  const telemetry = { chat: vi.fn(), toolObserver: () => observe, usageObserver };
  const f = fixture(true, telemetry);
  f.chat.inline = true;
  await f.run(f.chat, 'Private question');
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ type: 'content.delta' }));
  const timing = f.logger.info.mock.calls.find(
    ([fields]) => fields?.event === 'chat.turn_timing',
  )?.[0];
  expect(timing.firstTextMs).toBeGreaterThanOrEqual(0);
  expect(telemetry.chat).toHaveBeenCalledWith(
    'hover',
    'completed',
    expect.any(Number),
    undefined,
    timing.firstTextMs,
    noUsage,
    {},
  );
  f.chat.inline = false;
  f.chat.routineId = 'private-routine-id';
  await f.run(f.chat, 'Private routine');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'routine',
    'completed',
    expect.any(Number),
    undefined,
    expect.any(Number),
    noUsage,
    {},
  );
});

test('chat telemetry distinguishes early failures before a turn reaches the engine', async () => {
  const telemetry = { chat: vi.fn(), toolObserver: () => vi.fn(), usageObserver };
  const f = fixture(true, telemetry);
  f.isReady.mockReturnValueOnce(false);
  f.accountBusy.mockReturnValueOnce(true);
  f.prepare.mockRejectedValueOnce(new ChatGPTAuthError('Private account details'));
  f.prepare.mockRejectedValueOnce(new Error('Private model details'));
  f.models.mockRejectedValueOnce(new Error('Private model catalog details'));

  for (const code of [
    'engine_not_ready',
    'account_busy',
    'model_auth_failed',
    'model_preparation_failed',
    'model_catalog_failed',
  ]) {
    await f.run(f.chat, 'Private question');
    expect(telemetry.chat).toHaveBeenLastCalledWith(
      'chat',
      'failed',
      expect.any(Number),
      code,
      undefined,
      noUsage,
      {},
    );
  }
  expect(f.send).not.toHaveBeenCalled();
});

test('chat telemetry distinguishes failed, timed-out and interrupted turns', async () => {
  const telemetry = { chat: vi.fn(), toolObserver: () => vi.fn(), usageObserver };
  const f = fixture(true, telemetry);
  f.send.mockRejectedValueOnce(Error('Private provider error'));
  await f.run(f.chat, 'Private question');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'turn_start_failed',
    undefined,
    noUsage,
    {},
  );

  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {},
    result: async () => ({
      status: 'failed',
      sessionEnded: false,
      error: { name: 'Error', code: 'private-provider-code', message: 'Private provider error' },
    }),
  }));
  await f.run(f.chat, 'Private question');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'turn_result_failed',
    undefined,
    noUsage,
    {},
  );

  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {},
    result: async () => ({
      status: 'failed',
      sessionEnded: false,
      error: { name: 'TimeoutError', code: 'unknown', message: 'Private provider error' },
    }),
  }));
  await f.run(f.chat, 'Private question');
  expect(f.chat.status).toBe('error');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'timeout',
    expect.any(Number),
    'timeout',
    undefined,
    noUsage,
    {},
  );

  f.send.mockImplementationOnce(async () => {
    f.run.interrupt(f.chat);
    throw new DOMException('Private provider error', 'TimeoutError');
  });
  await f.run(f.chat, 'Private question');
  expect(f.chat.status).toBe('interrupted');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'cancelled',
    expect.any(Number),
    undefined,
    undefined,
    noUsage,
    {},
  );
});

test('chat telemetry separates plan usage limits from other failures', async () => {
  const telemetry = { chat: vi.fn(), toolObserver: () => vi.fn(), usageObserver };
  const f = fixture(true, telemetry);
  f.send.mockImplementationOnce(async () => ({
    stream: async function* () {},
    result: async () => ({
      status: 'failed',
      sessionEnded: false,
      error: {
        name: 'Error',
        code: 'subscription_sharing_usage_limit_exceeded',
        message: 'Private plan details',
      },
    }),
  }));
  await f.run(f.chat, 'Private question');
  expect(f.chat.status).toBe('error');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'usage_limit',
    undefined,
    noUsage,
    {},
  );
  // Routines read this classification; the message alone does not mention a limit.
  expect(endedOnUsageLimit(f.chat)).toBe(true);

  f.send.mockRejectedValueOnce(Error('You exceeded your current quota, please check your plan.'));
  await f.run(f.chat, 'Private question');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'usage_limit',
    undefined,
    noUsage,
    {},
  );
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

test.each([
  { interval: 10, expectedPreviews: 2 },
  { interval: 100, expectedPreviews: 17 },
])(
  'source persistence retains preview coalescing throughout a reply ($interval ms)',
  async ({ interval, expectedPreviews }) => {
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
            vi.setSystemTime((index + 1) * interval);
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
      expect(previews).toBe(expectedPreviews);
      expect(completed).toBe(expectedPreviews + 1);
      expect(f.chat.status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  },
);

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
  const telemetry = { chat: vi.fn(), toolObserver: () => vi.fn(), usageObserver };
  const f = fixture(true, telemetry);
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
  const timing = f.logger.info.mock.calls.find(
    ([fields]) => fields?.event === 'chat.turn_timing',
  )?.[0];
  expect(timing).toBeDefined();
  expect(timing.firstTextMs).toBeUndefined();
  expect(telemetry.chat).toHaveBeenCalledWith(
    'chat',
    'completed',
    expect.any(Number),
    undefined,
    undefined,
    noUsage,
    {},
  );
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

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('names a new conversation beside the reply without delaying it', async () => {
  const f = fixture();
  const title = deferred<string>();
  f.complete.mockReturnValueOnce(title.promise);
  await f.run(f.chat, '  Ruta\n por Durotar  ');
  // The reply finished while the title was still pending.
  expect(f.chat.status).toBe('done');
  expect(f.chat.title).toBe('New conversation');
  expect(f.send.mock.calls[0][0]).not.toContain('needsTitle');
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.complete.mock.calls[0][0]).toBe('model');
  expect(f.complete.mock.calls[0][2]).toContain('Ruta\n por Durotar');
  title.resolve('"Ruta por Durotar."\nExtra line');
  await f.run.drain();
  expect(f.chat.title).toBe('Ruta por Durotar');
  expect(f.chat.titleGenerated).toBe(true);
  await f.run(f.chat, 'Otra pregunta');
  expect(f.complete).toHaveBeenCalledTimes(1);
});

test('a generated title never replaces a name chosen meanwhile', async () => {
  const f = fixture();
  const title = deferred<string>();
  f.complete.mockReturnValueOnce(title.promise);
  await f.run(f.chat, 'Ruta por Durotar');
  f.chat.title = 'Mi ruta';
  f.chat.titleGenerated = true;
  title.resolve('Ruta por Durotar');
  await f.run.drain();
  expect(f.chat.title).toBe('Mi ruta');
});

test('a failed title keeps the reply and is retried on a later turn', async () => {
  const f = fixture();
  f.complete.mockRejectedValueOnce(Error('Private provider error'));
  await f.run(f.chat, 'Hola');
  await f.run.drain();
  expect(f.chat.status).toBe('done');
  expect(f.chat.titleGenerated).not.toBe(true);
  expect(f.logger.info).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'chat.title_failed' }),
    expect.any(String),
  );
  await f.run(f.chat, 'Quiero una build de mago');
  await f.run.drain();
  expect(f.complete).toHaveBeenCalledTimes(2);
  expect(f.chat.title).toBe('Generated title');
});

test('does not automatically name inline or proactive conversations', async () => {
  for (const kind of ['inline', 'proactive'] as const) {
    const f = fixture();
    f.chat[kind] = true;
    await f.run(f.chat, 'A different title');
    await f.run.drain();
    expect(f.chat.title).toBe('New conversation');
    expect(f.complete).not.toHaveBeenCalled();
  }
});

test('disabled titles do not request automatic naming', async () => {
  const f = fixture(false);
  await f.run(f.chat, 'Help me choose talents');
  await f.run.drain();
  expect(f.chat.titleGenerated).not.toBe(true);
  expect(f.complete).not.toHaveBeenCalled();
});

test('a turn with no AI provider stops before the engine and explains the fix', async () => {
  const telemetry = { chat: vi.fn(), toolObserver: () => vi.fn(), usageObserver };
  const f = fixture(true, telemetry);
  f.hasProvider.mockReturnValueOnce(false);
  await f.run(f.chat, 'Private question');
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.chat.status).toBe('error');
  expect(f.chat.messages.at(-1)).toEqual({
    role: 'system',
    text: expect.stringContaining('connect ChatGPT or an API key'),
    notice: 'noProvider',
  });
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'no_provider',
    undefined,
    noUsage,
    {},
  );

  // Other failures keep their own message and carry no notice code.
  f.prepare.mockRejectedValueOnce(new Error('Model is no longer configured.'));
  await f.run(f.chat, 'Private question');
  expect(f.chat.messages.at(-1)).toEqual({
    role: 'system',
    text: 'Model is no longer configured.',
  });
});

test('a turn whose engine goes silent fails as a timeout and frees the engine session', async () => {
  const chats: { chat: string; outcome: string }[] = [];
  const f = fixture(
    true,
    {
      chat: (_mode, outcome) => chats.push({ chat: 'chat', outcome }),
      toolObserver: () => () => {},
      usageObserver,
    } as Pick<UsageTelemetry, 'chat' | 'toolObserver' | 'usageObserver'>,
    30,
  );
  f.send.mockResolvedValueOnce({
    stream: async function* (options?: { signal?: AbortSignal }) {
      yield { type: 'content.delta', data: { partId: 'reply', kind: 'text', delta: 'Hel' } };
      // The engine keeps the stream open but never sends another event.
      await new Promise<void>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(Error('Read aborted')), {
          once: true,
        });
      });
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  });
  await f.run(f.chat, 'Question');
  await f.run.drain();
  expect(f.chat.status).toBe('error');
  expect(f.chat.messages.at(-1)?.text).toMatch(/received nothing from the AI/);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.chat.eveId).toBeUndefined();
  expect(chats.at(-1)?.outcome).toBe('timeout');
});

test('steady engine activity keeps a long turn alive past the idle timeout', async () => {
  const f = fixture(true, undefined, 40);
  f.send.mockResolvedValueOnce({
    stream: async function* () {
      for (let index = 0; index < 5; index++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { type: 'content.delta', data: { partId: 'reply', kind: 'text', delta: 'a' } };
      }
    },
    result: async () => ({ status: 'completed', sessionEnded: false }),
  });
  await f.run(f.chat, 'Question');
  await f.run.drain();
  expect(f.chat.status).toBe('done');
  expect(f.cancel).not.toHaveBeenCalled();
});

test('chat telemetry names the provider and why its own model requests failed during the turn', async () => {
  const telemetry = { chat: vi.fn(), toolObserver: () => vi.fn(), usageObserver };
  const failures = new ModelFailures();
  const connection = '00000000-0000-4000-8000-000000000001';
  const model = 'connection:' + connection + ':private-model';
  const f = fixture(true, telemetry, undefined, model, {
    modelFailures: failures,
    modelProvider: (slug) => (slug === model ? 'google' : 'chatgpt'),
  });
  f.models.mockResolvedValue([{ slug: model, displayName: 'Private', efforts: ['medium'] }]);
  const failedTurn = async () => ({
    stream: async function* () {},
    result: async () => ({
      status: 'failed',
      sessionEnded: false,
      error: { name: 'Error', code: 'unknown', message: 'Private provider error' },
    }),
  });

  // A failure from an earlier turn is not this turn's cause.
  failures.record('eve', 'rate_limited');
  f.send.mockImplementationOnce(failedTurn);
  await f.run(f.chat, 'Private question');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'turn_result_failed',
    undefined,
    noUsage,
    { provider: 'google', failureKind: undefined },
  );

  f.send.mockImplementationOnce(async () => {
    failures.record('eve', httpFailureKind(404));
    // Another chat's failure on the same connection is not this turn's.
    failures.record('other-eve-session', 'rate_limited');
    return failedTurn();
  });
  await f.run(f.chat, 'Private question');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'failed',
    expect.any(Number),
    'turn_result_failed',
    undefined,
    noUsage,
    { provider: 'google', failureKind: 'not_found' },
  );

  // A retried request that later succeeded does not mark a completed turn.
  f.send.mockImplementationOnce(async () => {
    failures.record('eve', 'provider_error');
    return {
      stream: async function* () {},
      result: async () => ({ status: 'completed', sessionEnded: false }),
    };
  });
  await f.run(f.chat, 'Private question');
  expect(telemetry.chat).toHaveBeenLastCalledWith(
    'chat',
    'completed',
    expect.any(Number),
    undefined,
    undefined,
    noUsage,
    { provider: 'google', failureKind: undefined },
  );
});
