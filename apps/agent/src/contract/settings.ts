import { Schema } from 'effect';
import { z } from 'zod';
import { IntBetween, LimitedString, withDefault } from './tool-inputs.ts';

// The read is an inspection and decodes with Schema; the update and undo are
// game actions, still zod until their family moves.
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
export const settingValue = z.union([z.boolean(), z.number().finite(), z.string().max(1000)]);
export const settingsUpdate = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('preview'),
    changes: z
      .array(z.object({ id: z.string().min(1).max(400), value: settingValue }))
      .min(1)
      .max(12),
  }),
  z.object({ operation: z.literal('apply'), transactionId: z.string().min(1).max(100) }),
]);
export const settingsUndo = z.object({ transactionId: z.string().min(1).max(100) });
