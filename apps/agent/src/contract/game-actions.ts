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
const guideText = (max: number) => z.string().trim().min(1).max(max);
const id = z.number().int().positive();
const coordinate = z.number().min(0).max(100);
// Shared by every goal: display text, a note under it, whether it can be
// passed over, and an optional map point (UI map ID, 0–100) for the arrow.
const goalBase = {
  text: guideText(120).optional(),
  note: guideText(200).optional(),
  optional: z.boolean().optional(),
  mapId: id.optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
};
const quest = { questId: id, questTitle: guideText(80) };
const objective = {
  questId: id.optional(),
  objective: z.number().int().min(1).max(10).optional(),
};
const item = { itemId: id, itemName: guideText(80) };
const npc = { npcId: id.optional(), npcName: guideText(80).optional() };
const count = z.number().int().min(1).max(1000).optional();
const location = { location: guideText(80) };
// Goal types and fields mirror Polestar's goal table (its ARCHITECTURE.md,
// "Guide data"); the addon renames the fields to Polestar's.
export const guideGoal = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('accept'), ...goalBase, ...quest, ...npc }),
    z.strictObject({ type: z.literal('turnin'), ...goalBase, ...quest, ...npc }),
    z.strictObject({ type: z.literal('complete'), ...goalBase, ...quest }),
    z.strictObject({
      type: z.literal('kill'),
      ...goalBase,
      ...objective,
      target: guideText(80),
      npcId: id.optional(),
      count,
    }),
    z.strictObject({ type: z.literal('collect'), ...goalBase, ...objective, ...item, count }),
    z.strictObject({
      type: z.literal('goto'),
      ...goalBase,
      mapId: id,
      x: coordinate,
      y: coordinate,
    }),
    z.strictObject({ type: z.literal('talk'), ...goalBase, npcId: id, npcName: guideText(80) }),
    z.strictObject({
      type: z.literal('interact'),
      ...goalBase,
      ...objective,
      objectId: id,
      objectName: guideText(80),
    }),
    z.strictObject({ type: z.literal('use'), ...goalBase, ...objective, ...item }),
    z.strictObject({ type: z.literal('buy'), ...goalBase, ...item, ...npc, count }),
    z.strictObject({ type: z.literal('vendor'), ...goalBase, ...npc }),
    z.strictObject({ type: z.literal('train'), ...goalBase, ...npc }),
    z.strictObject({ type: z.literal('getfp'), ...goalBase, ...location, ...npc }),
    z.strictObject({ type: z.literal('fly'), ...goalBase, ...location }),
    z.strictObject({ type: z.literal('hearth'), ...goalBase, ...location }),
    z.strictObject({ type: z.literal('sethome'), ...goalBase, ...location, ...npc }),
    z.strictObject({
      type: z.literal('level'),
      ...goalBase,
      level: z.number().int().min(2).max(60),
    }),
    z.strictObject({ type: z.literal('note'), ...goalBase, text: guideText(200) }),
  ])
  .refine(
    (goal) =>
      (goal.mapId === undefined) === (goal.x === undefined) &&
      (goal.x === undefined) === (goal.y === undefined),
    'Give mapId, x and y together',
  );
// The agent's /action request body is capped at 32 KiB and the guide then
// crosses the slow addon downlink, so a guide stays well under that in total.
export const GUIDE_MAX_BYTES = 24 * 1024;
export const guideInput = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
      .optional()
      .describe(
        'The id of an earlier Wisp guide to replace its steps in place; omit for a new guide.',
      ),
    title: guideText(80),
    steps: z
      .array(
        z.strictObject({
          title: guideText(80).optional(),
          note: guideText(300).optional(),
          goals: z.array(guideGoal).min(1).max(8),
        }),
      )
      .min(1)
      .max(30),
    open: z.boolean().default(true).describe('Show the guide in Polestar’s active tab.'),
  })
  .superRefine((guide, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(guide), 'utf8');
    if (bytes > GUIDE_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `The guide is ${bytes} bytes; keep it under ${GUIDE_MAX_BYTES} by shortening text or splitting it into smaller guides`,
      });
    }
  });
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update_settings'), args: settingsUpdate }),
  z.object({ kind: z.literal('undo_settings'), args: settingsUndo }),
  z.object({ kind: z.literal('set_waypoint'), args: waypointInput }),
  z.object({ kind: z.literal('clear_waypoint'), args: z.object({}) }),
  z.object({ kind: z.literal('create_macro'), args: macroInput }),
  z.object({ kind: z.literal('polestar_guide'), args: guideInput }),
]);
export const actionTools = {
  set_waypoint: 'set_map_waypoint',
  clear_waypoint: 'clear_map_waypoint',
  create_macro: 'create_macro',
  polestar_guide: 'create_guide',
  update_settings: 'update_settings',
  undo_settings: 'undo_settings',
} as const;
