// @effect-migrated
import { Schema } from 'effect';
import { TrimmedString } from '@wisp/protocol/checks';
import { IntBetween, PositiveInt, withDefault } from './tool-inputs.ts';

// Every object here is strict: decode it with `rejectUnknownKeys`.

export const databaseKind = Schema.Literals(['item', 'spell', 'quest', 'npc', 'zone']);
const searchFields = {
  kind: databaseKind,
  query: TrimmedString({ minLength: 1, maxLength: 64 }),
  page: withDefault(IntBetween(1, 200), () => 1),
  limit: withDefault(IntBetween(1, 20), () => 10),
};
// `Int` is a safe integer, so it stops at `Number.MAX_SAFE_INTEGER` as zod's `max` did.
const entityFields = { kind: databaseKind, id: PositiveInt };
export const databaseSearch = Schema.Struct(searchFields);
export const databaseEntity = Schema.Struct(entityFields);
export const databaseRequest = Schema.Union([
  Schema.Struct({ ...searchFields, operation: Schema.Literal('search') }),
  Schema.Struct({ ...entityFields, operation: Schema.Literal('get') }),
]);
export type DatabaseRequestInput = typeof databaseRequest.Encoded;
export type DatabaseRequest = typeof databaseRequest.Type;
