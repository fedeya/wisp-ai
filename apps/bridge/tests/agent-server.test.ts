import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

async function serve(deps: Partial<Parameters<typeof createAgentHandler>[0]>) {
  const server = createServer(
    createAgentHandler({
      token: 'test',
      currentTransport: () => 'addon',
      capabilitySettings: { enabled: () => true },
      ...deps,
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const post = (route: string, body: unknown, init: RequestInit = {}) =>
    fetch(origin + route, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    });
  return {
    origin,
    post,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const workingChat = (proactive = false) => ({
  ...newChat('chat', 'addon'),
  status: 'working' as const,
  eveId: 'eve',
  characterKey: 'Realm-Name',
  proactive,
});

test('agent server rejects bad tokens, unknown routes and oversized bodies', async () => {
  const chat = workingChat();
  const server = await serve({ getChats: () => [chat] });
  try {
    const forbidden = await fetch(server.origin + '/identity', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('Forbidden');
    expect((await server.post('/unknown', {})).status).toBe(404);
    expect(
      (await fetch(server.origin + '/identity', { headers: { authorization: 'Bearer test' } }))
        .status,
    ).toBe(404);
    const large = await server.post('/identity', { eveSession: 'eve', pad: 'x'.repeat(40000) });
    expect(large.status).toBe(503);
    expect(await large.text()).toBe('Request is too large');
    const identity = await server.post('/identity', { eveSession: 'eve' });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toEqual({ characterKey: 'Realm-Name' });
  } finally {
    await server.close();
  }
});

test('agent server refuses changes from automatic suggestions and reports the reason', async () => {
  const chat = workingChat(true);
  const server = await serve({ getChats: () => [chat] });
  try {
    const refused = await server.post('/memory', {
      eveSession: 'eve',
      slot: 'character',
      operation: 'save',
      key: 'k',
      text: 't',
    });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toMatch(/Automatic suggestions cannot change/);
    const missing = await server.post('/identity', { eveSession: 'other' });
    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe('No active connection for this character');
  } finally {
    await server.close();
  }
});

test('agent server aborts game requests when Eve hangs up', async () => {
  const chat = workingChat();
  let seen: AbortSignal | undefined;
  const request = vi.fn(
    (_input: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => reject(Error('aborted')));
      }),
  );
  const server = await serve({ getChats: () => [chat], pending: { request } as never });
  try {
    const client = new AbortController();
    const reply = server
      .post(
        '/inspect',
        { eveSession: 'eve', inspection: { kind: 'target', args: {} } },
        { signal: client.signal },
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(seen?.aborted).toBe(false);
    client.abort();
    await reply;
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  } finally {
    await server.close();
  }
});
