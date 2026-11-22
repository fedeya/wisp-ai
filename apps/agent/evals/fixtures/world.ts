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
