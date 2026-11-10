import { ReplyProjection } from '../src/reply-stream.ts';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { applyEvent, type Chat } from '../src/events.ts';
import { SnapshotGate } from '../src/snapshots.ts';
import { projectChats } from '../src/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';

test('invisible stream events and unchanged snapshots do not spend revisions', () => {
  const chat: Chat = {
    id: 'chat',
    owner: 'game',
    title: 'Test',
    status: 'working',
    activity: [],
    messages: [],
  };
  const gate = new SnapshotGate(100),
    parts = new ReplyProjection();
  const view = () => ({ session: 'game', chats: [chat], acks: [1], connected: true });
  assert.equal(gate.next(view())?.rev, 101);
  for (let index = 0; index < 10000; index++) {
    assert.equal(
      applyEvent(
        chat,
        { type: 'content.delta', data: { kind: 'reasoning', delta: 'private' } },
        parts,
      ),
      false,
    );
    assert.equal(gate.next(view()), null);
  }
  const call = {
    type: 'call.requested',
    data: {
      callId: 'tool',
      capability: { kind: 'tool', name: 'inspect_target', label: 'Inspecting target' },
    },
  };
  assert.equal(applyEvent(chat, call, parts), true);
  assert.equal(gate.next(view())?.rev, 102);
  assert.equal(
    applyEvent(
      chat,
      { type: 'call.progress', data: { callId: 'tool', label: 'Inspecting target' } },
      parts,
    ),
    false,
  );
  assert.equal(gate.next(view()), null);
  assert.equal(
    applyEvent(
      chat,
      { type: 'call.settled', data: { callId: 'tool', outcome: 'completed' } },
      parts,
    ),
    true,
  );
  assert.equal(gate.next(view())?.rev, 103);
  assert.equal(
    applyEvent(
      chat,
      { type: 'call.settled', data: { callId: 'tool', outcome: 'completed' } },
      parts,
    ),
    false,
  );
  gate.invalidate();
  assert.equal(gate.next(view())?.rev, 104, 'a failed disk write must remain retryable');
});

test('dense deltas coalesce into timed previews while all source is saved', () => {
  vi.useFakeTimers();
  try {
    const chat: Chat = {
      id: 'chat',
      owner: 'game',
      title: 'Test',
      status: 'working',
      activity: [],
      messages: [],
    };
    const state = createSessionState([chat]);
    state.activeChat = chat.id;
    const projection = new ReplyProjection(),
      gate = new SnapshotGate();
    const delta = 'a';
    let updates = 0;
    for (let index = 0; index < 100; index++) {
      vi.setSystemTime(index * 10);
      applyEvent(
        chat,
        { type: 'content.delta', data: { partId: 'answer', kind: 'text', delta } },
        projection,
      );
      if (gate.next(projectChats(state))) {
        updates++;
      }
    }
    assert.equal(updates, 2);
    assert.equal(chat.messages[0].text, delta.repeat(100));
    assert.equal(projectChats(state).chats[0].messages?.[0].text, delta.repeat(61));
    assert.ok(!JSON.stringify(projectChats(state)).includes('rawReply'));
    assert.equal(projection.flush(chat, 1200), true);
    assert.equal(projectChats(state).chats[0].messages?.[0].text, delta.repeat(100));
    assert.ok(gate.next(projectChats(state)));
    applyEvent(
      chat,
      {
        type: 'content.completed',
        data: { partId: 'answer', kind: 'text', value: delta.repeat(100) },
      },
      projection,
    );
    assert.equal(projectChats(state).chats[0].messages?.[0].text, 'a'.repeat(100));
    assert.ok(gate.next(projectChats(state)));
  } finally {
    vi.useRealTimers();
  }
});

test('long replies keep publishing partial previews beyond eight updates', () => {
  vi.useFakeTimers();
  try {
    const chat: Chat = {
      id: 'long',
      owner: 'game',
      title: 'Long reply',
      status: 'working',
      activity: [],
      messages: [],
    };
    const state = createSessionState([chat]);
    state.activeChat = chat.id;
    const projection = new ReplyProjection();
    const gate = new SnapshotGate();
    for (let index = 0; index < 20; index++) {
      vi.setSystemTime(index * 600);
      applyEvent(
        chat,
        {
          type: 'content.delta',
          data: { partId: 'answer', kind: 'text', delta: 'a' },
        },
        projection,
      );
      assert.ok(gate.next(projectChats(state)));
      assert.equal(projectChats(state).chats[0].messages?.[0].text, 'a'.repeat(index + 1));
      assert.equal(chat.messages[0].streaming, true);
    }
  } finally {
    vi.useRealTimers();
  }
});
