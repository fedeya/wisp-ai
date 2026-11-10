import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentHandler } from '@wisp/bridge/agent-server';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { inspectionSchema, travelInput } from '@wisp/protocol/game-inspection';
import { rpcRequests } from '@wisp/protocol/agent-rpc';
import { compactModelContext, searchToolGroups } from '@wisp/agent/model-tools';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import travel from '../apps/agent/agent/tools/wow__inspect_travel.ts';

test('locations discovery lazily exposes the actual travel definition and instructions', async () => {
  expect(searchToolGroups('hearthstone flight travel').matches[0]).toMatchObject({
    group: 'locations',
    tools: expect.arrayContaining(['wow__inspect_travel']),
  });
  const instructions = await readFile('apps/agent/agent/instructions.md', 'utf8');
  const base = {
    tools: ['wisp__load_tools', 'wow__inspect_travel'].map((name) => ({
      type: 'function' as const,
      name,
      description: '',
      inputSchema: {},
    })),
    prompt: [{ role: 'system' as const, content: instructions }],
  };
  const hidden = compactModelContext(base);
  expect(hidden.tools?.map((t) => t.name)).not.toContain('wow__inspect_travel');
  expect(hidden.prompt[0]).not.toMatchObject({
    content: expect.stringContaining('Use wow__inspect_travel'),
  });
  const loaded = compactModelContext({
    ...base,
    prompt: [
      ...base.prompt,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'load',
            toolName: 'wisp__load_tools',
            output: { type: 'json', value: { enabledGroups: ['locations'] } },
          },
        ],
      },
    ],
  });
  expect(loaded.tools?.map((t) => t.name)).toContain('wow__inspect_travel');
  expect(loaded.prompt[0]).toMatchObject({
    content: expect.stringContaining('Use wow__inspect_travel'),
  });
});

test('travel schema is exact and bounded, with a registered core capability', () => {
  expect(travelInput.parse({})).toEqual({ limit: 50 });
  expect(defaultCapabilities()).toContainEqual(
    expect.objectContaining({
      id: 'tool:inspect_travel',
      toolName: 'wow__inspect_travel',
      parent: 'core:wow',
    }),
  );
  expect(inspectionSchema.parse({ kind: 'travel', args: {} })).toEqual({
    kind: 'travel',
    args: { limit: 50 },
  });
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { mapId: 42 },
    { takeFlight: true },
  ]) {
    expect(
      rpcRequests.inspect.safeParse({ eveSession: 'eve', inspection: { kind: 'travel', args } })
        .success,
    ).toBe(false);
  }
});

test('actual travel tool uses the authenticated inspect RPC and existing capability/session admission', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-travel-'));
  const previous = {
    file: process.env.WOW_CAPABILITIES_FILE,
    url: process.env.WOW_BRIDGE_URL,
    token: process.env.WOW_BRIDGE_TOKEN,
  };
  const settings = new CapabilitySettings(path.join(directory, 'choices.json'));
  settings.agentFile = path.join(directory, 'agent.json');
  process.env.WOW_CAPABILITIES_FILE = settings.agentFile;
  let calls = 0;
  let active = true;
  const response = {
    status: 'available',
    data: {
      hearthstone: { status: 'available', itemId: 6948, owned: true },
      bind: { status: 'available', name: 'Inn', capturedAt: 123, provenance: 'GetBindLocation' },
      flights: { status: 'unavailable', reason: 'flight_window_closed' },
    },
  };
  const server = createServer(
    createAgentHandler({
      token: 'fixture',
      getChats: () => [
        { ...newChat('chat', 'addon'), status: active ? 'working' : 'idle', eveId: 'eve' },
      ],
      currentTransport: () => 'addon',
      capabilitySettings: settings,
      pending: {
        request: async (input: unknown) => {
          calls++;
          expect(input).toEqual({
            chat: 'chat',
            session: 'addon',
            inspection: { kind: 'travel', args: { limit: 5 } },
          });
          return response;
        },
      },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.WOW_BRIDGE_URL = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  process.env.WOW_BRIDGE_TOKEN = 'fixture';
  try {
    await settings.publish();
    const definition = await dynamicEvaluate(travel)({} as never);
    expect(definition).toBeTruthy();
    const execute = (
      definition as unknown as {
        execute: (args: { limit: number }, ctx: unknown) => Promise<unknown>;
      }
    ).execute;
    const ctx = { session: { id: 'eve' }, abortSignal: new AbortController().signal };
    expect(await execute({ limit: 5 }, ctx)).toEqual(response);
    await expect(settings.set('tool:inspect_travel', false)).rejects.toThrow('invalid setting');
    settings.availability.set('core:wow', { available: false, status: 'offline' });
    await settings.publish();
    expect(await dynamicEvaluate(travel)({} as never)).toBeNull();
    await expect(execute({ limit: 5 }, ctx)).rejects.toThrow('disabled');
    settings.availability.delete('core:wow');
    await settings.publish();
    active = false;
    await expect(execute({ limit: 5 }, ctx)).rejects.toThrow();
    active = true;
    process.env.WOW_BRIDGE_TOKEN = 'wrong';
    await expect(execute({ limit: 5 }, ctx)).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    for (const [key, value] of Object.entries({
      WOW_CAPABILITIES_FILE: previous.file,
      WOW_BRIDGE_URL: previous.url,
      WOW_BRIDGE_TOKEN: previous.token,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
