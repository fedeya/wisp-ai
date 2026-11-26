import { test } from 'vitest';
import { it } from '@effect/vitest';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { MemoryStore } from '../src/agent/memory-store.ts';
import { characterIdentity } from '../src/chat/context.ts';
import { reopen, testStorage } from './storage-fixture.ts';

it.live(
  'memory survives new store instances, isolates characters, and serializes concurrent updates',
  () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore;
      yield* Effect.all(
        [
          store.update(
            'character',
            'mage',
            'guide',
            'Following Guide A, chapter 2; reported by the user.',
          ),
          store.update('character', 'mage', 'goal', 'Explore Durotar'),
          store.update('character', 'warrior', 'guide', 'Following Guide B'),
          store.update('preferences', 'local-player', 'pace', 'Prefers exploration'),
        ],
        { concurrency: 'unbounded' },
      );
      yield* reopen(
        Effect.gen(function* () {
          const restarted = yield* MemoryStore;
          assert.equal((yield* restarted.read('character', 'mage')).length, 2);
          assert.equal(
            (yield* restarted.read('character', 'warrior'))[0].text,
            'Following Guide B',
          );
          yield* restarted.update('character', 'mage', 'guide', 'Stopped following Guide A');
          const guides = (yield* restarted.read('character', 'mage')).filter(
            (entry) => entry.key === 'guide',
          );
          assert.equal(guides.length, 1);
          yield* restarted.update('character', 'mage', 'guide');
          assert.equal(
            (yield* restarted.read('preferences', 'local-player'))[0].text,
            'Prefers exploration',
          );
          const rejected = yield* Effect.flip(
            restarted.update('character', 'mage', '../escape', 'bad'),
          );
          assert.equal(rejected.reason._tag, 'MemoryRejected');
          const oversized = yield* Effect.flip(
            restarted.update('character', 'mage', 'oversized', 'x'.repeat(1001)),
          );
          assert.equal(oversized.reason._tag, 'MemoryRejected');
        }),
      );
      const afterRestart = yield* reopen(
        Effect.gen(function* () {
          return yield* (yield* MemoryStore).read('character', 'mage');
        }),
      );
      assert.equal(afterRestart.length, 1);
    }).pipe(Effect.provide(testStorage())),
  30_000,
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
