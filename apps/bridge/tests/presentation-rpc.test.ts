import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent-server.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import { ReplyProjection } from '../src/reply-stream.ts';

test('presentation RPC authenticates, scopes the active character and reports bridge acceptance errors', async () => {
  const chat = newChat('presentation', 'addon');
  chat.status = 'working';
  chat.eveId = 'eve';
  let transport = 'addon';
  const projection = new ReplyProjection();
  const presentReply = vi.fn((_chat, callId, input, signal) =>
    projection.acceptPresentation(callId, input, signal),
  );
  const server = createServer(
    createAgentHandler({
      token: 'test',
      getChats: () => [chat],
      currentTransport: () => transport,
      presentReply,
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/present';
  const input = { references: { nova: { kind: 'spell', id: 122, label: 'Nova' } } };
  const post = (body: unknown, token = 'test') =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const payload = { eveSession: 'eve', callId: 'one', presentation: input };
  try {
    expect((await post(payload, 'wrong')).status).toBe(403);
    expect((await post({ ...payload, eveSession: 'other' })).status).toBe(503);
    transport = 'other-addon';
    expect((await post(payload)).status).toBe(503);
    transport = 'addon';
    chat.status = 'done';
    expect((await post(payload)).status).toBe(503);
    chat.status = 'working';
    expect((await post({ ...payload, presentation: { nodes: [] } })).status).toBe(503);
    expect(presentReply).not.toHaveBeenCalled();
    projection.requestPresentation(chat, 'one');
    const response = await post(payload);
    expect(response.status).toBe(200);
    const accepted = await response.json();
    expect(accepted).toEqual({ nodes: [], ...input });
    expect(chat.messages[0].references).toEqual({});
    projection.settlePresentation('one', accepted, true);
    projection.requestPresentation(chat, 'two');
    const rejected = await post({
      ...payload,
      callId: 'two',
      presentation: {
        references: { nova: { kind: 'spell', id: 116, label: 'Frostbolt' } },
      },
    });
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).toContain('already identifies something else');
    expect(chat.messages[0].references?.nova).toMatchObject({ id: 122 });
    expect(chat.activity).toEqual([]);
  } finally {
    projection.finish();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
