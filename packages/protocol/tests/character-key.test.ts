import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  characterLabel,
  expectedCharacter,
  parseCharacterKey,
  sameCharacter,
} from '../src/character-key.ts';

test('character keys accept the empty realm WoW Forever reports', () => {
  const realmless = JSON.stringify(['WoW Forever', '', 'Fedrath']);
  assert.deepEqual(parseCharacterKey(realmless), {
    game: 'WoW Forever',
    realm: '',
    name: 'Fedrath',
  });
  assert.equal(characterLabel(realmless), 'Fedrath');
  assert.equal(characterLabel(JSON.stringify(['WoW Forever', 'Realm', 'Mage'])), 'Mage · Realm');
  assert.throws(() => parseCharacterKey(JSON.stringify(['WoW Forever', 'Realm', ''])));
});

test('expected characters come only from a valid key', () => {
  assert.deepEqual(expectedCharacter(JSON.stringify(['WoW Forever', '', 'Fedrath'])), {
    expectedCharacter: { realm: '', name: 'Fedrath' },
  });
  assert.deepEqual(expectedCharacter(undefined), {});
  assert.deepEqual(expectedCharacter('not json'), {});
});

test('GUID keys follow a character and legacy keys match by game and name', () => {
  const key = (...parts: string[]) => JSON.stringify(['WoW Forever', ...parts]);
  const current = key('', 'Fedrath', 'Player-1-00A');
  assert.deepEqual(parseCharacterKey(current), {
    game: 'WoW Forever',
    realm: '',
    name: 'Fedrath',
    guid: 'Player-1-00A',
  });
  assert.equal(characterLabel(current), 'Fedrath');
  assert.deepEqual(expectedCharacter(current), {
    expectedCharacter: { realm: '', name: 'Fedrath', guid: 'Player-1-00A' },
  });
  assert.equal(sameCharacter(key('Old Realm', 'Fedrath'), current), true);
  assert.equal(sameCharacter(key('', 'Renamed', 'Player-1-00A'), current), true);
  assert.equal(sameCharacter(key('', 'Fedrath', 'Player-1-00B'), current), false);
  assert.equal(sameCharacter(key('Old Realm', 'Mage'), current), false);
  assert.equal(sameCharacter(JSON.stringify(['Retail', '', 'Fedrath']), current), false);
  assert.equal(sameCharacter('not json', current), false);
});
