import { test, expect, vi } from 'vitest';
import { Effect } from 'effect';
import type { GameCall } from '@wisp/wow-bridge';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { make as makeGameAccess } from '../src/game/agent-game-access.ts';
import { runBridgeEffect } from './capture-logs.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

async function serve(deps: Partial<Parameters<typeof createAgentHandler>[0]>) {
  const server = createServer(
    runBridgeEffect(
      createAgentHandler({
        token: 'test',
        currentTransport: () => 'addon',
        capabilitySettings: { enabled: () => true },
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
    const forbidden = await fetch(server.origin + '/identity', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('Forbidden');
    expect((await server.post('/unknown', {})).status).toBe(404);
    for (const route of ['/state', '/inspect', '/action']) {
      expect((await server.post(route, {})).status).toBe(404);
    }
    expect(
      (await fetch(server.origin + '/identity', { headers: { authorization: 'Bearer test' } }))
        .status,
    ).toBe(404);
    const large = await server.post('/identity', { agentSession: 'eve', pad: 'x'.repeat(40000) });
    expect(large.status).toBe(503);
    expect(await large.text()).toBe('Request is too large');
    const identity = await server.post('/identity', { agentSession: 'eve' });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toEqual({ characterKey: 'Realm-Name' });
  } finally {
    await server.close();
  }
});

test('agent server refuses changes from automatic suggestions and reports the reason', async () => {
  const chat = workingChat(true);
  const server = await serve({ getChats: () => [chat] });
  try {
    const refused = await server.post('/memory', {
      agentSession: 'eve',
      slot: 'character',
      operation: 'save',
      key: 'k',
      text: 't',
    });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toMatch(/Automatic suggestions cannot change/);
    const missing = await server.post('/identity', { agentSession: 'other' });
    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe('No active connection for this character');
  } finally {
    await server.close();
  }
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
  const requestGame = vi.fn(() => Effect.succeed({ status: 'available', data: {} }));
  let allowed = false;
  const game = makeGameAccess({
    getChats: () => [chat],
    currentTransport: () => 'addon',
    requestGame,
    capabilitySettings: { enabled: (key) => key === 'tool:dungeon_loot' && allowed },
    mcpManager: { call: vi.fn() },
  });
  const inspection = { kind: 'gear_candidates' as const, args: { itemIds: [14149] } };
  await expect(Effect.runPromise(game.inspectGame('eve', inspection))).rejects.toThrow('disabled');
  expect(requestGame).not.toHaveBeenCalled();
  allowed = true;
  await expect(Effect.runPromise(game.inspectGame('eve', inspection))).resolves.toMatchObject({
    status: 'available',
  });
  expect(requestGame).toHaveBeenCalledExactlyOnceWith({
    chat: chat.id,
    session: 'addon',
    agent: true,
    operation: { kind: 'inspect', inspection },
  });
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
  const reply = Effect.runPromiseExit(game.inspectGame('eve', { kind: 'target', args: {} }), {
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
