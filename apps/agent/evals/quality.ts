// Ground truth for grading answers. Each scenario states what is true in its
// fixtures and what a strong answer does, so the grader judges against data
// the agent could see, not against its own game knowledge.

const character =
  'Fedrath, level 21 Orc Mage (Horde) on realm Vorn, in Orgrimmar (Valle de la Fuerza), 2g 14s 50c. ' +
  'Empty slots: head, neck, shoulder, second ring. Weak: feet (Botas de lana, ilvl 13, +1 sta +1 int), ' +
  'wrist (ilvl 10, +1 int), waist (ilvl 12, +1 sta), first ring (Anillo de cobre tosco, +1 sta). ' +
  'Wand: Varita ardiente (ilvl 18, no stats listed; ranged DPS unknown). Spanish game client.';

const gearFacts = `
Candidates the tools returned (name, item level / required level, stats, source, last auction price):
- Head: Capucha de seda azur 7048 (24/19, +5 int +2 spi; Tailoring 145; 95s). Capucha de tela de araña 4321 (19/14, +3 int +2 sta; Tailoring 125; 42s).
- Neck: Medallón de explorador 20442 (23/18, +6 AGILITY +2 sta; quest reward) is a poor mage pick. Colgante de luz espectral 12047 (22/17, +3 int +3 spi; drop from an NPC in Bosque de Argénteos; no price).
- Shoulder: Sobrehombros de lana con doble pespunte 4314 (22/17, +4 sta +4 spell power; Tailoring 110; 10s). Sobrehombros de seda tejida 14112 (26/21, +4 int +4 spi; drop in Cavernas de los Lamentos; no price).
- Feet: Botas de seda de araña 4320 (25/20, +5 sp +4 int +2 sta; Tailoring 125; 70s). Sandalias del eclipse 210990 (24/21, +5 int +4 spi) has NO known source and no price: recommending it as obtainable is wrong. Botas de aprendiz bendecidas 3065 (20/15, +3 int +3 spi; vendor in Orgrimmar; 25s).
- Finger: Sello de los Renegados 15700 (25/21, +3 sta +4 sp; reward of the level 21 quest Pruebas de la Ciudad Sombría; no price). Anillo de perla tallada 11288 (20/15, +2 int +2 spi; world drop; 30s).
- Waist: Faja de seda azur 7055 (21/16, +3 int +2 spi; Tailoring 140; 56s). Wrist: Brazales de tela fina 3647 (17/12, +2 int; vendor in Orgrimmar; 9s).
- Wands: Varita de llamas 5240 (22/17, +1 int; Enchanting; 33s). Varita de las sombras 5214 (26/21, +2 int +1 spi; drop from Taragaman el Hambriento in Sima Ígnea, the dungeon inside Orgrimmar; no price).
- Staves: Bastón del sabio 5291 (24/19, +6 int +5 spi +2 sta; vendor in Orgrimmar; no price) vs equipped Bastón de aprendiz (20/15, +5 int +4 sta +3 spi): a small trade, not a clear upgrade.
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
      'Answers in Spanish. Names real better wands from the data (Varita de las sombras as the better stats from a Sima Ígnea drop, Varita de llamas as a cheap auction option at about 33s), with their stat gains and how to get them. Says that wand damage per second could not be compared. Does not invent other wands.',
  },
  'dungeon-level': {
    facts:
      character +
      `
wow__query_dungeons returned, from the game's group finder with entrances from Wisp's table of the game's map data (5-player dungeons, name range; entrance zone x, y): Sima Ígnea 13-18 (Orgrimmar 53, 48.9); Salón de Señores Feudales 13-20 (Forjaz/Ironforge, an Alliance city); Cuevas de los Lamentos 15-24 (Los Baldíos 47.7, 35); Ruinas de Lordaeron 15-22 (Entrañas/Undercity 72.5, 11.4); Minas de la Muerte 17-26 (Páramos de Poniente/Westfall, Alliance territory); Castillo de Colmillo Oscuro 20-30 (Bosque de Argénteos 44.7, 67.8); Cavernas de Brazanegra 24-32 (Vallefresno); Sitio de Excavación: Los Humedales 26-33; Ciudad de Dalaran 28-35 (Montañas de Alterac); Gnomeregan 29-38 (Dun Morogh, Alliance territory); Horado Rajacieno 29-38 (Los Baldíos); Monasterio Escarlata - Cementerio 30-38 (Claros de Tirisfal); La Ciudad Anegada 35-42; Bastión de Krol'dok 40-47. Ruinas de Lordaeron, Salón de Señores Feudales, the Excavation Site, Dalaran, La Ciudad Anegada and Krol'dok are new in Forever (the reading does not say so; saying it is fine). No best level, quest counts or drops were returned. Forever has no automatic Dungeon Finder.`,
    goodAnswer:
      'Answers in Spanish that a level 21 mage can already do dungeons, recommends Cuevas de los Lamentos or Ruinas de Lordaeron as the right fit now, notes Sima Ígnea is easy and close, gives the returned ranges for the dungeons around this level (including the Forever-only ones), and flags dungeons whose entrance is in Alliance territory or cities. Inventing an automatic dungeon finder, dungeons or ranges not returned lowers correctness.',
  },
  'mark-rfc': {
    facts:
      character +
      `
Sources the tools returned: wow__query_dungeons gives the Sima Ígnea (Ragefire Chasm) entrance on Orgrimmar, UI map 1454, at 53, 48.9 from the game's map data. The waypoint tool succeeded and reported placed=true and navigation=true.`,
    goodAnswer:
      'Places one waypoint on Orgrimmar (1454) at the wow__query_dungeons entrance 53, 48.9 and says so in Spanish, briefly. Does not invent other coordinates and does not refuse when a source gave them.',
  },
  'next-quest': {
    facts:
      character +
      `
Quest log: Destripadoras alabruja 875 (level 16, 4/8 rings, 1150 XP, Los Baldíos; turn in to Darsok Swiftdagger at 45.9, 36.4). El espíritu de los vientos 1061 (level 21, complete, 1850 XP; turn in to Ziz Fizziks in Sierra Espolón at 62.4, 40.1). Calling in the Reserves 5881 (level 24, not started objective). Caverna de la Tormenta 1489 (level 27, kill an elite NPC): too high for level 21.`,
    goodAnswer:
      'Answers in Spanish with one clear recommendation (finish the Barrens quest, or turn in the completed level 21 quest), explains it with the verified progress, XP and where to go, accounts for travel from Orgrimmar, and does not recommend the level 27 quest now.',
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
