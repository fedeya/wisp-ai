// @effect-migrated
import { Schema } from 'effect';

const source = Schema.Struct({
  id: Schema.optional(Schema.Int),
  kind: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  subName: Schema.optional(Schema.String),
  zones: Schema.optional(Schema.Array(Schema.String)),
  requiredLevel: Schema.optional(Schema.Number),
  questLevel: Schema.optional(Schema.Number),
  evidence: Schema.Literals(['player-observed', 'game files, unconfirmed']),
  installs: Schema.optional(Schema.Number),
  lastSeen: Schema.optional(Schema.String),
});

const sources = Schema.optional(Schema.Array(source));
const item = Schema.Struct({
  itemId: Schema.Int,
  drops: sources,
  vendors: sources,
  quests: sources,
  crafted: sources,
  containers: sources,
  auction: Schema.optional(
    Schema.Struct({
      unitPriceCopper: Schema.optional(Schema.Number),
      ageDays: Schema.optional(Schema.Number),
    }),
  ),
  sourceKnown: Schema.Boolean,
  sourcesStatus: Schema.Literals(['available', 'unavailable', 'disabled']),
  moreSourcesNotShown: Schema.optional(Schema.Int),
});

export const itemSourcesResult = Schema.Struct({
  status: Schema.Literal('available'),
  items: Schema.Array(item),
  priceStatus: Schema.String,
  realm: Schema.optional(Schema.String),
  sources: Schema.optional(
    Schema.Struct({
      everloot: Schema.String,
      names: Schema.String,
      prices: Schema.String,
    }),
  ),
  note: Schema.String,
});

export type ItemSourcesResult = typeof itemSourcesResult.Type;
