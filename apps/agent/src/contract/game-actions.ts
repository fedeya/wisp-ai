// @effect-migrated
import { Schema } from 'effect';
import { rejectUnknownKeys, TrimmedString } from '@wisp/protocol/checks';
import { settingsUpdate, settingsUndo } from './settings.ts';
import {
  Const,
  DiscriminatedUnion,
  IntBetween,
  LimitedString,
  NoArgs,
  NumberBetween,
  PositiveInt,
  refine,
  withDefault,
} from './tool-inputs.ts';

// An input marked strict rejects unknown keys: decode it with `rejectUnknownKeys`.

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
  return undefined;
}
export const waypointInput = Schema.Struct({
  mapId: PositiveInt,
  x: NumberBetween(0, 100),
  y: NumberBetween(0, 100),
  label: LimitedString(1, 80),
  source: LimitedString(1, 500),
  navigate: withDefault(Schema.Boolean, () => true),
});
export const macroInput = Schema.Struct({
  name: TrimmedString({ minLength: 1, maxLength: 16 }).check(
    refine(
      // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
      (name) => Buffer.byteLength(name, 'utf8') <= 16 && !/[\x00-\x1f|[\]()]/.test(name),
      'Use a short plain macro name, up to 16 UTF-8 bytes',
    ),
  ),
  body: LimitedString(1, 255).check(Schema.makeFilter((body) => macroBodyError(body) ?? true)),
  perCharacter: withDefault(Schema.Boolean, () => true),
});
const guideText = (maxLength: number) => TrimmedString({ minLength: 1, maxLength });
const id = PositiveInt;
const coordinate = NumberBetween(0, 100);
// Shared by every goal: display text, a note under it, whether it can be
// passed over, and an optional map point (UI map ID, 0–100) for the arrow.
const goalBase = {
  text: Schema.optionalKey(guideText(120)),
  note: Schema.optionalKey(guideText(200)),
  optional: Schema.optionalKey(Schema.Boolean),
  mapId: Schema.optionalKey(id),
  x: Schema.optionalKey(coordinate),
  y: Schema.optionalKey(coordinate),
};
const quest = { questId: id, questTitle: guideText(80) };
const objective = {
  questId: Schema.optionalKey(id),
  objective: Schema.optionalKey(IntBetween(1, 10)),
};
const item = { itemId: id, itemName: guideText(80) };
const npc = { npcId: Schema.optionalKey(id), npcName: Schema.optionalKey(guideText(80)) };
const count = Schema.optionalKey(IntBetween(1, 1000));
const location = { location: guideText(80) };
// Goal types and fields mirror Polestar's goal table (its ARCHITECTURE.md,
// "Guide data"); the addon renames the fields to Polestar's. Strict.
export const guideGoal = DiscriminatedUnion([
  Schema.Struct({ type: Const('accept'), ...goalBase, ...quest, ...npc }),
  Schema.Struct({ type: Const('turnin'), ...goalBase, ...quest, ...npc }),
  Schema.Struct({ type: Const('complete'), ...goalBase, ...quest }),
  Schema.Struct({
    type: Const('kill'),
    ...goalBase,
    ...objective,
    target: guideText(80),
    npcId: Schema.optionalKey(id),
    count,
  }),
  Schema.Struct({ type: Const('collect'), ...goalBase, ...objective, ...item, count }),
  Schema.Struct({ type: Const('goto'), ...goalBase, mapId: id, x: coordinate, y: coordinate }),
  Schema.Struct({ type: Const('talk'), ...goalBase, npcId: id, npcName: guideText(80) }),
  Schema.Struct({
    type: Const('interact'),
    ...goalBase,
    ...objective,
    objectId: id,
    objectName: guideText(80),
  }),
  Schema.Struct({ type: Const('use'), ...goalBase, ...objective, ...item }),
  Schema.Struct({ type: Const('buy'), ...goalBase, ...item, ...npc, count }),
  Schema.Struct({ type: Const('vendor'), ...goalBase, ...npc }),
  Schema.Struct({ type: Const('train'), ...goalBase, ...npc }),
  Schema.Struct({ type: Const('getfp'), ...goalBase, ...location, ...npc }),
  Schema.Struct({ type: Const('fly'), ...goalBase, ...location }),
  Schema.Struct({ type: Const('hearth'), ...goalBase, ...location }),
  Schema.Struct({ type: Const('sethome'), ...goalBase, ...location, ...npc }),
  Schema.Struct({ type: Const('level'), ...goalBase, level: IntBetween(2, 60) }),
  Schema.Struct({ type: Const('note'), ...goalBase, text: guideText(200) }),
]).check(
  refine(
    (goal) =>
      (goal.mapId === undefined) === (goal.x === undefined) &&
      (goal.x === undefined) === (goal.y === undefined),
    'Give mapId, x and y together',
  ),
);
// The agent's /action request body is capped at 32 KiB and the guide then
// crosses the slow addon downlink, so a guide stays well under that in total.
export const GUIDE_MAX_BYTES = 24 * 1024;
// Strict.
export const guideInput = Schema.Struct({
  id: Schema.optionalKey(
    // The `u` flag lets the pattern reach the model; it matches the same ids.
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u)).annotate({
      description:
        'The id of an earlier Wisp guide to replace its steps in place; omit for a new guide.',
    }),
  ),
  title: guideText(80),
  steps: Schema.Array(
    Schema.Struct({
      title: Schema.optionalKey(guideText(80)),
      note: Schema.optionalKey(guideText(300)),
      goals: Schema.Array(guideGoal).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  open: withDefault(
    Schema.Boolean.annotate({ description: 'Show the guide in Polestar’s active tab.' }),
    () => true,
  ),
}).check(
  Schema.makeFilter((guide) => {
    const bytes = Buffer.byteLength(JSON.stringify(guide), 'utf8');
    return (
      bytes <= GUIDE_MAX_BYTES ||
      `The guide is ${bytes} bytes; keep it under ${GUIDE_MAX_BYTES} by shortening text or splitting it into smaller guides`
    );
  }),
);

const action = <const K extends string, A extends Schema.Top>(kind: K, args: A) =>
  Schema.Struct({ kind: Schema.Literal(kind), args });

export const actionSchema = Schema.Union([
  action('update_settings', settingsUpdate),
  action('undo_settings', settingsUndo),
  action('set_waypoint', waypointInput),
  action('clear_waypoint', NoArgs),
  action('create_macro', macroInput),
  action('polestar_guide', guideInput),
]);
export type GameAction = typeof actionSchema.Encoded;
type ActionKind = GameAction['kind'];

export const actionTools = {
  set_waypoint: 'set_map_waypoint',
  clear_waypoint: 'clear_map_waypoint',
  create_macro: 'create_macro',
  polestar_guide: 'create_guide',
  update_settings: 'update_settings',
  undo_settings: 'undo_settings',
} as const satisfies Record<ActionKind, string>;

// Whether each action's arguments reject unknown keys.
const strictArgs = {
  update_settings: false,
  undo_settings: false,
  set_waypoint: false,
  clear_waypoint: false,
  create_macro: false,
  polestar_guide: true,
} satisfies Record<ActionKind, boolean>;

/**
 * How to decode an action of `kind`: with `rejectUnknownKeys` when its
 * arguments are strict, which also closes the `{ kind, args }` envelope.
 */
export const actionParseOptions = (kind: ActionKind) =>
  strictArgs[kind] ? rejectUnknownKeys : undefined;
