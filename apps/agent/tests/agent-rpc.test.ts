import { test, expect, vi, afterEach } from 'vitest';
import { agentRPC } from '../src/agent-rpc.ts';
import { rpcRequests } from '@wisp/protocol/agent-rpc';
afterEach(() => vi.unstubAllGlobals());
test('strict domain schemas accept their RPC session envelope without accepting unrelated fields', () => {
  const search = { eveSession: 'session', operation: 'search', kind: 'spell', query: 'Frost Nova' };
  expect(rpcRequests.database.parse(search).eveSession).toBe('session');
  expect(
    rpcRequests.database.parse({ eveSession: 'session', operation: 'get', kind: 'spell', id: 122 })
      .operation,
  ).toBe('get');
  expect(rpcRequests.wowhead.parse({ eveSession: 'session', query: 'Mage guide' }).query).toBe(
    'Mage guide',
  );
  expect(
    rpcRequests.simulate.parse({
      eveSession: 'session',
      plans: [{ label: 'Test', priority: [{ spellId: 116 }] }],
    }).iterations,
  ).toBe(500);
  expect(rpcRequests.database.safeParse({ ...search, arbitraryCode: 'bad' }).success).toBe(false);
});

test('RPC validates inputs and memory responses instead of trusting JSON casts', async () => {
  const fetch = vi.fn(async () => Response.json({ entries: [{ key: 'plan', text: 42 }] }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    agentRPC('memory', { eveSession: 'session', slot: 'character', operation: 'list' }),
  ).rejects.toThrow();
  await expect(agentRPC('state', { eveSession: 'session', sections: [] })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('RPC preserves caller cancellation alongside its timeout', async () => {
  const abort = new AbortController();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      signal = init.signal;
      return Response.json({ characterKey: null });
    }),
  );
  expect(await agentRPC('identity', { eveSession: 'session' }, abort.signal)).toEqual({
    characterKey: null,
  });
  abort.abort();
  expect(signal?.aborted).toBe(true);
});

test('search budgets survive the RPC envelope and reject out-of-bound overrides', async () => {
  const payload = {
    eveSession: 'test',
    query: 'Availability',
    depth: 'deep' as const,
    maxResults: 8,
    maxQueries: 4,
    timeoutSeconds: 120,
    excerptCharacters: 6000,
    queries: ['Alternate route'],
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    return Response.json({ status: 'available', sources: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  await agentRPC('wowhead', payload);
  for (const invalid of [
    { maxResults: 13 },
    { timeoutSeconds: 181 },
    { maxQueries: 7 },
    { excerptCharacters: 12001 },
    { depth: 'unlimited' },
    { maxResults: 0 },
  ]) {
    expect(rpcRequests.wowhead.safeParse({ ...payload, ...invalid }).success).toBe(false);
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});
