// @effect-migrated
import { Schema } from 'effect';
import { TrimmedString } from '@wisp/protocol/checks';
import {
  IntBetween,
  NumberBetween,
  PositiveInt,
  refine,
  StringRecord,
  withDefault,
} from './tool-inputs.ts';

// Every object here is strict: decode it with `rejectUnknownKeys`.

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const percent = Schema.optionalKey(NumberBetween(0, 100));

export const rotationAction = Schema.Struct({
  spellId: PositiveInt,
  manaBelowPercent: percent,
  manaAbovePercent: percent,
  rageAbove: percent,
  energyAbove: percent,
  comboPointsAtLeast: Schema.optionalKey(IntBetween(1, 9)),
  dotRefreshBelowSeconds: Schema.optionalKey(NonNegative),
});
const label = TrimmedString({ minLength: 1, maxLength: 80 });
const rotationPlan = Schema.Struct({
  label,
  talents: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: PositiveInt, rank: IntBetween(1, 5) })),
  ),
  opener: withDefault(Schema.Array(rotationAction), () => []),
  priority: Schema.Array(rotationAction),
});
export const simulationInput = Schema.Struct({
  nativeRequest: Schema.optionalKey(StringRecord(Schema.Unknown)),
  startIndex: withDefault(NonNegativeInt, () => 0),
  character: Schema.optionalKey(
    Schema.Struct({
      class: Schema.Literals([
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
      level: IntBetween(1, 60),
      raceToken: Schema.Literals([
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
    }),
  ),
  catalogOnly: withDefault(Schema.Boolean, () => false),
  plans: withDefault(Schema.Array(rotationPlan), () => []),
  includeCurrentEquipment: withDefault(Schema.Boolean, () => true),
  equipmentSets: withDefault(
    Schema.Array(
      Schema.Struct({
        label,
        base: withDefault(Schema.Literals(['current', 'empty']), () => 'current' as const),
        replacements: Schema.Array(
          Schema.Struct({ slot: IntBetween(1, 18), itemId: NonNegativeInt }),
        ),
      }),
    ),
    () => [],
  ),
  durationSeconds: withDefault(Schema.Finite.check(Schema.isGreaterThan(0)), () => 30),
  iterations: withDefault(PositiveInt, () => 500),
  targetLevelOffset: withDefault(Schema.Int, () => 0),
  targetDistanceYards: Schema.optionalKey(NonNegative),
}).check(
  refine(
    (input) => input.nativeRequest !== undefined || input.catalogOnly || input.plans.length > 0,
    'Provide at least one plan for simulation.',
  ),
  refine(
    (input) =>
      input.nativeRequest !== undefined ||
      input.catalogOnly ||
      input.includeCurrentEquipment ||
      input.equipmentSets.length > 0,
    'Provide at least one equipment set when excluding current equipment.',
  ),
);

/** A simulation request as the agent's tool sends it, before defaults are applied. */
export type SimulationInput = typeof simulationInput.Encoded;
/** A simulation request after decoding, with its defaults. */
export type SimulationOptions = typeof simulationInput.Type;
/** One step of a rotation plan, after decoding. */
export type RotationAction = typeof rotationAction.Type;

/** Whether a decoded request reads the live character or its equipment. */
export function simulationNeedsLiveState(options: SimulationOptions) {
  return (
    !options.nativeRequest &&
    (!options.character ||
      (!options.catalogOnly &&
        (options.includeCurrentEquipment ||
          options.equipmentSets.some((set) => set.base === 'current'))))
  );
}
