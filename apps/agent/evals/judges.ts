// Binary LLM judges, one per failure mode that needs interpretation. The
// modes and the few-shot examples come from reviewing real Wisp chats (error
// discovery, 2026-11-23); objective modes are code checks in checks.ts.
// Each judge writes its critique before its verdict.

export interface Judge {
  task: string;
  pass: string;
  fail: string;
  examples: Array<{ answer: string; critique: string; result: 'Pass' | 'Fail' }>;
}

export const judges = {
  'unsupported-claim': {
    task: 'Does the answer state a game fact (a location, coordinate, number, mechanic, source, or "what players usually do") that neither the FACTS nor the TOOL RESULTS support, without saying it is unverified?',
    pass: 'Every concrete game fact is backed by the facts or a tool result, or is clearly marked as unverified or as the assistant’s own suggestion. General gameplay advice that names no Forever-specific place, number or mechanic (pull one enemy at a time, break line of sight behind cover, drink between pulls) is fine.',
    fail: 'At least one concrete game fact is stated as true without support: an invented location or coordinate, a made-up price or drop rate, a mechanic stated with certainty that no source gave, or the assistant’s own idea presented as common practice. Calling a wand an upgrade from its stats while its damage per second is unknown, without saying so, also fails: for a wand the damage matters most.',
    examples: [
      {
        answer:
          'Rune of Teleportation is sold by reagent vendors. In Orgrimmar, look in the Valley of Spirits near the mage trainers; you are already there.',
        critique:
          'No tool result names a vendor or a place for the rune; the Valley of Spirits location is stated as fact and the player is sent there. It is unsupported (the real vendor was elsewhere).',
        result: 'Fail',
      },
      {
        answer: 'Most players bind raid markers to Alt+1/2/3: skull, cross and moon.',
        critique:
          'Presents a keybinding as what players usually use, but no source supports it; it is the assistant’s own idea stated as common practice.',
        result: 'Fail',
      },
      {
        answer:
          'Run Ragefire Chasm for a wand upgrade: the Shadow Wand gives +2 Intellect and +1 Spirit.',
        critique:
          'The stats match the data, but no source gives either wand’s damage per second; calling it an upgrade without saying the damage is unknown overstates it.',
        result: 'Fail',
      },
      {
        answer:
          'Next time, pull one at a time; if both join, duck behind cover to break the caster’s line of sight.',
        critique:
          'General gameplay advice that names no Forever-specific fact; the killer and damage it builds on come from the combat reading.',
        result: 'Pass',
      },
      {
        answer:
          'Horthus, the reagent vendor, sells it in Orgrimmar at 45.4, 56.6 (QuestieDB Forever position, not a live sighting).',
        critique:
          'The vendor, city and coordinates match the item-source and location results, and the answer states where the position comes from.',
        result: 'Pass',
      },
      {
        answer:
          'Kill Venture Co. overseers until the Cat’s Eye Emerald drops. I couldn’t verify its drop chance.',
        critique:
          'The source of the item matches the quest data, and the unknown drop chance is stated as unknown instead of guessed. Borderline but supported.',
        result: 'Pass',
      },
    ],
  },
  'unobtainable-gear': {
    task: 'Does the answer recommend getting an item the character cannot get or use now, without saying so?',
    pass: 'Every recommended item can be obtained and used now (bought at an auction price or vendor, a reachable drop or quest reward), or the answer clearly labels when it becomes usable (a future level, a profession requirement, weapon training) and does not present it as something to get now.',
    fail: 'The answer recommends, as something to get now, an item that only a profession the character lacks can make and that has no auction price; an item that needs a profession skill the character does not have; or an item the character cannot equip yet, without making that clear.',
    examples: [
      {
        answer:
          '1. Head — Azure Silk Hood: +5 Intellect. 2. Boots — Spidersilk Boots: +5 spell power. Both are crafted; I couldn’t find a price.',
        critique:
          'Both first picks are tailoring crafts with no auction price, and the character has no Tailoring; the answer still ranks them as the top upgrades instead of something the player can get now. The player could not find them.',
        result: 'Fail',
      },
      {
        answer:
          '| 4 | Green Tinted Goggles — +8 Stamina, +7 Spirit if you already have Engineering | Head | Engineering 150 |',
        critique:
          'The goggles need Engineering 150 and the facts show Engineering 4; listing them in the upgrade table as a priority invites a purchase the player cannot use.',
        result: 'Fail',
      },
      {
        answer:
          'Buy Double-stitched Woolen Shoulders first: about 10s at the auction house, +4 Stamina and +4 spell power in your empty slot.',
        critique:
          'A crafted item, but it has an auction price, so the player can buy it now; the answer says where.',
        result: 'Pass',
      },
      {
        answer:
          'Save for level 22: Robes of Arugal (+5 Intellect). For now, take the Gravedirt Amulet.',
        critique: 'The level 22 item is clearly labeled as a later goal, not something to use now.',
        result: 'Pass',
      },
    ],
  },
  'ignores-context': {
    task: 'Does the recommendation ignore the character’s context (distance and travel, level, money, danger, or a side effect) that the facts or tool results show?',
    pass: 'The recommendation fits where the character is, its level and budget, and warns about a real risk or side effect the data shows.',
    fail: 'The recommendation sends the character far away or into danger without saying so, exceeds the budget or level, or proposes something with a side effect the data shows (for example an error on every key press) without a warning.',
    examples: [
      {
        answer:
          'Do the Warsong Reports quest: take the reports to the scout, the outrider and the runner, then return to Kadrak.',
        critique:
          'The location results put the runner at the far side of the zone; the answer picks the quest by level alone and never mentions the trip.',
        result: 'Fail',
      },
      {
        answer:
          'Right-click the Chant to reveal the creatures, stun one and use the chest to capture it.',
        critique:
          'Summoning reveals every creature at once and they all attack; the answer gives no warning, and the player died to eight of them.',
        result: 'Fail',
      },
      {
        answer:
          'Turn in Spirit of the Wind later when you pass through Stonetalon; for now finish Witchwing Slayers here in the Barrens (4/8 talons).',
        critique:
          'Accounts for where the character is and defers the far turn-in instead of sending them across the map.',
        result: 'Pass',
      },
    ],
  },
  'uses-available-data': {
    task: 'Does the answer use the game data its tools returned, instead of asking the player for it or saying it cannot know?',
    pass: 'The answer is based on the game data in the tool results (combat log, honor and rank, group, loot) when that data was available.',
    fail: 'The answer asks the player to paste, read or report something the tool results already contain, or says it cannot see data that a tool returned.',
    examples: [
      {
        answer:
          'I can’t see your combat log. Open the Combat Log tab and paste the last lines before you died.',
        critique:
          'A combat reading was available; asking the player to paste it shifts the work to them.',
        result: 'Fail',
      },
      {
        answer:
          'Urryx Zer killed you with Fireball for 107 damage when you had 24 HP; Elba Suraa’s throw had dropped you from 82 just before.',
        critique: 'Names the killer, ability and health from the combat reading.',
        result: 'Pass',
      },
    ],
  },
} satisfies Record<string, Judge>;

export type JudgeName = keyof typeof judges;
