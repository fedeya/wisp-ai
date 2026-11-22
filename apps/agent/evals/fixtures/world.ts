import type { ToolStub } from 'eve/evals';

// Catalog, web and map fixtures for non-gear questions. Put these before
// fedrathStubs(): the first matching stub wins.
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const thewowdb = { name: 'TheWoWDB', version: 'forever' };

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

export function dungeonStubs(): ToolStub[] {
  return json([
    {
      id: 'zone-search',
      tool: 'thewowdb__search_database',
      outcome: {
        response: {
          status: 'available',
          source: thewowdb,
          data: {
            results: [
              { id: 2437, name: 'Sima Ígnea', kind: 'zone' },
              { id: 718, name: 'Cuevas de los Lamentos', kind: 'zone' },
            ],
          },
        },
      },
    },
    {
      id: 'zone-entity',
      tool: 'thewowdb__get_database_entity',
      outcome: {
        response: {
          status: 'available',
          source: thewowdb,
          data: { name: 'Sima Ígnea', kind: 'zone', levelRange: [13, 18], parent: 'Orgrimmar' },
        },
      },
    },
    {
      id: 'web-search',
      tool: 'web__web_search',
      outcome: {
        response: {
          results: [
            {
              title: 'WoW Forever dungeon level guide',
              url: 'https://example.org/forever/dungeons',
              excerpt:
                'Ragefire Chasm (Sima Ígnea) 13-18, Wailing Caverns 17-24, Deadmines 17-26, Shadowfang Keep 22-30. Dungeon Finder unlocks at level 13.',
            },
          ],
        },
      },
    },
    {
      id: 'web-fetch',
      tool: 'web_fetch',
      outcome: {
        response: {
          url: 'https://example.org/forever/dungeons',
          content:
            'Ragefire Chasm sits inside Orgrimmar in the Cleft of Shadow (entrance 52.8, 49.6). Recommended 13-18. Wailing Caverns in the Barrens: 17-24.',
        },
      },
    },
  ]);
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

// Polestar's journal as wow__dungeons returns it for a level 21 Horde
// character: ranges and entrances follow Polestar's Forever data.
const dungeon = (
  key: string,
  name: string,
  minLevel: number,
  maxLevel: number,
  bestLevel: number,
  zone: string,
  entrance: [number, number, number],
  extra: Record<string, unknown> = {},
) => ({
  key,
  name,
  kind: 'dungeon',
  minLevel,
  maxLevel,
  bestLevel,
  players: 5,
  zone,
  entrance: { mapId: entrance[0], x: entrance[1], y: entrance[2] },
  ...extra,
});
const journal = {
  source: 'Polestar dungeon journal',
  version: '0.4.1.1',
  characterLevel: 21,
  faction: 'H',
};

export function dungeonJournalStubs(): ToolStub[] {
  return json([
    {
      id: 'dungeon-rfc',
      tool: 'wow__dungeons',
      match: { dungeon: { pattern: '[Ss]ima|[Rr]agefire|RFC|rfc' } },
      outcome: {
        response: {
          status: 'available',
          data: {
            ...journal,
            moreQuests: false,
            dungeon: {
              ...dungeon(
                'ragefire-chasm',
                'Sima Ígnea',
                13,
                18,
                15,
                'Orgrimmar',
                [1454, 49.3, 95.1],
                {
                  questCount: 8,
                },
              ),
              quests: [
                {
                  id: 5723,
                  title: 'Poner a prueba la fuerza del enemigo',
                  level: 15,
                  minLevel: 9,
                  objectives: 'Mata a 8 troggs Furia Ardiente\nMata a 8 chamanes Furia Ardiente',
                  start: { name: 'Rahauro', mapId: 1456, x: 70.6, y: 30.7 },
                  finish: { name: 'Rahauro', mapId: 1456, x: 70.6, y: 30.7 },
                  rewards: { xp: 1350 },
                },
                {
                  id: 5725,
                  title: 'El poder de destruir...',
                  level: 16,
                  minLevel: 10,
                  state: 'completed',
                  start: { name: 'Varimathras', mapId: 1458, x: 56.2, y: 92.2 },
                  finish: { name: 'Varimathras', mapId: 1458, x: 56.2, y: 92.2 },
                },
                {
                  id: 5722,
                  title: 'Buscando la bolsa perdida',
                  level: 16,
                  minLevel: 10,
                  objectives: 'Recupera la bolsa de Maur Grimtotem',
                  start: { name: 'Rahauro', mapId: 1456, x: 70.6, y: 30.7 },
                  finish: { name: 'Rahauro', mapId: 1456, x: 70.6, y: 30.7 },
                  rewards: { xp: 1600 },
                },
              ],
              bosses: [
                { name: 'Oggleflint', level: 16 },
                {
                  name: 'Taragaman el Hambriento',
                  level: 16,
                  loot: [{ id: 5214, name: 'Varita de las sombras', quality: 2 }],
                },
                { name: 'Jergosh el Invocador', level: 16 },
                { name: 'Bazzalan', level: 16 },
              ],
            },
          },
        },
      },
    },
    {
      id: 'dungeon-list',
      tool: 'wow__dungeons',
      outcome: {
        response: {
          status: 'available',
          data: {
            ...journal,
            dungeons: [
              dungeon('ragefire-chasm', 'Sima Ígnea', 13, 18, 15, 'Orgrimmar', [1454, 49.3, 95.1], {
                questCount: 8,
              }),
              dungeon(
                'the-hall-of-thanes',
                'La Sala de los Thanes',
                13,
                18,
                15,
                'Forjaz',
                [1455, 15.1, 86],
                {
                  newInForever: true,
                  questCount: 1,
                  enemyTerritory: 'Entrada en territorio de la Alianza (en Forjaz)',
                },
              ),
              dungeon(
                'ruins-of-lordaeron',
                'Ruinas de Lordaeron',
                15,
                22,
                19,
                'Entrañas',
                [1458, 72.7, 11.5],
                {
                  newInForever: true,
                  questCount: 10,
                },
              ),
              dungeon(
                'wailing-caverns',
                'Cuevas de los Lamentos',
                17,
                24,
                21,
                'Los Baldíos',
                [1413, 46.7, 35.7],
                {
                  questCount: 9,
                },
              ),
              dungeon(
                'shadowfang-keep',
                'Castillo de Colmillo Oscuro',
                20,
                30,
                24,
                'Bosque de Argénteos',
                [1421, 45, 67.9],
                {
                  questCount: 6,
                },
              ),
              dungeon(
                'blackfathom-deeps',
                'Cavernas de Brazanegra',
                24,
                32,
                27,
                'Vallefresno',
                [1440, 15.1, 13.2],
                {
                  questCount: 9,
                },
              ),
              dungeon(
                'stormwind-stockade',
                'Las Mazmorras',
                24,
                32,
                27,
                'Ventormenta',
                [1453, 50.8, 67],
                {
                  enemyTerritory: 'Entrada en territorio de la Alianza (en Ventormenta)',
                },
              ),
              dungeon(
                'excavation-site-wetlands',
                'Excavación: Los Humedales',
                26,
                33,
                29,
                'Los Humedales',
                [1437, 50.8, 61.1],
                {
                  newInForever: true,
                  questCount: 5,
                },
              ),
              dungeon(
                'city-of-dalaran',
                'Ciudad de Dalaran',
                28,
                35,
                32,
                'Montañas de Alterac',
                [1416, 8.8, 59.6],
                {
                  newInForever: true,
                  questCount: 4,
                  attunements: 1,
                },
              ),
            ],
          },
        },
      },
    },
  ]);
}
