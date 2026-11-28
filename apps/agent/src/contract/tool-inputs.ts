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

/**
 * zod's `z.string().min(minLength).max(maxLength)`, without trimming. The model
 * sees zod's `minLength`, in UTF-16 units as both count, where Effect writes
 * the fewest code points that many units can hold.
 */
export const LimitedString = (minLength: number, maxLength: number) =>
  Schema.String.check(
    Schema.isMinLength(minLength, { toJsonSchema: () => ({ minLength }) }),
    Schema.isMaxLength(maxLength),
  );

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
type ZodJsonSchema = 'const' | 'oneOf' | 'record' | 'descriptionLast';
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

/**
 * zod's `z.record(z.string(), value)`: an object of `value`s under any keys.
 * The model sees zod's `propertyNames` and `additionalProperties`, which
 * Effect leaves out for a string key, and for an unknown value.
 */
export const StringRecord = <V extends Schema.Top>(value: V) =>
  Schema.Record(Schema.String, value).annotate(zodJsonSchema('record'));

/** Any key but `__proto__`, as the pattern Effect writes for the record's values says. */
const AnyKeyButProto = Schema.String.check(
  Schema.makeFilter((name: string) => name !== '__proto__', {
    toJsonSchema: () => ({ pattern: '^(?!__proto__$)' }),
  }),
);

/**
 * zod's `z.record(key, value)`: an object of `value`s whose keys all satisfy
 * `key`. Another key fails the record, as it failed zod's and fails
 * `RecordOf`'s, where `Schema.Record` would drop it. The model sees the key's
 * JSON Schema as `propertyNames`. It checks keys as `RecordOf` does, on its own
 * `Schema.Record`, so the annotation stays on the record and not on a check.
 * zod dropped an own `__proto__` key without reading it; the record drops it
 * as a key it does not have, which its decode options may reject instead.
 */
export const KeyedRecord = <V extends Schema.Top>(key: Schema.Codec<string>, value: V) => {
  const isKey = Schema.is(key);
  const propertyNames = Schema.toJsonSchemaDocument(key).schema;
  return Schema.Record(AnyKeyButProto, value)
    .annotate(zodJsonSchema('record'))
    .check(
      Schema.makeFilter(
        (record) =>
          Object.keys(record)
            .filter((name) => !isKey(name))
            .map((name) => ({ path: [name], issue: 'Invalid key in record' })),
        { toJsonSchema: () => ({ propertyNames }) },
      ),
    );
};

/**
 * zod's `.describe(description)` on a schema it does not wrap (no `.optional()`
 * or `.default()` before it), which zod writes after the schema's own keywords.
 * Add the schema's checks after this, so the annotation stays on the schema.
 */
export const Described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description, ...zodJsonSchema('descriptionLast') });

/** zod's `z.object({})`: any object, read as no arguments. */
export const NoArgs = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.Never),
    SchemaTransformation.transform({ decode: () => ({}), encode: (args) => args }),
  ),
);

/** zod's `z.strictObject({})`: only an object without keys, whatever the decode options. */
export const NoArgsStrict = Schema.Record(Schema.String, Schema.Never);
