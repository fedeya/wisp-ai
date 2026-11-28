// @effect-migrated
import { expect, it } from '@effect/vitest';
import { Option } from 'effect';
import {
  adoptableKeys,
  characterLabel,
  expectedCharacter,
  parseCharacterKey,
} from '../src/character-key.ts';

const guidKey = JSON.stringify(['WoW Forever', 'Player-1-00A']);
const legacy = (realm: string, name: string, game = 'WoW Forever') =>
  JSON.stringify([game, realm, name]);

it('GUID keys and pre-GUID keys both parse, and nothing else does', () => {
  expect(parseCharacterKey(guidKey)).toStrictEqual(
    Option.some({ kind: 'guid', game: 'WoW Forever', guid: 'Player-1-00A' }),
  );
  expect(parseCharacterKey(legacy('', 'Fedrath'))).toStrictEqual(
    Option.some({ kind: 'legacy', game: 'WoW Forever', realm: '', name: 'Fedrath' }),
  );
  expect(parseCharacterKey(legacy('Realm', ''))).toStrictEqual(Option.none());
  expect(parseCharacterKey(JSON.stringify(['WoW Forever', '']))).toStrictEqual(Option.none());
  expect(parseCharacterKey(JSON.stringify(['WoW Forever', 'a', 'b', 'c']))).toStrictEqual(
    Option.none(),
  );
  expect(parseCharacterKey('not json')).toStrictEqual(Option.none());
});

it('labels come from saved names, or from the pre-GUID key itself', () => {
  expect(characterLabel(guidKey, { [guidKey]: { name: 'Fedrath', realm: '' } })).toBe('Fedrath');
  expect(characterLabel(guidKey)).toBe('Unknown character');
  expect(characterLabel(legacy('', 'Fedrath'))).toBe('Fedrath');
  expect(characterLabel(legacy('Realm', 'Mage'), {}, ' - ')).toBe('Mage - Realm');
  expect(characterLabel('not json')).toBe('not json');
});

it('expected characters use the GUID when the key has one', () => {
  expect(expectedCharacter(guidKey)).toStrictEqual({ guid: 'Player-1-00A' });
  expect(expectedCharacter(legacy('', 'Fedrath'))).toStrictEqual({ realm: '', name: 'Fedrath' });
  expect(expectedCharacter(undefined)).toBeUndefined();
  expect(expectedCharacter('not json')).toBeUndefined();
});

it('pre-GUID keys are adopted by name unless the name was saved on several realms', () => {
  const fedrath = { game: 'WoW Forever', name: 'Fedrath' };
  const pvp = legacy('Realm 2 PvP', 'Fedrath'),
    pve = legacy('Realm 1 PvE', 'Fedrath'),
    noRealm = legacy('', 'Fedrath');
  expect(adoptableKeys([pvp, noRealm, null, guidKey], fedrath).sort()).toStrictEqual(
    [noRealm, pvp].sort(),
  );
  expect(adoptableKeys([pvp, pve, noRealm], fedrath)).toStrictEqual([noRealm]);
  expect(
    adoptableKeys([legacy('', 'Mage'), legacy('', 'Fedrath', 'Retail')], fedrath),
  ).toStrictEqual([]);
  expect(adoptableKeys(['not json'], fedrath)).toStrictEqual([]);
});
