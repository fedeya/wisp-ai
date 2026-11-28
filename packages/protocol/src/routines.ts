// @effect-migrated
import { Effect, Schema, SchemaTransformation, Struct } from 'effect';
import { RecordOf, TrimmedString } from './checks.js';

// This is the adapter boundary: new sources add an event and typed fields here,
// while routine behavior remains data composed by the agent.
export const routineEvents = {
  level_up: { native: 'PLAYER_LEVEL_UP', fields: { level: 'number' } },
  equipment_changed: {
    native: 'PLAYER_EQUIPMENT_CHANGED',
    fields: { slot: 'number', itemId: 'number' },
  },
  money_changed: { native: 'PLAYER_MONEY', fields: { copper: 'number' } },
  bags_changed: { native: 'BAG_UPDATE_DELAYED', fields: {} },
  quests_changed: { native: 'QUEST_LOG_UPDATE', fields: {} },
  spells_changed: { native: 'SPELLS_CHANGED', fields: {} },
  talents_changed: { native: 'PLAYER_TALENT_UPDATE', fields: {} },
  zone_changed: { native: 'ZONE_CHANGED_NEW_AREA', fields: { zone: 'string' } },
} as const;
export const routineEventName = Schema.Literals(Struct.keys(routineEvents));
const scalar = Schema.Union([
  Schema.String.check(Schema.isMaxLength(300)),
  Schema.Finite,
  Schema.Boolean,
]);
const filter = Schema.Struct({
  field: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  op: Schema.Literals(['eq', 'ne', 'gte', 'lte', 'contains', 'multiple_of']),
  value: scalar,
});
type RoutineFilter = typeof filter.Type;

function supportedFilter(event: typeof routineEventName.Type, f: RoutineFilter) {
  const fields: Readonly<Record<string, string>> = routineEvents[event].fields;
  const type = fields[f.field];
  return !(
    !type ||
    typeof f.value !== type ||
    (['gte', 'lte', 'multiple_of'].includes(f.op) && type !== 'number') ||
    (f.op === 'contains' && type !== 'string') ||
    (f.op === 'multiple_of' && (typeof f.value !== 'number' || f.value <= 0))
  );
}

// The routine schemas are a tool's input, so a default applies to a missing
// key only: accepting `undefined` would add `null` to the model's JSON Schema.
// They are strict: decode them with `rejectUnknownKeys` from `./checks.js`.
const eventTrigger = Schema.Struct({
  kind: Schema.Literal('event'),
  event: routineEventName,
  filters: Schema.Array(filter)
    .check(Schema.isMaxLength(8))
    .annotate({ default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
});
const intervalTrigger = Schema.Struct({
  kind: Schema.Literal('interval'),
  seconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 2_592_000 })),
});
export const routineTrigger = Schema.Union([eventTrigger, intervalTrigger], {
  mode: 'oneOf',
}).check(
  Schema.makeFilter((trigger) =>
    trigger.kind === 'event'
      ? trigger.filters
          .filter((f) => !supportedFilter(trigger.event, f))
          .map(() => 'Unsupported field, value or operator for this event')
      : undefined,
  ),
);
export type RoutineTrigger = typeof routineTrigger.Type;
export const routineDefinition = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u)),
  title: TrimmedString({ minLength: 1, maxLength: 100 }),
  instruction: TrimmedString({ minLength: 1, maxLength: 6000 }),
  triggers: Schema.Array(routineTrigger).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  cooldownSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 86_400 }))
    .annotate({ default: 600 })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(600))),
  once: Schema.Boolean.annotate({
    description:
      'Pause after the first successful non-silent result. Silent checks and failures keep watching.',
    default: false,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
const routineId = Schema.Struct({ id: Schema.String });
/** Strict: decode it with `rejectUnknownKeys`. */
export const routineInput = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('catalog') }),
    Schema.Struct({ operation: Schema.Literal('list') }),
    Schema.Struct({ operation: Schema.Literal('get'), ...routineId.fields }),
    Schema.Struct({ operation: Schema.Literal('save'), routine: routineDefinition }),
    Schema.Struct({ operation: Schema.Literal('pause'), ...routineId.fields }),
    Schema.Struct({ operation: Schema.Literal('resume'), ...routineId.fields }),
    Schema.Struct({ operation: Schema.Literal('remove'), ...routineId.fields }),
  ],
  { mode: 'oneOf' },
);
export type RoutineInput = typeof routineInput.Type;
// The addon sends an empty Lua table, which it cannot tell from a list, as `[]`.
const emptyList = Schema.Tuple([]);
const isEmptyList = Schema.is(emptyList);
const eventValues = RecordOf(Schema.String.check(Schema.isMaxLength(40)), scalar).check(
  Schema.isMaxProperties(8),
);
/** Strict: decode it with `rejectUnknownKeys`. */
export const routineEvent = Schema.Struct({
  event: routineEventName,
  values: Schema.Union([emptyList, eventValues]).pipe(
    Schema.decodeTo(
      eventValues,
      SchemaTransformation.transform({
        decode: (values) => (isEmptyList(values) ? {} : values),
        encode: (values) => values,
      }),
    ),
  ),
});
export type RoutineEvent = typeof routineEvent.Type;
export type RoutineDefinition = typeof routineDefinition.Type;
export function describeRoutineTrigger(trigger: RoutineTrigger): string {
  if (trigger.kind === 'interval') {
    return trigger.seconds % 3600 === 0
      ? `Every ${trigger.seconds / 3600} hours`
      : `Every ${trigger.seconds / 60} minutes`;
  }
  const labels: Record<keyof typeof routineEvents, string> = {
    level_up: 'On level up',
    equipment_changed: 'When equipment changes',
    money_changed: 'When money changes',
    bags_changed: 'When bags change',
    quests_changed: 'When quests change',
    spells_changed: 'When learned spells change',
    talents_changed: 'When talents change',
    zone_changed: 'When entering a zone',
  };
  const fields: Record<string, string> = {
    level: 'level',
    slot: 'equipment slot',
    itemId: 'item ID',
    copper: 'money in copper',
    zone: 'zone',
  };
  const operators = {
    eq: 'is',
    ne: 'is not',
    gte: 'is at least',
    lte: 'is at most',
    contains: 'contains',
    multiple_of: 'is a multiple of',
  };
  return (
    labels[trigger.event] +
    (trigger.filters.length
      ? ' · ' +
        trigger.filters.map((f) => `${fields[f.field]} ${operators[f.op]} ${f.value}`).join(' and ')
      : '')
  );
}
/** Strict, like the definition it extends: decode it with `rejectUnknownKeys`. */
export const savedRoutine = routineDefinition.mapFields(
  Struct.assign({
    characterKey: Schema.String.check(Schema.isMinLength(1)),
    sourceChatId: Schema.optional(Schema.String),
    enabled: Schema.Boolean,
    updatedAt: Schema.Finite,
    nextAt: Schema.Finite,
    lastStartedAt: Schema.optional(Schema.Finite),
    pending: Schema.optional(
      Schema.Struct({
        event: Schema.String,
        values: Schema.Record(Schema.String, scalar),
        at: Schema.Finite,
      }),
    ),
  }),
);
export const routineRun = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  routineId: Schema.String.check(Schema.isMinLength(1)),
  characterKey: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.String,
  startedAt: Schema.Finite,
  finishedAt: Schema.optional(Schema.Finite),
  event: Schema.String,
  status: Schema.Literals(['running', 'done', 'no_tip', 'error', 'cancelled', 'interrupted']),
  summary: Schema.optional(Schema.String),
});
export type Routine = typeof savedRoutine.Type;
export type RoutineRun = typeof routineRun.Type;
export function matchesRoutineEvent(trigger: RoutineTrigger, event: RoutineEvent): boolean {
  return (
    trigger.kind === 'event' &&
    trigger.event === event.event &&
    trigger.filters.every((f) => {
      const value = event.values[f.field];
      if (typeof value !== typeof f.value) {
        return false;
      }
      switch (f.op) {
        case 'eq':
          return value === f.value;
        case 'ne':
          return value !== f.value;
        case 'gte':
          return typeof value === 'number' && value >= Number(f.value);
        case 'lte':
          return typeof value === 'number' && value <= Number(f.value);
        case 'contains':
          return typeof value === 'string' && value.includes(String(f.value));
        case 'multiple_of':
          return typeof value === 'number' && value % Number(f.value) === 0;
      }
    })
  );
}
