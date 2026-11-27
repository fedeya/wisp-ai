import { expect, test } from 'vitest';
import { asSchema } from 'ai';
import { z } from 'zod';
import { withoutPropertyNames } from '../src/tools/model-schema.ts';
import { assembleTools, TOOL_CALL } from '../src/tools/turn-tools.ts';
import { defineTool } from '../src/tools/tool.ts';

test('propertyNames is dropped as a keyword, not as a property name', () => {
  expect(
    withoutPropertyNames({
      type: 'object',
      propertyNames: { pattern: '^a' },
      properties: {
        propertyNames: { type: 'string' },
        nested: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
      },
    }),
  ).toEqual({
    type: 'object',
    properties: {
      propertyNames: { type: 'string' },
      nested: { type: 'object', additionalProperties: {} },
    },
  });
});

test('tool schemas reach the model without propertyNames and still check record keys', async () => {
  const { tools } = assembleTools({
    session: 's',
    signal: AbortSignal.timeout(1000),
    direct: {
      label: defineTool({
        description: 'Label references.',
        inputSchema: z.object({ references: z.record(z.string().regex(/^[a-z]+$/), z.number()) }),
        execute: () => ({}),
      }),
    },
    deferred: [{ name: 'map', description: 'Map.', inputSchema: {}, run: async () => ({}) }],
    skills: [],
  });
  for (const name of ['label', TOOL_CALL]) {
    const schema = asSchema(tools[name]!.inputSchema);
    expect(JSON.stringify(await schema.jsonSchema)).not.toContain('propertyNames');
  }
  const label = asSchema(tools.label!.inputSchema);
  expect(await label.validate!({ references: { ok: 1 } })).toMatchObject({ success: true });
  expect(await label.validate!({ references: { 'Bad key': 1 } })).toMatchObject({
    success: false,
  });
});
