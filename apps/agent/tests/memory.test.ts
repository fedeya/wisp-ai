import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sessionHost, type AgentHostCalls } from '../src/contract/host-calls.ts';
import { localMemory } from '../src/wisp/agent-memory.ts';

test('memory recalls saved entries and character scope fails closed without identity', async () => {
  const entries = [{ key: 'guide', text: 'Guide A', updatedAt: '2026-11-07' }];
  const requests: Record<string, unknown>[] = [];
  const calls: AgentHostCalls = {
    selectedModel: () => Promise.reject(Error('Not used')),
    call: async (session, call, input) => {
      requests.push({ session, call, ...input });
      return (
        call === 'identity' ? { characterKey: session === 'unknown' ? null : 'mage' } : { entries }
      ) as never;
    },
  };
  const host = (session: string) => sessionHost(calls, session, new AbortController().signal);
  const ctx = (id: string) => ({
    session: { id },
    abortSignal: new AbortController().signal,
    callId: 'call',
    host: host(id),
  });

  const memory = localMemory('character');
  assert.equal(await memory.scope(host('first')), 'mage');
  assert.equal(await memory.scope(host('unknown')), null);
  assert.match((await memory.recall(host('new-session')))!, /Guide A/);
  assert.equal(requests.at(-1)?.session, 'new-session');
  assert.equal(requests.at(-1)?.slot, 'character');
  const tools = memory.tools();
  assert.deepEqual(Object.keys(tools), ['character__save_memory', 'character__remove_memory']);
  await tools.character__save_memory!.execute(
    { key: 'guide', text: 'Guide B' },
    ctx('new-session'),
  );
  assert.deepEqual(requests.at(-1), {
    session: 'new-session',
    call: 'memory',
    slot: 'character',
    operation: 'save',
    key: 'guide',
    text: 'Guide B',
  });
  await tools.character__remove_memory!.execute({ key: 'guide' }, ctx('new-session'));
  assert.equal(requests.at(-1)?.operation, 'remove');
  assert.equal(await localMemory('preferences').scope(host('new-session')), 'local-player');
  entries.length = 0;
  assert.equal(await memory.recall(host('new-session')), null);
});
