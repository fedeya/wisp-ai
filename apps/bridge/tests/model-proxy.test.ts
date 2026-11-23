import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAI } from '@ai-sdk/openai';
import { proxyConnectionModel, proxyModel } from '../src/models/model-proxy.ts';
import { ModelFailures } from '../src/models/model-failures.ts';
import type { ModelConnections } from '../src/models/model-connections.ts';
import type { ChatGPTAuth } from '../src/auth/chatgpt-auth.ts';
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
  const failures = new ModelFailures();
  const server = createServer((req, res) => {
    void proxyModel(req, res, auth, undefined, failures).catch((e) => {
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
    // Rejected before reaching OpenAI; the streamed failures above were HTTP 200.
    // Unnamed requests (as from the SDK above) are not attributed to a session.
    assert.equal(failures.since('chatgpt', 0), undefined);
    const named = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port, {
      method: 'POST',
      headers: { 'x-wisp-session': 'eve-1' },
      body: JSON.stringify({ model: 'hidden-model' }),
    });
    assert.equal(named.status, 400);
    assert.equal(failures.since('eve-1', 0), 'wisp_rejected');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('connection proxy records the provider status of failed requests by session', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  let status = 404;
  const connections = {
    forward: async () => {
      if (status === 0) throw new TypeError('fetch failed');
      return Response.json({ error: { message: 'Private provider error' } }, { status });
    },
  } as unknown as ModelConnections;
  const failures = new ModelFailures();
  const server = createServer((req, res) => {
    void proxyConnectionModel(req, res, connections, failures).catch(() => {
      res.writeHead(503).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url =
    'http://127.0.0.1:' +
    (server.address() as { port: number }).port +
    '/model/connections/' +
    id +
    '/chat/completions';
  try {
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'x-wisp-session': 'eve-1' }, body: '{}' }))
        .status,
      404,
    );
    assert.equal(failures.since('eve-1', 0), 'not_found');
    status = 429;
    await fetch(url, { method: 'POST', headers: { 'x-wisp-session': 'eve-1' }, body: '{}' });
    assert.equal(failures.since('eve-1', 0), 'rate_limited');
    status = 0;
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'x-wisp-session': 'eve-1' }, body: '{}' }))
        .status,
      503,
    );
    assert.equal(failures.since('eve-1', 0), 'network');
    assert.equal(failures.since('eve-2', 0), undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('connection proxy records a stream that breaks after a 200', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const connections = {
    forward: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  } as unknown as ModelConnections;
  const failures = new ModelFailures();
  const server = createServer((req, res) => {
    void proxyConnectionModel(req, res, connections, failures).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url =
    'http://127.0.0.1:' +
    (server.address() as { port: number }).port +
    '/model/connections/' +
    id +
    '/chat/completions';
  try {
    // The proxy drops the client once the provider's stream breaks.
    await fetch(url, { method: 'POST', headers: { 'x-wisp-session': 'eve-1' }, body: '{}' })
      .then((response) => response.text())
      .catch(() => undefined);
    assert.equal(failures.since('eve-1', 0), 'network');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('connection proxy records nothing when Eve cancels mid-stream', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const connections = {
    forward: async (
      _id: string,
      _path: string,
      _body: string,
      _headers: Headers,
      signal: AbortSignal,
    ) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
            signal.addEventListener('abort', () => controller.error(signal.reason));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  } as unknown as ModelConnections;
  const failures = new ModelFailures();
  const server = createServer((req, res) => {
    void proxyConnectionModel(req, res, connections, failures)
      .catch(() => res.destroy())
      .finally(done);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url =
    'http://127.0.0.1:' +
    (server.address() as { port: number }).port +
    '/model/connections/' +
    id +
    '/chat/completions';
  try {
    const cancel = new AbortController();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-wisp-session': 'eve-1' },
      body: '{}',
      signal: cancel.signal,
    });
    await response.body!.getReader().read();
    cancel.abort();
    await finished;
    assert.equal(failures.since('eve-1', 0), undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
