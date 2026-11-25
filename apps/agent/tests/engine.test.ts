import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { setAgentHost } from '../src/agent-host.ts';
import {
  compactionSplit,
  createAgentEngine,
  searchTools,
  type Compaction,
  type EngineEvent,
  type ModelMessage,
  type StoredMessage,
} from '../src/engine.ts';

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

async function fixture(plan: (count: number, request: Item) => Item, contextWindow?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-engine-'));
  const flags = path.join(root, 'capabilities.json');
  await writeFile(
    flags,
    JSON.stringify({
      enabled: {
        ...Object.fromEntries(defaultCapabilities().map((capability) => [capability.id, false])),
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
    } else if (req.url === '/inspect') {
      inspections.push(JSON.parse(body));
      json({ status: 'completed', data: { settings: [], verified: true } });
    } else {
      const request = JSON.parse(body) as Item;
      requests.push(request);
      const item = plan(requests.length, request);
      if (request.stream) {
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
  // An in-memory history with the bridge store's rules: rows stay, compactions are records.
  const histories = new Map<string, StoredMessage[]>();
  const compactions = new Map<string, Compaction[]>();
  const sessions = new Map<
    string,
    { chatId: string; model: string; inputTokens: number; outputTokens: number }
  >();
  const engine = createAgentEngine({
    origin: () => origin,
    token: 'offline-token',
    history: {
      begin: async (session, start) =>
        void sessions.set(
          session,
          sessions.get(session) ?? { ...start, inputTokens: 0, outputTokens: 0 },
        ),
      addUsage: async (session, usage) => {
        const totals = sessions.get(session)!;
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
      },
      load: async (session) => {
        const latest = compactions.get(session)?.at(-1);
        const start = latest?.keptFrom ?? 0;
        return {
          summary: latest?.summary,
          messages: (histories.get(session) ?? []).slice(start),
          start,
        };
      },
      append: async (session, from, messages, model) =>
        void histories.set(session, [
          ...(histories.get(session) ?? []).slice(0, from),
          ...messages.map((message) => ({ message, model })),
        ]),
      compact: async (session, compaction) =>
        void compactions.set(session, [...(compactions.get(session) ?? []), compaction]),
      delete: async (session) => {
        histories.delete(session);
        compactions.delete(session);
      },
    },
    logger: { info: () => {}, warn: () => {} },
  });
  async function send(session: string, input: string) {
    const turn = engine.send(session, input, AbortSignal.timeout(30000), 'chat');
    const events: EngineEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    return { events, result: await turn.result };
  }
  return {
    engine,
    send,
    requests,
    inspections,
    histories,
    compactions,
    sessions,
    close: async () => {
      server.close();
      await engine.close();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

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
      expect(f.sessions.get(session)).toMatchObject({
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
      expect(f.histories.get(session)!.at(-1)!.message).toMatchObject({ role: 'tool' });

      await f.engine.end(session);
      expect(f.histories.has(session)).toBe(false);
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
      const turns: ModelMessage[] = [];
      for (let index = 0; index < 6; index++) {
        turns.push({ role: 'user', content: 'Question ' + index + ' ' + 'x'.repeat(1500) });
        turns.push({ role: 'assistant', content: 'Answer ' + index });
      }
      f.histories.set(
        session,
        turns.map((message) => ({ message, model: 'gpt-test' })),
      );
      const { events, result } = await f.send(session, 'Next question');
      expect(result).toEqual({ status: 'completed' });
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['context.started', 'context.settled']),
      );
      expect(events.find((event) => event.type === 'context.settled')!.data).toEqual({
        kind: 'compaction',
        outcome: 'completed',
      });
      // The compaction is a record: every message stays stored, this turn's included.
      expect(f.compactions.get(session)).toEqual([
        { keptFrom: 4, summary: 'Summary of the quest plan.', model: expect.any(String) },
      ]);
      const stored = f.histories.get(session)!;
      expect(stored).toHaveLength(14);
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
  const history: ModelMessage[] = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: String(index),
  }));
  const { older, recent } = compactionSplit(history, 2);
  expect(older).toHaveLength(6);
  expect(recent[0]).toEqual({ role: 'user', content: '6' });
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
