import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import rewards from '../apps/agent/agent/tools/wow__inspect_quest_rewards.ts';
import { createAgentHandler } from '../apps/bridge/src/agent-server.ts';
import { CapabilitySettings } from '../apps/bridge/src/capabilities.ts';
import { GameRequests } from '../apps/bridge/src/game-requests.ts';
import { newChat } from '../apps/bridge/src/chat-lifecycle.ts';
import { inspectionSchema, questRewardsInput } from '@wisp/protocol/game-inspection';
import { observeQuestRewards } from './addon/quest-rewards-fixture.ts';

test('quest rewards native definition -> authenticated RPC -> session-scoped production Lua observation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-quest-rewards-'));
  const previous = {
    flags: process.env.WOW_CAPABILITIES_FILE,
    url: process.env.WOW_BRIDGE_URL,
    token: process.env.WOW_BRIDGE_TOKEN,
  };
  const settings = new CapabilitySettings(path.join(root, 'settings.json'));
  settings.agentFile = path.join(root, 'agent.json');
  process.env.WOW_CAPABILITIES_FILE = settings.agentFile;
  const chat = newChat('rewards', 'test');
  chat.eveId = 'eve-rewards';
  chat.status = 'working';
  chat.owner = 'game-session';
  let transport = 'game-session';
  let reads = 0;
  const pending = new GameRequests(() => {
    const request = pending.snapshot()[0];
    if (!request) return;
    queueMicrotask(() => {
      reads++;
      expect(request.inspection).toEqual({ kind: 'quest_rewards', args: {} });
      expect(pending.receive(request.id, 'old-session', chat.id, {})).toBe(false);
      expect(pending.receive(request.id, transport, 'other-chat', {})).toBe(false);
      pending.receive(request.id, transport, chat.id, observeQuestRewards());
    });
  });
  const handler = createAgentHandler({
    token: 'fixture-token',
    capabilitySettings: settings,
    pending,
    getChats: () => [chat],
    currentTransport: () => transport,
  } as Parameters<typeof createAgentHandler>[0]);
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  process.env.WOW_BRIDGE_URL = origin;
  process.env.WOW_BRIDGE_TOKEN = 'fixture-token';
  try {
    await settings.publish();
    const resolve = () => dynamicEvaluate(rewards)({} as never);
    const tool = await resolve();
    expect(tool).toMatchObject({ deferred: true });
    const execute = () =>
      tool!.execute({}, {
        session: { id: chat.eveId },
        abortSignal: new AbortController().signal,
      } as never);
    const result = (await execute()) as ReturnType<typeof observeQuestRewards>;
    expect(result.status).toBe('available');
    expect(result.data.choices.options).toHaveLength(3);
    expect(result.data.guaranteed.options).toHaveLength(1);
    expect(result.data.choices.options[0].link).toBe('item:100:choice1');
    expect(result.data.choices.options[1].link).toBe('item:100:choice2');
    expect(result.data.choices.options[0].comparisons.map((c: { slot: number }) => c.slot)).toEqual(
      [11, 12],
    );
    expect(result.data.choices.options[2]).toMatchObject({
      status: 'loading',
      statsStatus: 'unknown',
    });
    expect(result.data.choices.options[2].stats).toBeUndefined();
    process.env.WOW_BRIDGE_TOKEN = 'wrong';
    await expect(execute()).rejects.toThrow('Forbidden');
    process.env.WOW_BRIDGE_TOKEN = 'fixture-token';
    settings.availability.set('tool:inspect_quest_rewards', {
      available: false,
      status: 'unavailable',
    });
    await settings.publish();
    expect(await resolve()).toBeNull();
    await expect(execute()).rejects.toThrow('disabled');
    settings.availability.delete('tool:inspect_quest_rewards');
    settings.availability.set('core:wow', { available: false, status: 'unavailable' });
    await settings.publish();
    expect(await resolve()).toBeNull();
    await expect(execute()).rejects.toThrow('disabled');
    settings.availability.delete('core:wow');
    await settings.publish();
    transport = 'new-session';
    await expect(execute()).rejects.toThrow('No active connection');
    transport = chat.owner;
    chat.status = 'idle';
    await expect(execute()).rejects.toThrow('No active connection');
    expect(reads).toBe(1);
  } finally {
    pending.cancelAll('Test complete');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries({
      WOW_CAPABILITIES_FILE: previous.flags,
      WOW_BRIDGE_URL: previous.url,
      WOW_BRIDGE_TOKEN: previous.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('quest reward protocol is current-dialog-only and rejects action/quest/limit inputs', () => {
  expect(inspectionSchema.safeParse({ kind: 'quest_rewards', args: {} }).success).toBe(true);
  for (const args of [{ questId: 42 }, { claim: true }, { limit: 1000 }, { select: 1 }]) {
    expect(questRewardsInput.safeParse(args).success).toBe(false);
  }
});
