import type { ToolStub } from 'eve/evals';

// Quest, dungeon and map fixtures for non-gear questions. Put these before
// fedrathStubs(): the first matching stub wins.
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

export function questStubs(): ToolStub[] {
  return json([
    {
      id: 'quest-875',
      tool: 'questie__get_quest',
      match: { questId: { const: 875 } },
      outcome: {
        response: {
          status: 'available',
          data: {
            name: 'Destripadoras alabruja',
            level: 16,
            starters: { npc: [3449] },
            finishers: { npc: [3449] },
            objectives: { item: [[5064, 'Anillo de destripadora', 8]] },
            zone: 'Los Baldíos',
          },
        },
      },
    },
    {
      id: 'quest-1061',
      tool: 'questie__get_quest',
      match: { questId: { const: 1061 } },
      outcome: {
        response: {
          status: 'available',
          data: {
            name: 'El espíritu de los vientos',
            level: 21,
            finishers: { npc: [4201] },
            zone: 'Sierra Espolón',
          },
        },
      },
    },
    {
      id: 'quest-other',
      tool: 'questie__get_quest',
      outcome: { response: { status: 'available', data: { zone: 'Vallefresno' } } },
    },
    {
      id: 'npc-locations',
      tool: 'questie__find_npc_locations',
      outcome: {
        response: {
          provider: 'QuestieDB Forever',
          npcs: [
            {
              id: 4201,
              name: 'Ziz Fizziks',
              locations: [{ mapId: 1442, map: 'Sierra Espolón', x: 62.4, y: 40.1 }],
            },
            {
              id: 3449,
              name: 'Darsok Swiftdagger',
              locations: [{ mapId: 1413, map: 'Los Baldíos', x: 45.9, y: 36.4 }],
            },
          ],
        },
      },
    },
  ]);
}

// Catalog and web lookups the dungeon scenarios should not need, since
// wow__query_dungeons answers them. They return nothing rather than facts, so
// a stray search neither reaches the real services nor contradicts the game.
export function noLookupStubs(): ToolStub[] {
  return json(
    [
      'thewowdb__search_database',
      'thewowdb__get_database_entity',
      'web__web_search',
      'web_fetch',
    ].map((tool) => ({
      id: 'no-' + tool,
      tool,
      outcome: { response: { status: 'available', data: { results: [] } } },
    })),
  );
}

export function mapStubs(): ToolStub[] {
  return json([
    {
      id: 'map',
      tool: 'wow__inspect_map',
      outcome: {
        response: {
          status: 'available',
          data: {
            current: { mapId: 1454, name: 'Orgrimmar' },
            matches: [{ mapId: 1454, name: 'Orgrimmar' }],
          },
        },
      },
    },
    {
      id: 'waypoint',
      tool: 'wow__set_map_waypoint',
      outcome: { response: { status: 'available', data: { placed: true, navigation: true } } },
    },
  ]);
}

// wow__query_dungeons for a level 21 Horde character: names and ranges as Forever's
// group finder returns them, entrances from Wisp's generated table.
const reading = { characterLevel: 21, faction: 'Horde' };
const rfc = {
  name: 'Sima Ígnea',
  instanceMapId: 389,
  minLevel: 13,
  maxLevel: 18,
  players: 5,
  entrances: [{ mapId: 1454, zone: 'Orgrimmar', x: 53, y: 48.9 }],
};
const dungeons = [
  rfc,
  {
    name: 'Salón de Señores Feudales',
    instanceMapId: 3065,
    minLevel: 13,
    maxLevel: 20,
    players: 5,
    entrances: [{ mapId: 1455, zone: 'Forjaz', x: 27.7, y: 47.9 }],
  },
  {
    name: 'Cuevas de los Lamentos',
    instanceMapId: 43,
    minLevel: 15,
    maxLevel: 24,
    players: 5,
    entrances: [{ mapId: 1413, zone: 'Los Baldíos', x: 47.7, y: 35 }],
  },
  {
    name: 'Ruinas de Lordaeron',
    instanceMapId: 2999,
    minLevel: 15,
    maxLevel: 22,
    players: 5,
    entrances: [{ mapId: 1458, zone: 'Entrañas', x: 72.5, y: 11.4 }],
  },
  {
    name: 'Minas de la Muerte',
    instanceMapId: 36,
    minLevel: 17,
    maxLevel: 26,
    players: 5,
    entrances: [{ mapId: 1436, zone: 'Páramos de Poniente', x: 38.2, y: 77.5 }],
  },
  {
    name: 'Castillo de Colmillo Oscuro',
    instanceMapId: 33,
    minLevel: 20,
    maxLevel: 30,
    players: 5,
    entrances: [{ mapId: 1421, zone: 'Bosque de Argénteos', x: 44.7, y: 67.8 }],
  },
  {
    name: 'Cavernas de Brazanegra',
    instanceMapId: 48,
    minLevel: 24,
    maxLevel: 32,
    players: 5,
    entrances: [{ mapId: 1440, zone: 'Vallefresno', x: 16.5, y: 11 }],
  },
  {
    name: 'Sitio de Excavación: Los Humedales',
    instanceMapId: 2998,
    minLevel: 26,
    maxLevel: 33,
    players: 5,
    entrances: [{ mapId: 1437, zone: 'Los Humedales', x: 47.8, y: 56.2 }],
  },
  {
    name: 'Ciudad de Dalaran',
    instanceMapId: 2959,
    minLevel: 28,
    maxLevel: 35,
    players: 5,
    entrances: [{ mapId: 1416, zone: 'Montañas de Alterac', x: 8.5, y: 59.3 }],
  },
  {
    name: 'Gnomeregan',
    instanceMapId: 90,
    minLevel: 29,
    maxLevel: 38,
    players: 5,
    entrances: [{ mapId: 1426, zone: 'Dun Morogh', x: 17.7, y: 39.2 }],
  },
  {
    name: 'Horado Rajacieno',
    instanceMapId: 47,
    minLevel: 29,
    maxLevel: 38,
    players: 5,
    entrances: [{ mapId: 1413, zone: 'Los Baldíos', x: 42.3, y: 89.9 }],
  },
  {
    name: 'Monasterio Escarlata - Cementerio',
    instanceMapId: 189,
    minLevel: 30,
    maxLevel: 38,
    players: 5,
    entrances: [{ mapId: 1420, zone: 'Claros de Tirisfal', x: 85.1, y: 31.4 }],
  },
  {
    name: 'La Ciudad Anegada',
    instanceMapId: 2970,
    minLevel: 35,
    maxLevel: 42,
    players: 5,
    entrances: [{ mapId: 1434, zone: 'Vega de Tuercespina', x: 21.3, y: 27.8 }],
  },
  {
    name: "Bastión de Krol'dok",
    instanceMapId: 3039,
    minLevel: 40,
    maxLevel: 47,
    players: 5,
    entrances: [{ mapId: 2548, zone: "Krol'dok", x: 37.5, y: 37.3 }],
  },
];

export function dungeonStubs(): ToolStub[] {
  return json([
    {
      id: 'dungeon-rfc',
      tool: 'wow__query_dungeons',
      match: { dungeon: { pattern: '[Ss]ima|[Rr]agefire|RFC|rfc' } },
      outcome: { response: { status: 'available', data: { ...reading, dungeons: [rfc] } } },
    },
    {
      id: 'dungeon-list',
      tool: 'wow__query_dungeons',
      outcome: { response: { status: 'available', data: { ...reading, dungeons } } },
    },
  ]);
}
