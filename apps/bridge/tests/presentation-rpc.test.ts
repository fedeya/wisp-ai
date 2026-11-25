import { test, expect, vi } from 'vitest';
import { serveAgent } from './agent-server-fixture.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { ReplyProjection } from '../src/reply/reply-stream.ts';

test('presentation RPC authenticates, scopes the active character and reports bridge acceptance errors', async () => {
  const chat = newChat('presentation', 'addon');
  chat.status = 'working';
  chat.agentSession = 'eve';
  let transport = 'addon';
  const projection = new ReplyProjection();
  const presentReply = vi.fn((_chat, callId, input, signal) =>
    projection.acceptPresentation(callId, input, signal),
  );
  const server = await serveAgent({
    token: 'test',
    getChats: () => [chat],
    currentTransport: () => transport,
    presentReply,
  });
  const url = server.origin + '/present';
  const input = { references: { nova: { kind: 'spell', id: 122, label: 'Nova' } } };
  const post = (body: unknown, token = 'test') =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const payload = { agentSession: 'eve', callId: 'one', presentation: input };
  try {
    expect((await post(payload, 'wrong')).status).toBe(403);
    expect((await post({ ...payload, agentSession: 'other' })).status).toBe(503);
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
    await server.close();
  }
});
