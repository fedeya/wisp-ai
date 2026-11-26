import { z } from 'zod';
export const settingsRead = z.object({
  sections: z
    .array(z.enum(['options', 'addons', 'action_bars', 'keybindings']))
    .min(1)
    .max(4)
    .default(['options']),
  provider: z.enum(['all', 'game', 'ace']).default('all'),
  addon: z.string().min(1).max(120).optional(),
  query: z.string().min(1).max(100).optional(),
  ids: z.array(z.string().min(1).max(400)).max(30).default([]),
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(60).default(30),
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
