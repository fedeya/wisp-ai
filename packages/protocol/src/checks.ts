// @effect-migrated
import { Schema, SchemaTransformation } from 'effect';
import type { SchemaAST } from 'effect';

/**
 * Decoding options for the contracts' strict objects: an unknown key fails
 * instead of being dropped. Decode a schema documented as strict with these,
 * and describe it to a model with the same `onExcessProperty`.
 */
export const rejectUnknownKeys = {
  onExcessProperty: 'error',
} as const satisfies SchemaAST.ParseOptions;

interface LengthBounds {
  readonly minLength?: number;
  readonly maxLength?: number;
}

/**
 * Describes the bounds of the trimmed value on the untrimmed input, as JSON
 * Schema only: the input itself is checked after trimming.
 */
const trimmedLength = ({ minLength, maxLength }: LengthBounds) =>
  Schema.makeFilter<string>(() => true, {
    toJsonSchema: () => ({
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
    }),
  });

/** A string that is trimmed, then checked against `bounds`. */
export function TrimmedString(bounds: LengthBounds = {}) {
  const checks = [
    ...(bounds.minLength === undefined ? [] : [Schema.isMinLength(bounds.minLength)]),
    ...(bounds.maxLength === undefined ? [] : [Schema.isMaxLength(bounds.maxLength)]),
  ];
  const trimmed = checks.reduce<Schema.Codec<string>>(
    (schema, check) => schema.check(check),
    Schema.Trimmed,
  );
  return Schema.String.check(trimmedLength(bounds)).pipe(
    Schema.decodeTo(trimmed, SchemaTransformation.trim()),
  );
}

const tabOrNewline = /[\t\n\r]/g;

/**
 * A URL string: surrounding whitespace is trimmed and tabs and newlines are
 * removed, as URL parsing ignores them.
 */
export const UrlString = Schema.String.check(
  Schema.makeFilter((input) => URL.canParse(input.trim()), { expected: 'a URL' }),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (input) => input.trim().replace(tabOrNewline, ''),
      encode: (input) => input,
    }),
  ),
);

/**
 * A record whose keys must all satisfy `key`. A key that does not fails the
 * record; `Schema.Record` would drop it instead.
 */
export function RecordOf<V extends Schema.Top>(key: Schema.Codec<string>, value: V) {
  const isKey = Schema.is(key);
  return Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record) =>
      Object.keys(record)
        .filter((name) => !isKey(name))
        .map((name) => ({ path: [name], issue: 'Invalid key in record' })),
    ),
  );
}
