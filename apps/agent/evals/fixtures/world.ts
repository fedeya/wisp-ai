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

// wow__dungeons for a level 21 Horde character with Questie and Polestar
// installed: names and ranges from Forever's group finder, entrances from
// QuestieDB, extras and the RFC page from Polestar's journal.
const entry = (
  name: string,
  instanceMapId: number,
  minLevel: number,
  maxLevel: number,
  entrance: [number, number, number, string] | null,
  extra: Record<string, unknown> = {},
) => ({
  name,
  instanceMapId,
  minLevel,
  maxLevel,
  players: 5,
  source: 'group finder',
  ...(entrance && {
    entrances: [{ mapId: entrance[0], x: entrance[1], y: entrance[2], source: entrance[3] }],
  }),
  ...extra,
});
const reading = {
  sources: { groupFinder: true, questie: true, polestar: '0.4.1.1' },
  characterLevel: 21,
  faction: 'H',
};
const questie = 'QuestieDB Forever';
const rfc = entry('Sima Ígnea', 389, 13, 18, [1454, 52.6, 49, questie], {
  journalKey: 'ragefire-chasm',
  bestLevel: 15,
  zone: 'Orgrimmar',
  questCount: 8,
});

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
            ...reading,
            moreQuests: false,
            dungeon: {
              ...rfc,
              quests: [
                {
                  id: 5723,
                  title: 'Poner a prueba la fuerza del enemigo',
                  level: 15,
                  minLevel: 9,
                  objectives: 'Mata a 8 troggs Furia Ardiente. Mata a 8 chamanes Furia Ardiente.',
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
                },
                {
                  id: 5722,
                  title: 'Buscando la bolsa perdida',
                  level: 16,
                  minLevel: 10,
                  objectives: 'Recupera la bolsa de Maur Grimtotem',
                  start: { name: 'Rahauro', mapId: 1456, x: 70.6, y: 30.7 },
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
            ...reading,
            dungeons: [
              rfc,
              entry('Salón de Señores Feudales', 3065, 13, 20, [1455, 27.63, 47.83, questie], {
                newInForever: true,
                bestLevel: 15,
                zone: 'Forjaz',
                questCount: 1,
                enemyTerritory: 'Entrada en territorio de la Alianza (en Forjaz)',
              }),
              entry('Cuevas de los Lamentos', 43, 15, 24, [1413, 46, 36.5, questie], {
                bestLevel: 21,
                zone: 'Los Baldíos',
                questCount: 9,
              }),
              entry('Ruinas de Lordaeron', 2999, 15, 22, [1458, 72.41, 11.37, questie], {
                newInForever: true,
                bestLevel: 19,
                zone: 'Entrañas',
                questCount: 10,
              }),
              entry('Minas de la Muerte', 36, 17, 26, [1436, 42.5, 71.7, questie], {
                zone: 'Páramos de Poniente',
                enemyTerritory: 'Entrada en territorio de la Alianza (Páramos de Poniente)',
              }),
              entry('Castillo de Colmillo Oscuro', 33, 20, 30, [1421, 44.8, 67.8, questie], {
                bestLevel: 24,
                zone: 'Bosque de Argénteos',
                questCount: 6,
              }),
              entry('Cavernas de Brazanegra', 48, 24, 32, [1440, 14.5, 14.2, questie], {
                bestLevel: 27,
                zone: 'Vallefresno',
                questCount: 9,
              }),
              entry(
                'Sitio de Excavación: Los Humedales',
                2998,
                26,
                33,
                [1437, 47.79, 56.16, questie],
                {
                  newInForever: true,
                  bestLevel: 29,
                  zone: 'Los Humedales',
                  questCount: 5,
                },
              ),
              entry('Ciudad de Dalaran', 2959, 28, 35, [1416, 8.46, 59.21, questie], {
                newInForever: true,
                bestLevel: 32,
                zone: 'Montañas de Alterac',
                questCount: 4,
                attunements: 1,
              }),
              entry('Gnomeregan', 90, 29, 38, [1426, 24.3, 39.8, questie], {
                enemyTerritory: 'Entrada en territorio de la Alianza (Dun Morogh)',
              }),
              entry('Horado Rajacieno', 47, 29, 38, [1413, 42.9, 90.2, questie], { questCount: 4 }),
              entry('La Ciudad Anegada', 2970, 35, 42, null, { newInForever: true }),
              entry("Bastión de Krol'dok", 3039, 40, 47, null, { newInForever: true }),
            ],
          },
        },
      },
    },
  ]);
}
