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
            name: 'Witchwing Slayers',
            level: 16,
            starters: { npc: [3449] },
            finishers: { npc: [3449] },
            objectives: { item: [[5064, 'Witchwing Talon', 8]] },
            zone: 'The Barrens',
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
            name: 'Spirit of the Wind',
            level: 21,
            finishers: { npc: [4201] },
            zone: 'Stonetalon Mountains',
          },
        },
      },
    },
    {
      id: 'quest-other',
      tool: 'questie__get_quest',
      outcome: { response: { status: 'available', data: { zone: 'Ashenvale' } } },
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
              locations: [{ mapId: 1442, map: 'Stonetalon Mountains', x: 62.4, y: 40.1 }],
            },
            {
              id: 3449,
              name: 'Darsok Swiftdagger',
              locations: [{ mapId: 1413, map: 'The Barrens', x: 45.9, y: 36.4 }],
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
  name: 'Ragefire Chasm',
  instanceMapId: 389,
  minLevel: 13,
  maxLevel: 18,
  players: 5,
  entrances: [{ mapId: 1454, zone: 'Orgrimmar', x: 53, y: 48.9 }],
};
const dungeons = [
  rfc,
  {
    name: 'Hall of Thanes',
    instanceMapId: 3065,
    minLevel: 13,
    maxLevel: 20,
    players: 5,
    entrances: [{ mapId: 1455, zone: 'Ironforge', x: 27.7, y: 47.9 }],
  },
  {
    name: 'Wailing Caverns',
    instanceMapId: 43,
    minLevel: 15,
    maxLevel: 24,
    players: 5,
    entrances: [{ mapId: 1413, zone: 'The Barrens', x: 47.7, y: 35 }],
  },
  {
    name: 'Ruins of Lordaeron',
    instanceMapId: 2999,
    minLevel: 15,
    maxLevel: 22,
    players: 5,
    entrances: [{ mapId: 1458, zone: 'Undercity', x: 72.5, y: 11.4 }],
  },
  {
    name: 'The Deadmines',
    instanceMapId: 36,
    minLevel: 17,
    maxLevel: 26,
    players: 5,
    entrances: [{ mapId: 1436, zone: 'Westfall', x: 38.2, y: 77.5 }],
  },
  {
    name: 'Shadowfang Keep',
    instanceMapId: 33,
    minLevel: 20,
    maxLevel: 30,
    players: 5,
    entrances: [{ mapId: 1421, zone: 'Silverpine Forest', x: 44.7, y: 67.8 }],
  },
  {
    name: 'Blackfathom Deeps',
    instanceMapId: 48,
    minLevel: 24,
    maxLevel: 32,
    players: 5,
    entrances: [{ mapId: 1440, zone: 'Ashenvale', x: 16.5, y: 11 }],
  },
  {
    name: 'Excavation Site: Wetlands',
    instanceMapId: 2998,
    minLevel: 26,
    maxLevel: 33,
    players: 5,
    entrances: [{ mapId: 1437, zone: 'Wetlands', x: 47.8, y: 56.2 }],
  },
  {
    name: 'City of Dalaran',
    instanceMapId: 2959,
    minLevel: 28,
    maxLevel: 35,
    players: 5,
    entrances: [{ mapId: 1416, zone: 'Alterac Mountains', x: 8.5, y: 59.3 }],
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
    name: 'Razorfen Kraul',
    instanceMapId: 47,
    minLevel: 29,
    maxLevel: 38,
    players: 5,
    entrances: [{ mapId: 1413, zone: 'The Barrens', x: 42.3, y: 89.9 }],
  },
  {
    name: 'Scarlet Monastery - Graveyard',
    instanceMapId: 189,
    minLevel: 30,
    maxLevel: 38,
    players: 5,
    entrances: [{ mapId: 1420, zone: 'Tirisfal Glades', x: 85.1, y: 31.4 }],
  },
  {
    name: 'The Drowned City',
    instanceMapId: 2970,
    minLevel: 35,
    maxLevel: 42,
    players: 5,
    entrances: [{ mapId: 1434, zone: 'Stranglethorn Vale', x: 21.3, y: 27.8 }],
  },
  {
    name: "Krol'dok Stronghold",
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

// The game's Death Recap for the character's latest death, in the shape
// addon/WispAI/Combat/Combat.lua returns (view=deaths), modelled on a real
// chat: two Venture Co. enemies at Windshear Crag, a Fireball finished it.
const recapEvents = [
  {
    event: 'SPELL_DAMAGE',
    spell: 'Fireball',
    source: 'Venture Co. Deforester',
    amount: 107,
    health: 24,
    healthPercent: 8,
    secondsBeforeDeath: 0,
    overkill: 83,
    causedDeath: true,
  },
  {
    event: 'SPELL_DAMAGE',
    spell: 'Throw',
    source: 'Venture Co. Logger',
    amount: 58,
    health: 82,
    healthPercent: 29,
    secondsBeforeDeath: 1,
  },
  {
    event: 'SWING_DAMAGE',
    spell: 'Melee',
    source: 'Venture Co. Logger',
    amount: 31,
    health: 113,
    healthPercent: 40,
    secondsBeforeDeath: 3,
  },
  {
    event: 'SPELL_DAMAGE',
    spell: 'Fireball',
    source: 'Venture Co. Deforester',
    amount: 64,
    health: 177,
    healthPercent: 63,
    secondsBeforeDeath: 5,
  },
  {
    event: 'SWING_DAMAGE',
    spell: 'Melee',
    source: 'Venture Co. Logger',
    amount: 42,
    health: 219,
    healthPercent: 78,
    secondsBeforeDeath: 7,
  },
];
export function combatStubs(): ToolStub[] {
  return json([
    {
      id: 'combat',
      tool: 'wow__read_combat',
      outcome: {
        response: {
          status: 'available',
          data: {
            inCombat: false,
            dead: true,
            view: 'deaths',
            deathCount: 1,
            deaths: [
              {
                diedAt: 1_795_318_990,
                secondsAgo: 40,
                zone: 'Stonetalon Mountains',
                subzone: 'Windshear Crag',
                level: 21,
                recapAvailable: true,
                maxHealth: 279,
                killingBlow: recapEvents[0],
                damageTaken: 302,
                damageBySource: [
                  { source: 'Venture Co. Deforester', ability: 'Fireball', amount: 171, hits: 2 },
                  { source: 'Venture Co. Logger', ability: 'Melee', amount: 73, hits: 2 },
                  { source: 'Venture Co. Logger', ability: 'Throw', amount: 58, hits: 1 },
                ],
                secondsCovered: 7,
                events: recapEvents,
              },
            ],
            note: "Newest death first, from the game's Death Recap. Events are newest first; the first caused the death.",
          },
        },
      },
    },
  ]);
}

// Forever PvP progression for a level 21 character that has fought in the
// open world but never queued a battleground: Civilian, some Honor.
export function pvpStubs(): ToolStub[] {
  return json([
    {
      id: 'character-pvp',
      tool: 'wow__query_character',
      match: { sections: { contains: { const: 'pvp' } } },
      outcome: {
        response: {
          status: 'available',
          sections: {
            pvp: {
              status: 'available',
              data: {
                rank: {
                  rank: 0,
                  title: 'Civilian',
                  points: 0,
                  nextRankPoints: 2000,
                  weeklyCapPoints: 7500,
                  note: 'Rank points come from battlegrounds and PvP quests; honorable kills in the open world give Honor, not rank points.',
                },
                honor: {
                  name: 'Honor Points',
                  amount: 89,
                  max: 25000,
                  earnedThisWeek: 89,
                  note: 'A currency for PvP gear.',
                },
                kills: { today: 3, yesterday: 0, lifetime: 12 },
              },
            },
          },
        },
      },
    },
  ]);
}

// Rune of Teleportation: the catalog finds the item and Questie places its
// vendor, Horthus, in Orgrimmar (the item's vendor comes from item sources).
export function runeStubs(): ToolStub[] {
  return json([
    {
      id: 'rune-search',
      tool: 'thewowdb__search_database',
      match: { query: { pattern: '[Rr]une|[Rr]una' } },
      outcome: {
        response: {
          status: 'available',
          source: { name: 'TheWoWDB', version: 'forever' },
          results: [{ kind: 'item', id: 17031, name: 'Rune of Teleportation' }],
        },
      },
    },
    {
      id: 'horthus',
      tool: 'questie__find_npc_locations',
      match: { name: { pattern: '[Hh]orthus' } },
      outcome: {
        response: {
          provider: 'QuestieDB Forever',
          npcs: [
            {
              id: 3335,
              name: 'Horthus',
              subName: 'Reagents',
              locations: [{ mapId: 1454, map: 'Orgrimmar', x: 45.4, y: 56.6 }],
            },
          ],
        },
      },
    },
  ]);
}
