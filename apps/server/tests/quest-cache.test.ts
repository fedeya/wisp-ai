import { test, expect, vi } from 'vitest';
import { Effect } from 'effect';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { runBridgeEffect } from './capture-logs.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { characterIdentity, rememberTurnQuests } from '../src/chat/context.ts';

test('state RPC serves quests locally, fetches only missing sections, and respects refresh and permissions', async () => {
  const snapshot = {
    capturedAt: 123,
    sections: {
      character: { status: 'available', data: { name: 'Mage', realm: 'Realm' } },
      quests: {
        status: 'available',
        data: {
          quests: [
            { id: 1492, title: 'Cached delivery', rewardXP: 850, objectives: [], complete: true },
          ],
          count: 1,
          truncated: false,
        },
      },
    },
  };
  const chat = {
    ...newChat('chat', 'addon'),
    status: 'working' as const,
    agentSession: 'eve',
    characterKey: characterIdentity(snapshot),
  };
  rememberTurnQuests(chat, snapshot);
  let allowed = true;
  const request = vi.fn((_input: unknown) =>
    Effect.succeed({
      capturedAt: 130,
      sections: {
        talents: { status: 'available', data: { unspentPoints: 1 } },
        quests: { status: 'available', data: { quests: [], count: 0 } },
      },
    }),
  );
  // Other service dependencies are not used by the state endpoint under test.
  const handler = runBridgeEffect(
    createAgentHandler({
      token: 'test',
      getChats: () => [chat],
      currentTransport: () => 'addon',
      capabilitySettings: { enabled: () => allowed },
      pending: { request },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/state';
  const read = (sections: string[], refresh?: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ agentSession: 'eve', sections, refresh }),
    });
  try {
    const quests = await read(['quests']);
    expect(quests.status).toBe(200);
    expect((await quests.json()).sections.quests.data.quests[0]).toMatchObject({
      title: 'Cached delivery',
      rewardXP: 850,
    });
    expect(request).not.toHaveBeenCalled();
    const mixed = await read(['quests', 'talents']);
    const result = await mixed.json();
    expect(result.sections.quests.data.quests[0].title).toBe('Cached delivery');
    expect(result.sections.quests.data.quests[0].rewardXP).toBe(850);
    expect(result.sections.talents.data.unspentPoints).toBe(1);
    expect(request).toHaveBeenLastCalledWith({
      chat: 'chat',
      session: 'addon',
      agent: true,
      sections: ['talents'],
    });
    await (await read(['quests'], true)).json();
    expect(request).toHaveBeenLastCalledWith({
      chat: 'chat',
      session: 'addon',
      agent: true,
      sections: ['quests'],
    });
    allowed = false;
    const denied = await read(['quests']);
    expect(denied.status).toBe(503);
    expect(await denied.text()).toContain('disabled');
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
