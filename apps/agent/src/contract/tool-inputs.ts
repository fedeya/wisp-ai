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

/** zod's `z.number().min(minimum).max(maximum)`: finite, as zod's numbers are. */
export const NumberBetween = (minimum: number, maximum: number) =>
  Schema.Finite.check(Schema.isBetween({ minimum, maximum }));

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

/**
 * The annotation that tells `effectToolInput`'s zod layout how zod wrote a
 * schema's JSON Schema where Effect writes it another way. Only that layout
 * reads it, and it leaves it out of the JSON Schema.
 */
export const zodJsonSchemaKey = 'wisp/zodJsonSchema';
type ZodJsonSchema = 'const' | 'oneOf';
const zodJsonSchema = (form: ZodJsonSchema) => ({ [zodJsonSchemaKey]: form });

/** zod's `z.literal(value)`, shown to the model as `const` where Effect writes a one-value `enum`. */
export const Const = <const L extends string>(value: L) =>
  Schema.Literal(value).annotate(zodJsonSchema('const'));

/**
 * zod's `z.discriminatedUnion`: `members` tell themselves apart by a literal
 * key, so at most one matches, and the model sees `oneOf`. Effect writes
 * `anyOf` once a member's JSON Schema is looser than its decoding, as a string
 * length is; the literal key keeps the members apart either way.
 */
export const DiscriminatedUnion = <const Members extends readonly Schema.Constraint[]>(
  members: Members,
) => Schema.Union(members, { mode: 'oneOf' }).annotate(zodJsonSchema('oneOf'));

/** zod's `z.object({})`: any object, read as no arguments. */
export const NoArgs = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.Never),
    SchemaTransformation.transform({ decode: () => ({}), encode: (args) => args }),
  ),
);

/** zod's `z.strictObject({})`: only an object without keys, whatever the decode options. */
export const NoArgsStrict = Schema.Record(Schema.String, Schema.Never);
