import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import definition from '../apps/agent/agent/tools/wow__inspect_pet.ts';
import { createAgentHandler } from '../apps/bridge/src/agent-server.ts';
import { CapabilitySettings } from '../apps/bridge/src/capabilities.ts';
import { newChat } from '../apps/bridge/src/chat-lifecycle.ts';
import { inspectionSchema } from '@wisp/protocol/game-inspection';

test('inspect_pet native dynamic definition executes authenticated scoped RPC and honors capability gates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-pet-'));
  const keys = ['WOW_CAPABILITIES_FILE', 'WOW_BRIDGE_URL', 'WOW_BRIDGE_TOKEN'] as const;
  const previous = keys.map((key) => process.env[key]);
  const settings = new CapabilitySettings(path.join(root, 'choices.json'));
  settings.agentFile = path.join(root, 'agent.json');
  process.env.WOW_CAPABILITIES_FILE = settings.agentFile;
  const chat = newChat('pet', 'addon');
  chat.status = 'working';
  chat.eveId = 'eve-pet';
  let transport = 'addon';
  const calls: unknown[] = [];
  const result = { status: 'available', capturedAt: 123, data: { presence: 'absent' } };
  const server = createServer(
    createAgentHandler({
      token: 'pet-token',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: settings,
      pending: {
        request: async (input: unknown) => {
          calls.push(input);
          return result;
        },
      },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  try {
    await settings.publish();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    process.env.WOW_BRIDGE_URL = url;
    process.env.WOW_BRIDGE_TOKEN = 'pet-token';
    const tool = (await dynamicEvaluate(definition as never)({} as never)) as {
      deferred: boolean;
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    } | null;
    expect(tool).toBeTruthy();
    expect(tool?.deferred).toBe(true);
    expect(inspectionSchema.safeParse({ kind: 'pet', args: {} }).success).toBe(true);
    for (const args of [{ toggle: true }, { pet: 'target' }, { limit: 1000 }, { refresh: true }]) {
      expect(inspectionSchema.safeParse({ kind: 'pet', args }).success).toBe(false);
    }
    const execute = () =>
      tool!.execute!({}, {
        session: { id: 'eve-pet' },
        abortSignal: AbortSignal.timeout(5000),
      } as never);
    expect(await execute()).toEqual(result);
    expect(calls).toEqual([
      { chat: 'pet', session: 'addon', inspection: { kind: 'pet', args: {} } },
    ]);
    const post = (body: unknown, token = 'pet-token') =>
      fetch(url + '/inspect', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
      });
    const payload = { eveSession: 'eve-pet', inspection: { kind: 'pet', args: {} } };
    expect((await post(payload, 'wrong')).status).toBe(403);
    expect((await post({ ...payload, eveSession: 'other' })).status).toBe(503);
    transport = 'replaced';
    expect((await post(payload)).status).toBe(503);
    transport = 'addon';
    chat.status = 'done';
    expect((await post(payload)).status).toBe(503);
    chat.status = 'working';
    settings.availability.set('tool:inspect_pet', { available: false, status: 'unavailable' });
    await settings.publish();
    expect(await dynamicEvaluate(definition as never)({} as never)).toBeNull();
    expect((await post(payload)).status).toBe(503);
    settings.availability.delete('tool:inspect_pet');
    settings.availability.set('core:wow', { available: false, status: 'unavailable' });
    await settings.publish();
    expect(await dynamicEvaluate(definition as never)({} as never)).toBeNull();
    expect((await post(payload)).status).toBe(503);
    expect(calls).toHaveLength(1);
  } finally {
    keys.forEach((key, i) =>
      previous[i] === undefined ? delete process.env[key] : (process.env[key] = previous[i]),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
