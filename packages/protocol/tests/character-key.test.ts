import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  adoptableKeys,
  characterLabel,
  expectedCharacter,
  parseCharacterKey,
} from '../src/character-key.ts';

const guidKey = JSON.stringify(['WoW Forever', 'Player-1-00A']);
const legacy = (realm: string, name: string, game = 'WoW Forever') =>
  JSON.stringify([game, realm, name]);

test('GUID keys and pre-GUID keys both parse, and nothing else does', () => {
  assert.deepEqual(parseCharacterKey(guidKey), {
    kind: 'guid',
    game: 'WoW Forever',
    guid: 'Player-1-00A',
  });
  assert.deepEqual(parseCharacterKey(legacy('', 'Fedrath')), {
    kind: 'legacy',
    game: 'WoW Forever',
    realm: '',
    name: 'Fedrath',
  });
  assert.throws(() => parseCharacterKey(legacy('Realm', '')));
  assert.throws(() => parseCharacterKey(JSON.stringify(['WoW Forever', ''])));
});

test('labels come from saved names, or from the pre-GUID key itself', () => {
  assert.equal(characterLabel(guidKey, { [guidKey]: { name: 'Fedrath', realm: '' } }), 'Fedrath');
  assert.equal(characterLabel(guidKey), 'Unknown character');
  assert.equal(characterLabel(legacy('', 'Fedrath')), 'Fedrath');
  assert.equal(characterLabel(legacy('Realm', 'Mage'), {}, ' - '), 'Mage - Realm');
  assert.equal(characterLabel('not json'), 'not json');
});

test('expected characters use the GUID when the key has one', () => {
  assert.deepEqual(expectedCharacter(guidKey), { guid: 'Player-1-00A' });
  assert.deepEqual(expectedCharacter(legacy('', 'Fedrath')), { realm: '', name: 'Fedrath' });
  assert.equal(expectedCharacter(undefined), undefined);
  assert.equal(expectedCharacter('not json'), undefined);
});

test('pre-GUID keys are adopted by name unless the name was saved on several realms', () => {
  const fedrath = { game: 'WoW Forever', name: 'Fedrath' };
  const pvp = legacy('Realm 2 PvP', 'Fedrath'),
    pve = legacy('Realm 1 PvE', 'Fedrath'),
    noRealm = legacy('', 'Fedrath');
  assert.deepEqual(
    adoptableKeys([pvp, noRealm, null, guidKey], fedrath).sort(),
    [noRealm, pvp].sort(),
  );
  assert.deepEqual(adoptableKeys([pvp, pve, noRealm], fedrath), [noRealm]);
  assert.deepEqual(
    adoptableKeys([legacy('', 'Mage'), legacy('', 'Fedrath', 'Retail')], fedrath),
    [],
  );
  assert.deepEqual(adoptableKeys(['not json'], fedrath), []);
});
