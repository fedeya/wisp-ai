// @effect-migrated
import { expect, it } from '@effect/vitest';
import { asSchema } from 'ai';
import { Effect } from 'effect';
import type { ToolDefinition } from '../src/tools/tool.ts';
import { authored, assembleTools } from '../src/tools/turn-tools.ts';
import web__web_search from '../src/wisp/tools/web__web_search.ts';
import wisp__manage_routine from '../src/wisp/tools/wisp__manage_routine.ts';

// Tools whose input is a `@wisp/protocol` schema. The model must keep seeing the
// same JSON Schema for them when that schema changes library.
const protocolTools = { web__web_search, wisp__manage_routine } satisfies Record<
  string,
  ToolDefinition
>;

/**
 * The JSON Schema the model receives for an authored tool: the AI SDK's for a
 * direct tool, and what `tool_search` returns for a deferred one.
 */
const modelInputSchema = Effect.fnUntraced(function* (
  name: string,
  tool: ToolDefinition,
): Effect.fn.Return<unknown, unknown, never> {
  if (tool.deferred) return authored(name, tool).inputSchema;
  const { tools } = assembleTools({
    session: 'session',
    signal: yield* Effect.scoped(Effect.abortSignal),
    direct: { [name]: tool },
    deferred: [],
    skills: [],
  });
  const schema = tools[name]?.inputSchema;
  if (!schema) return yield* Effect.die(new Error('Missing SDK tool schema for ' + name));
  const json: unknown = yield* Effect.tryPromise(async () => asSchema(schema).jsonSchema);
  return json;
});

for (const [name, tool] of Object.entries(protocolTools)) {
  it.effect(`the model sees the same ${name} input schema`, () =>
    Effect.gen(function* () {
      // Serialized, so the snapshot also keeps the key order the model reads.
      expect(JSON.stringify(yield* modelInputSchema(name, tool), null, 2)).toMatchSnapshot();
    }),
  );
}
