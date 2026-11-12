import { test, expect } from 'vitest';
import {
  replyPresentation,
  PRESENT_UI_TOOL,
  SKIP_TIP_TOOL,
} from '@wisp/protocol/reply-presentation';
import { applyEvent } from '../src/events.ts';
import { newChat } from '../src/chat-lifecycle.ts';
import { ReplyProjection } from '../src/reply-stream.ts';
import { rebuildHistory } from '../src/history.ts';
import { replyContent } from '../src/reply-content.ts';
import { projectChats } from '../src/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';

const panel = {
  nodes: [
    {
      id: 'comparison',
      kind: 'comparison',
      unit: 'DPS',
      items: [
        { id: 'a', label: 'A', value: 10 },
        { id: 'b', label: 'B', value: 20 },
      ],
    },
  ],
  references: {},
};
function fixture() {
  const chat = newChat('inline', 'game');
  const projection = new ReplyProjection();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const emit = (type: string, data: Record<string, unknown>) => {
    events.push({ type, data });
    applyEvent(chat, { type, data }, projection);
  };
  const text = (partId: string, value: string) =>
    emit('content.completed', { partId, kind: 'text', value });
  const request = (callId: string, name = PRESENT_UI_TOOL) =>
    emit('call.requested', {
      callId,
      capability: { kind: 'tool', name, label: 'Presentation should stay hidden' },
    });
  const settle = (callId: string, output: unknown = panel, outcome = 'completed') =>
    emit('call.settled', { callId, output, outcome });
  const accept = (callId: string, input: unknown = panel, signal = new AbortController().signal) =>
    projection.acceptPresentation(callId, input, signal);
  const read = (callId: string) => {
    request(callId, 'wow__query_character');
    settle(callId, {});
  };
  return { chat, projection, events, emit, text, request, settle, accept, read };
}

test('plain text streams directly, including Markdown and JSON examples, without an output protocol', () => {
  const f = fixture();
  f.emit('content.delta', {
    partId: 'answer',
    kind: 'text',
    delta: 'Hola 🧙.\n```json\n{"type":"example"}\n```',
  });
  expect(replyContent(f.chat.messages[0])?.text).toContain('Hola 🧙.');
  expect(replyContent(f.chat.messages[0])?.text).toContain('{"type":"example"}');
  f.text('answer', 'Texto final autoritativo.');
  expect(f.chat.messages).toHaveLength(1);
  expect(replyContent(f.chat.messages[0])?.text).toBe('Texto final autoritativo.');
});

test('Markdown and reference tokens reach Lua unchanged before and after late metadata', () => {
  const f = fixture();
  const source =
    '**[[ref:missing]]** `[[ref:code]]` ``tick ` [[ref:double]]``\n' +
    '~~~text\n[[ref:fenced]]\n~~~\n\\[[ref:escaped]] [[ref:late]] unfinished [[ref:';
  f.emit('content.delta', { partId: 'answer', kind: 'text', delta: source });
  const before = replyContent(f.chat.messages[0])!;
  expect(before.text).toBe(source);
  expect(before.parts).toEqual([{ type: 'text', text: source }]);
  expect(before.references).toEqual({});
  f.request('refs');
  f.settle('refs', { references: { late: { kind: 'spell', id: 122, label: 'Nova' } } });
  const linked = replyContent(f.chat.messages[0])!;
  expect(linked.text).toBe(source);
  expect(linked.parts).toEqual(before.parts);
  expect(linked.references?.late).toMatchObject({ id: 122 });
  expect(before.references).toEqual({});
  f.text('answer', source);
  expect(replyContent(f.chat.messages[0])).toMatchObject({ text: source, streaming: false });
  expect(f.chat.messages[0].text).toBe(source);
  expect(f.chat.activity).toEqual([]);
});

test('text, a validated presentation and subsequent text form one ordered assistant message', () => {
  const f = fixture();
  f.text('before', 'Antes.\n\n');
  f.emit('call.input', { callId: 'ui', name: PRESENT_UI_TOOL, delta: '{"nodes":[' });
  f.request('ui');
  f.emit('call.progress', { callId: 'ui', label: 'Hidden progress' });
  expect(f.chat.messages[0].ui).toEqual([]);
  f.settle('ui');
  f.text('after', '\n\nDespués.');
  expect(f.chat.activity).toEqual([]);
  expect(f.chat.messages).toHaveLength(1);
  expect(f.chat.messages[0].parts).toEqual([
    { type: 'text', text: 'Antes.\n\n' },
    { type: 'ui', id: 'comparison' },
    { type: 'text', text: '\n\nDespués.' },
  ]);
  expect(f.chat.messages[0].ui).toEqual(panel.nodes);
  expect(replyContent(f.chat.messages[0])).not.toHaveProperty('replyFormat');
});

test('a comparison has live progress after prose without persisting a tool row', async () => {
  const f = fixture();
  f.chat.status = 'working';
  const state = createSessionState([f.chat]);
  state.activeChat = f.chat.id;
  const rows = () => projectChats(state).chats[0].messages!;
  f.text('before', 'I will compare the two setups.');
  f.emit('call.input', { callId: 'comparison', name: PRESENT_UI_TOOL, delta: '{"no' });
  expect(rows().map((m) => m.role)).toEqual(['assistant']);
  f.emit('call.input', { callId: 'comparison', delta: 'des":[{' });
  expect(rows().at(-1)).toMatchObject({
    role: 'tool',
    text: 'Creating panel',
    tool: { status: 'running' },
  });
  f.emit('call.input', { callId: 'comparison', delta: '"kind":"comparison"' });
  expect(rows().at(-1)?.text).toBe('Creating comparison');
  let accepted = false;
  const accepting = f.accept('comparison').then(() => (accepted = true));
  await Promise.resolve();
  expect(accepted).toBe(false);
  f.emit('call.requested', {
    callId: 'comparison',
    capability: { name: PRESENT_UI_TOOL, kind: 'tool' },
    input: panel,
  });
  await accepting;
  expect(rows().at(-1)?.text).toBe('Creating comparison');
  expect(f.chat.messages.map((m) => m.role)).toEqual(['assistant']);
  f.settle('comparison');
  expect(rows().map((m) => m.role)).toEqual(['assistant']);
  expect(rows()[0].ui).toEqual(panel.nodes);
  expect(f.chat.activity).toEqual([]);
});

test('reference registration stays out of presentation progress', () => {
  const f = fixture();
  f.chat.status = 'working';
  const state = createSessionState([f.chat]);
  state.activeChat = f.chat.id;
  f.text('before', 'Preparing the reply.');
  f.emit('call.input', { callId: 'refs', name: PRESENT_UI_TOOL, delta: '{"nodes":[],' });
  f.emit('call.requested', {
    callId: 'refs',
    capability: { name: PRESENT_UI_TOOL, kind: 'tool' },
    input: { nodes: [], references: { spell: { kind: 'spell', id: 122, label: 'Nova' } } },
  });
  expect(projectChats(state).chats[0].messages?.map((m) => m.role)).toEqual(['assistant']);
});

test('a comparison starts showing progress after a streamed references field', () => {
  const f = fixture();
  f.chat.status = 'working';
  const state = createSessionState([f.chat]);
  state.activeChat = f.chat.id;
  f.text('before', 'I will compare the two setups.');
  const references = Object.fromEntries(
    Array.from({ length: 45 }, (_, index) => [
      'spell' + index,
      { kind: 'spell', id: index + 1, label: 'Spell ' + index },
    ]),
  );
  f.emit('call.input', {
    callId: 'comparison',
    name: PRESENT_UI_TOOL,
    delta: '{"references":' + JSON.stringify(references) + ',"no',
  });
  expect(projectChats(state).chats[0].messages?.map((m) => m.role)).toEqual(['assistant']);
  f.emit('call.input', { callId: 'comparison', delta: 'des":[{"kind":"comparison"' });
  expect(projectChats(state).chats[0].messages?.at(-1)?.text).toBe('Creating comparison');
});

test('panels keep call order under out-of-order settlement and duplicate replay', () => {
  const f = fixture();
  f.request('one');
  f.request('two');
  const second = { nodes: [{ id: 'second', kind: 'stat', label: 'Level', value: '10' }] };
  f.settle('two', second);
  f.settle('one');
  f.request('one');
  f.settle('one');
  expect(f.chat.messages[0].parts).toEqual([
    { type: 'ui', id: 'comparison' },
    { type: 'ui', id: 'second' },
  ]);
  expect(f.chat.messages[0].ui).toHaveLength(2);
  expect(f.projection.hasContent).toBe(true);
});

test('invalid or failed presentations leave prose available without tool rows', () => {
  const f = fixture();
  f.text('before', 'Antes.');
  for (const [id, output, outcome] of [
    [
      'bad',
      { nodes: [{ id: 'bad', kind: 'button', label: 'Bad', action: { kind: 'lua' } }] },
      'completed',
    ],
    ['failed', panel, 'failed'],
    ['unknown', { metadata: 'never render' }, 'completed'],
  ] as const) {
    f.request(id);
    f.settle(id, output, outcome);
  }
  f.text('after', 'Después.');
  expect(f.chat.activity).toEqual([]);
  expect(f.chat.messages).toHaveLength(1);
  expect(f.chat.messages[0].ui).toEqual([]);
  expect(replyContent(f.chat.messages[0])?.text).toBe('Antes.Después.');
});

test('updating a component preserves its first inline position and rejects identity changes', () => {
  const f = fixture();
  f.text('before', 'Antes.');
  f.request('one');
  f.settle('one');
  f.text('after', 'Después.');
  f.request('update');
  const updated = { ...panel, nodes: [{ ...panel.nodes[0], title: 'Actualizado' }] };
  f.settle('update', updated);
  expect(f.chat.messages[0].parts?.map((part) => part.type)).toEqual(['text', 'ui', 'text']);
  expect(f.chat.messages[0].ui).toEqual(updated.nodes);
  f.request('change-kind');
  f.settle('change-kind', { nodes: [{ id: 'comparison', kind: 'text', text: 'Wrong type' }] });
  expect(f.chat.messages[0].ui).toEqual(updated.nodes);
});

test('an update after an ordinary tool changes the original panel without duplicating it', async () => {
  const f = fixture();
  f.text('before', 'Antes.');
  f.request('one');
  const first = { nodes: [{ id: 'summary', kind: 'stat', label: 'DPS', value: '10' }] };
  f.settle('one', await f.accept('one', first));
  f.read('read');
  f.text('after', 'Con los datos nuevos.');
  f.request('update');
  const updated = { nodes: [{ ...first.nodes[0], value: '20' }] };
  f.settle('update', await f.accept('update', updated));
  expect(f.chat.messages.map((message) => message.role)).toEqual([
    'assistant',
    'tool',
    'assistant',
  ]);
  expect(f.chat.messages[0].parts).toEqual([
    { type: 'text', text: 'Antes.' },
    { type: 'ui', id: 'summary' },
  ]);
  expect(f.chat.messages[0].ui).toEqual(updated.nodes);
  expect(f.chat.messages[2].ui).toEqual([]);
  expect(f.chat.messages[2].parts).toEqual([{ type: 'text', text: 'Con los datos nuevos.' }]);
  expect(f.chat.activity).toHaveLength(1);
});

test('a mixed presentation routes existing panels and new children to their original message', async () => {
  const f = fixture();
  const root = { id: 'summary', kind: 'card' };
  const child = { id: 'value', parent: 'summary', kind: 'stat', label: 'DPS', value: '10' };
  f.request('one');
  f.settle('one', await f.accept('one', { nodes: [root, child] }));
  f.read('read');
  f.request('mixed');
  const updated = { ...child, value: '20' };
  const added = { id: 'detail', parent: 'summary', kind: 'text', text: 'Verified update' };
  const fresh = { id: 'new-panel', kind: 'stat', label: 'Level', value: '10' };
  f.settle('mixed', await f.accept('mixed', { nodes: [root, updated, added, fresh] }));
  expect(f.chat.messages[0].ui).toEqual([root, updated, added]);
  expect(f.chat.messages[0].parts).toEqual([{ type: 'ui', id: 'summary' }]);
  expect(f.chat.messages[2].ui).toEqual([fresh]);
  expect(f.chat.messages[2].parts).toEqual([{ type: 'ui', id: 'new-panel' }]);
});

test.each([
  [{ id: 'summary', kind: 'text', text: 'Changed kind' }],
  [
    { id: 'other', kind: 'card' },
    { id: 'value', parent: 'other', kind: 'stat', label: 'DPS', value: '20' },
  ],
])('component identity stays immutable across ordinary tools (%j)', async (...nodes) => {
  const f = fixture();
  f.request('one');
  const first = {
    nodes: [
      { id: 'summary', kind: 'card' },
      { id: 'value', parent: 'summary', kind: 'stat', label: 'DPS', value: '10' },
    ],
  };
  f.settle('one', await f.accept('one', first));
  f.read('read');
  f.request('conflict');
  await expect(f.accept('conflict', { nodes })).rejects.toThrow('cannot change kind or parent');
  expect(f.chat.messages[0].ui).toEqual(first.nodes);
});

test.each([
  { count: 47, size: 1, error: '48 components' },
  { count: 8, size: 2800, error: 'combined presentation is too large' },
])(
  'updates charge component and byte budgets to the owning message ($error)',
  async ({ count, size, error }) => {
    const f = fixture();
    const root = { id: 'summary', kind: 'card' };
    const first = {
      nodes: [
        root,
        ...Array.from({ length: count }, (_, index) => ({
          id: 'child' + index,
          parent: 'summary',
          kind: 'text',
          text: 'x'.repeat(size),
        })),
      ],
    };
    f.request('one');
    f.settle('one', await f.accept('one', first));
    f.read('read');
    f.request('overflow');
    await expect(
      f.accept('overflow', {
        nodes: [
          root,
          {
            id: 'extra',
            parent: 'summary',
            kind: 'text',
            text: 'x'.repeat(size),
          },
        ],
      }),
    ).rejects.toThrow(error);
    expect(f.chat.messages[0].ui).toEqual(first.nodes);
    expect(f.chat.messages[2].ui).toEqual([]);
  },
);

test('pending components cannot acquire different owners before their first successful presentation', async () => {
  const f = fixture();
  f.request('one');
  const accepted = await f.accept('one');
  f.read('read');
  f.request('two');
  await expect(f.accept('two')).rejects.toThrow('pending in another message');
  f.settle('two', undefined, 'failed');
  f.settle('one', accepted);
  f.request('retry');
  const updated = { ...panel, nodes: [{ ...panel.nodes[0], title: 'Updated after settlement' }] };
  f.settle('retry', await f.accept('retry', updated));
  expect(f.chat.messages[0].ui).toEqual(updated.nodes);
  expect(f.chat.messages[2].ui).toEqual([]);
});

test('late cross-message updates preserve ownership, newest values and replay', async () => {
  const f = fixture();
  f.chat.messages.push({ id: 'user', role: 'user', text: 'Compará' });
  f.events.push({
    type: 'delivery.consumed',
    data: { parts: [{ kind: 'text', text: 'Compará' }] },
  });
  f.request('one');
  f.settle('one', await f.accept('one'));
  f.read('read');
  f.request('slow');
  const slow = await f.accept('slow', {
    ...panel,
    nodes: [{ ...panel.nodes[0], title: 'Older update' }],
  });
  f.read('read-again');
  f.request('fast');
  const fast = await f.accept('fast', {
    ...panel,
    nodes: [{ ...panel.nodes[0], title: 'Latest update' }],
  });
  f.settle('fast', fast);
  f.settle('slow', slow);
  const presentations = f.chat.messages.filter((message) => message.ui?.length);
  expect(presentations).toHaveLength(1);
  expect(presentations[0].id).toBe('presentation-one');
  expect(presentations[0].ui).toEqual(fast.nodes);
  expect(rebuildHistory(f.chat, f.events)?.map(replyContent)).toEqual(
    f.chat.messages.map(replyContent),
  );
});

test('component ownership resets on a new turn without changing the previous reply', async () => {
  const f = fixture();
  f.request('one');
  f.settle('one', await f.accept('one'));
  const original = f.chat.messages[0];
  f.emit('turn.started', { turnId: 'next' });
  f.chat.messages.push({ role: 'user', text: 'Next question' });
  f.request('new');
  const next = { nodes: [{ id: 'comparison', kind: 'text', text: 'A new component' }] };
  f.settle('new', await f.accept('new', next));
  expect(original.ui).toEqual(panel.nodes);
  expect(f.chat.messages.at(-1)?.ui).toEqual(next.nodes);
  expect(f.chat.messages.at(-1)?.parts).toEqual([{ type: 'ui', id: 'comparison' }]);
});

test('verified references register silently, resolve prose and cannot change meaning', () => {
  const f = fixture();
  f.request('refs');
  f.settle('refs', { references: { nova: { kind: 'spell', id: 122, label: 'Nova' } } });
  expect(replyContent(f.chat.messages[0])).toBeNull();
  f.text('answer', 'Usá [[ref:nova]]. `[[ref:example]]`');
  expect(replyContent(f.chat.messages[0])?.text).toBe('Usá [[ref:nova]]. `[[ref:example]]`');
  f.request('conflict');
  f.settle('conflict', { references: { nova: { kind: 'spell', id: 999, label: 'Wrong' } } });
  expect(f.chat.messages[0].references?.nova).toMatchObject({ id: 122 });
});

test('acceptance waits for ordered events and publishes only a successful settlement', async () => {
  const f = fixture();
  f.chat.messages.push({ id: 'user', role: 'user', text: 'Compará' });
  f.events.push({
    type: 'delivery.consumed',
    data: { parts: [{ kind: 'text', text: 'Compará' }] },
  });
  const accepted = f.accept('ui');
  f.emit('turn.started', { turnId: 'turn' });
  f.text('before', 'Antes.');
  f.request('ui');
  const output = await accepted;
  expect(output).toEqual(panel);
  expect(f.chat.messages.at(-1)?.ui).toEqual([]);
  expect(await f.accept('ui')).toEqual(panel);
  await expect(
    f.accept('ui', { nodes: [{ id: 'other', kind: 'text', text: 'Changed' }] }),
  ).rejects.toThrow('different payload');
  f.settle('ui', output);
  f.text('after', 'Después.');
  expect(f.chat.messages.at(-1)?.parts?.map((part) => part.type)).toEqual(['text', 'ui', 'text']);
  const restored = rebuildHistory(f.chat, f.events)!;
  expect(restored.map(replyContent)).toEqual(f.chat.messages.map(replyContent));
});

test('reference conflicts reject before acknowledgement, including concurrent reservations', async () => {
  const f = fixture();
  const first = { references: { nova: { kind: 'spell', id: 122, label: 'Nova' } } };
  const conflict = { references: { nova: { kind: 'spell', id: 999, label: 'Other' } } };
  f.request('one');
  const accepted = await f.accept('one', first);
  f.request('two');
  await expect(f.accept('two', conflict)).rejects.toThrow('already identifies something else');
  f.settle('one', accepted);
  await expect(f.accept('two', conflict)).rejects.toThrow('already identifies something else');
  f.settle('two', undefined, 'failed');
  f.request('repair');
  const repaired = await f.accept('repair', { references: { other: conflict.references.nova } });
  f.settle('repair', repaired);
  expect(f.chat.messages[0].references).toMatchObject({ nova: { id: 122 }, other: { id: 999 } });
});

test('failed calls release reservations and never publish accepted content', async () => {
  const f = fixture();
  f.text('before', 'Texto disponible.');
  f.request('failed');
  await f.accept('failed');
  f.settle('failed', panel, 'failed');
  expect(f.chat.messages[0].ui).toEqual([]);
  await expect(f.accept('failed')).rejects.toThrow('already finished');
  f.request('replacement');
  const replacement = { nodes: [{ id: 'comparison', kind: 'text', text: 'Now available' }] };
  f.settle('replacement', await f.accept('replacement', replacement));
  expect(f.chat.messages[0].ui).toEqual(replacement.nodes);
  expect(f.chat.activity).toEqual([]);
});

test('acceptance rejects component conflicts and aggregate limits before returning success', async () => {
  const f = fixture();
  f.request('one');
  await f.accept('one');
  f.request('kind');
  await expect(
    f.accept('kind', { nodes: [{ id: 'comparison', kind: 'text', text: 'Changed kind' }] }),
  ).rejects.toThrow('cannot change kind or parent');
  f.request('large');
  const full = { nodes: Array.from({ length: 48 }, (_, i) => ({ id: 'node' + i, kind: 'card' })) };
  await expect(f.accept('large', full)).rejects.toThrow('48 components');
  f.settle('one', undefined, 'failed');
  f.settle('large', await f.accept('large', full));
  f.request('extra');
  await expect(f.accept('extra')).rejects.toThrow('48 components');
});

test('reference and byte budgets include pending calls and existing message groups', async () => {
  const f = fixture();
  const references = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => ['r' + i, { kind: 'spell', id: i + 1, label: 'Spell' }]),
  );
  f.request('refs');
  await f.accept('refs', { references });
  f.request('more-refs');
  await expect(
    f.accept('more-refs', { references: { extra: { kind: 'spell', id: 100, label: 'Extra' } } }),
  ).rejects.toThrow('64 references');
  f.settle('refs', undefined, 'failed');
  const large = {
    nodes: Array.from({ length: 30 }, (_, i) => ({
      id: 'n' + i,
      kind: 'text',
      text: 'x'.repeat(700),
    })),
  };
  f.request('large');
  f.settle('large', await f.accept('large', large));
  f.request('ordinary', 'wow__query_character');
  f.settle('ordinary', {});
  f.request('global-refs');
  const longReferences = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [
      'r' + i,
      { kind: 'spell', id: i + 1, label: 's'.repeat(100) },
    ]),
  );
  await expect(f.accept('global-refs', { references: longReferences })).rejects.toThrow(
    'combined presentation is too large',
  );
});

test('waiting acceptance rejects on caller cancellation and turn completion', async () => {
  const f = fixture();
  const caller = new AbortController();
  const cancelled = expect(f.accept('cancelled', panel, caller.signal)).rejects.toThrow(
    'Caller cancelled',
  );
  caller.abort(Error('Caller cancelled'));
  await cancelled;
  const ended = expect(f.accept('late')).rejects.toThrow('turn has finished');
  f.projection.finish();
  await ended;
  f.emit('turn.started', { turnId: 'next' });
  f.request('new');
  expect(await f.accept('new')).toEqual(panel);
});

test('ordinary tool calls remain chronological and visible between response segments', () => {
  const f = fixture();
  f.text('before', 'Reviso tu equipo.');
  f.request('read', 'wow__query_character');
  f.settle('read', {});
  f.text('answer', 'Estas son las diferencias.');
  f.request('ui');
  f.settle('ui');
  f.text('after', 'Mi recomendación.');
  expect(f.chat.messages.map((message) => message.role)).toEqual([
    'assistant',
    'tool',
    'assistant',
  ]);
  expect(f.chat.activity).toHaveLength(1);
  expect(f.chat.messages[2].parts?.map((part) => part.type)).toEqual(['text', 'ui', 'text']);
});

test('the shared projection replays interleaved content, resetting reference keys on new turns', () => {
  const f = fixture();
  f.chat.messages.push({ id: 'inline-user-1', role: 'user', text: 'Compará' });
  f.events.push({
    type: 'delivery.consumed',
    data: { parts: [{ kind: 'text', text: 'Compará' }] },
  });
  f.text('before', 'Antes.');
  f.request('ui');
  f.settle('ui');
  f.text('after', 'Después.');
  const replayed = rebuildHistory(f.chat, f.events)!;
  expect(replayed).not.toBeNull();
  expect(replayed.map(replyContent)).toEqual(f.chat.messages.map(replyContent));
  f.emit('turn.started', { turnId: 'next' });
  f.chat.messages.push({ role: 'user', text: 'Otra pregunta' });
  f.request('next-refs');
  f.settle('next-refs', { references: { nova: { kind: 'spell', id: 999, label: 'Other' } } });
  f.text('next-answer', '[[ref:nova]]');
  expect(f.chat.messages.at(-1)?.references?.nova).toMatchObject({ id: 999 });
  expect(f.chat.messages[1].references).toEqual({});
});

test('the silent no-tip tool only suppresses automatic suggestions and stays hidden', () => {
  for (const automatic of [true, false]) {
    const f = fixture();
    f.chat.proactive = automatic;
    f.request('skip', SKIP_TIP_TOOL);
    f.settle('skip', { skipped: true });
    expect(f.projection.noTip).toBe(automatic);
    expect(f.chat.messages).toEqual([]);
    expect(f.chat.activity).toEqual([]);
  }
});

test('presentation validation rejects broken trees, invalid comparison identities and payload limits', () => {
  for (const nodes of [
    [{ id: 'x', kind: 'card', parent: 'missing' }],
    [
      { id: 'x', kind: 'card' },
      { id: 'x', kind: 'card' },
    ],
    [{ ...panel.nodes[0], winner: 'missing' }],
    [{ id: 'x', kind: 'slider', label: 'Bad', min: 5, max: 1, step: 1, value: 2 }],
    [{ id: 'x', kind: 'reference', reference: 'missing' }],
  ]) {
    expect(replyPresentation.safeParse({ nodes }).success).toBe(false);
  }
  expect(
    replyPresentation.safeParse({
      nodes: Array.from({ length: 49 }, (_, i) => ({ id: 'x' + i, kind: 'card' })),
    }).success,
  ).toBe(false);
  expect(replyPresentation.safeParse({ nodes: [], references: {} }).success).toBe(false);
  expect(replyPresentation.parse(panel)).toEqual(panel);
});
