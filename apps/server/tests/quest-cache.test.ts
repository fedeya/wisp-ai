import { test, expect, vi } from 'vitest';
import { Effect } from 'effect';
import { make as makeGameAccess } from '../src/game/agent-game-access.ts';
import type { CharacterSections } from '@wisp/agent/game-access';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { characterIdentity, rememberTurnQuests } from '../src/chat/context.ts';

test('GameAccess serves quests locally, fetches only missing sections, and respects refresh and permissions', async () => {
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
  const game = makeGameAccess({
    getChats: () => [chat],
    currentTransport: () => 'addon',
    capabilitySettings: { enabled: () => allowed },
    requestGame: request,
    mcpManager: { call: vi.fn() },
  });
  const read = (sections: CharacterSections, refresh?: boolean) =>
    Effect.runPromise(game.readCharacter('eve', sections, refresh));
  expect(await read(['quests'])).toMatchObject({
    sections: { quests: { data: { quests: [{ title: 'Cached delivery', rewardXP: 850 }] } } },
  });
  expect(request).not.toHaveBeenCalled();
  expect(await read(['quests', 'talents'])).toMatchObject({
    sections: {
      quests: { data: { quests: [{ title: 'Cached delivery', rewardXP: 850 }] } },
      talents: { data: { unspentPoints: 1 } },
    },
  });
  expect(request).toHaveBeenLastCalledWith({
    chat: 'chat',
    session: 'addon',
    agent: true,
    operation: { kind: 'read', sections: ['talents'] },
  });
  await read(['quests'], true);
  expect(request).toHaveBeenLastCalledWith({
    chat: 'chat',
    session: 'addon',
    agent: true,
    operation: { kind: 'read', sections: ['quests'] },
  });
  allowed = false;
  await expect(read(['quests'])).rejects.toThrow('disabled');
  expect(request).toHaveBeenCalledTimes(2);
});
