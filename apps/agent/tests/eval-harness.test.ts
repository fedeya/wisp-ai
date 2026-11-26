import { afterEach } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setAgentHost } from '../src/host/agent-host.ts';
import { avoidsTool } from '../evals/judges/tool-calls.ts';
import { wispHarness } from '../evals/runtime/harness.ts';

afterEach(() => setAgentHost(undefined));

// A model that calls one deferred tool through tool_call, then answers.
async function fakeModel() {
  let count = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    if (req.url?.startsWith('/session-model')) {
      res.end(JSON.stringify({ model: 'offline-test', effort: 'provider-default' }));
      return;
    }
    count++;
    const item =
      count % 2
        ? {
            id: 'item-' + count,
            type: 'function_call',
            call_id: 'call-' + count,
            status: 'completed',
            name: 'tool_call',
            arguments: JSON.stringify({
              name: 'wow__get_settings',
              input: { query: 'nameplates' },
            }),
          }
        : {
            id: 'message-' + count,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Nameplates are on.', annotations: [] }],
          };
    const response = { id: 'response-' + count, model: 'offline-test', created_at: 1 };
    const completed = { ...response, output: [item], usage: { input_tokens: 5, output_tokens: 5 } };
    if (!JSON.parse(body).stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completed));
      return;
    }
    const events = [
      { type: 'response.created', response },
      // A message streams its text as deltas, as the Responses API does.
      ...(item.type === 'message'
        ? [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, content: [] },
            },
            {
              type: 'response.output_text.delta',
              item_id: item.id,
              output_index: 0,
              delta: 'Nameplates are on.',
            },
          ]
        : [{ type: 'response.output_item.added', output_index: 0, item }]),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: completed },
    ];
    res
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port };
}

describeEval('Wisp eval adapter', { harness: wispHarness }, (it) => {
  it(
    'reports a real engine turn with stubbed tools',
    { timeout: 60_000 },
    async ({ expect, run }) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'wisp-eval-harness-'));
      const flags = path.join(directory, 'capabilities.json');
      await writeFile(
        flags,
        JSON.stringify({
          enabled: {
            'mcp:everloot': false,
            'memory:preferences': false,
            'memory:character': false,
          },
        }),
      );
      const { server, origin } = await fakeModel();
      setAgentHost({ origin, token: 'offline-token', capabilitiesFile: flags });
      try {
        const stubs = [
          {
            id: 'settings',
            tool: 'wow__get_settings',
            match: { query: { const: 'nameplates' } },
            outcome: { response: { settings: [{ id: 'nameplateShowAll', value: true }] } },
          },
        ];
        const result = await run({ question: 'are my nameplates on?', stubs });
        expect(result.errors ?? []).toEqual([]);
        // A missed scorer is recorded without failing the test.
        await expect(result).toSatisfyJudge(avoidsTool('wow__get_settings'), { threshold: null });
        // The deferred call is seen as the tool it ran, with the stubbed output.
        expect(toolCalls(result)).toEqual([
          {
            name: 'wow__get_settings',
            arguments: { query: 'nameplates' },
            status: 'ok',
            result: { settings: [{ id: 'nameplateShowAll', value: true }] },
          },
        ]);
        expect(result.output.reply).toBe('Nameplates are on.');
        expect(result.artifacts?.steps).toBe(2);
        expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 10 });
      } finally {
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
