import { test, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAgentHost } from '@wisp/agent/agent-host';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { createMastraEngine } from '../src/agent/mastra-engine.ts';
import { applyEvent } from '../src/chat/events.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { ReplyProjection } from '../src/reply/reply-stream.ts';

afterEach(() => setAgentHost(undefined));

// An OpenAI Responses stream with one output item: a tool call or text.
function responseEvents(count: number, item: Record<string, unknown>) {
  const added =
    item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] };
  const body =
    item.type === 'function_call'
      ? [
          {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index: 0,
            arguments: item.arguments,
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
  return [
    {
      type: 'response.created',
      response: { id: 'response-' + count, model: 'offline-test', created_at: 1 },
    },
    { type: 'response.output_item.added', output_index: 0, item: added },
    ...body,
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'response-' + count,
        model: 'offline-test',
        created_at: 1,
        output: [item],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    },
  ];
}

test(
  'the Mastra engine runs skills, deferred tools and memory through bridge events',
  {
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-mastra-'));
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
    const requests: { input: unknown[]; tools: { name: string }[] }[] = [];
    const inspections: { eveSession: string; inspection: { kind: string } }[] = [];
    const planned: Record<number, { name: string; input: unknown }> = {
      1: { name: 'skill', input: { name: 'settings' } },
      2: { name: 'search_tools', input: { query: 'settings cvars addons' } },
      3: { name: 'load_tool', input: { toolName: 'wow__get_settings' } },
      4: { name: 'wow__get_settings', input: {} },
    };
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith('/session-model?')) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ model: 'offline-test', effort: 'provider-default' }));
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      if (req.headers.authorization !== 'Bearer offline-token') {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/inspect') {
        inspections.push(JSON.parse(body));
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'completed', data: { settings: [], verified: true } }));
        return;
      }
      const request = JSON.parse(body);
      requests.push(request);
      const count = requests.length;
      const call = planned[count];
      const item = call
        ? {
            id: 'tool-item-' + count,
            type: 'function_call',
            call_id: 'tool-call-' + count,
            status: 'completed',
            name: call.name,
            arguments: JSON.stringify(call.input),
          }
        : {
            id: 'message-' + count,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: count === 5 ? 'Offline integration passed.' : 'Second turn.',
                annotations: [],
              },
            ],
          };
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
        responseEvents(count, item)
          .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
          .join(''),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    setAgentHost({ origin, token: 'offline-token', capabilitiesFile: flags });
    const engine = createMastraEngine({
      agentRoot: path.dirname(fileURLToPath(import.meta.resolve('@wisp/agent/package.json'))),
      runtimeDir: root,
      origin: () => origin,
      token: 'offline-token',
      logger: { info: () => {}, warn: () => {} },
    });
    try {
      const session = engine.newSessionId();
      const chat = newChat('mastra', 'test');
      const projection = new ReplyProjection();
      const types: string[] = [];
      const first = engine.send(session, 'Which addons do I have?', AbortSignal.timeout(30000));
      for await (const event of first.events) {
        types.push(event.type);
        applyEvent(chat, event, projection);
      }
      projection.flush(chat, Date.now(), true);
      expect(await first.result).toEqual({ status: 'completed' });

      // Deferred tools stay out of the first request until search and load.
      expect(requests[0]!.tools.map((tool) => tool.name)).toContain('wisp__present_ui');
      expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain('wow__get_settings');
      expect(requests[3]!.tools.map((tool) => tool.name)).toContain('wow__get_settings');
      // The skill tool returned the authored settings instructions to the model.
      expect(JSON.stringify(requests[1]!.input)).toContain('To change a setting');
      // The tool reached the bridge under this session, like an Eve tool call.
      expect(inspections).toEqual([
        // Mastra validates input before execute, so schema defaults are filled in.
        expect.objectContaining({
          eveSession: session,
          inspection: expect.objectContaining({ kind: 'settings' }),
        }),
      ]);
      const tool = chat.messages.find((message) => message.tool?.name === 'wow__get_settings');
      expect(tool?.tool).toMatchObject({ status: 'completed', label: 'Read settings' });
      // Meta tools are control calls, not player-facing activity.
      expect(chat.activity.map((call) => call.name)).toEqual(['wow__get_settings']);
      expect(chat.messages.map((message) => message.text)).toContain('Offline integration passed.');
      expect(types).toContain('usage.recorded');
      expect(chat.usage?.inputTokens).toBeGreaterThan(0);

      // Memory replays the first turn, tool results included, into the next one.
      const second = engine.send(session, 'Thanks', AbortSignal.timeout(30000));
      for await (const event of second.events) {
        applyEvent(chat, event, projection);
      }
      expect(await second.result).toEqual({ status: 'completed' });
      const history = JSON.stringify(requests[5]!.input);
      expect(history).toContain('Which addons do I have?');
      expect(history).toContain('Offline integration passed.');
      expect(history).toContain('tool-call-4');
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  },
);
