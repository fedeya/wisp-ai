import { z } from 'zod';
export const rotationAction = z.strictObject({
  spellId: z.number().int().positive(),
  manaBelowPercent: z.number().min(0).max(100).optional(),
  manaAbovePercent: z.number().min(0).max(100).optional(),
  rageAbove: z.number().min(0).max(100).optional(),
  energyAbove: z.number().min(0).max(100).optional(),
  comboPointsAtLeast: z.number().int().min(1).max(9).optional(),
  dotRefreshBelowSeconds: z.number().nonnegative().optional(),
});
const rotationPlan = z.strictObject({
  label: z.string().trim().min(1).max(80),
  talents: z
    .array(
      z.strictObject({ id: z.number().int().positive(), rank: z.number().int().min(1).max(5) }),
    )
    .optional(),
  opener: z.array(rotationAction).default([]),
  priority: z.array(rotationAction),
});
export const simulationInput = z
  .strictObject({
    nativeRequest: z.record(z.string(), z.unknown()).optional(),
    startIndex: z.number().int().nonnegative().default(0),
    character: z
      .strictObject({
        class: z.enum([
          'MAGE',
          'WARRIOR',
          'ROGUE',
          'HUNTER',
          'PALADIN',
          'PRIEST',
          'SHAMAN',
          'WARLOCK',
          'DRUID',
        ]),
        level: z.number().int().min(1).max(60),
        raceToken: z.enum([
          'Human',
          'Gnome',
          'Troll',
          'Scourge',
          'Undead',
          'Dwarf',
          'NightElf',
          'Orc',
          'Tauren',
        ]),
      })
      .optional(),
    catalogOnly: z.boolean().default(false),
    plans: z.array(rotationPlan).default([]),
    includeCurrentEquipment: z.boolean().default(true),
    equipmentSets: z
      .array(
        z.strictObject({
          label: z.string().trim().min(1).max(80),
          base: z.enum(['current', 'empty']).default('current'),
          replacements: z.array(
            z.strictObject({
              slot: z.number().int().min(1).max(18),
              itemId: z.number().int().nonnegative(),
            }),
          ),
        }),
      )
      .default([]),
    durationSeconds: z.number().positive().default(30),
    iterations: z.number().int().positive().default(500),
    targetLevelOffset: z.number().int().default(0),
    targetDistanceYards: z.number().nonnegative().optional(),
  })
  .refine(
    (input) => input.nativeRequest !== undefined || input.catalogOnly || input.plans.length > 0,
    {
      message: 'Provide at least one plan for simulation.',
    },
  )
  .refine(
    (input) =>
      input.nativeRequest !== undefined ||
      input.catalogOnly ||
      input.includeCurrentEquipment ||
      input.equipmentSets.length > 0,
    {
      message: 'Provide at least one equipment set when excluding current equipment.',
    },
  );

export function simulationNeedsLiveState(input: z.input<typeof simulationInput>) {
  const options = simulationInput.parse(input);
  return (
    !options.nativeRequest &&
    (!options.character ||
      (!options.catalogOnly &&
        (options.includeCurrentEquipment ||
          options.equipmentSets.some((set) => set.base === 'current'))))
  );
}
