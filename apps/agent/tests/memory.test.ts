import { test } from 'vitest';
import assert from 'node:assert/strict';

import { localMemory } from '../src/agent-memory.ts';
test('native Eve memory recalls on a new session and character scope fails closed without identity', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [{ key: 'guide', text: 'Guide A', updatedAt: '2026-11-07' }];
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    const data = JSON.parse(String(init?.body));
    requests.push(data);
    return new Response(
      JSON.stringify(
        String(url).endsWith('/identity')
          ? { characterKey: data.eveSession === 'unknown' ? null : 'mage' }
          : { entries },
      ),
    );
  };
  try {
    const memory = localMemory('character');
    assert.equal(typeof memory.scope, 'function');
    const scope = memory.scope as (ctx: any) => Promise<string | null>;
    assert.equal(
      await scope({ session: { id: 'first' }, abortSignal: new AbortController().signal }),
      'mage',
    );
    assert.equal(
      await scope({ session: { id: 'unknown' }, abortSignal: new AbortController().signal }),
      null,
    );
    const recalled = await memory.provider.recall['turn.started']({
      session: { id: 'new-session' },
      abortSignal: new AbortController().signal,
    } as never);
    assert.match(JSON.stringify(recalled), /Guide A/);
    assert.equal(requests.at(-1)?.eveSession, 'new-session');
    assert.equal(requests.at(-1)?.slot, 'character');
    const tools = await memory.provider.tools!({
      session: { id: 'new-session' },
      abortSignal: new AbortController().signal,
    } as never);
    await (tools!.save_memory as any).execute({ key: 'guide', text: 'Guide B' });
    assert.deepEqual(requests.at(-1), {
      eveSession: 'new-session',
      slot: 'character',
      operation: 'save',
      key: 'guide',
      text: 'Guide B',
    });
    await (tools!.remove_memory as any).execute({ key: 'guide' });
    assert.equal(requests.at(-1)?.operation, 'remove');
    const preferences = localMemory('preferences');
    assert.equal(
      await (preferences.scope as any)({
        session: { id: 'new-session' },
        abortSignal: new AbortController().signal,
      }),
      'local-player',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
