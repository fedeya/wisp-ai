import { z } from 'zod';
// A character key is [game, guid]: the GUID never changes for a character, so
// data stored under it survives realm and name changes. Keys saved before the
// addon sent GUIDs are [game, realm, name]; the realm is empty in WoW Forever.
const guidKey = z.tuple([z.string().min(1), z.string().min(1)]);
const legacyKey = z.tuple([z.string().min(1), z.string(), z.string().min(1)]);
export type CharacterKey =
  | { kind: 'guid'; game: string; guid: string }
  | { kind: 'legacy'; game: string; realm: string; name: string };
export function parseCharacterKey(key: string): CharacterKey {
  const value: unknown = JSON.parse(key);
  const guid = guidKey.safeParse(value);
  if (guid.success) return { kind: 'guid', game: guid.data[0], guid: guid.data[1] };
  const [game, realm, name] = legacyKey.parse(value);
  return { kind: 'legacy', game, realm, name };
}
function tryParse(key: string): CharacterKey | undefined {
  try {
    return parseCharacterKey(key);
  } catch {
    return undefined;
  }
}
/**
 * The pre-GUID keys whose data belongs to a character with this game and
 * name: keys with an empty realm, and keys with a realm only when a single
 * realm has that name. WoW Forever reuses names across its PvP and PvE
 * servers, and an empty realm can no longer tell which one is current.
 */
export function adoptableKeys(
  stored: Iterable<string | null | undefined>,
  character: { game: string; name: string },
): string[] {
  const candidates = [...new Set(stored)].flatMap((key) => {
    const parsed = key ? tryParse(key) : undefined;
    return parsed?.kind === 'legacy' &&
      parsed.game === character.game &&
      parsed.name === character.name
      ? [{ key: key!, realm: parsed.realm }]
      : [];
  });
  const realms = new Set(candidates.flatMap((c) => (c.realm ? [c.realm] : [])));
  return candidates.filter((c) => !c.realm || realms.size === 1).map((c) => c.key);
}
export type ExpectedCharacter = { guid: string } | { realm: string; name: string };
/**
 * The character an action must run as, for the addon to double-check.
 * Undefined when the turn had no identity; the transport session still pins
 * the character.
 */
export function expectedCharacter(key: string | undefined): ExpectedCharacter | undefined {
  const parsed = key ? tryParse(key) : undefined;
  if (!parsed) return undefined;
  return parsed.kind === 'guid'
    ? { guid: parsed.guid }
    : { realm: parsed.realm, name: parsed.name };
}
export const characterName = z.object({ name: z.string().min(1), realm: z.string() });
export type CharacterName = z.infer<typeof characterName>;
/** A readable name: from `names` (saved by the bridge) or a pre-GUID key itself. */
export function characterLabel(
  key: string,
  names: Record<string, CharacterName> = {},
  separator = ' · ',
): string {
  const parsed = tryParse(key);
  const name = names[key] ?? (parsed?.kind === 'legacy' ? parsed : undefined);
  if (!name) return parsed ? 'Unknown character' : key;
  return name.realm ? name.name + separator + name.realm : name.name;
}
