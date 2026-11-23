/** Player-facing context for an integration's page: what it is, where it comes from, what to ask. */
export type IntegrationGuide = {
  about: string;
  link?: { label: string; url: string };
  examples: readonly string[];
};

const guides: Readonly<Partial<Record<string, IntegrationGuide>>> = {
  'integration:questie': {
    about:
      'Questie is a quest helper addon. Wisp reads QuestieDB, its database for Forever, to answer questions about quests, quest chains and where NPCs and objects are.',
    link: { label: 'QuestieDB on GitHub', url: 'https://github.com/Questie/QuestieDB' },
    examples: [
      'Where do I turn in this quest?',
      'Which quests lead up to this one?',
      'Where can I find the objects I need for my quest?',
    ],
  },
  'integration:polestar': {
    about:
      'Polestar is a free leveling guide addon for Forever. Wisp reads the guide and step you are on, and can build custom guides that open in Polestar’s window.',
    link: {
      label: 'Polestar on CurseForge',
      url: 'https://www.curseforge.com/wow/addons/polestar',
    },
    examples: [
      'What is my next step in the guide?',
      'Make me a guide to finish my open quests in this zone.',
      'How far along am I in this guide?',
    ],
  },
  'integration:syndicator': {
    about:
      'Syndicator keeps track of the items on all your characters. Wisp uses what it has saved to tell you where an item is: bags, bank, mail and, if you allow it, guild storage on your realm and faction.',
    link: {
      label: 'Syndicator on CurseForge',
      url: 'https://www.curseforge.com/wow/addons/syndicator',
    },
    examples: [
      'Which of my characters has Linen Cloth?',
      'Do I have any healing potions on my alts?',
      'How many Copper Bars do I have across all my characters?',
    ],
  },
  'integration:auctionator': {
    about:
      'Auctionator records auction house prices when you scan. Wisp reads the last price seen for each item and how old it is. It never scans, buys or posts for you.',
    link: {
      label: 'Auctionator on CurseForge',
      url: 'https://www.curseforge.com/wow/addons/auctionator',
    },
    examples: [
      'What was the last price for Copper Ore?',
      'Which items in my bags are worth the most?',
      'Should I sell these on the auction house or to a vendor?',
    ],
  },
  'integration:thewowdb': {
    about:
      'TheWoWDB is a database of Forever game data. Wisp searches it for items, spells, quests, NPCs and zones.',
    link: { label: 'TheWoWDB', url: 'https://thewowdb.com' },
    examples: [
      'What does Frost Nova do?',
      'Which spells does a Mage learn at level 10?',
      'Which zones are good for level 20 to 25?',
    ],
  },
  'mcp:everloot': {
    about:
      'Everloot is a Forever database of drops, vendors, professions, talents and market history. Wisp connects to its public MCP server.',
    link: { label: 'Everloot', url: 'https://everloot.app' },
    examples: [
      'Which vendors sell Fine Thread?',
      'What is the fastest way to level Tailoring?',
      'How has the price of Silk Cloth changed?',
    ],
  },
  'integration:wowsims': {
    about:
      'WoWSims Forever is an open-source combat simulator. Wisp runs it on your computer to compare rotations and equipment for your character. It is experimental and simulates supported abilities only.',
    link: { label: 'WoWSims Forever on GitHub', url: 'https://github.com/wowsims/forever' },
    examples: [
      'Simulate my DPS with my current gear.',
      'Would this new sword be an upgrade?',
      'Which rotation does more damage at my level?',
    ],
  },
  'integration:web': {
    about:
      'Wisp searches the web with the service you choose above and reads public pages, such as guides and patch notes, when you share a link.',
    examples: [
      'Find a Forever leveling guide for Hunters.',
      'What changed in the latest Forever patch?',
      'Summarize the guide at this link.',
    ],
  },
};

export function integrationGuide(id: string): IntegrationGuide | undefined {
  return guides[id];
}
