import { test, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { groupInput, inspectionSchema } from '@wisp/protocol/game-inspection';
import { rpcRequests } from '@wisp/protocol/agent-rpc';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { compactModelContext, searchToolGroups } from '@wisp/agent/model-tools';
import { CapabilitySettings } from '@wisp/bridge/capabilities';
import { IntegrationState } from '@wisp/bridge/integration-state';
import { createAgentHandler } from '@wisp/bridge/agent-server';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import definition from '../apps/agent/agent/tools/wow__inspect_group.ts';

afterEach(() => vi.unstubAllEnvs());

test('group inspection is admitted by schema, capability registry and dedicated discovery', () => {
  expect(inspectionSchema.safeParse({ kind: 'group', args: { spellIds: [1459] } }).success).toBe(
    true,
  );
  expect(defaultCapabilities().find((c) => c.id === 'tool:inspect_group')?.toolName).toBe(
    'wow__inspect_group',
  );
  expect(searchToolGroups('party buffs auras').matches).toContainEqual({
    group: 'group',
    tools: ['wow__inspect_group'],
  });
});

test('exact bounded input rejects extra fields and invalid spell IDs through the RPC envelope', () => {
  expect(groupInput.parse({})).toEqual({ spellIds: [] });
  for (const args of [
    { spellIds: [0] },
    { spellIds: [-1] },
    { spellIds: [1.5] },
    { spellIds: ['1459'] },
    { spellIds: [2147483648] },
    { spellIds: Array(21).fill(1) },
    { cast: 1459 },
    { unit: 'raid1' },
    { maxAuras: 10000 },
  ]) {
    expect(
      rpcRequests.inspect.safeParse({ eveSession: 'eve', inspection: { kind: 'group', args } })
        .success,
    ).toBe(false);
  }
  expect(inspectionSchema.safeParse({ kind: 'group', args: {}, action: 'cast' }).success).toBe(
    false,
  );
});

test('group loads only its intended tool and instructions without enabling unavailable definitions', () => {
  const options: Parameters<typeof compactModelContext>[0] = {
    prompt: [{ role: 'system', content: readFileSync('apps/agent/agent/instructions.md', 'utf8') }],
    tools: [
      'wisp__load_tools',
      'wow__query_character',
      'wow__inspect_group',
      'wow__read_chat',
      'wow__inspect_map',
    ].map((name) => ({ type: 'function', name, inputSchema: { type: 'object' } })),
  };
  expect(compactModelContext(options).tools?.map((t) => t.name)).not.toContain(
    'wow__inspect_group',
  );
  options.prompt.push({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'load',
        toolName: 'wisp__load_tools',
        output: { type: 'json', value: { enabledGroups: ['group'] } },
      },
    ],
  });
  const loaded = compactModelContext(options);
  expect(loaded.tools?.map((t) => t.name)).toEqual([
    'wisp__load_tools',
    'wow__inspect_group',
    'wow__query_character',
  ]);
  expect(JSON.stringify(loaded.prompt)).toContain('Party buffs:');
  expect(JSON.stringify(loaded.prompt)).toContain('matches.present=false');
  options.tools = options.tools?.filter((t) => t.name !== 'wow__inspect_group');
  expect(compactModelContext(options).tools?.map((t) => t.name)).not.toContain(
    'wow__inspect_group',
  );
});

test('real tool executes group RPC through availability, auth and current-session admission', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-group-'));
  const settings = new CapabilitySettings(path.join(directory, 'settings.json'));
  settings.agentFile = path.join(directory, 'agent.json');
  vi.stubEnv('WOW_CAPABILITIES_FILE', settings.agentFile);
  const state = new IntegrationState(settings);
  const chat = { ...newChat('group-chat', 'addon'), status: 'working' as const, eveId: 'eve' };
  let transport = 'addon';
  const snapshot = {
    status: 'available',
    data: {
      mode: 'solo',
      members: [{ unit: 'player', guid: 'fixture', auraCoverage: 'complete', auras: [] }],
    },
  };
  const request = vi.fn(async () => snapshot);
  const server = createServer(
    createAgentHandler({
      token: 'fixture-token',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: settings,
      pending: { request },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  vi.stubEnv('WOW_BRIDGE_URL', url);
  vi.stubEnv('WOW_BRIDGE_TOKEN', 'fixture-token');
  const resolve = () => dynamicEvaluate(definition)({} as never);
  const context = { session: { id: 'eve' }, abortSignal: new AbortController().signal };
  try {
    await settings.publish();
    expect(await resolve()).toBeNull();
    expect(
      state.receive({
        version: 'fixture',
        questie: { status: 'missing', trainers: false, services: false },
      }),
    ).toBe(true);
    await settings.publish();
    const tool = (await resolve())!;
    expect(tool).toBeTruthy();
    const result = await tool.execute({ spellIds: [1459] }, context as never);
    expect(JSON.stringify(result)).toContain('fixture');
    expect(request).toHaveBeenLastCalledWith(
      {
        chat: 'group-chat',
        session: 'addon',
        inspection: { kind: 'group', args: { spellIds: [1459] } },
      },
      expect.any(AbortSignal),
    );
    transport = 'replacement-session';
    await expect(tool.execute({ spellIds: [] }, context as never)).rejects.toThrow();
    transport = 'addon';
    await expect(
      tool.execute({ spellIds: [] }, { ...context, session: { id: 'unknown' } } as never),
    ).rejects.toThrow();
    vi.stubEnv('WOW_BRIDGE_TOKEN', 'wrong');
    await expect(tool.execute({ spellIds: [] }, context as never)).rejects.toThrow('Forbidden');
    vi.stubEnv('WOW_BRIDGE_TOKEN', 'fixture-token');
    state.reset();
    await settings.publish();
    expect(await resolve()).toBeNull();
    await expect(tool.execute({ spellIds: [] }, context as never)).rejects.toThrow('disabled');
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
