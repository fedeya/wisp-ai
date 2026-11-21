import { z } from 'zod';
// [game, realm, name, guid?]. The realm is empty in WoW Forever, which has no
// realms. The GUID never changes for a character, so it is what ties stored
// data to them; keys saved before it existed have only three parts.
const identity = z.union([
  z.tuple([z.string().min(1), z.string(), z.string().min(1), z.string().min(1)]),
  z.tuple([z.string().min(1), z.string(), z.string().min(1)]),
]);
export interface CharacterIdentity {
  game: string;
  realm: string;
  name: string;
  guid?: string;
}
export function parseCharacterKey(key: string): CharacterIdentity {
  const [game, realm, name, guid] = identity.parse(JSON.parse(key));
  return guid ? { game, realm, name, guid } : { game, realm, name };
}
function tryParse(key: string): CharacterIdentity | undefined {
  try {
    return parseCharacterKey(key);
  } catch {
    return undefined;
  }
}
/**
 * Whether data stored under `stored` belongs to the character `current` names.
 * Matching GUIDs follow a character through realm or name changes; keys saved
 * before GUIDs existed match by game and name, whatever their realm.
 */
export function sameCharacter(stored: string, current: string): boolean {
  const a = tryParse(stored),
    b = tryParse(current);
  if (!a || !b || a.game !== b.game) return false;
  if (a.guid && b.guid) return a.guid === b.guid;
  return !a.guid && a.name === b.name;
}
/**
 * The character an action must run as, for the addon to double-check. Empty
 * when the turn had no identity; the transport session still pins the character.
 */
export function expectedCharacter(key: string | undefined): {
  expectedCharacter?: { realm: string; name: string; guid?: string };
} {
  const parsed = key ? tryParse(key) : undefined;
  if (!parsed) return {};
  const { realm, name, guid } = parsed;
  return { expectedCharacter: guid ? { realm, name, guid } : { realm, name } };
}
export function characterLabel(key: string, separator = ' · '): string {
  const parsed = tryParse(key);
  if (!parsed) return key;
  return parsed.realm ? parsed.name + separator + parsed.realm : parsed.name;
}
