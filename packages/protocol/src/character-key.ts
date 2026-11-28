// @effect-migrated
import { Option, Schema } from 'effect';
// A character key is [game, guid]: the GUID never changes for a character, so
// data stored under it survives realm and name changes. Keys saved before the
// addon sent GUIDs are [game, realm, name]; the realm is empty in WoW Forever.
const filled = Schema.String.check(Schema.isMinLength(1));
const guidKey = Schema.Tuple([filled, filled]);
const legacyKey = Schema.Tuple([filled, Schema.String, filled]);
const storedKey = Schema.fromJsonString(Schema.Union([guidKey, legacyKey]));
const decodeStoredKey = Schema.decodeOption(storedKey);
export type CharacterKey =
  | { kind: 'guid'; game: string; guid: string }
  | { kind: 'legacy'; game: string; realm: string; name: string };
/** The character a stored key names, or none when the key is not one. */
export function parseCharacterKey(key: string): Option.Option<CharacterKey> {
  return decodeStoredKey(key).pipe(
    Option.map((parts): CharacterKey =>
      parts.length === 2
        ? { kind: 'guid', game: parts[0], guid: parts[1] }
        : { kind: 'legacy', game: parts[0], realm: parts[1], name: parts[2] },
    ),
  );
}
function tryParse(key: string): CharacterKey | undefined {
  return Option.getOrUndefined(parseCharacterKey(key));
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
    return key &&
      parsed?.kind === 'legacy' &&
      parsed.game === character.game &&
      parsed.name === character.name
      ? [{ key, realm: parsed.realm }]
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
export const characterName = Schema.Struct({ name: filled, realm: Schema.String });
export type CharacterName = typeof characterName.Type;
/** A readable name: from `names` (saved by the bridge) or a pre-GUID key itself. */
export function characterLabel(
  key: string,
  names: Readonly<Record<string, CharacterName>> = {},
  separator = ' · ',
): string {
  const parsed = tryParse(key);
  const name = names[key] ?? (parsed?.kind === 'legacy' ? parsed : undefined);
  if (!name) return parsed ? 'Unknown character' : key;
  return name.realm ? name.name + separator + name.realm : name.name;
}
