import { test, expect, vi } from 'vitest';
import { createAgentCalls } from '../src/agent/agent-calls.ts';
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
  const request = vi.fn(async (_input: unknown) => ({
    capturedAt: 130,
    sections: {
      talents: { status: 'available', data: { unspentPoints: 1 } },
      quests: { status: 'available', data: { quests: [], count: 0 } },
    },
  }));
  // Other service dependencies are not used by the state call under test.
  const agent = createAgentCalls({
    getChats: () => [chat],
    currentTransport: () => 'addon',
    capabilitySettings: { enabled: () => allowed },
    pending: { request },
  } as unknown as Parameters<typeof createAgentCalls>[0]);
  const read = (sections: string[], refresh?: boolean) =>
    agent.call(
      'eve',
      'state',
      { sections: sections as never, refresh },
      new AbortController().signal,
    ) as Promise<any>;
  {
    const quests = await read(['quests']);
    expect(quests.sections.quests.data.quests[0]).toMatchObject({
      title: 'Cached delivery',
      rewardXP: 850,
    });
    expect(request).not.toHaveBeenCalled();
    const result = await read(['quests', 'talents']);
    expect(result.sections.quests.data.quests[0].title).toBe('Cached delivery');
    expect(result.sections.quests.data.quests[0].rewardXP).toBe(850);
    expect(result.sections.talents.data.unspentPoints).toBe(1);
    expect(request).toHaveBeenLastCalledWith(
      { chat: 'chat', session: 'addon', agent: true, sections: ['talents'] },
      expect.any(AbortSignal),
    );
    await read(['quests'], true);
    expect(request).toHaveBeenLastCalledWith(
      { chat: 'chat', session: 'addon', agent: true, sections: ['quests'] },
      expect.any(AbortSignal),
    );
    allowed = false;
    await expect(read(['quests'])).rejects.toThrow('disabled');
    expect(request).toHaveBeenCalledTimes(2);
  }
});
