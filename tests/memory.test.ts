import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseScope } from './database-fixture.ts';
import { MemoryStore } from '@wisp/bridge/memory-store';
import { characterIdentity } from '@wisp/bridge/context';
import { localMemory } from '@wisp/agent/agent-memory';

test(
  'memory survives new store instances, isolates characters, and serializes concurrent updates',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wow-wisp-memory-'));
    const scope = databaseScope();
    try {
      const file = path.join(directory, 'wisp.sqlite');
      const store = new MemoryStore(scope.open(file));
      await Promise.all([
        store.update(
          'character',
          'mage',
          'guide',
          'Following Guide A, chapter 2; reported by the user.',
        ),
        store.update('character', 'mage', 'goal', 'Explore Durotar'),
        store.update('character', 'warrior', 'guide', 'Following Guide B'),
        store.update('preferences', 'local-player', 'pace', 'Prefers exploration'),
      ]);
      const restarted = new MemoryStore(scope.open(file));
      assert.equal((await restarted.read('character', 'mage')).length, 2);
      assert.equal((await restarted.read('character', 'warrior'))[0].text, 'Following Guide B');
      await restarted.update('character', 'mage', 'guide', 'Stopped following Guide A');
      assert.equal(
        (await restarted.read('character', 'mage')).filter((entry) => entry.key === 'guide').length,
        1,
      );
      await restarted.update('character', 'mage', 'guide');
      assert.equal((await new MemoryStore(scope.open(file)).read('character', 'mage')).length, 1);
      assert.equal(
        (await restarted.read('preferences', 'local-player'))[0].text,
        'Prefers exploration',
      );
      await assert.rejects(restarted.update('character', 'mage', '../escape', 'bad'));
      await assert.rejects(restarted.update('character', 'mage', 'oversized', 'x'.repeat(1001)));
    } finally {
      assert.ok(directory.startsWith(path.join(tmpdir(), 'wow-wisp-memory-')));
      await scope.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
  const context = (name: string) => ({
    sections: {
      character: { status: 'available', data: { name, realm: 'Realm', game: 'WoW Forever' } },
    },
  });
  assert.notEqual(characterIdentity(context('Mage')), characterIdentity(context('Warrior')));
  assert.equal(characterIdentity(undefined), undefined);
});
