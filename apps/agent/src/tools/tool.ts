import type { z } from 'zod';
import { JsonSchema, Schema } from 'effect';
import type { SchemaAST } from 'effect';
import type { Effect } from 'effect';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from 'effect/StandardSchema';
import type * as Game from '../host/game-access.ts';

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
  outputSchema?: z.ZodType<Output>;
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

/**
 * An Effect schema as a tool's input. With `rejectUnknownKeys`, an unknown key
 * fails validation and the model's JSON Schema closes every object, as
 * `Schema.toStandardJSONSchemaV1` cannot.
 */
export function effectToolInput<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  parseOptions?: SchemaAST.ParseOptions,
): StandardSchemaV1<S['Encoded'], S['Type']> & StandardJSONSchemaV1<S['Encoded'], S['Type']> {
  const standard = Schema.toStandardSchemaV1(schema, { parseOptions });
  // Effect's own converter answers any other target, or rejects it.
  const converter = Schema.toStandardJSONSchemaV1(schema)['~standard'].jsonSchema;
  const options = { onExcessProperty: parseOptions?.onExcessProperty };
  const convert = (side: Schema.Constraint, { target }: StandardJSONSchemaV1.Options) =>
    isDraft(target) ? jsonSchemaFor(Schema.toJsonSchemaDocument(side, options), target) : undefined;
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
