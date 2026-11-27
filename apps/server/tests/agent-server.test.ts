import { test, expect, vi } from 'vitest';
import { Effect } from 'effect';
import type { GameCall } from '@wisp/wow-bridge';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { make as makeGameAccess } from '../src/game/agent-game-access.ts';
import { make as makeMemoryAccess } from '../src/memory/agent-access.ts';
import { runBridgeEffect } from './capture-logs.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

async function serve(deps: Partial<Parameters<typeof createAgentHandler>[0]>) {
  const server = createServer(
    runBridgeEffect(
      createAgentHandler({
        token: 'test',
        currentTransport: () => 'addon',
        capabilitySettings: { enabled: () => true },
        invalidateAddonView: () => {},
        saveChats: () => {},
        ...deps,
      } as unknown as Parameters<typeof createAgentHandler>[0]),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const post = (route: string, body: unknown, init: RequestInit = {}) =>
    fetch(origin + route, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    });
  return {
    origin,
    post,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const workingChat = (proactive = false) => ({
  ...newChat('chat', 'addon'),
  status: 'working' as const,
  agentSession: 'eve',
  characterKey: 'Realm-Name',
  proactive,
});

test('agent server rejects bad tokens, unknown routes and oversized bodies', async () => {
  const chat = workingChat();
  const server = await serve({ getChats: () => [chat] });
  try {
    const forbidden = await fetch(server.origin + '/title', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('Forbidden');
    expect((await server.post('/unknown', {})).status).toBe(404);
    for (const route of ['/state', '/inspect', '/action', '/identity', '/memory']) {
      expect((await server.post(route, {})).status).toBe(404);
    }
    expect(
      (await fetch(server.origin + '/title', { headers: { authorization: 'Bearer test' } })).status,
    ).toBe(404);
    const large = await server.post('/title', { agentSession: 'eve', pad: 'x'.repeat(40000) });
    expect(large.status).toBe(503);
    expect(await large.text()).toBe('Request is too large');
    const title = await server.post('/title', { agentSession: 'eve', title: 'Plan' });
    expect(title.status).toBe(200);
    expect(await title.json()).toEqual({ title: 'Plan' });
  } finally {
    await server.close();
  }
});

test('panel tools invalidate the addon only after a write, without saving chats', async () => {
  const calls: string[] = [];
  const saveChats = vi.fn();
  const server = await serve({
    getChats: () => [workingChat()],
    panelRepository: {
      list: () => Effect.succeed([]),
      get: () => Effect.undefined,
      update: () =>
        Effect.sync(() => {
          calls.push('commit');
          return [];
        }),
    },
    invalidateAddonView: () => {
      calls.push('invalidate');
    },
    saveChats,
  });
  try {
    const post = (input: unknown) => server.post('/panels', { agentSession: 'eve', input });
    expect((await post({ operation: 'list' })).status).toBe(200);
    expect((await post({ operation: 'get', id: 'panel' })).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await post({ operation: 'remove', id: 'panel' })).status).toBe(200);
    expect(calls).toEqual(['commit', 'invalidate']);
    expect(saveChats).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

test('memory access refuses changes from automatic suggestions and rejects unknown sessions', async () => {
  const chat = workingChat(true);
  const update = vi.fn(() => Effect.succeed([]));
  const entry = { key: 'plan', text: 'Remember this', updatedAt: '2026-11-09' };
  const memoryAccess = makeMemoryAccess({
    repository: {
      read: () => Effect.succeed([{ ...entry, extension: { source: 'legacy' } }]),
      update,
    },
    chats: () => [chat],
    currentTransport: () => 'addon',
    capabilities: { enabled: () => true },
    snapshot: () => Effect.succeed({ status: 'available', entries: [] }),
    setView: () => {},
  });
  await expect(
    Effect.runPromise(
      memoryAccess.update('eve', 'character', { operation: 'save', key: 'k', text: 't' }),
    ),
  ).rejects.toThrow('Automatic suggestions cannot change');
  expect(update).not.toHaveBeenCalled();
  expect(await Effect.runPromise(memoryAccess.read('eve', 'character'))).toEqual([entry]);
  await expect(Effect.runPromise(memoryAccess.characterKey('other'))).rejects.toThrow(
    'No active connection for this character',
  );
});

test('actions run without a character identity and add the expected character when known', async () => {
  const unknown = { ...workingChat(), characterKey: undefined };
  const known = {
    ...workingChat(),
    agentSession: 'known',
    characterKey: JSON.stringify(['WoW Forever', '', 'Fedrath']),
  };
  const request = vi.fn((_input: GameCall) => Effect.succeed({ status: 'completed' }));
  const game = makeGameAccess({
    getChats: () => [unknown, known, { ...workingChat(true), agentSession: 'automatic' }],
    requestGame: request,
    currentTransport: () => 'addon',
    capabilitySettings: { enabled: () => true },
    mcpManager: { call: vi.fn() },
  });
  const waypoint = {
    kind: 'set_waypoint' as const,
    args: { mapId: 1, x: 50, y: 50, label: 'NPC', source: 'user', navigate: true },
  };
  for (const agentSession of ['eve', 'known']) {
    await expect(Effect.runPromise(game.runGameAction(agentSession, waypoint))).resolves.toEqual({
      status: 'completed',
    });
  }
  await expect(Effect.runPromise(game.runGameAction('automatic', waypoint))).rejects.toThrow(
    'Automatic suggestions cannot change',
  );
  expect(
    request.mock.calls.map(([input]) =>
      input.operation.kind === 'act' ? input.operation.action : undefined,
    ),
  ).toEqual([waypoint, { ...waypoint, expectedCharacter: { realm: '', name: 'Fedrath' } }]);
});

test('raw loot reads require the dungeon loot capability', async () => {
  const chat = workingChat();
  const requestGame = vi.fn(() => Effect.succeed({ status: 'available', data: { items: [] } }));
  let allowed = false;
  const game = makeGameAccess({
    getChats: () => [chat],
    currentTransport: () => 'addon',
    requestGame,
    capabilitySettings: { enabled: (key) => key === 'tool:dungeon_loot' && allowed },
    mcpManager: { call: vi.fn() },
  });
  const inspection = { kind: 'gear_candidates' as const, args: { itemIds: [14149] } };
  await expect(Effect.runPromise(game.readGearCandidates('eve', inspection.args))).rejects.toThrow(
    'disabled',
  );
  expect(requestGame).not.toHaveBeenCalled();
  allowed = true;
  await expect(
    Effect.runPromise(game.readGearCandidates('eve', inspection.args)),
  ).resolves.toMatchObject({
    status: 'available',
  });
  expect(requestGame).toHaveBeenCalledExactlyOnceWith({
    chat: chat.id,
    session: 'addon',
    agent: true,
    operation: { kind: 'inspect', inspection },
  });
});

test('armor search can read catalog candidates with its own tool permission', async () => {
  const chat = workingChat();
  const requestGame = vi.fn(() =>
    Effect.succeed({ status: 'available', data: { items: [{ id: 14_149 }] } }),
  );
  const game = makeGameAccess({
    getChats: () => [chat],
    currentTransport: () => 'addon',
    requestGame,
    capabilitySettings: {
      enabled: (key) =>
        ['tool:search_armor', 'mcp:everloot', 'mcp_tool:everloot:item_categories'].includes(key),
    },
    mcpManager: {
      call: () =>
        Effect.succeed({ content: [], structuredContent: { items: [{ itemId: 14_149 }] } }),
    },
  });

  await expect(
    Effect.runPromise(
      game.searchArmor('eve', { slot: 'feet', armorType: 'cloth', quality: ['rare'] }),
    ),
  ).resolves.toMatchObject({
    status: 'available',
    catalog: { listed: 1 },
    data: { items: [{ id: 14_149 }] },
  });
  expect(requestGame).toHaveBeenCalledExactlyOnceWith({
    chat: chat.id,
    session: 'addon',
    agent: true,
    operation: {
      kind: 'inspect',
      inspection: { kind: 'gear_candidates', args: { itemIds: [14_149] } },
    },
  });
});

test('game inspection methods validate their readings and keep addon failure replies', async () => {
  const chat = workingChat();
  const failure = { status: 'unavailable', error: 'No target selected' };
  const requestGame = vi
    .fn<() => Effect.Effect<unknown>>()
    .mockReturnValueOnce(
      Effect.succeed({ status: 'available', data: { items: [{ id: '14149' }] } }),
    )
    .mockReturnValueOnce(Effect.succeed(failure))
    .mockReturnValueOnce(
      Effect.succeed({
        status: 'available',
        data: { level: 23, note: 'Target', nativeExtension: 'preserved' },
      }),
    )
    .mockReturnValueOnce(
      Effect.succeed({ status: 'available', data: { items: [{ id: 14149, stats: [] }] } }),
    );
  const game = makeGameAccess({
    getChats: () => [chat],
    currentTransport: () => 'addon',
    requestGame,
    capabilitySettings: { enabled: () => true },
    mcpManager: { call: vi.fn() },
  });
  const readGear = () => Effect.runPromise(game.readGearCandidates('eve', { itemIds: [14149] }));
  await expect(readGear()).rejects.toThrow('number');
  await expect(Effect.runPromise(game.readTarget('eve', {}))).resolves.toEqual(failure);
  await expect(Effect.runPromise(game.readTarget('eve', {}))).resolves.toMatchObject({
    status: 'available',
    data: { level: 23, nativeExtension: 'preserved' },
  });
  await expect(readGear()).resolves.toMatchObject({ data: { items: [{ id: 14149, stats: [] }] } });
});

test('interrupting an in-process inspection aborts the pending game request', async () => {
  const chat = workingChat();
  let seen: AbortSignal | undefined;
  const request = vi.fn(() =>
    Effect.promise((signal) => {
      seen = signal;
      return new Promise(() => {});
    }),
  );
  const game = makeGameAccess({
    getChats: () => [chat],
    requestGame: request,
    currentTransport: () => 'addon',
    capabilitySettings: { enabled: () => true },
    mcpManager: { call: vi.fn() },
  });
  const client = new AbortController();
  const reply = Effect.runPromiseExit(game.readTarget('eve', {}), {
    signal: client.signal,
  });
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(seen?.aborted).toBe(false);
    client.abort();
    expect((await reply)._tag).toBe('Failure');
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  } finally {
    client.abort();
    await reply;
  }
});

test('web search reports its depth, provider and outcome without the query', async () => {
  const chat = workingChat();
  const search = vi
    .fn()
    .mockResolvedValueOnce({
      status: 'available',
      source: 'Web',
      version: 'unspecified',
      query: 'private query',
      provider: 'Exa',
      sources: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
    })
    .mockRejectedValueOnce(Error('Private provider failure'));
  const telemetry = { webSearch: vi.fn() };
  const server = await serve({
    getChats: () => [chat],
    defaultModel: () => 'model',
    telemetry,
    webSearch: { search, available: () => true },
  });
  try {
    const found = await server.post('/wowhead', {
      agentSession: 'eve',
      query: 'private query',
      depth: 'deep',
    });
    expect(found.status).toBe(200);
    expect(telemetry.webSearch).toHaveBeenLastCalledWith({
      depth: 'deep',
      provider: 'Exa',
      outcome: 'available',
      duration: expect.any(Number),
      resultCount: 2,
    });
    expect(
      (await server.post('/wowhead', { agentSession: 'eve', query: 'private query' })).status,
    ).toBe(503);
    expect(telemetry.webSearch).toHaveBeenLastCalledWith({
      depth: 'standard',
      provider: undefined,
      outcome: 'failed',
      duration: expect.any(Number),
      resultCount: 0,
    });
    expect(JSON.stringify(telemetry.webSearch.mock.calls)).not.toContain('private');
  } finally {
    await server.close();
  }
});
