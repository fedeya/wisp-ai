import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseScope } from './database-fixture.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { characterIdentity } from '../src/context.ts';

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
test('character memory identity distinguishes characters and rejects missing identity', () => {
  const context = (name: string) => ({
    sections: {
      character: { status: 'available', data: { name, realm: 'Realm', game: 'WoW Forever' } },
    },
  });
  assert.notEqual(characterIdentity(context('Mage')), characterIdentity(context('Warrior')));
  assert.equal(characterIdentity(undefined), undefined);
});
