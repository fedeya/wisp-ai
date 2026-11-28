import { Schema } from 'effect';

/** An item in the pinned simulator/items.json. */
export const CatalogItem = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  type: Schema.optionalKey(Schema.Int),
  armorType: Schema.optionalKey(Schema.Int),
  weaponType: Schema.optionalKey(Schema.Int),
  handType: Schema.optionalKey(Schema.Int),
  rangedWeaponType: Schema.optionalKey(Schema.Int),
  reqLvl: Schema.optionalKey(Schema.Int),
  classAllowlist: Schema.optionalKey(Schema.Array(Schema.Int)),
  unique: Schema.optionalKey(Schema.Boolean),
  limitCategory: Schema.optionalKey(Schema.Int),
  requiredProfession: Schema.optionalKey(Schema.Int),
  factionRestriction: Schema.optionalKey(Schema.Int),
});
export type CatalogItem = typeof CatalogItem.Type;
export interface EquippedItem {
  slot: number;
  id: number;
  link: string;
}
export const equipmentSlots = [1, 2, 3, 15, 5, 9, 10, 6, 7, 8, 11, 12, 13, 14, 16, 17, 18];
export function replaceEquipment(
  equipped: readonly EquippedItem[],
  replacements: { slot: number; itemId: number }[],
  catalog: Map<number, CatalogItem>,
  _token: string,
  _level: number,
  _race: string,
) {
  const result = new Map(equipped.map((i) => [i.slot, { ...i }]));
  if (result.size !== equipped.length) {
    throw Error('The gear reading contains duplicate slots.');
  }
  const seen = new Set<number>();
  for (const replacement of replacements) {
    const { slot, itemId } = replacement;
    if (!equipmentSlots.includes(slot) || seen.has(slot)) {
      throw Error('Invalid or duplicate replacement slot.');
    }
    seen.add(slot);
    if (!itemId) {
      result.delete(slot);
      continue;
    }
    const item = catalog.get(itemId);
    if (!item) {
      throw Error('Candidate item ' + itemId + ' is absent from the pinned simulator database.');
    }
    // Replacements are base catalog items: never transfer the old item's enchant or suffix.
    result.set(slot, { slot, id: itemId, link: 'item:' + itemId });
  }
  return [...result.values()];
}
