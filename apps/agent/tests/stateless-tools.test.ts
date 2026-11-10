import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { subscriptionCallOptions } from '../src/model-tools.ts';

test('a stateless tool round trip resends encrypted reasoning instead of referencing unpersisted items', async () => {
  const requests: { store?: boolean; include?: string[]; input: Record<string, unknown>[] }[] = [];
  let toolCalls = 0;
  const provider = createOpenAI({
    apiKey: 'test',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: `response-${requests.length}`,
        created_at: 1,
        model: 'gpt-6.1-sol',
        status: 'completed',
        output:
          requests.length === 1
            ? [
                { type: 'reasoning', id: 'rs-test', summary: [], encrypted_content: 'opaque-test' },
                {
                  type: 'function_call',
                  id: 'fc-test',
                  call_id: 'call-test',
                  name: 'lookup',
                  arguments: '{}',
                },
              ]
            : [
                {
                  type: 'message',
                  id: 'message-test',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Ready', annotations: [] }],
                },
              ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const result = await generateText({
    model: provider.responses('gpt-6.1-sol'),
    prompt: 'Look up the answer.',
    providerOptions: subscriptionCallOptions({ prompt: [] }).providerOptions,
    stopWhen: stepCountIs(2),
    tools: {
      lookup: tool({
        inputSchema: z.object({}),
        execute: async () => {
          toolCalls++;
          return { answer: 'Ready' };
        },
      }),
    },
  });
  assert.equal(result.text, 'Ready');
  assert.equal(toolCalls, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.store === false));
  assert.ok(requests[0].include?.includes('reasoning.encrypted_content'));
  assert.ok(!requests[1].input.some((item) => item.type === 'item_reference'));
  assert.ok(
    requests[1].input.some(
      (item) => item.type === 'reasoning' && item.encrypted_content === 'opaque-test',
    ),
  );
  assert.ok(
    requests[1].input.some(
      (item) => item.type === 'function_call_output' && item.call_id === 'call-test',
    ),
  );
});
