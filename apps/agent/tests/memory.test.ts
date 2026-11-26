import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Effect, FileSystem } from 'effect';

import { AgentCapabilities, layerFromFile } from '../src/host/capabilities.ts';
import { localMemory } from '../src/wisp/agent-memory.ts';

const signal = () => new AbortController().signal;
const ctx = (id: string) => ({ session: { id }, abortSignal: signal(), callId: 'call' });

test('memory recalls saved entries and character scope fails closed without identity', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [{ key: 'guide', text: 'Guide A', updatedAt: '2026-11-07' }];
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    const data = JSON.parse(String(init?.body));
    requests.push(data);
    return new Response(
      JSON.stringify(
        String(url).endsWith('/identity')
          ? { characterKey: data.agentSession === 'unknown' ? null : 'mage' }
          : { entries },
      ),
    );
  };
  try {
    const capabilities = await Effect.runPromise(
      Effect.flatMap(AgentCapabilities, (settings) => settings.read).pipe(
        Effect.provide(layerFromFile(() => undefined)),
        Effect.provide(FileSystem.layerNoop({})),
      ),
    );
    const memory = localMemory('character');
    assert.equal(await Effect.runPromise(memory.scope('first', capabilities)), 'mage');
    assert.equal(await Effect.runPromise(memory.scope('unknown', capabilities)), null);
    assert.match((await Effect.runPromise(memory.recall('new-session')))!, /Guide A/);
    assert.equal(requests.at(-1)?.agentSession, 'new-session');
    assert.equal(requests.at(-1)?.slot, 'character');
    const tools = memory.tools();
    assert.deepEqual(Object.keys(tools), ['character__save_memory', 'character__remove_memory']);
    await tools.character__save_memory!.execute(
      { key: 'guide', text: 'Guide B' },
      ctx('new-session'),
    );
    assert.deepEqual(requests.at(-1), {
      agentSession: 'new-session',
      slot: 'character',
      operation: 'save',
      key: 'guide',
      text: 'Guide B',
    });
    await tools.character__remove_memory!.execute({ key: 'guide' }, ctx('new-session'));
    assert.equal(requests.at(-1)?.operation, 'remove');
    assert.equal(
      await Effect.runPromise(localMemory('preferences').scope('new-session', capabilities)),
      'local-player',
    );
    entries.length = 0;
    assert.equal(await Effect.runPromise(memory.recall('new-session')), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
