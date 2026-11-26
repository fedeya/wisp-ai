import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createAgentCalls } from '../src/agent/agent-calls.ts';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

type CallDependencies = Parameters<typeof createAgentCalls>[0];

function calls(deps: Partial<CallDependencies>) {
  return createAgentCalls({
    currentTransport: () => 'addon',
    capabilitySettings: { enabled: () => true },
    ...deps,
  } as unknown as CallDependencies);
}

const signal = () => new AbortController().signal;

const workingChat = (proactive = false) => ({
  ...newChat('chat', 'addon'),
  status: 'working' as const,
  agentSession: 'eve',
  characterKey: 'Realm-Name',
  proactive,
});

test('the loopback server only serves its token and its routes', async () => {
  const server = createServer(
    createAgentHandler({ token: 'test' } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const forbidden = await fetch(origin + '/model/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('Forbidden');
    // The agent's calls are no longer routes.
    const identity = await fetch(origin + '/identity', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: '{}',
    });
    expect(identity.status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test('a call reaches the working chat of its session', async () => {
  const agent = calls({ getChats: () => [workingChat()] });
  await expect(agent.call('eve', 'identity', {}, signal())).resolves.toEqual({
    characterKey: 'Realm-Name',
  });
  await expect(agent.call('other', 'identity', {}, signal())).rejects.toThrow(
    'No active connection for this character',
  );
});

test('automatic suggestions cannot change what the player owns', async () => {
  const agent = calls({ getChats: () => [workingChat(true)] });
  await expect(
    agent.call(
      'eve',
      'memory',
      { slot: 'character', operation: 'save', key: 'k', text: 't' },
      signal(),
    ),
  ).rejects.toThrow(/Automatic suggestions cannot change/);
});

test('actions run without a character identity and add the expected character when known', async () => {
  const unknown = { ...workingChat(), characterKey: undefined };
  const known = {
    ...workingChat(),
    agentSession: 'known',
    characterKey: JSON.stringify(['WoW Forever', '', 'Fedrath']),
  };
  const request = vi.fn(async (_input: { action?: unknown }) => ({ status: 'completed' }));
  const agent = calls({ getChats: () => [unknown, known], pending: { request } as never });
  const waypoint = {
    kind: 'set_waypoint' as const,
    args: { mapId: 1, x: 50, y: 50, label: 'NPC', source: 'user' as const, navigate: true },
  };
  for (const session of ['eve', 'known']) {
    await agent.call(session, 'action', { action: waypoint }, signal());
  }
  expect(request.mock.calls.map(([input]) => input.action)).toEqual([
    waypoint,
    { ...waypoint, expectedCharacter: { realm: '', name: 'Fedrath' } },
  ]);
});

test("a game request is cancelled with the tool call's signal", async () => {
  let seen: AbortSignal | undefined;
  const request = vi.fn(
    (_input: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => reject(Error('aborted')));
      }),
  );
  const agent = calls({ getChats: () => [workingChat()], pending: { request } as never });
  const cancel = new AbortController();
  const reply = agent
    .call('eve', 'inspect', { inspection: { kind: 'target', args: {} } }, cancel.signal)
    .catch(() => undefined);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(seen?.aborted).toBe(false);
  cancel.abort();
  await reply;
  expect(seen?.aborted).toBe(true);
});

test('web search reports its depth, provider and outcome without the query', async () => {
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
  const agent = calls({
    getChats: () => [workingChat()],
    defaultModel: () => 'model',
    telemetry,
    webSearch: { search, available: () => true } as never,
  });
  await agent.call('eve', 'wowhead', { query: 'private query', depth: 'deep' } as never, signal());
  expect(telemetry.webSearch).toHaveBeenLastCalledWith({
    depth: 'deep',
    provider: 'Exa',
    outcome: 'available',
    duration: expect.any(Number),
    resultCount: 2,
  });
  await expect(
    agent.call('eve', 'wowhead', { query: 'private query', depth: 'standard' } as never, signal()),
  ).rejects.toThrow('Private provider failure');
  expect(telemetry.webSearch).toHaveBeenLastCalledWith({
    depth: 'standard',
    provider: undefined,
    outcome: 'failed',
    duration: expect.any(Number),
    resultCount: 0,
  });
  expect(JSON.stringify(telemetry.webSearch.mock.calls)).not.toContain('private');
});
