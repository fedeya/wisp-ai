import type { z } from 'zod';
import { JsonSchema, Predicate, Schema } from 'effect';
import type { SchemaAST } from 'effect';
import type { Effect } from 'effect';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from 'effect/StandardSchema';
import type * as Game from '../host/game-access.ts';
import { zodJsonSchemaKey } from '../contract/tool-inputs.ts';

/** What a tool receives besides its input. */
export interface ToolContext {
  /** The agent session the call belongs to; the bridge resolves it to a chat. */
  session: { id: string };
  abortSignal: AbortSignal;
  /** The model's id for this call. */
  callId: string;
  gameAccess?: Game.Service['Service'];
  runEffect?: <A>(effect: Effect.Effect<A, Error>, options: { signal: AbortSignal }) => Promise<A>;
}

/** A tool result shaped for the model, in the AI SDK tool-result form. */
export type ToolModelOutput =
  | { type: 'text'; value: string }
  | { type: 'error-text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'content'; value: unknown[] };

export interface ToolDefinition<Input = any, Output = any> {
  description: string;
  inputSchema:
    | z.ZodType<Input>
    | (StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>);
  outputSchema?:
    | z.ZodType<Output>
    | (StandardSchemaV1<unknown, Output> & StandardJSONSchemaV1<unknown, Output>);
  /**
   * Deferred tools stay out of every request until the model finds them with
   * `tool_search` and runs them with `tool_call`, which keeps the request's
   * tool list, and so the provider's prompt cache, stable.
   */
  deferred?: boolean;
  /** The turn ends once the model calls this tool, without another model step. */
  endsTurn?: boolean;
  /** Presentation-safe activity labels shown to the player. */
  label?: {
    start?: (input: Input) => string;
    complete?: (input: Input, output: Output) => string;
  };
  execute: (input: Input, ctx: ToolContext) => Output | Promise<Output>;
  /** What the model sees instead of the full output. */
  toModelOutput?: (output: Output) => ToolModelOutput;
  /** Capability switch that must be on for the model to see the tool. */
  capability?: string;
}

type Draft = 'draft-2020-12' | 'draft-07';
const isDraft = (target: string): target is Draft =>
  target === 'draft-2020-12' || target === 'draft-07';

function jsonSchemaFor(
  document: JsonSchema.Document<'draft-2020-12'>,
  target: Draft,
): Record<string, unknown> {
  if (target === 'draft-2020-12') {
    const definitions = Object.keys(document.definitions).length
      ? { $defs: document.definitions }
      : {};
    return {
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      ...document.schema,
      ...definitions,
    };
  }
  const draft07 = JsonSchema.toDocumentDraft07(document);
  const definitions = Object.keys(draft07.definitions).length
    ? { definitions: draft07.definitions }
    : {};
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07, ...draft07.schema, ...definitions };
}

// The order zod's JSON Schema generator writes keywords in: a wrapper's
// `default` and `description` first, then the keywords of the type it wraps.
const zodKeywordOrder = [
  '$schema',
  'default',
  'description',
  'minItems',
  'maxItems',
  'type',
  'minLength',
  'maxLength',
  'exclusiveMinimum',
  'minimum',
  'exclusiveMaximum',
  'maximum',
  'enum',
  'const',
  'items',
  'properties',
  'required',
  'propertyNames',
  'additionalProperties',
];
const zodRank = (keyword: string) => {
  const rank = zodKeywordOrder.indexOf(keyword);
  return rank < 0 ? zodKeywordOrder.length : rank;
};
// Keywords whose value is a schema or a list of schemas, and those whose value
// maps names to schemas.
const schemaKeywords = new Set([
  'items',
  'additionalProperties',
  'not',
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);
const schemaMapKeywords = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

const zodLayout = (schema: unknown) =>
  Predicate.isObject(schema) ? zodLayoutObject(schema) : schema;
const zodLayoutAll = (schemas: unknown) =>
  Array.isArray(schemas) ? schemas.map(zodLayout) : zodLayout(schemas);

const isSingleValue = Schema.is(Schema.Tuple([Schema.Unknown]));

/** A record as zod wrote it: its string keys, and the schema of every value. */
const zodRecord = ({
  [zodJsonSchemaKey]: _form,
  ...schema
}: JsonSchema.JsonSchema): JsonSchema.JsonSchema => ({
  ...schema,
  propertyNames: { type: 'string' },
  additionalProperties: Predicate.isObject(schema.additionalProperties)
    ? schema.additionalProperties
    : {},
});

/**
 * A JSON Schema written as zod wrote it: keywords in zod's order, `properties`
 * on every object, open objects without `additionalProperties: true`, and the
 * forms the `zodJsonSchemaKey` annotation names (`const` for a literal, `oneOf`
 * for a discriminated union, `propertyNames` and `additionalProperties` for a
 * record).
 */
function zodLayoutObject(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const form = schema[zodJsonSchemaKey];
  if (form === 'record') return zodLayoutObject(zodRecord(schema));
  const entries = Object.entries(schema).flatMap(([keyword, value]): [string, unknown][] => {
    if (keyword === zodJsonSchemaKey) return [];
    if (keyword === 'additionalProperties' && value === true) return [];
    if (form === 'const' && keyword === 'enum' && isSingleValue(value)) {
      return [['const', value[0]]];
    }
    if (form === 'oneOf' && keyword === 'anyOf') return [['oneOf', zodLayoutAll(value)]];
    if (schemaKeywords.has(keyword)) return [[keyword, zodLayoutAll(value)]];
    if (schemaMapKeywords.has(keyword) && Predicate.isObject(value)) {
      const schemas = Object.entries(value).map(([name, entry]) => [name, zodLayout(entry)]);
      return [[keyword, Object.fromEntries(schemas)]];
    }
    return [[keyword, value]];
  });
  const closedBySchema = Predicate.isObject(schema.additionalProperties);
  if (schema.type === 'object' && !('properties' in schema) && !closedBySchema) {
    entries.push(['properties', {}]);
  }
  // Array sorts are stable: keywords zod does not write keep Effect's order, last.
  entries.sort(([a], [b]) => zodRank(a) - zodRank(b));
  return Object.fromEntries(entries);
}

interface ToolInputOptions {
  /**
   * How the input decodes. With `rejectUnknownKeys`, an unknown key fails
   * validation and the model's JSON Schema closes every object, as
   * `Schema.toStandardJSONSchemaV1` cannot.
   */
  readonly parseOptions?: SchemaAST.ParseOptions | undefined;
  /**
   * `'zod'` writes the model's JSON Schema as zod did (see `zodLayoutObject`), so a
   * tool whose input moved from zod sends the model the same bytes.
   */
  readonly layout?: 'effect' | 'zod' | undefined;
}

/** An Effect schema as a tool's input. */
export function effectToolInput<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  { parseOptions, layout = 'effect' }: ToolInputOptions = {},
): StandardSchemaV1<S['Encoded'], S['Type']> & StandardJSONSchemaV1<S['Encoded'], S['Type']> {
  const standard = Schema.toStandardSchemaV1(schema, { parseOptions });
  // Effect's own converter answers any other target, or rejects it.
  const converter = Schema.toStandardJSONSchemaV1(schema)['~standard'].jsonSchema;
  const options = {
    onExcessProperty: parseOptions?.onExcessProperty,
    includeAnnotationKey: (key: string) => layout === 'zod' && key === zodJsonSchemaKey,
  };
  const shape = (json: JsonSchema.JsonSchema) => (layout === 'zod' ? zodLayoutObject(json) : json);
  const convert = (side: Schema.Constraint, { target }: StandardJSONSchemaV1.Options) =>
    isDraft(target)
      ? shape(jsonSchemaFor(Schema.toJsonSchemaDocument(side, options), target))
      : undefined;
  return {
    '~standard': {
      ...standard['~standard'],
      jsonSchema: {
        input: (request) => convert(schema, request) ?? converter.input(request),
        output: (request) => convert(Schema.toType(schema), request) ?? converter.output(request),
      },
    },
  };
}

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

export const toolOutput = {
  text: (value: string): ToolModelOutput => ({ type: 'text', value }),
  errorText: (value: string): ToolModelOutput => ({ type: 'error-text', value }),
  json: (value: unknown): ToolModelOutput => ({ type: 'json', value }),
};
