// @effect-migrated
import { Effect, Schema } from 'effect';

/**
 * An optional field that is dropped, rather than rejected, when it is not a
 * `schema`. ChatGPT's answers were read field by field before, ignoring a field
 * of an unexpected type, and still are.
 */
export const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));
