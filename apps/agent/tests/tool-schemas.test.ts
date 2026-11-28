// @effect-migrated allow=effectPromises: reads the AI SDK's JSON Schema, which may be a PromiseLike
import { expect, it } from '@effect/vitest';
import { asSchema } from 'ai';
import { Effect } from 'effect';
import type { ToolDefinition } from '../src/tools/tool.ts';
import { authored, assembleTools } from '../src/tools/turn-tools.ts';
import { authoredTools } from '../src/wisp/tool-registry.ts';

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
  const json: unknown = yield* Effect.tryPromise(() =>
    Promise.resolve(asSchema(schema).jsonSchema),
  );
  return json;
});

// Every authored tool. The model must keep seeing the same JSON Schema for each
// when its input schema changes library.
for (const [name, tool] of Object.entries(authoredTools)) {
  it.effect(`the model sees the same ${name} input schema`, () =>
    Effect.gen(function* () {
      // Serialized, so the snapshot also keeps the key order the model reads.
      expect(JSON.stringify(yield* modelInputSchema(name, tool), null, 2)).toMatchSnapshot();
    }),
  );
}
