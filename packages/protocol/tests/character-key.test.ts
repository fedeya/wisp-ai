import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  characterLabel,
  expectedCharacter,
  parseCharacterKey,
  adoptableKeys,
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
    realm: '',
    name: 'Fedrath',
  });
  assert.equal(expectedCharacter(undefined), undefined);
  assert.equal(expectedCharacter('not json'), undefined);
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
    realm: '',
    name: 'Fedrath',
    guid: 'Player-1-00A',
  });
  const adopt = (...stored: string[]) => adoptableKeys(stored, current);
  assert.deepEqual(adopt(key('Old Realm', 'Fedrath')), [key('Old Realm', 'Fedrath')]);
  assert.deepEqual(adopt(key('', 'Renamed', 'Player-1-00A')), [key('', 'Renamed', 'Player-1-00A')]);
  assert.deepEqual(adopt(key('', 'Fedrath', 'Player-1-00B')), []);
  assert.deepEqual(adopt(key('Old Realm', 'Mage')), []);
  assert.deepEqual(adopt(JSON.stringify(['Retail', '', 'Fedrath'])), []);
  assert.deepEqual(adopt('not json', current), []);
  assert.deepEqual(adoptableKeys([key('', 'Fedrath')], 'not json'), []);
});
