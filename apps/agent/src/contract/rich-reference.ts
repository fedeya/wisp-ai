// @effect-migrated
import { Schema } from 'effect';
import { Const, LimitedString, NumberBetween, PositiveInt, refine } from './tool-inputs.ts';

// Objects here drop unknown keys, as zod's `z.object` did. zod's refinements
// without a message failed with its default, kept here.
const invalid = 'Invalid input';

const label = LimitedString(1, 160).check(
  refine(
    // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
    (value) => !/[|\x00-\x1f]/.test(value) && !value.includes('[[ref:'),
    invalid,
  ),
);
const common = {
  label,
  source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
};
const entity = <const K extends 'spell' | 'item' | 'quest'>(kind: K) =>
  Schema.Struct({
    ...common,
    kind: Const(kind),
    id: PositiveInt,
    // The `u` flag lets the pattern reach the model; it matches the same payloads.
    payload: Schema.optionalKey(
      Schema.String.check(
        Schema.isMaxLength(1000),
        Schema.isPattern(/^(spell|item|quest):[\d:+.-]+$/u),
      ),
    ),
  }).check(
    refine(
      (value) =>
        !value.payload ||
        value.payload.startsWith(value.kind + ':' + value.id + ':') ||
        value.payload === value.kind + ':' + value.id,
      invalid,
    ),
  );
export const referenceSchema = Schema.Union([
  Schema.Struct({
    ...common,
    kind: Const('unit'),
    guid: LimitedString(3, 150).check(Schema.isPattern(/^[A-Za-z]+-[A-Za-z0-9-]+$/u)),
  }),
  entity('spell'),
  entity('item'),
  entity('quest'),
  Schema.Struct({
    ...common,
    kind: Const('map'),
    mapId: PositiveInt,
    x: Schema.optionalKey(NumberBetween(0, 100)),
    y: Schema.optionalKey(NumberBetween(0, 100)),
  }).check(refine((value) => (value.x === undefined) === (value.y === undefined), invalid)),
  Schema.Struct({
    ...common,
    kind: Const('macro'),
    name: LimitedString(1, 16).check(
      refine(
        (value) =>
          // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
          Buffer.byteLength(value, 'utf8') <= 16 && !/[|\x00-\x1f]/.test(value),
        invalid,
      ),
    ),
  }),
]);
export type RichReference = typeof referenceSchema.Type;
export type ReferenceCatalog = Record<string, RichReference>;
