// @effect-migrated
import { Schema } from 'effect';
import {
  Const,
  DiscriminatedUnion,
  IntBetween,
  LimitedString,
  withDefault,
} from './tool-inputs.ts';

export const settingsRead = Schema.Struct({
  sections: withDefault(
    Schema.Array(Schema.Literals(['options', 'addons', 'action_bars', 'keybindings'])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
    ),
    () => ['options'] as const,
  ),
  provider: withDefault(Schema.Literals(['all', 'game', 'ace']), () => 'all' as const),
  addon: Schema.optionalKey(LimitedString(1, 120)),
  query: Schema.optionalKey(LimitedString(1, 100)),
  ids: withDefault(Schema.Array(LimitedString(1, 400)).check(Schema.isMaxLength(30)), () => []),
  offset: withDefault(IntBetween(0, 10000), () => 0),
  limit: withDefault(IntBetween(1, 60), () => 30),
});
export const settingValue = Schema.Union([
  Schema.Boolean,
  Schema.Finite,
  Schema.String.check(Schema.isMaxLength(1000)),
]);
export const settingsUpdate = DiscriminatedUnion([
  Schema.Struct({
    operation: Const('preview'),
    changes: Schema.Array(Schema.Struct({ id: LimitedString(1, 400), value: settingValue })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(12),
    ),
  }),
  Schema.Struct({ operation: Const('apply'), transactionId: LimitedString(1, 100) }),
]);
export const settingsUndo = Schema.Struct({ transactionId: LimitedString(1, 100) });
