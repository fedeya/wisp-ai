import { asSchema, jsonSchema, type FlexibleSchema, type JSONSchema7 } from 'ai';

/** Keywords whose value maps names to schemas, rather than being a schema itself. */
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * A JSON Schema without `propertyNames`. zod writes it for every record, and
 * OpenAI's tool schemas do not support it: the AI SDK removes it and logs a
 * warning on every request.
 */
export function withoutPropertyNames(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutPropertyNames);
  if (!node || typeof node !== 'object') return node;
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'propertyNames') continue;
    schema[key] =
      SCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [name, withoutPropertyNames(child)]),
          )
        : withoutPropertyNames(value);
  }
  return schema;
}

/**
 * A tool's input schema as the model sees it: its JSON Schema without
 * `propertyNames`, and the same validation, so record keys are still checked
 * when a call's input is parsed.
 */
export function modelInputSchema<T>(schema: FlexibleSchema<T>) {
  const base = asSchema(schema);
  return jsonSchema<T>(
    async () => withoutPropertyNames(await base.jsonSchema) as JSONSchema7,
    base.validate ? { validate: base.validate } : {},
  );
}
