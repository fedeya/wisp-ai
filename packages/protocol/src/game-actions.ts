import { z } from 'zod';
import { settingsUpdate, settingsUndo } from './settings.ts';
// Any macro command is allowed; only the game's own size limit and control bytes are rejected.
export function macroBodyError(body: string): string | undefined {
  if (
    !body.trim() ||
    Buffer.byteLength(body, 'utf8') > 255 ||
    // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body)
  ) {
    return 'Macro bodies must contain 1–255 UTF-8 bytes of macro text';
  }
}
export const waypointInput = z.object({
  mapId: z.number().int().positive(),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  label: z.string().min(1).max(80),
  source: z.string().min(1).max(500),
  navigate: z.boolean().default(true),
});
export const macroInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .refine(
      // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
      (name) => Buffer.byteLength(name, 'utf8') <= 16 && !/[\x00-\x1f|[\]()]/.test(name),
      'Use a short plain macro name, up to 16 UTF-8 bytes',
    ),
  body: z
    .string()
    .min(1)
    .max(255)
    .superRefine((body, ctx) => {
      const error = macroBodyError(body);
      if (error) {
        ctx.addIssue({ code: 'custom', message: error });
      }
    }),
  perCharacter: z.boolean().default(true),
});
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update_settings'), args: settingsUpdate }),
  z.object({ kind: z.literal('undo_settings'), args: settingsUndo }),
  z.object({ kind: z.literal('set_waypoint'), args: waypointInput }),
  z.object({ kind: z.literal('clear_waypoint'), args: z.object({}) }),
  z.object({ kind: z.literal('create_macro'), args: macroInput }),
]);
export const actionTools = {
  set_waypoint: 'set_map_waypoint',
  clear_waypoint: 'clear_map_waypoint',
  create_macro: 'create_macro',
  update_settings: 'update_settings',
  undo_settings: 'undo_settings',
} as const;
