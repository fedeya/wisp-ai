import { expect, it } from '@effect/vitest';
import { asSchema } from 'ai';
import { Effect } from 'effect';
import { stepUsage } from '../src/execution/usage.ts';
import { TurnEvents } from '../src/execution/turn-events.ts';
import { assembleTools, SKILL, TOOL_CALL, TOOL_SEARCH } from '../src/tools/turn-tools.ts';

const { tools } = assembleTools({
  session: 'session',
  signal: AbortSignal.abort(),
  direct: {},
  deferred: [{ name: 'map', description: 'Map.', inputSchema: {}, run: () => Promise.resolve({}) }],
  skills: [{ name: 'gear', description: 'Gear.', instructions: 'Read the gear.' }],
});
const fixedTool = (name: string) => {
  const tool = tools[name];
  return tool ? Effect.succeed(asSchema(tool.inputSchema)) : Effect.die(new Error(name));
};

it.effect('the fixed tools show the model the JSON Schema zod wrote for them', () =>
  Effect.gen(function* () {
    const json = Effect.fnUntraced(function* (name: string) {
      const schema = yield* fixedTool(name);
      return JSON.stringify(yield* Effect.promise(() => Promise.resolve(schema.jsonSchema)));
    });
    const draft07 = '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object",';
    expect(yield* json(SKILL)).toBe(
      draft07 +
        '"properties":{"name":{"type":"string","minLength":1}},"required":["name"],"additionalProperties":false}',
    );
    expect(yield* json(TOOL_SEARCH)).toBe(
      draft07 +
        '"properties":{"query":{"type":"string","minLength":1}},"required":["query"],"additionalProperties":false}',
    );
    expect(yield* json(TOOL_CALL)).toBe(
      draft07 +
        '"properties":{"name":{"type":"string","minLength":1},"input":{"default":{},"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["name"],"additionalProperties":false}',
    );
  }),
);

it.effect('tool_call defaults its input and drops an own __proto__ key, as zod did', () =>
  Effect.gen(function* () {
    const schema = yield* fixedTool(TOOL_CALL);
    const validate = (input: unknown) =>
      Effect.promise(() => Promise.resolve(schema.validate?.(input)));
    expect(yield* validate({ name: 'map' })).toEqual({
      success: true,
      value: { name: 'map', input: {} },
    });
    const own = yield* validate(JSON.parse('{"name":"map","input":{"__proto__":{"x":1},"y":2}}'));
    expect(own).toEqual({ success: true, value: { name: 'map', input: { y: 2 } } });
    expect((yield* validate({ name: '' }))?.success).toBe(false);
    expect((yield* validate({ name: 'map', input: [] }))?.success).toBe(false);
  }),
);

it('step usage reads counts as numbers or details, missing, undefined or null', () => {
  expect(
    stepUsage({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: undefined,
      reasoningTokens: null,
    }),
  ).toEqual({ inputTokens: 10, outputTokens: 5 });
  expect(
    stepUsage({
      inputTokens: { total: 10, noCache: 4, cacheRead: 6, cacheWrite: undefined },
      outputTokens: { total: 5, text: 3, reasoning: 2 },
    }),
  ).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 6, reasoningTokens: 2 });
  expect(stepUsage({ inputTokens: Number.NaN, outputTokens: 5 })).toBeUndefined();
  expect(stepUsage({ inputTokens: { total: undefined }, outputTokens: 5 })).toBeUndefined();
  expect(stepUsage(null)).toBeUndefined();
});

it('a tool_call is shown as the deferred tool it runs, with its label', () => {
  const events = new TurnEvents({
    labels: new Map(),
    deferred: new Map([
      [
        'map',
        {
          name: 'map',
          description: 'Map.',
          inputSchema: {},
          label: {
            start: (input: { zone?: string }) => 'Opening ' + (input.zone ?? 'the map'),
            complete: () => {
              throw new Error('label failed');
            },
          },
          run: () => Promise.resolve({}),
        },
      ],
    ]),
  });
  const [requested] = events.read({
    type: 'tool-call',
    toolCallId: 'call',
    toolName: TOOL_CALL,
    input: { name: 'map', extra: true },
  });
  expect(requested?.data).toEqual({
    callId: 'call',
    input: {},
    capability: { name: 'map', label: 'Opening the map', kind: 'tool' },
  });
  // A label that throws is left out.
  const [settled] = events.read({
    type: 'tool-result',
    toolCallId: 'call',
    toolName: TOOL_CALL,
    input: { name: 'map' },
    output: {},
  });
  expect(settled?.data).toEqual({ callId: 'call', outcome: 'completed', output: {} });
});
