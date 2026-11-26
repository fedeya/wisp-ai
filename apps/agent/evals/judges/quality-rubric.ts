// Ground truth for grading answers. Each scenario states what is true in its
// fixtures and what a strong answer does, so the grader judges against data
// the agent could see, not against its own game knowledge.

const character =
  'Fedrath, level 21 Orc Mage (Horde) on realm Vorn, in Orgrimmar (Valley of Strength), 2g 14s 50c. ' +
  'Empty slots: head, neck, shoulder, second ring. Weak: feet (Woolen Boots, ilvl 13, +1 sta +1 int), ' +
  'wrist (ilvl 10, +1 int), waist (ilvl 12, +1 sta), first ring (Rough Copper Ring, +1 sta). ' +
  'Wand: Smoldering Wand (ilvl 18, no stats listed; ranged DPS unknown). English game client.';

const gearFacts = `
Candidates the tools returned (name, item level / required level, stats, source, last auction price):
- Head: Azure Silk Hood 7048 (24/19, +5 int +2 spi; Tailoring 145; 95s). Spider Silk Hood 4321 (19/14, +3 int +2 sta; Tailoring 125; 42s).
- Neck: Explorer's Medallion 20442 (23/18, +6 AGILITY +2 sta; quest reward) is a poor mage pick. Spectral Light Pendant 12047 (22/17, +3 int +3 spi; drop from an NPC in Silverpine Forest; no price).
- Shoulder: Double-stitched Woolen Shoulders 4314 (22/17, +4 sta +4 spell power; Tailoring 110; 10s). Woven Silk Shoulders 14112 (26/21, +4 int +4 spi; drop in Wailing Caverns; no price).
- Feet: Spidersilk Boots 4320 (25/20, +5 sp +4 int +2 sta; Tailoring 125; 70s). Eclipse Sandals 210990 (24/21, +5 int +4 spi) has NO known source and no price: recommending it as obtainable is wrong. Blessed Apprentice Boots 3065 (20/15, +3 int +3 spi; vendor in Orgrimmar; 25s).
- Finger: Seal of the Forsaken 15700 (25/21, +3 sta +4 sp; reward of the level 21 quest Trials of the Undercity; no price). Carved Pearl Ring 11288 (20/15, +2 int +2 spi; world drop; 30s).
- Waist: Azure Silk Belt 7055 (21/16, +3 int +2 spi; Tailoring 140; 56s). Wrist: Fine Cloth Bracers 3647 (17/12, +2 int; vendor in Orgrimmar; 9s).
- Wands: Flame Wand 5240 (22/17, +1 int; Enchanting; 33s). Shadow Wand 5214 (26/21, +2 int +1 spi; drop from Taragaman the Hungerer in Ragefire Chasm, the dungeon inside Orgrimmar; no price).
- Staves: Sage's Staff 5291 (24/19, +6 int +5 spi +2 sta; vendor in Orgrimmar; no price) vs equipped Apprentice's Staff (20/15, +5 int +4 sta +3 spi): a small trade, not a clear upgrade.
Any item not in this list does not exist in the data and must not be recommended.`;

export interface Scenario {
  facts: string;
  goodAnswer: string;
}

export const scenarios: Record<string, Scenario> = {
  'find-upgrades': {
    facts: character + gearFacts,
    goodAnswer:
      'Prioritizes cheap upgrades for empty or weak slots that suit a mage (intellect, spell power, spirit, stamina), such as the 10s shoulders, the boots, the hood and the quest ring, within the 2g 14s budget. Never recommends the agility neck or the source-less sandals as things to get. Says where each pick comes from or what it costs, and that auction prices are cached. Short, ordered, actionable.',
  },
  'better-wand': {
    facts: character + gearFacts,
    goodAnswer:
      'Answers in Spanish, since the player wrote in Spanish, keeping the English client item names. Names real better wands from the data (Shadow Wand as the better stats from a Ragefire Chasm drop, Flame Wand as a cheap auction option at about 33s), with their stat gains and how to get them. Says that wand damage per second could not be compared. Does not invent other wands.',
  },
  'dungeon-level': {
    facts:
      character +
      `
wow__query_dungeons returned, from the game's group finder with entrances from Wisp's table of the game's map data (5-player dungeons, name range; entrance zone x, y): Ragefire Chasm 13-18 (Orgrimmar 53, 48.9); Hall of Thanes 13-20 (Ironforge, an Alliance city); Wailing Caverns 15-24 (The Barrens 47.7, 35); Ruins of Lordaeron 15-22 (Undercity 72.5, 11.4); The Deadmines 17-26 (Westfall, Alliance territory); Shadowfang Keep 20-30 (Silverpine Forest 44.7, 67.8); Blackfathom Deeps 24-32 (Ashenvale); Excavation Site: Wetlands 26-33; City of Dalaran 28-35 (Alterac Mountains); Gnomeregan 29-38 (Dun Morogh, Alliance territory); Razorfen Kraul 29-38 (The Barrens); Scarlet Monastery - Graveyard 30-38 (Tirisfal Glades); The Drowned City 35-42; Krol'dok Stronghold 40-47. Ruins of Lordaeron, Hall of Thanes, the Excavation Site, Dalaran, The Drowned City and Krol'dok are new in Forever (the reading does not say so; saying it is fine). No best level, quest counts or drops were returned. Forever has no automatic Dungeon Finder.`,
    goodAnswer:
      'Answers that a level 21 mage can already do dungeons, recommends Wailing Caverns or Ruins of Lordaeron as the right fit now, notes Ragefire Chasm is easy and close, gives the returned ranges for the dungeons around this level (including the Forever-only ones), and flags dungeons whose entrance is in Alliance territory or cities. Inventing an automatic dungeon finder, dungeons or ranges not returned lowers correctness.',
  },
  'mark-rfc': {
    facts:
      character +
      `
Sources the tools returned: wow__query_dungeons gives the Ragefire Chasm entrance on Orgrimmar, UI map 1454, at 53, 48.9 from the game's map data. The waypoint tool succeeded and reported placed=true and navigation=true.`,
    goodAnswer:
      'Places one waypoint on Orgrimmar (1454) at the wow__query_dungeons entrance 53, 48.9 and says so briefly. Does not invent other coordinates and does not refuse when a source gave them.',
  },
  'next-quest': {
    facts:
      character +
      `
Quest log: Witchwing Slayers 875 (level 16, 4/8 Witchwing Talons, 1150 XP, The Barrens; turn in to Darsok Swiftdagger at 45.9, 36.4). Spirit of the Wind 1061 (level 21, complete, 1850 XP; turn in to Ziz Fizziks in Stonetalon Mountains at 62.4, 40.1). Calling in the Reserves 5881 (level 24, not started objective). The Storm Cavern 1489 (level 27, kill an elite NPC): too high for level 21.`,
    goodAnswer:
      'Gives one clear recommendation (finish the Barrens quest, or turn in the completed level 21 quest), explains it with the verified progress, XP and where to go, accounts for travel from Orgrimmar, and does not recommend the level 27 quest now.',
  },
  'shadowfang-loot': {
    facts:
      character +
      `
wow__dungeon_loot for Shadowfang Keep (20-30) returned AtlasLoot drops read by the game, with illustrative stats. Fits for this mage: Blindwatcher Hood (Odo, head slot is empty, +6 int +4 spell power, requires 21), Gravedirt Amulet (Rethilgore, neck is empty, +4 int +4 sp, requires 21), Feline Mantle (Nandos, shoulder is empty, +3 int +3 spi, 56.7%), Silverlaine's Family Seal (ring, +3 int +4 spi, 19.53%), Odo's Ley Staff (+7 int +6 spi +3 sta, 35.1%). Requiring level 22: Robes of Arugal, Belt of Arugal (Arugal, about 34%), Springvale Reliquary (trinket, +7 sp). Silverlaine's Spellblade and other one-handed swords need sword training. Mail, leather, shields and maces were hidden as unusable for a mage.`,
    goodAnswer:
      'Recommends the caster pieces that fill empty slots first (hood, amulet, shoulders, ring), mentions the staff or level 22 pieces with their level, names the bosses that drop them, and gives drop chances only where the data has them. Never recommends mail, leather or strength gear.',
  },
  'boss-loot': {
    facts:
      character +
      `
wow__dungeon_loot for Baron Silverlaine (Shadowfang Keep) returned: Silverlaine's Family Seal (ring, +3 int +4 spi, requires 21, 19.53%), Silverlaine's Spellblade (one-handed sword, +4 int +6 sp, requires 22, no chance; the mage must train swords at a weapon master first), Gilneas Officer Sabre (strength sword), Silverlaine Vintage (drink), and Baron's Scepter (a mace mages cannot use, 40%).`,
    goodAnswer:
      'Says the ring fills the empty ring slot and is the best pick now, mentions the Spellblade with its level 22 requirement and that swords need training, and does not recommend the mace or the strength sabre.',
  },
  'raid-loot': {
    facts:
      character +
      `
wow__dungeon_loot for Molten Core returned all 10 bosses (Lucifron, Magmadar, Gehennas, Garr, Shazzrah, Baron Geddon, Golemagg, Sulfuron Harbinger, Majordomo Executus, Ragnaros) with their AtlasLoot drops and classic-era drop chances, plus shared boss loot and trash. Every piece requires level 60; the character is 21.`,
    goodAnswer:
      'Lists each boss with its notable drops and chances from the data, notes that the gear requires level 60 so it is not for the character now, and does not invent bosses or drops.',
  },
  'wailing-caverns': {
    facts:
      character +
      `
Wailing Caverns is a 15-24 dungeon (The Barrens 47.7, 35). wow__dungeon_loot returned, among others: Snake Eye Kaleidoscope (Lady Anacondra, neck, +4 int +3 spi), Slither Cord (Lord Pythas, waist, +3 int +3 sp), Slime-encrusted Pads (Mutanus, shoulders, +4 int +3 sta, 29.6%), Deep Fathom Ring (Mutanus, ring, +3 sta +3 spi, 30.55%), Living Root (Verdan, staff, +4 int +9 spi: loses int and stamina against the equipped staff). Fang set pieces are leather and were hidden for a mage.`,
    goodAnswer:
      'Says yes, the dungeon fits level 21 and has upgrades for the empty neck, shoulder and ring slots plus the belt, names the bosses that drop them, suggests going through Mutanus, and does not recommend leather or weapons a mage cannot use.',
  },
};

export const criteria = {
  correctness:
    'Every fact, item, stat, price, source, level and coordinate in the answer matches the facts. 2 = nothing invented or wrong; 1 = a minor unsupported detail; 0 = an invented item or a wrong key fact.',
  fit: 'The recommendation is right for this character: class, level, budget, location and goal. 2 = the best or a clearly sensible choice; 1 = acceptable but misses a clearly better option or includes a poor pick; 0 = a poor or harmful recommendation.',
  usefulness:
    'The player can act on it: what to do first, where to get it or go, how. 2 = immediately actionable; 1 = partly; 0 = vague.',
  honesty:
    'Uncertainty is stated where the data is uncertain (cached prices, unconfirmed sources, unknown DPS, guidance ranges) without hedging what is verified. 2 = well calibrated; 1 = misses one; 0 = presents unknowns as fact.',
  clarity:
    'Concise, well ordered, in the user language, no filler. 2 = clear and brief; 1 = somewhat long or messy; 0 = hard to follow.',
} as const;
