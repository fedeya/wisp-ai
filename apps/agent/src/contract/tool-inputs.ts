// @effect-migrated
import { Effect, Schema, SchemaTransformation } from 'effect';

// Building blocks for tool inputs that were zod schemas: each decodes what its
// zod counterpart accepted, and its JSON Schema keeps the keywords zod wrote.
// Defaults and optional keys apply to a missing key only, so the model's JSON
// Schema shows no `null`.

/** zod's `.int().positive()`. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** zod's `.int().min(minimum).max(maximum)`. */
export const IntBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/** zod's `z.string().min(minLength).max(maxLength)`, without trimming. */
export const LimitedString = (minLength: number, maxLength: number) =>
  Schema.String.check(Schema.isMinLength(minLength), Schema.isMaxLength(maxLength));

/**
 * zod's `.default(value())`: `schema` with `value()` when its key is missing,
 * shown to the model as its default. Each decode gets its own value, as zod
 * cloned its defaults.
 */
export const withDefault = <S extends Schema.Top & { readonly Rebuild: S }>(
  schema: S,
  value: () => NoInfer<S['Encoded']>,
) => Schema.withDecodingDefaultKey<S>(Effect.sync(value))(schema.annotate({ default: value() }));

/** zod's `.refine(holds, message)`: fails with `message` unless `holds`. */
export const refine = <T>(holds: (input: T) => boolean, message: string) =>
  Schema.makeFilter<T>((input) => holds(input) || message);

/** zod's `z.object({})`: any object, read as no arguments. */
export const NoArgs = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.Never),
    SchemaTransformation.transform({ decode: () => ({}), encode: (args) => args }),
  ),
);

/** zod's `z.strictObject({})`: only an object without keys, whatever the decode options. */
export const NoArgsStrict = Schema.Record(Schema.String, Schema.Never);
