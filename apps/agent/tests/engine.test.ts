import { afterEach, expect, test } from 'vitest';
import { Effect, Layer, Logger, References } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as Game from '../src/host/game-access.ts';
import * as Memory from '../src/host/memory.ts';
import * as Capabilities from '../src/host/capabilities.ts';
import * as Mcp from '../src/integrations/mcp-tools.ts';
import * as Everloot from '../src/integrations/everloot.ts';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { setAgentHost } from '../src/host/agent-host.ts';
import {
  compactionSplit,
  make,
  layer as agentLayer,
  EngineConfig,
  HistoryError,
  SessionHistory,
  searchTools,
  type EngineEvent,
  type Entry,
  type TurnInput,
} from '../src/engine.ts';
import * as MemoryHistory from '../src/session/memory-history.ts';
import { gate } from './gate.ts';

afterEach(() => setAgentHost(undefined));

type Item = Record<string, unknown>;
const toolCall = (count: number, name: string, input: unknown): Item => ({
  id: 'tool-item-' + count,
  type: 'function_call',
  call_id: 'tool-call-' + count,
  status: 'completed',
  name,
  arguments: JSON.stringify(input),
});
const message = (count: number, text: string): Item => ({
  id: 'message-' + count,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

// An OpenAI Responses stream with one output item.
function streamed(count: number, item: Item) {
  const body =
    item.type === 'function_call'
      ? [
          {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
        ]
      : [
          {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            delta: (item.content as { text: string }[])[0]!.text,
          },
        ];
  const response = { id: 'response-' + count, model: 'offline-test', created_at: 1 };
  return [
    { type: 'response.created', response },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] },
    },
    ...body,
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { ...response, output: [item], usage: { input_tokens: 20, output_tokens: 10 } },
    },
  ]
    .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
    .join('');
}

async function fixture(
  plan: (count: number, request: Item) => Item | undefined,
  contextWindow?: number,
  options: {
    appendFails?: (count: number) => boolean;
    beforeAppend?: (entries: readonly Entry[]) => Promise<void>;
    logging?: Layer.Layer<never>;
    /** Game reads answer after this long, for a turn stopped while a tool runs. */
    inspectDelayMs?: number;
  } = {},
) {
  let appends = 0;
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-engine-'));
  const flags = path.join(root, 'capabilities.json');
  await writeFile(
    flags,
    JSON.stringify({
      enabled: {
        ...Object.fromEntries(defaultCapabilities().map((capability) => [capability.id, false])),
        'mcp:everloot': false,
        'tool:get_settings': true,
        'tool:query_character': true,
      },
    }),
  );
  const requests: Item[] = [];
  const inspections: Item[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    if (req.headers.authorization !== 'Bearer offline-token') {
      res.writeHead(401).end();
      return;
    }
    const json = (value: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url?.startsWith('/session-model?')) {
      json({ model: 'offline-test', effort: 'provider-default', contextWindow });
    } else {
      const request = JSON.parse(body) as Item;
      requests.push(request);
      const item = plan(requests.length, request);
      if (!item) {
        // A request the provider rejects, which the AI SDK does not retry.
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Rejected', type: 'invalid_request_error' } }));
      } else if (request.stream) {
        res
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(streamed(requests.length, item));
      } else {
        json({
          id: 'response-' + requests.length,
          model: 'offline-test',
          created_at: 1,
          output: [item],
          usage: { input_tokens: 20, output_tokens: 10 },
        });
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  setAgentHost({ origin, token: 'offline-token', capabilitiesFile: flags });
  // An in-memory log with the bridge store's rules: entries stay, compactions are entries.
  const memory = Effect.runSync(MemoryHistory.make);
  const store = SessionHistory.HistoryStore.of({
    ...memory,
    append: (session, entries, model) =>
      Effect.gen(function* () {
        if (options.appendFails?.(++appends)) {
          return yield* new HistoryError({
            operation: 'append',
            cause: Error('The disk is full.'),
          });
        }
        const beforeAppend = options.beforeAppend;
        if (beforeAppend) yield* Effect.promise(() => beforeAppend(entries));
        yield* memory.append(session, entries, model);
      }),
  });
  const history = {
    append: (session: string, entries: readonly Entry[], model: string) =>
      Effect.runPromise(store.append(session, entries, model)),
    entries: (session: string) => Effect.runSync(memory.entries(session)),
    has: (session: string) => Effect.runSync(memory.has(session)),
  };
  const messagesOf = (session: string) =>
    history.entries(session).filter(({ entry }) => entry.type !== 'compaction');
  const compactionsOf = (session: string) =>
    history.entries(session).filter(({ entry }) => entry.type === 'compaction');
  const gameAccess = Game.Service.of({
    ...Game.unavailableGameAccess,
    readSettings: (agentSession, args) =>
      Effect.gen(function* () {
        inspections.push({ agentSession, inspection: { kind: 'settings', args } });
        if (options.inspectDelayMs) yield* Effect.sleep(options.inspectDelayMs);
        return {
          status: 'available' as const,
          data: { applications: [], options: [], verified: true },
        };
      }),
  });
  const engine = make(
    agentLayer.pipe(
      Layer.provide(
        SessionHistory.layer.pipe(Layer.provide(Layer.succeed(SessionHistory.HistoryStore, store))),
      ),
      Layer.provide(Layer.succeed(Game.Service, gameAccess)),
      Layer.provide(
        Layer.succeed(Memory.Service, {
          characterKey: () => Effect.succeed(null),
          read: () => Effect.succeed([]),
          update: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.succeed(EngineConfig, { origin: () => origin, token: 'offline-token' })),
      Layer.provide(Mcp.layer([Everloot.profile])),
      Layer.provide(Capabilities.layerFromFile(() => flags)),
      Layer.provide(NodeFileSystem.layer),
      Layer.provideMerge(options.logging ?? Logger.layer([])),
    ),
  );
  async function send(
    session: string,
    input: string | TurnInput,
    onEvent: (event: EngineEvent) => void = () => {},
    signal = AbortSignal.timeout(30_000),
  ) {
    const turn = engine.send(
      session,
      typeof input === 'string' ? { text: input } : input,
      signal,
      'chat',
    );
    const events: EngineEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
      onEvent(event);
    }
    return { events, result: await turn.result };
  }
  return {
    engine,
    send,
    requests,
    inspections,
    history,
    messagesOf,
    compactionsOf,
    session: (session: string) => Effect.runSync(memory.session(session)),
    close: async () => {
      server.close();
      await engine.close();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const userEntry = (text: string): Entry => ({ type: 'user', content: [{ type: 'text', text }] });
const assistantEntry = (text: string): Entry => ({
  type: 'assistant',
  content: [{ type: 'text', text }],
  time: { created: 0 },
});

const toolNames = (request: Item) => (request.tools as { name: string }[]).map((tool) => tool.name);

test(
  'skills, deferred tools and history run through bridge events with a stable tool list',
  {
    timeout: 60_000,
  },
  async () => {
    const f = await fixture((count) =>
      count === 1
        ? toolCall(count, 'skill', { name: 'settings' })
        : count === 2
          ? toolCall(count, 'tool_search', { query: 'settings addons cvars' })
          : count === 3
            ? toolCall(count, 'tool_call', { name: 'wow__get_settings', input: {} })
            : count === 4
              ? message(count, 'Offline integration passed.')
              : count === 5
                ? toolCall(count, 'wisp__skip_tip', {})
                : message(count, 'Should not be reached.'),
    );
    try {
      const session = f.engine.newSessionId();
      const first = await f.send(session, 'Which addons do I have?');
      expect(first.result).toEqual({ status: 'completed' });

      // Deferred tools stay behind tool_search/tool_call, so the list never changes.
      const tools = toolNames(f.requests[0]!);
      expect(tools).toEqual(
        expect.arrayContaining(['tool_search', 'tool_call', 'skill', 'wisp__present_ui']),
      );
      expect(tools).not.toContain('wow__get_settings');
      expect(f.requests.slice(0, 4).map(toolNames)).toEqual(Array(4).fill(tools));
      expect(JSON.stringify(f.requests[1]!.input)).toContain('To change a setting');
      expect(JSON.stringify(f.requests[2]!.input)).toContain('wow__get_settings');
      // The tool reached the bridge under this session, with schema defaults applied.
      expect(f.inspections).toEqual([
        expect.objectContaining({
          agentSession: session,
          inspection: expect.objectContaining({ kind: 'settings' }),
        }),
      ]);

      // A deferred call is reported as the tool it ran; meta tools are control calls.
      const requested = first.events
        .filter((event) => event.type === 'call.requested')
        .map((event) => event.data.capability);
      expect(requested).toEqual([
        expect.objectContaining({ name: 'skill', kind: 'control' }),
        expect.objectContaining({ name: 'tool_search', kind: 'control' }),
        { name: 'wow__get_settings', label: 'Reading settings', kind: 'tool' },
      ]);
      expect(first.events).toContainEqual({
        type: 'call.settled',
        data: expect.objectContaining({
          callId: 'tool-call-3',
          outcome: 'completed',
          label: 'Read settings',
        }),
      });
      expect(first.events).toContainEqual({
        type: 'content.completed',
        data: expect.objectContaining({ kind: 'text', value: 'Offline integration passed.' }),
      });
      expect(first.events.filter((event) => event.type === 'usage.recorded')).toHaveLength(4);
      // The session belongs to its chat, and each model step's tokens add to its totals.
      expect(f.session(session)).toMatchObject({
        chatId: 'chat',
        inputTokens: 80,
        outputTokens: 40,
      });

      // The next turn resends the stored history, tool calls included, and an
      // endsTurn tool finishes it without another model step.
      const second = await f.send(session, 'Any tip?');
      expect(second.result).toEqual({ status: 'completed' });
      expect(f.requests).toHaveLength(5);
      const history = JSON.stringify(f.requests[4]!.input);
      expect(history).toContain('Which addons do I have?');
      expect(history).toContain('tool-call-3');
      expect(history).toContain('Offline integration passed.');
      // Each step is one assistant entry, its tool calls carrying their results.
      expect(f.messagesOf(session).map(({ entry }) => entry.type)).toEqual([
        'user',
        'assistant',
        'assistant',
        'assistant',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(f.messagesOf(session)[3]!.entry).toMatchObject({
        type: 'assistant',
        finish: 'tool-calls',
        tokens: { input: 20, output: 10 },
        content: [
          {
            type: 'tool',
            id: 'tool-call-3',
            name: 'tool_call',
            state: { status: 'completed', input: { name: 'wow__get_settings' } },
          },
        ],
      });
      expect(f.messagesOf(session).at(-1)!.entry).toMatchObject({
        type: 'assistant',
        content: [{ type: 'tool', name: 'wisp__skip_tip', state: { status: 'completed' } }],
      });

      await f.engine.end(session);
      expect(f.history.has(session)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test(
  'a long history is compacted into a summary before the turn',
  { timeout: 60_000 },
  async () => {
    const f = await fixture(
      (count, request) =>
        message(count, request.stream ? 'Answer after compaction.' : 'Summary of the quest plan.'),
      2000,
    );
    try {
      const session = f.engine.newSessionId();
      const turns: Entry[] = [];
      for (let index = 0; index < 6; index++) {
        turns.push(userEntry('Question ' + index + ' ' + 'x'.repeat(1500)));
        turns.push(assistantEntry('Answer ' + index));
      }
      await f.history.append(session, turns, 'gpt-test');
      const { events, result } = await f.send(session, 'Next question');
      expect(result).toEqual({ status: 'completed' });
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['context.started', 'context.settled']),
      );
      expect(events.find((event) => event.type === 'context.settled')!.data).toEqual({
        kind: 'compaction',
        outcome: 'completed',
      });
      // The compaction is a log entry: every message stays, this turn's included.
      expect(f.compactionsOf(session)).toEqual([
        {
          entry: { type: 'compaction', keptFrom: 4, summary: 'Summary of the quest plan.' },
          model: expect.any(String),
        },
      ]);
      const stored = f.messagesOf(session);
      expect(stored).toHaveLength(14);
      expect(f.history.entries(session)[12]!.entry.type).toBe('compaction');
      expect(JSON.stringify(stored)).toContain('Question 1 ');
      expect(JSON.stringify(stored.at(-1))).toContain('Answer after compaction.');
      // The model reads the summary, then the four most recent turns.
      const sent = JSON.stringify(f.requests.at(-1)!.input);
      expect(sent).toContain('<conversation_summary>');
      expect(sent).toContain('Summary of the quest plan.');
      expect(sent).toContain('Question 2');
      expect(sent).not.toContain('Question 1 ');
    } finally {
      await f.close();
    }
  },
);

test('compaction keeps whole recent turns and search ranks tool names first', () => {
  const history: Entry[] = Array.from({ length: 10 }, (_, index) =>
    index % 2 ? assistantEntry(String(index)) : userEntry(String(index)),
  );
  const { older, recent } = compactionSplit(history, 2);
  expect(older).toHaveLength(6);
  expect(recent[0]).toEqual(userEntry('6'));
  // Saved memory stays with the player message it was sent with.
  const withMemory: Entry[] = [
    ...history.slice(0, 6),
    { type: 'synthetic', kind: 'memory', text: 'Plays a mage' },
    ...history.slice(6),
  ];
  expect(compactionSplit(withMemory, 2).recent[0]).toMatchObject({ type: 'synthetic' });
  expect(compactionSplit(history.slice(0, 2), 4)).toEqual({
    older: [],
    recent: history.slice(0, 2),
  });
  const tools = [
    { name: 'wow__get_settings', description: 'Reads addons', inputSchema: {}, run: async () => 0 },
    {
      name: 'wow__read_chat',
      description: 'Reads chat settings',
      inputSchema: {},
      run: async () => 0,
    },
  ];
  expect(searchTools(tools, 'settings').map((tool) => tool.name)).toEqual([
    'wow__get_settings',
    'wow__read_chat',
  ]);
  expect(searchTools(tools, 'unrelated')).toEqual([]);
});

test(
  'a turn that fails after a tool ran keeps that step in the history',
  { timeout: 60_000 },
  async () => {
    const f = await fixture((count) =>
      count === 1
        ? toolCall(count, 'tool_call', { name: 'wow__get_settings', input: {} })
        : undefined,
    );
    try {
      const session = f.engine.newSessionId();
      const turn = await f.send(session, 'Which addons do I have?');
      expect(turn.result.status).toBe('failed');
      expect(f.inspections).toHaveLength(1);
      // The next turn's model sees the settings it already read.
      expect(f.messagesOf(session).map(({ entry }) => entry.type)).toEqual(['user', 'assistant']);
      expect(f.messagesOf(session).at(-1)!.entry).toMatchObject({
        type: 'assistant',
        content: [{ type: 'tool', id: 'tool-call-1', state: { status: 'completed' } }],
      });
    } finally {
      await f.close();
    }
  },
);

test('cancelling while a completed step is being saved does not repeat the step', async () => {
  const saving = gate();
  const releaseSave = gate();
  const f = await fixture(
    (count) => toolCall(count, 'tool_call', { name: 'wow__get_settings', input: {} }),
    undefined,
    {
      beforeAppend: async (entries) => {
        if (entries.some((entry) => entry.type === 'assistant')) {
          saving.open();
          await releaseSave.promise;
        }
      },
    },
  );
  const controller = new AbortController();
  const session = f.engine.newSessionId();
  const turn = f.send(session, 'Check my settings', undefined, controller.signal);
  try {
    await Promise.race([
      saving.promise,
      turn.then(() => {
        throw Error('The turn ended before saving the assistant step.');
      }),
    ]);
    controller.abort();
    releaseSave.open();
    expect((await turn).result).toEqual({ status: 'cancelled' });
    expect(f.requests).toHaveLength(1);
    const assistants = f.messagesOf(session).filter(({ entry }) => entry.type === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.entry).toMatchObject({
      content: [{ type: 'tool', id: 'tool-call-1', state: { status: 'completed' } }],
    });
  } finally {
    controller.abort();
    releaseSave.open();
    await f.close();
  }
});

test(
  'cancelling a turn stops the tool loop and settles it as cancelled',
  { timeout: 60_000 },
  async () => {
    const f = await fixture(
      (count) => toolCall(count, 'tool_call', { name: 'wow__get_settings', input: {} }),
      undefined,
      { inspectDelayMs: 2000 },
    );
    try {
      const controller = new AbortController();
      const session = f.engine.newSessionId();
      const turn = await f.send(
        session,
        'Which addons do I have?',
        (event) => event.type === 'call.requested' && controller.abort(),
        controller.signal,
      );
      expect(turn.result).toEqual({ status: 'cancelled' });
      expect(turn.events.filter((event) => event.type === 'call.requested')).toHaveLength(1);
      expect(f.requests).toHaveLength(1);
      // The step it stopped is logged, its call as still running.
      expect(f.messagesOf(session).at(-1)!.entry).toMatchObject({
        type: 'assistant',
        finish: 'interrupted',
        content: [
          { type: 'tool', id: 'tool-call-1', name: 'tool_call', state: { status: 'running' } },
        ],
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'a turn whose step cannot be logged fails with the store error',
  { timeout: 60_000 },
  async () => {
    const logs: string[] = [];
    const f = await fixture(
      (count) =>
        count === 1
          ? toolCall(count, 'tool_call', { name: 'wow__get_settings', input: {} })
          : message(count, 'Should not be reached.'),
      undefined,
      // The player's message logs; the first step does not.
      {
        appendFails: (count) => count === 2,
        logging: Logger.layer([
          Logger.make(({ logLevel, fiber }) => {
            const { event } = fiber.getRef(References.CurrentLogAnnotations);
            if (typeof event === 'string') logs.push(`${logLevel}: ${event}`);
          }),
        ]),
      },
    );
    try {
      const turn = await f.send(f.engine.newSessionId(), 'Which addons do I have?');
      expect(turn.result).toMatchObject({
        status: 'failed',
        error: { message: 'The disk is full.' },
      });
      expect(logs).toContain('Warn: agent.turn_failed');
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test(
  'a turn logs its context and the earlier chat apart from what the player wrote',
  { timeout: 60_000 },
  async () => {
    const f = await fixture((count) => message(count, 'Answer ' + count));
    try {
      const session = f.engine.newSessionId();
      const context = [{ name: 'game_context', data: { zone: 'Orgrimmar' } }];
      await f.send(session, {
        text: 'Where am I?',
        context,
        history: [{ role: 'user', text: 'Hi' }],
      });
      // The session has a log now, so the chat's earlier messages are not logged again.
      await f.send(session, { text: 'And now?', context, history: [{ role: 'user', text: 'Hi' }] });
      expect(
        f
          .messagesOf(session)
          .map(({ entry }) => (entry.type === 'synthetic' ? entry.kind : entry.type)),
      ).toEqual(['context', 'history', 'user', 'assistant', 'context', 'user', 'assistant']);
      expect(f.messagesOf(session)[2]!.entry).toEqual({
        type: 'user',
        content: [{ type: 'text', text: 'Where am I?' }],
      });
      // The model reads each turn as the one tagged message the bridge used to send.
      expect(JSON.stringify(f.requests[1]!.input)).toContain(
        JSON.stringify(
          '<game_context>\n{"zone":"Orgrimmar"}\n</game_context>\n\n<user_message>\n"And now?"\n</user_message>',
        ).slice(1, -1),
      );
    } finally {
      await f.close();
    }
  },
);
