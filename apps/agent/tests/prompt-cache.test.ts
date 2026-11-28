import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Schema } from 'effect';
import { generateText } from 'ai';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';

import { connectionModel } from '../src/models/connection-model.ts';
import { withAnthropicCache } from '../src/models/prompt-cache.ts';

const cached = { anthropic: { cacheControl: { type: 'ephemeral' } } };
/** The parts of an Anthropic Messages request these tests read. */
const decodeAnthropicRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      system: Schema.Unknown,
      messages: Schema.Array(Schema.Struct({ content: Schema.Unknown })),
    }),
  ),
);
const text = (value: string) => [{ type: 'text' as const, text: value }];

test('marks the last system message and the last two messages as cache breakpoints', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'system', content: 'Tools and instructions' },
    { role: 'user', content: text('First') },
    { role: 'assistant', content: text('Answer'), providerOptions: { anthropic: { other: 1 } } },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c',
          toolName: 't',
          output: { type: 'json', value: 1 },
        },
      ],
    },
  ];
  const result = withAnthropicCache(prompt);
  expect(result.map((message) => message.providerOptions)).toEqual([
    cached,
    undefined,
    { anthropic: { other: 1, cacheControl: { type: 'ephemeral' } } },
    cached,
  ]);
  // The prompt it was given stays as it was.
  expect(prompt[0]?.providerOptions).toBeUndefined();
});

test('a prompt without a system message or history marks what it has', () => {
  expect(
    withAnthropicCache([{ role: 'user', content: text('Only') }]).map(
      (message) => message.providerOptions,
    ),
  ).toEqual([cached]);
});

test('an Anthropic connection sends the breakpoints as cache_control', async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('The test server has no port.');
    const origin = 'http://127.0.0.1:' + address.port;
    const model = connectionModel(
      {
        model: 'anthropic/claude-test',
        effort: 'provider-default',
        connectionId: '00000000-0000-4000-8000-000000000000',
        provider: 'anthropic',
        modelId: 'claude-test',
      },
      origin,
      'token',
      async () => false,
      'cache-key',
    );
    await generateText({
      model,
      instructions: 'Instructions',
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'Second' },
      ],
    });
    const request = decodeAnthropicRequest(bodies[0] ?? '{}');
    expect(request.system).toEqual([
      { type: 'text', text: 'Instructions', cache_control: { type: 'ephemeral' } },
    ]);
    expect(
      request.messages.map((message) => JSON.stringify(message.content).includes('cache_control')),
    ).toEqual([false, true, true]);
  } finally {
    server.close();
  }
});
