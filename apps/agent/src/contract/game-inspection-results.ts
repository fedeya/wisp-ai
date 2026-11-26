import { Schema, type Effect } from 'effect';
import type { z } from 'zod';
import type { inspectionSchema } from './game-inspection.ts';

export type GameInspection = z.input<typeof inspectionSchema>;
type InspectionKind = GameInspection['kind'];

// Keep additional native/provider fields visible to the model. Only declared
// fields are trusted by host code; client-specific extensions remain unknown.
const extensions = Schema.Record(Schema.String, Schema.Unknown);
const fields = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [extensions]);
const optional = Schema.optional;
const text = Schema.String;
const number = Schema.Number;
const flag = Schema.Boolean;
const texts = Schema.Array(text);
const numbers = Schema.Array(number);
// SerializeJSON sends an empty Lua table as [] even when used as a dictionary.
const luaDictionary = Schema.Union([extensions, Schema.Tuple([])]);
const numericDictionary = Schema.Union([Schema.Record(text, number), Schema.Tuple([])]);
const note = optional(text);
const metadata = {
  capturedAt: optional(number),
  source: optional(text),
  character: optional(text),
};

const failure = fields({ ...metadata, status: Schema.Literal('unavailable'), error: text });
const available = <D extends Schema.Decoder<unknown>>(data: D) =>
  fields({ ...metadata, status: Schema.Literal('available'), data });
const reply = <D extends Schema.Decoder<unknown>>(data: D) =>
  Schema.Union([available(data), failure]);

const gearItem = fields({
  id: Schema.Int,
  name: optional(text),
  quality: optional(number),
  itemLevel: optional(number),
  requiredLevel: optional(number),
  equipLocation: optional(text),
  itemLevelGain: optional(number),
  stats: optional(numericDictionary),
  statDelta: optional(numericDictionary),
  proficiency: optional(Schema.Literals(['usable', 'trainable', 'class_cannot_use'])),
  trainableAtLevel: optional(number),
});
const gearData = fields({
  status: optional(Schema.Literals(['available', 'loading'])),
  items: Schema.Array(gearItem),
  other: optional(Schema.Array(gearItem)),
  loadingIds: optional(numbers),
  counts: optional(Schema.Record(text, number)),
  note,
});
const gearResult = reply(gearData);
const catalog = fields({
  source: text,
  label: optional(text),
  build: optional(text),
  credit: optional(text),
  url: text,
  listed: number,
  incomplete: flag,
  byQuality: Schema.Record(text, fields({ total: number, listed: number })),
});
const gearSearch = Schema.Union([
  fields({ ...available(gearData).schema.fields, catalog }),
  fields({ ...failure.schema.fields, catalog }),
]);

const locations = reply(
  fields({
    status: Schema.Literals(['available', 'no_matches']),
    mapId: number,
    zone: optional(text),
    locations: Schema.Array(
      fields({ x: number, y: number, npcId: optional(number), objectId: optional(number) }),
    ),
    total: number,
    truncated: flag,
    note,
  }),
);

const setting = fields({
  id: text,
  label: optional(text),
  readable: flag,
  writable: optional(flag),
});
const mapInfo = fields({
  mapID: number,
  name: optional(text),
  parentMapID: optional(number),
  mapType: optional(number),
});
const guideStep = fields({
  index: number,
  number: optional(number),
  title: optional(text),
  goals: optional(
    Schema.Array(
      fields({
        text: optional(text),
        questId: optional(number),
        npcId: optional(number),
        itemId: optional(number),
      }),
    ),
  ),
});
const questChainNode = fields({
  id: number,
  name: optional(text),
  requiredLevel: optional(number),
  relations: Schema.Record(text, numbers),
  knownRelations: Schema.Record(text, flag),
});
const flightPoint = fields({
  name: text,
  nodeId: number,
  discovery: Schema.Literals(['unknown', 'undiscovered', 'learned']),
});

const inspectionResults = {
  settings: reply(
    fields({
      applications: texts,
      options: optional(Schema.Array(setting)),
      addons: optional(
        Schema.Array(
          fields({ name: text, title: optional(text), loaded: flag, version: optional(text) }),
        ),
      ),
      keybindings: optional(
        Schema.Array(
          fields({
            command: text,
            label: optional(text),
            category: optional(text),
            key1: optional(text),
            key2: optional(text),
          }),
        ),
      ),
      actionBars: optional(
        Schema.Array(
          fields({ slot: number, kind: text, id: optional(number), subType: optional(text) }),
        ),
      ),
      total: optional(number),
      offset: optional(number),
      nextOffset: optional(number),
    }),
  ),
  npc_locations: locations,
  object_locations: locations,
  questie_quest: reply(
    Schema.Union([
      fields({ status: Schema.Literal('available'), questId: number, data: luaDictionary }),
      fields({ status: Schema.Literal('unknown'), questId: number, note }),
    ]),
  ),
  questie_chain: reply(
    fields({
      status: Schema.Literals(['available', 'unknown']),
      rootQuestId: number,
      nodes: Schema.Array(questChainNode),
      missingQuestIds: numbers,
      truncated: flag,
      maxDepth: number,
      note,
    }),
  ),
  stored_item: reply(
    fields({
      status: Schema.Literal('available'),
      itemId: number,
      matches: Schema.Array(
        fields({
          character: optional(text),
          guild: optional(text),
          realm: optional(text),
          counts: numericDictionary,
          total: number,
        }),
      ),
      totalCached: number,
      owners: number,
      truncated: flag,
    }),
  ),
  item_prices: reply(
    fields({
      status: Schema.Literal('available'),
      realm: optional(text),
      cached: flag,
      prices: Schema.Array(
        fields({
          itemId: number,
          status: text,
          unitPriceCopper: optional(number),
          ageDays: optional(number),
        }),
      ),
    }),
  ),
  polestar_guide: reply(
    fields({
      status: Schema.Literal('available'),
      guide: optional(fields({ id: optional(text), title: optional(text) })),
      step: optional(guideStep),
      upcoming: optional(Schema.Array(guideStep)),
      stepCount: optional(number),
      finished: optional(flag),
      note,
    }),
  ),
  reference: reply(
    fields({
      id: number,
      name: optional(text),
      title: optional(text),
      status: optional(text),
      note,
    }),
  ),
  progression: reply(
    fields({
      active: fields({
        count: number,
        quests: Schema.Array(
          fields({
            id: number,
            title: optional(text),
            level: optional(number),
            complete: optional(flag),
          }),
        ),
      }),
      completion: Schema.Array(
        fields({
          id: number,
          status: Schema.Literals(['available', 'unavailable']),
          completed: optional(flag),
        }),
      ),
      reputations: Schema.Array(
        fields({
          id: number,
          status: Schema.Literals(['available', 'unavailable']),
          data: optional(luaDictionary),
        }),
      ),
      note,
    }),
  ),
  target: reply(
    fields({
      name: optional(text),
      level: optional(number),
      classification: optional(text),
      npcId: optional(number),
      isPlayer: optional(flag),
      faction: optional(text),
      reaction: optional(number),
      attackable: optional(flag),
      dead: optional(flag),
      note: text,
    }),
  ),
  trainer: reply(
    fields({
      trainer: optional(text),
      moneyCopper: number,
      services: Schema.Array(
        fields({ name: text, status: optional(text), costCopper: optional(number) }),
      ),
      note,
    }),
  ),
  flight_paths: reply(
    fields({
      maps: Schema.Array(
        fields({
          origin: text,
          observedAt: number,
          originMapId: optional(number),
          mapOpen: flag,
          destinations: Schema.Array(fields({ name: text })),
        }),
      ),
      worldMap: optional(
        fields({ points: Schema.Array(flightPoint), matched: number, truncated: flag }),
      ),
      observedOrigins: number,
      matched: number,
      truncated: flag,
    }),
  ),
  dungeons: reply(
    fields({
      dungeons: Schema.Array(
        fields({
          name: optional(text),
          instanceMapId: number,
          minLevel: optional(number),
          maxLevel: optional(number),
        }),
      ),
      characterLevel: optional(number),
      faction: optional(text),
      groupFinder: flag,
    }),
  ),
  training: reply(
    fields({
      class: text,
      spells: Schema.Array(
        fields({
          spellId: number,
          name: optional(text),
          requiredLevel: number,
          method: Schema.Literals(['trainer', 'quest']),
          baseCostCopper: optional(number),
          learned: optional(flag),
        }),
      ),
      total: number,
      nextOffset: optional(number),
      unresolvedNames: number,
    }),
  ),
  chat: reply(
    fields({
      messages: Schema.Array(
        fields({
          timestamp: number,
          channel: text,
          sender: optional(text),
          text: optional(text),
          direction: Schema.Literals(['outgoing', 'received']),
        }),
      ),
      count: number,
      matched: number,
      truncated: flag,
      enabledChannels: texts,
      enabledPublicChannels: Schema.Array(fields({ name: text })),
      note,
    }),
  ),
  combat: reply(
    Schema.Union([
      fields({
        view: Schema.Literal('fight'),
        inCombat: flag,
        dead: optional(flag),
        fight: optional(
          Schema.Union([
            fields({
              durationSeconds: optional(number),
              damageTaken: optional(number),
              damageDone: optional(number),
            }),
            Schema.Tuple([]),
          ]),
        ),
        unavailable: optional(text),
        note,
      }),
      fields({
        view: Schema.Literal('deaths'),
        inCombat: flag,
        dead: optional(flag),
        deaths: Schema.Array(
          fields({ diedAt: number, secondsAgo: number, recapAvailable: optional(flag) }),
        ),
        deathCount: number,
        groupDeaths: optional(Schema.Array(fields({ name: optional(text), recapAvailable: flag }))),
        note,
      }),
    ]),
  ),
  resources: reply(
    fields({
      moneyCopper: number,
      bags: Schema.Array(
        fields({ bag: number, slot: number, id: number, count: number, link: optional(text) }),
      ),
      freeBagSlots: optional(number),
      bagCapacity: number,
      skills: Schema.Array(
        fields({
          id: optional(number),
          name: optional(text),
          rank: optional(number),
          maxRank: optional(number),
        }),
      ),
      skillsStatus: text,
      collapsedSkills: flag,
    }),
  ),
  compare_items: reply(
    fields({
      candidates: Schema.Array(
        fields({
          item: gearItem,
          comparisons: Schema.Array(
            fields({
              slot: number,
              empty: flag,
              equipped: optional(gearItem),
              statDelta: optional(numericDictionary),
            }),
          ),
        }),
      ),
      note,
    }),
  ),
  search_armor: gearSearch,
  search_weapons: gearSearch,
  gear_candidates: gearResult,
  auctions: reply(
    fields({
      realm: optional(text),
      source: text,
      loadedResults: number,
      totalSearchResults: optional(number),
      results: Schema.Array(
        Schema.Union([
          fields({
            itemId: optional(number),
            name: optional(text),
            quantity: optional(number),
            buyoutCopper: optional(number),
            unitBuyoutCopper: optional(number),
            minimumPriceCopper: optional(number),
            totalQuantity: optional(number),
          }),
          Schema.Tuple([]),
        ]),
      ),
      partial: flag,
      note,
    }),
  ),
  macros: reply(
    fields({
      macros: Schema.Array(
        fields({
          name: text,
          scope: Schema.Literals(['account', 'character']),
          body: optional(text),
        }),
      ),
      accountCount: number,
      characterCount: number,
      accountLimit: number,
      characterLimit: number,
    }),
  ),
  map: reply(
    fields({
      currentMapId: optional(number),
      maps: Schema.Array(mapInfo),
      matches: Schema.Array(mapInfo),
      searchStatus: text,
      truncated: flag,
      waypoint: optional(fields({ mapId: number, x: number, y: number })),
      waypointStatus: text,
      note,
    }),
  ),
  hearthstone: reply(
    fields({
      bind: Schema.Union([
        fields({ status: Schema.Literal('available'), name: text }),
        fields({ status: Schema.Literal('unavailable') }),
      ]),
    }),
  ),
} satisfies Record<InspectionKind, Schema.Decoder<unknown>>;

type InspectionResults = { [K in InspectionKind]: (typeof inspectionResults)[K]['Type'] };
export type InspectionResult<K extends InspectionKind> = InspectionResults[K];

const resultSchemas: { [K in InspectionKind]: Schema.Decoder<InspectionResult<K>> } =
  inspectionResults;

export function decodeInspectionResult<K extends InspectionKind>(
  kind: K,
): (input: unknown) => Effect.Effect<InspectionResult<K>, Schema.SchemaError> {
  return Schema.decodeUnknownEffect<Schema.Decoder<InspectionResult<K>>>(resultSchemas[kind]);
}
