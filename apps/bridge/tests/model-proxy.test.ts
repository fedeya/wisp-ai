import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAI } from '@ai-sdk/openai';
import { proxyModel } from '../src/model-proxy.ts';
import type { ChatGPTAuth } from '../src/chatgpt-auth.ts';
import { subscriptionCallOptions } from '@wisp/agent/model-tools';

test('SDK streams via bridge, forces private responses, and preserves terminal failures', async () => {
  let terminal = 'response.completed',
    requested: Record<string, unknown> = {},
    upstream = '';
  const auth = {
    models: async () => [{ slug: 'gpt-test', displayName: 'Test' }],
    authorized: async (url: string, init: RequestInit) => {
      upstream = url;
      requested = JSON.parse(String(init.body));
      const events = [
        {
          type: 'response.created',
          response: { id: 'response-test', model: 'gpt-test', created_at: 1 },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'message-test', type: 'message', role: 'assistant', content: [] },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'message-test',
          output_index: 0,
          delta: 'Hello',
        },
        ...(terminal
          ? [
              terminal === 'response.failed'
                ? {
                    type: terminal,
                    sequence_number: 4,
                    response: {
                      error: {
                        code: 'subscription_sharing_usage_limit_exceeded',
                        message: 'Plan usage limit reached',
                      },
                    },
                  }
                : { type: terminal, response: {} },
            ]
          : []),
      ];
      return new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  } as unknown as ChatGPTAuth;
  const server = createServer((req, res) => {
    void proxyModel(req, res, auth).catch((e) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(400).end(e.message);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const provider = createOpenAI({
      apiKey: 'loopback-only',
      baseURL: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    });
    async function stream() {
      const { stream } = await provider.responses('gpt-test').doStream(
        subscriptionCallOptions({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          providerOptions: { openai: { store: true, safetyIdentifier: 'eve-session-test' } },
        }),
      );
      const chunks = [];
      for await (const c of stream) {
        chunks.push(c);
      }
      return chunks;
    }
    let chunks = await stream();
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.delta === 'Hello'));
    assert.ok(chunks.some((c) => c.type === 'finish' && c.finishReason.unified === 'stop'));
    assert.equal(requested.store, false);
    assert.equal(requested.stream, true);
    assert.equal('safety_identifier' in requested, false);
    assert.equal(upstream, 'https://api.openai.com/v1/responses');
    terminal = 'response.failed';
    chunks = await stream();
    assert.ok(chunks.some((c) => c.type === 'error'));
    assert.ok(chunks.some((c) => c.type === 'finish' && c.finishReason.unified === 'error'));
    terminal = '';
    chunks = await stream();
    assert.ok(chunks.some((c) => c.type === 'finish' && c.finishReason.unified === 'interrupted'));
    const bad = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port, {
      method: 'POST',
      body: JSON.stringify({ model: 'hidden-model' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
