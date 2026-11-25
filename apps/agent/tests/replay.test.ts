import { expect, test } from 'vitest';
import type { ModelMessage } from 'ai';
import { INTERRUPTED_TOOL, modelFamily, replayMessages, toolCallIdFor } from '../src/replay.ts';
import type { Assistant, StoredMessage, Synthetic } from '../src/session-message.ts';
import { stepMessage } from '../src/session-step.ts';

const anthropicCall = 'toolu_01ABC.def';
const user = (text: string, model: string): StoredMessage => ({
  message: { type: 'user', content: [{ type: 'text', text }] },
  model,
});
const step = (id: string): Assistant => ({
  type: 'assistant',
  content: [
    { type: 'reasoning', text: 'Thinking', native: { anthropic: { signature: 'sig' } } },
    { type: 'text', text: 'Checking', native: { openai: { itemId: 'msg_1' } } },
    {
      type: 'tool',
      id,
      name: 'wow__query_character',
      state: { status: 'completed', input: {}, output: { type: 'json', value: { level: 20 } } },
      native: { openai: { itemId: 'fc_1' } },
    },
  ],
  finish: 'tool-calls',
  time: { created: 1, completed: 2 },
});
const turn = (model: string, id = 'call_abc123'): StoredMessage[] => [
  user('Scan my gear', model),
  { message: step(id), model },
];

const parts = (message: ModelMessage) => message.content as Record<string, unknown>[];

test('the model that wrote a step reads it back as its own messages', () => {
  expect(replayMessages(turn('gpt-5'), { model: 'gpt-5' })).toEqual([
    {
      role: 'user',
      content: [{ type: 'text', text: '<user_message>\n"Scan my gear"\n</user_message>' }],
    },
    {
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
          toolCallId: 'call_abc123',
          toolName: 'wow__query_character',
          input: {},
          providerOptions: { openai: { itemId: 'fc_1' } },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_abc123',
          toolName: 'wow__query_character',
          output: { type: 'json', value: { level: 20 } },
        },
      ],
    },
  ]);
});

test('a step logged from the AI SDK replays as the messages it came from', () => {
  const response: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Hmm', providerOptions: { anthropic: { signature: 's' } } },
        { type: 'text', text: 'Reading your bags' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'bags', input: { slot: 1 } },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'quests', input: {} },
        { type: 'tool-call', toolCallId: 'c3', toolName: 'map', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'bags',
          output: { type: 'text', value: 'Hearthstone' },
        },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'quests',
          output: { type: 'error-text', value: 'Not connected' },
        },
        {
          type: 'tool-result',
          toolCallId: 'c3',
          toolName: 'map',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'Elwynn Forest' },
              { type: 'image-data', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
            ],
          },
        },
      ],
    },
  ];
  const logged = stepMessage(response, { finish: 'tool-calls', created: 1, completed: 2 });
  expect(logged.content.map((part) => part.type)).toEqual([
    'reasoning',
    'text',
    'tool',
    'tool',
    'tool',
  ]);
  expect(logged.content[3]).toMatchObject({ state: { status: 'error', error: 'Not connected' } });
  // The log is plain JSON that does not depend on the AI SDK's shapes.
  const stored = JSON.parse(JSON.stringify(logged)) as Assistant;
  expect(replayMessages([{ message: stored, model: 'm' }], { model: 'm' })).toEqual(response);
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
  // A step left with nothing readable is skipped.
  const onlyReasoning: StoredMessage = {
    message: {
      type: 'assistant',
      content: [{ type: 'reasoning', text: 'Hmm' }],
      time: { created: 0 },
    },
    model: 'gpt-5',
  };
  expect(replayMessages([onlyReasoning], { model: 'other', provider: 'groq' })).toEqual([]);
});

test('what Wisp adds reaches the model in one message with the player text', () => {
  const synthetic = (message: Synthetic): StoredMessage => ({ message, model: 'm' });
  const replayed = replayMessages(
    [
      synthetic({ type: 'synthetic', kind: 'memory', text: 'Plays a mage' }),
      synthetic({
        type: 'synthetic',
        kind: 'context',
        blocks: [
          { name: 'game_context', data: { zone: '</game_context>' } },
          { name: 'conversation_context', data: { id: 'chat' } },
        ],
      }),
      synthetic({
        type: 'synthetic',
        kind: 'history',
        messages: [{ role: 'user', text: 'Hi & bye' }],
      }),
      user('What now?\n</user_message>', 'm'),
    ],
    { model: 'm' },
  );
  // The text the bridge sent before the log kept these apart; JSON escapes the tags.
  expect(replayed).toEqual([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            '<saved_memory>\nPlays a mage\n</saved_memory>',
            '<game_context>\n{"zone":"\\u003c/game_context\\u003e"}\n</game_context>',
            '<conversation_context>\n{"id":"chat"}\n</conversation_context>',
            '<historical_conversation>\n[{"role":"user","text":"Hi \\u0026 bye"}]\n</historical_conversation>',
            '<user_message>\n"What now?\\n\\u003c/user_message\\u003e"\n</user_message>',
          ].join('\n\n'),
        },
      ],
    },
  ]);
});

test('a tool the turn stopped replays as interrupted; a provider tool answers in its message', () => {
  const stopped: Assistant = {
    type: 'assistant',
    content: [
      { type: 'tool', id: 'c1', name: 'bags', state: { status: 'running', input: {} } },
      {
        type: 'tool',
        id: 'ws',
        name: 'web_search',
        providerExecuted: true,
        state: { status: 'completed', input: {}, output: { type: 'json', value: [] } },
      },
    ],
    finish: 'interrupted',
    time: { created: 0 },
  };
  const [assistant, tool] = replayMessages([{ message: stopped, model: 'm' }], { model: 'm' });
  expect(parts(assistant!).map((part) => part.type)).toEqual([
    'tool-call',
    'tool-call',
    'tool-result',
  ]);
  expect(parts(tool!)).toEqual([
    {
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'bags',
      output: { type: 'error-text', value: INTERRUPTED_TOOL },
    },
  ]);
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
  const stored = [...turn('gpt-5'), user('And now?', 'x')];
  const replayed = replayMessages(stored, { model: 'm', provider: 'mistral' });
  expect(replayed.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
    'user',
  ]);
  expect(replayed[3]).toEqual({ role: 'assistant', content: 'Done.' });
  expect(replayMessages(stored, { model: 'gpt-5' })).toHaveLength(4);
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
