import { ReplyProjection } from '@wisp/bridge/reply-stream';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyEvent, type Chat } from '@wisp/bridge/events';
import { SnapshotGate } from '@wisp/bridge/snapshots';

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
