import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent-server.ts';
import { newChat } from '../src/chat-lifecycle.ts';

test('merchant RPC enforces authentication, active Eve/game session and feature permission', async () => {
  const chat = { ...newChat('merchant', 'addon'), status: 'working' as const, eveId: 'eve' };
  let transport = 'addon';
  let allowed = true;
  const request = vi.fn(async () => ({
    status: 'available',
    capturedAt: 123,
    data: { offers: [] },
  }));
  const enabled = vi.fn(() => allowed);
  const server = createServer(
    createAgentHandler({
      token: 'test',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: { enabled },
      pending: { request },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/inspect';
  const post = (token = 'test', eveSession = 'eve', args: object = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ eveSession, inspection: { kind: 'merchant', args } }),
    });
  try {
    expect((await post('bad')).status).toBe(403);
    expect((await post('test', 'other')).status).toBe(503);
    expect(request).not.toHaveBeenCalled();
    const result = await post();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ capturedAt: 123 });
    expect(enabled).toHaveBeenLastCalledWith('tool:inspect_merchant');
    expect(request).toHaveBeenLastCalledWith(
      {
        chat: 'merchant',
        session: 'addon',
        inspection: { kind: 'merchant', args: { offset: 0, limit: 20 } },
      },
      expect.any(AbortSignal),
    );
    allowed = false;
    expect((await post()).status).toBe(503);
    allowed = true;
    transport = 'replacement';
    expect((await post()).status).toBe(503);
    transport = 'addon';
    expect((await post('test', 'eve', { limit: 41 })).status).toBe(503);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
