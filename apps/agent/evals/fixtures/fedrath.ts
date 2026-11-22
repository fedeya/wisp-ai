import type { ToolStub } from 'eve/evals';

// Stub responses must be plain JSON values.
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

// A level 21 Horde mage modelled on a real player's gear questions: empty
// head, neck, shoulder and one ring slot, a few weak pieces and a Spanish
// client. Item data is illustrative; IDs only need to be consistent here.
type Stats = Record<string, number>;
interface Item {
  id: number;
  name: string;
  quality: number;
  itemLevel: number;
  requiredLevel: number;
  equipLocation: string;
  stats: Stats;
}
const INT = 'ITEM_MOD_INTELLECT_SHORT';
const STA = 'ITEM_MOD_STAMINA_SHORT';
const SPI = 'ITEM_MOD_SPIRIT_SHORT';
const AGI = 'ITEM_MOD_AGILITY_SHORT';
const SP = 'ITEM_MOD_SPELL_POWER_SHORT';
const ARMOR = 'RESISTANCE0_NAME';

const item = (
  id: number,
  name: string,
  quality: number,
  itemLevel: number,
  requiredLevel: number,
  equipLocation: string,
  stats: Stats,
): Item => ({ id, name, quality, itemLevel, requiredLevel, equipLocation, stats });

export const equipped: Record<number, Item> = {
  5: item(6503, 'Togas de arlequín', 2, 22, 0, 'INVTYPE_ROBE', { [INT]: 2, [SPI]: 6, [ARMOR]: 36 }),
  6: item(3587, 'Cinturón de lino reforzado', 1, 12, 7, 'INVTYPE_WAIST', { [STA]: 1, [ARMOR]: 8 }),
  7: item(270011, 'Leotardos bordados', 2, 21, 0, 'INVTYPE_LEGS', {
    [SP]: 4,
    [STA]: 5,
    [ARMOR]: 30,
  }),
  8: item(2583, 'Botas de lana', 1, 13, 8, 'INVTYPE_FEET', { [STA]: 1, [INT]: 1, [ARMOR]: 12 }),
  9: item(3607, 'Brazales de lino tejido', 1, 10, 5, 'INVTYPE_WRIST', { [INT]: 1, [ARMOR]: 6 }),
  10: item(4310, 'Guantes de seda ligera', 2, 18, 13, 'INVTYPE_HAND', { [INT]: 3, [ARMOR]: 14 }),
  11: item(2834, 'Anillo de cobre tosco', 1, 12, 7, 'INVTYPE_FINGER', { [STA]: 1 }),
  15: item(281268, 'Capa de hechicero', 2, 20, 15, 'INVTYPE_CLOAK', {
    [INT]: 3,
    [SP]: 2,
    [ARMOR]: 12,
  }),
  16: item(281274, 'Bastón de aprendiz', 2, 20, 15, 'INVTYPE_2HWEAPON', {
    [INT]: 5,
    [STA]: 4,
    [SPI]: 3,
  }),
  18: item(5210, 'Varita ardiente', 2, 18, 13, 'INVTYPE_RANGEDRIGHT', {}),
};

const character = {
  name: 'Fedrath',
  realm: 'Vorn',
  level: 21,
  class: 'MAGE',
  race: 'Orco',
  raceToken: 'Orc',
  faction: 'Horde',
  moneyCopper: 21_450,
  xp: 4200,
  xpMax: 13_000,
  game: 'WoW Forever',
  version: '1.60.1',
  build: '70959',
  guid: 'Player-0000-00000001',
};
const location = {
  zone: 'Orgrimmar',
  subzone: 'Valle de la Fuerza',
  mapId: 1454,
  x: 0.52,
  y: 0.48,
};

export function playerMessage(text: string, chatId = 'eval-chat') {
  const tagged = (name: string, data: unknown) =>
    `<${name}>\n${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}\n</${name}>`;
  return [
    tagged('game_context', {
      capturedAt: 1_795_319_000,
      source: 'WoW addon live API',
      sections: {
        character: { status: 'available', data: character },
        location: { status: 'available', data: location },
      },
    }),
    tagged('conversation_context', { id: chatId, title: 'New chat', automatic: false }),
    tagged('user_message', text),
  ].join('\n\n');
}

const gearReading = {
  source: 'WoW addon live API',
  character: 'Fedrath',
  capturedAt: 1_795_319_010,
  sections: {
    character: { status: 'available', data: character },
    location: { status: 'available', data: location },
    gear: {
      status: 'available',
      data: {
        items: Object.entries(equipped).map(([slot, entry]) => ({
          slot: Number(slot),
          id: entry.id,
          link: `|cnIQ${entry.quality}:|Hitem:${entry.id}::::::::21:1482:::::::::|h[${entry.name}]|h|r`,
          name: entry.name,
          quality: entry.quality,
          itemLevel: entry.itemLevel,
          requiredLevel: entry.requiredLevel,
          equipLocation: entry.equipLocation,
          stats: entry.stats,
        })),
      },
    },
    bags: {
      status: 'available',
      data: {
        items: [
          { bag: 0, slot: 1, id: 2589, count: 14, link: '[Paño de lino]' },
          { bag: 0, slot: 2, id: 2592, count: 6, link: '[Paño de lana]' },
          { bag: 0, slot: 3, id: 858, count: 4, link: '[Poción de sanación inferior]' },
        ],
      },
    },
    quests: {
      status: 'available',
      data: {
        count: 4,
        quests: [
          {
            id: 875,
            title: 'Destripadoras alabruja',
            level: 16,
            rewardXP: 1150,
            complete: false,
            objectives: [{ text: 'Anillo de destripadora: 4/8', type: 'item', finished: false }],
          },
          {
            id: 1061,
            title: 'El espíritu de los vientos',
            level: 21,
            rewardXP: 1850,
            complete: true,
            objectives: [],
          },
          {
            id: 5881,
            title: 'Calling in the Reserves',
            level: 24,
            rewardXP: 2400,
            complete: false,
            objectives: [{ text: 'Entrega el aviso', type: 'event', finished: false }],
          },
          {
            id: 1489,
            title: 'Caverna de la Tormenta',
            level: 27,
            rewardXP: 2900,
            complete: false,
            objectives: [{ text: 'Mata a Hamuul Runatótem 0/1', type: 'monster', finished: false }],
          },
        ],
      },
    },
  },
};

const slots: Record<string, number[]> = {
  INVTYPE_HEAD: [1],
  INVTYPE_NECK: [2],
  INVTYPE_SHOULDER: [3],
  INVTYPE_CHEST: [5],
  INVTYPE_ROBE: [5],
  INVTYPE_WAIST: [6],
  INVTYPE_LEGS: [7],
  INVTYPE_FEET: [8],
  INVTYPE_WRIST: [9],
  INVTYPE_HAND: [10],
  INVTYPE_FINGER: [11, 12],
  INVTYPE_CLOAK: [15],
  INVTYPE_2HWEAPON: [16],
  INVTYPE_RANGEDRIGHT: [18],
};
// Mirrors the addon's gear_candidates reading against the fixture's gear.
function candidate(entry: Item) {
  const options = (slots[entry.equipLocation] || []).map((slot) => ({
    slot,
    current: equipped[slot],
  }));
  const target =
    options.find((option) => !option.current) ??
    options.sort((a, b) => a.current!.itemLevel - b.current!.itemLevel)[0]!;
  const current = target.current;
  const delta: Stats = {};
  for (const key of new Set([...Object.keys(entry.stats), ...Object.keys(current?.stats ?? {})])) {
    delta[key] = (entry.stats[key] ?? 0) - (current?.stats[key] ?? 0);
  }
  return {
    ...entry,
    slot: target.slot,
    emptySlot: !current,
    equipped: current && { id: current.id, name: current.name, itemLevel: current.itemLevel },
    itemLevelGain: entry.itemLevel - (current?.itemLevel ?? 0),
    statDelta: delta,
  };
}
function searchResult(category: Record<string, string>, items: Item[], tooHighLevel = 0) {
  const matches = items.map(candidate).sort((a, b) => b.itemLevelGain - a.itemLevelGain);
  return {
    catalog: {
      source: 'Everloot item_categories',
      label: 'found in game files, unconfirmed',
      build: '1.60.1.70959',
      url: 'https://everloot.app/database/items',
      category,
      listed: matches.length + tooHighLevel + 3,
      incomplete: false,
    },
    character: 'Fedrath',
    source: 'WoW addon live API',
    status: 'available',
    capturedAt: 1_795_319_020,
    data: {
      status: 'available',
      items: matches,
      counts: {
        requested: matches.length + tooHighLevel + 3,
        matching: matches.length,
        tooHighLevel,
        tooLowLevel: 0,
        notEquipment: 3,
      },
      note: 'Every match, ordered by item level gain over the weakest matching equipped slot; the order is not a recommendation or stat weighting. Armor/weapon proficiency is not checked. loadingIds were not in the client cache yet.',
    },
  };
}

// Candidates per slot. 210990 exists only in the game files (no known source);
// 20442 is an agility neck a mage should not want.
const armor: Record<string, Item[]> = {
  head: [
    item(7048, 'Capucha de seda azur', 2, 24, 19, 'INVTYPE_HEAD', {
      [INT]: 5,
      [SPI]: 2,
      [ARMOR]: 22,
    }),
    item(4321, 'Capucha de tela de araña', 2, 19, 14, 'INVTYPE_HEAD', {
      [INT]: 3,
      [STA]: 2,
      [ARMOR]: 18,
    }),
  ],
  neck: [
    item(20442, 'Medallón de explorador', 3, 23, 18, 'INVTYPE_NECK', { [AGI]: 6, [STA]: 2 }),
    item(12047, 'Colgante de luz espectral', 2, 22, 17, 'INVTYPE_NECK', { [INT]: 3, [SPI]: 3 }),
  ],
  shoulder: [
    item(4314, 'Sobrehombros de lana con doble pespunte', 2, 22, 17, 'INVTYPE_SHOULDER', {
      [STA]: 4,
      [SP]: 4,
      [ARMOR]: 27,
    }),
    item(14112, 'Sobrehombros de seda tejida', 2, 26, 21, 'INVTYPE_SHOULDER', {
      [INT]: 4,
      [SPI]: 4,
      [ARMOR]: 29,
    }),
  ],
  feet: [
    item(4320, 'Botas de seda de araña', 3, 25, 20, 'INVTYPE_FEET', {
      [INT]: 4,
      [STA]: 2,
      [SP]: 5,
      [ARMOR]: 25,
    }),
    item(210990, 'Sandalias del eclipse', 3, 24, 21, 'INVTYPE_FEET', {
      [INT]: 5,
      [SPI]: 4,
      [ARMOR]: 24,
    }),
    item(3065, 'Botas de aprendiz bendecidas', 2, 20, 15, 'INVTYPE_FEET', {
      [INT]: 3,
      [SPI]: 3,
      [ARMOR]: 18,
    }),
  ],
  finger: [
    item(11288, 'Anillo de perla tallada', 2, 20, 15, 'INVTYPE_FINGER', { [INT]: 2, [SPI]: 2 }),
    item(15700, 'Sello de los Renegados', 3, 25, 21, 'INVTYPE_FINGER', { [STA]: 3, [SP]: 4 }),
  ],
  waist: [
    item(7055, 'Faja de seda azur', 2, 21, 16, 'INVTYPE_WAIST', {
      [INT]: 3,
      [SPI]: 2,
      [ARMOR]: 15,
    }),
  ],
  wrist: [
    item(3647, 'Brazales de tela fina', 2, 17, 12, 'INVTYPE_WRIST', { [INT]: 2, [ARMOR]: 10 }),
  ],
  hands: [],
  chest: [],
  legs: [],
  back: [],
  trinket: [],
};
const weapons: Record<string, Item[]> = {
  wands: [
    item(5240, 'Varita de llamas', 2, 22, 17, 'INVTYPE_RANGEDRIGHT', { [INT]: 1 }),
    item(5214, 'Varita de las sombras', 3, 26, 21, 'INVTYPE_RANGEDRIGHT', { [INT]: 2, [SPI]: 1 }),
  ],
  staves: [
    item(5291, 'Bastón del sabio', 2, 24, 19, 'INVTYPE_2HWEAPON', { [INT]: 6, [SPI]: 5, [STA]: 2 }),
  ],
};

// Observed sources (Everloot relations) for the candidates that have one.
const sources: Record<number, unknown[]> = {
  7048: [
    { rel: 'created_by', kind: 'spell', name: 'Capucha de seda azur', profession: 'Sastrería 145' },
  ],
  4321: [
    {
      rel: 'created_by',
      kind: 'spell',
      name: 'Capucha de tela de araña',
      profession: 'Sastrería 125',
    },
  ],
  20442: [{ rel: 'reward_from', kind: 'quest', name: 'Explorador de los Baldíos', level: 18 }],
  12047: [
    {
      rel: 'drops_from',
      kind: 'npc',
      name: 'Señor de las sombras Fardel',
      zone: 'Bosque de Argénteos',
    },
  ],
  4314: [
    {
      rel: 'created_by',
      kind: 'spell',
      name: 'Sobrehombros de lana con doble pespunte',
      profession: 'Sastrería 110',
    },
  ],
  14112: [
    {
      rel: 'drops_from',
      kind: 'npc',
      name: 'Mago oscuro Velagrado',
      zone: 'Cavernas de los Lamentos',
    },
  ],
  4320: [
    {
      rel: 'created_by',
      kind: 'spell',
      name: 'Botas de seda de araña',
      profession: 'Sastrería 125',
    },
  ],
  3065: [{ rel: 'sold_by', kind: 'npc', name: 'Zurzna', zone: 'Orgrimmar' }],
  11288: [{ rel: 'drops_from', kind: 'npc', name: 'world drop', zone: 'Baldíos' }],
  15700: [{ rel: 'reward_from', kind: 'quest', name: 'Pruebas de la Ciudad Sombría', level: 21 }],
  7055: [
    { rel: 'created_by', kind: 'spell', name: 'Faja de seda azur', profession: 'Sastrería 140' },
  ],
  3647: [{ rel: 'sold_by', kind: 'npc', name: 'Magda', zone: 'Orgrimmar' }],
  5240: [
    { rel: 'created_by', kind: 'spell', name: 'Varita de llamas', profession: 'Encantamiento 110' },
  ],
  5214: [{ rel: 'drops_from', kind: 'npc', name: 'Taragaman el Hambriento', zone: 'Sima Ígnea' }],
  5291: [{ rel: 'sold_by', kind: 'npc', name: 'Kaelystia', zone: 'Orgrimmar' }],
};
const prices: Record<number, number> = {
  7048: 9500,
  4321: 4200,
  4314: 1000,
  4320: 7000,
  3065: 2500,
  11288: 3000,
  7055: 5600,
  3647: 900,
  5240: 3300,
  20442: 12000,
};

// Per-item answers in the shape the bridge's item_sources returns: only names,
// zones, quest levels and evidence, never details production cannot see. The
// eval bridge serves these for the requested IDs only.
const relationKinds: Record<string, string> = {
  dropped_by: 'drops',
  drops_from: 'drops',
  sold_by: 'vendors',
  reward_from: 'quests',
  created_by: 'crafted',
};
export function itemSourcesFixture() {
  const ids = [...Object.values(armor), ...Object.values(weapons)].flat().map((entry) => entry.id);
  return Object.fromEntries(
    ids.map((itemId) => {
      const found: Record<string, unknown[]> = {};
      for (const edge of (sources[itemId] ?? []) as Array<Record<string, any>>) {
        const kind = relationKinds[String(edge.rel)];
        if (!kind) {
          continue;
        }
        (found[kind] ??= []).push({
          kind: edge.kind,
          name: edge.name,
          ...(edge.zone ? { zones: [edge.zone] } : {}),
          ...(edge.level ? { requiredLevel: edge.level } : {}),
          evidence: edge.rel === 'created_by' ? 'game files, unconfirmed' : 'player-observed',
        });
      }
      return [
        itemId,
        {
          itemId,
          ...found,
          auction: prices[itemId] ? { unitPriceCopper: prices[itemId], ageDays: 0 } : undefined,
          sourceKnown: Object.keys(found).length > 0,
          sourcesStatus: 'available',
        },
      ];
    }),
  );
}

export function fedrathStubs(): ToolStub[] {
  return json([
    {
      id: 'character',
      tool: 'wow__query_character',
      outcome: { response: gearReading },
    },
    ...Object.entries(armor).map(([slot, items]) => ({
      id: 'armor-' + slot,
      tool: 'wow__search_armor',
      match: { slot: { const: slot } },
      outcome: {
        response: searchResult(
          {
            class: 'armor',
            subclass: ['neck', 'finger', 'trinket'].includes(slot) ? 'miscellaneous' : 'cloth',
            slot,
          },
          items,
          slot === 'feet' ? 4 : 2,
        ),
      },
    })),
    ...Object.entries(weapons).map(([type, items]) => ({
      id: 'weapons-' + type,
      tool: 'wow__search_weapons',
      match: { weaponType: { const: type } },
      outcome: { response: searchResult({ class: 'weapons', subclass: type }, items, 1) },
    })),
    {
      id: 'weapons-other',
      tool: 'wow__search_weapons',
      outcome: { response: searchResult({ class: 'weapons' }, []) },
    },
    ...Object.entries(sources).map(([id, edges]) => ({
      id: 'source-' + id,
      tool: 'everloot__entity_relations',
      match: { id: { const: Number(id) } },
      outcome: {
        response: {
          connected: true,
          dataAsOf: '2026-11-22T03:20:15.775Z',
          url: 'https://everloot.app/database/items/' + id,
          page: { kind: 'item', id: Number(id), edges, notShown: 0 },
        },
      },
    })),
    {
      id: 'source-unknown',
      tool: 'everloot__entity_relations',
      outcome: {
        response: {
          connected: true,
          dataAsOf: '2026-11-22T03:20:15.775Z',
          page: { edges: [], notShown: 0 },
        },
      },
    },
    {
      id: 'item-page',
      tool: 'everloot__item_page',
      outcome: { response: { connected: true, page: { name: null, drops: [], pins: [] } } },
    },
    {
      id: 'prices',
      tool: 'auctionator__get_item_prices',
      outcome: {
        response: {
          status: 'available',
          capturedAt: 1_795_319_072,
          data: {
            prices: Object.entries(prices).map(([itemId, unitPriceCopper]) => ({
              itemId: Number(itemId),
              status: 'available',
              unitPriceCopper,
              ageKnown: true,
              ageDays: 0,
            })),
            note: 'Last-seen unit prices in copper, not live listings.',
          },
        },
      },
    },
    {
      id: 'present',
      tool: 'wisp__present_ui',
      outcome: { response: { status: 'presented' } },
    },
    {
      id: 'auctions',
      tool: 'wow__inspect_auctions',
      outcome: { throw: { message: 'Open the auction house and load a search first' } },
    },
    {
      id: 'compare',
      tool: 'wow__compare_items',
      outcome: {
        throw: { message: 'Not used in this eval: search results already compare items.' },
      },
    },
    {
      id: 'catalog-search',
      tool: 'thewowdb__search_database',
      outcome: {
        response: { status: 'no_matches', source: { name: 'TheWoWDB', version: 'forever' } },
      },
    },
    {
      id: 'catalog-entity',
      tool: 'thewowdb__get_database_entity',
      outcome: {
        response: { status: 'not_found', source: { name: 'TheWoWDB', version: 'forever' } },
      },
    },
  ]);
}
