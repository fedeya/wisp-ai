import { Schema } from 'effect';

export interface ClassAdapter {
  token: string;
  engineClass: string;
  spec: string;
  resource: 'mana' | 'rage' | 'energy';
  families: string[];
  channels?: string[];
  requiredTalents?: Record<string, number>;
  areaRanges?: Record<string, number>;
  dots?: string[];
  requiresRangedAuto?: boolean;
  melee?: boolean;
  wand?: boolean;
  options?: Record<string, unknown>;
  assumptions: string[];
}
// One class in the pinned simulator/classes.json. Fields are in the file's
// order, so a decoded entry serializes as the file has it.
const SpellRank = Schema.Struct({
  id: Schema.Int,
  level: Schema.Int,
  minRange: Schema.Finite,
  maxRange: Schema.Finite,
});
export const ClassMetadata = Schema.Struct({
  talents: Schema.Array(
    Schema.Array(
      Schema.Struct({
        id: Schema.Int,
        name: Schema.optionalKey(Schema.String),
        max: Schema.Int,
        row: Schema.optionalKey(Schema.Int),
        prerequisiteId: Schema.optionalKey(Schema.Int),
      }),
    ),
  ),
  ranks: Schema.Record(Schema.String, Schema.Array(SpellRank)),
  triggerParents: Schema.Record(Schema.String, Schema.Int),
});
export type ClassMetadata = typeof ClassMetadata.Type;
