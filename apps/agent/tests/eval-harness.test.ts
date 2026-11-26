import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setAgentHost } from '../src/agent-host.ts';
import { defineEval, matches, runEval, type MatchRule } from '../evals/harness.ts';
import { calledTool, expects, maxToolCalls, notCalledTool, replied } from '../evals/checks.ts';

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

test(
  'evals run a real engine turn with gates, soft scorers and stubs',
  {
    timeout: 60_000,
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wisp-eval-harness-'));
    const flags = path.join(directory, 'capabilities.json');
    await writeFile(
      flags,
      JSON.stringify({
        enabled: { 'mcp:everloot': false, 'memory:preferences': false, 'memory:character': false },
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
      const passing = await runEval(
        defineEval({
          description: 'reads settings',
          question: 'are my nameplates on?',
          stubs,
          gates: [
            replied(),
            calledTool('wow__get_settings', { input: { query: 'nameplates' }, count: 1 }),
            expects('reports the setting', (turn) => /Nameplates are on/.test(turn.reply)),
          ],
          // Tracked, not required: a soft miss scores the run but does not fail it.
          scorers: [maxToolCalls(5), notCalledTool('wow__get_settings')],
        }),
      );
      expect(passing.verdict).toBe('scored');
      expect(passing.failed).toEqual([]);
      expect(passing.soft).toEqual(['did not call wow__get_settings']);
      // The deferred call is seen as the tool it ran, with the stubbed output.
      expect(passing.turn?.toolCalls).toEqual([
        {
          name: 'wow__get_settings',
          input: { query: 'nameplates' },
          output: { settings: [{ id: 'nameplateShowAll', value: true }] },
        },
      ]);
      expect(passing.turn?.reply).toBe('Nameplates are on.');
      expect(passing.steps).toBe(2);

      const failing = await runEval(
        defineEval({
          description: 'expects a different tool',
          question: 'are my nameplates on?',
          stubs,
          gates: [replied(), calledTool('wow__query_character')],
        }),
      );
      expect(failing.verdict).toBe('failed');
      expect(failing.failed).toEqual(['called wow__query_character']);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('stubs match inputs by value, pattern and array element', () => {
  const stub = (match: Record<string, MatchRule>) => ({
    id: 's',
    tool: 't',
    match,
    outcome: { response: {} },
  });
  expect(matches(stub({ id: { const: 7 } }), 't', { id: 7 })).toBe(true);
  expect(matches(stub({ id: { const: 7 } }), 'other', { id: 7 })).toBe(false);
  expect(matches(stub({ query: { pattern: '[Rr]une' } }), 't', { query: 'Rune of X' })).toBe(true);
  expect(matches(stub({ query: { pattern: '[Rr]une' } }), 't', { query: 'Hood' })).toBe(false);
  const pvp = stub({ sections: { contains: { const: 'pvp' } } });
  expect(matches(pvp, 't', { sections: ['character', 'pvp'] })).toBe(true);
  expect(matches(pvp, 't', { sections: ['gear'] })).toBe(false);
});
