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
function sameCharacter(stored: CharacterIdentity, current: CharacterIdentity) {
  if (stored.game !== current.game) return false;
  if (stored.guid && current.guid) return stored.guid === current.guid;
  return !stored.guid && stored.name === current.name;
}
/**
 * The stored keys whose data belongs to the character `key` names:
 * - keys with the same GUID (its realm or name changed);
 * - pre-GUID keys with an empty realm and the same game and name;
 * - pre-GUID keys with a realm and the same game and name, but only when a
 *   single realm has that name. WoW Forever reuses names across its PvP and
 *   PvE servers, and an empty realm can no longer tell which one is current.
 */
export function adoptableKeys(stored: Iterable<string | null | undefined>, key: string): string[] {
  const current = tryParse(key);
  if (!current) return [];
  const candidates = [...new Set(stored)].flatMap((k) => {
    const parsed = k && k !== key ? tryParse(k) : undefined;
    return parsed && sameCharacter(parsed, current) ? [{ key: k!, ...parsed }] : [];
  });
  const realms = new Set(candidates.flatMap((c) => (!c.guid && c.realm ? [c.realm] : [])));
  return candidates.filter((c) => c.guid || !c.realm || realms.size === 1).map((c) => c.key);
}
export type ExpectedCharacter = Pick<CharacterIdentity, 'realm' | 'name' | 'guid'>;
/**
 * The character an action must run as, for the addon to double-check.
 * Undefined when the turn had no identity; the transport session still pins
 * the character.
 */
export function expectedCharacter(key: string | undefined): ExpectedCharacter | undefined {
  const parsed = key ? tryParse(key) : undefined;
  if (!parsed) return undefined;
  const { realm, name, guid } = parsed;
  return guid ? { realm, name, guid } : { realm, name };
}
export function characterLabel(key: string, separator = ' · '): string {
  const parsed = tryParse(key);
  if (!parsed) return key;
  return parsed.realm ? parsed.name + separator + parsed.realm : parsed.name;
}
