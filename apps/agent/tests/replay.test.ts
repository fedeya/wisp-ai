import { expect, test } from 'vitest';
import type { ModelMessage } from 'ai';
import { modelFamily, replayMessages, toolCallIdFor, type StoredMessage } from '../src/replay.ts';

const anthropicCall = 'toolu_01ABC.def';
const turn = (model: string, id = 'call_abc123'): StoredMessage[] => [
  { message: { role: 'user', content: 'Scan my gear' }, model },
  {
    message: {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking',
          providerOptions: { anthropic: { signature: 'sig' } },
        },
        { type: 'text', text: 'Checking', providerOptions: { openai: { itemId: 'msg_1' } } },
        {
          type: 'tool-call',
          toolCallId: id,
          toolName: 'wow__query_character',
          input: {},
          providerOptions: { openai: { itemId: 'fc_1' } },
        },
      ],
    },
    model,
  },
  {
    message: {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: 'wow__query_character',
          output: { type: 'json', value: { level: 20 } },
        },
      ],
    },
    model,
  },
];

const parts = (message: ModelMessage) => message.content as Record<string, unknown>[];

test('the model that wrote a message reads it unchanged', () => {
  const stored = turn('gpt-5');
  expect(replayMessages(stored, { model: 'gpt-5' })).toEqual(stored.map((s) => s.message));
});

test('another model reads no provider-native data and no reasoning', () => {
  const replayed = replayMessages(turn('gpt-5'), {
    model: 'connection:abc:claude-sonnet',
    provider: 'anthropic',
    modelId: 'claude-sonnet',
  });
  const assistant = parts(replayed[1]!);
  expect(assistant.map((part) => part.type)).toEqual(['text', 'tool-call']);
  expect(assistant.every((part) => !('providerOptions' in part))).toBe(true);
  // A message left with nothing readable is skipped.
  const onlyReasoning: StoredMessage = {
    message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Hmm' }] },
    model: 'gpt-5',
  };
  expect(replayMessages([onlyReasoning], { model: 'other', provider: 'groq' })).toEqual([]);
});

test('tool call IDs follow the target API, matching between call and result', () => {
  const ids = (target: Parameters<typeof replayMessages>[1], id: string) =>
    replayMessages(turn('gpt-5', id), target).flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : parts(message)
            .filter((part) => typeof part.toolCallId === 'string')
            .map((part) => part.toolCallId),
    );
  const [claudeCall, claudeResult] = ids({ model: 'c', provider: 'anthropic' }, anthropicCall);
  expect(claudeCall).toBe('toolu_01ABC_def');
  expect(claudeResult).toBe(claudeCall);
  const [mistralCall, mistralResult] = ids({ model: 'm', provider: 'mistral' }, 'call_abc123');
  expect(mistralCall).toMatch(/^[a-zA-Z0-9]{9}$/);
  expect(mistralResult).toBe(mistralCall);
  const long = 'x'.repeat(64);
  const [openaiCall] = ids({ model: 'gpt-5' }, long);
  expect(String(openaiCall).length).toBeLessThanOrEqual(40);
  // Different long IDs stay different instead of being cut to the same prefix.
  expect(toolCallIdFor(long + 'a', 'openai')).not.toBe(toolCallIdFor(long + 'b', 'openai'));
  expect(toolCallIdFor('abcdefghi1', 'mistral')).not.toBe(toolCallIdFor('abcdefghi2', 'mistral'));
  expect(toolCallIdFor('call_ok', 'other')).toBe('call_ok');
});

test('Mistral gets an assistant message between tool results and the next user message', () => {
  const stored = [...turn('gpt-5'), { message: { role: 'user', content: 'And now?' }, model: 'x' }];
  const replayed = replayMessages(stored as StoredMessage[], { model: 'm', provider: 'mistral' });
  expect(replayed.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
    'user',
  ]);
  expect(replayed[3]).toEqual({ role: 'assistant', content: 'Done.' });
  expect(replayMessages(stored as StoredMessage[], { model: 'gpt-5' })).toHaveLength(4);
});

test('model families come from the provider, or the model name on gateways', () => {
  expect(modelFamily({ model: 'gpt-5.4' })).toBe('openai');
  expect(modelFamily({ model: 'x', provider: 'openrouter', modelId: 'anthropic/claude-4' })).toBe(
    'anthropic',
  );
  expect(modelFamily({ model: 'x', provider: 'compatible', modelId: 'devstral-small' })).toBe(
    'mistral',
  );
  expect(modelFamily({ model: 'x', provider: 'groq', modelId: 'llama-4' })).toBe('other');
});
