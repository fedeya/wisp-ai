import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resumeChat, isAutomaticEmptyChat } from '@wisp/bridge/sessions';
import type { Chat } from '@wisp/bridge/events';
const chat = (id: string, populated = true): Chat => ({
  id,
  title: populated ? 'Existing conversation' : 'New conversation',
  messages: populated ? [{ role: 'user', text: 'Hello' }] : [],
  status: 'idle',
  owner: 'game',
  activity: [],
});
test('login and reload resume a saved chat without creating a conversation', () => {
  const chats = [chat('old'), chat('recent'), chat('explicit-empty', false)];
  assert.equal(resumeChat(chats, 'old')?.id, 'old');
  assert.equal(resumeChat(chats, 'stale-id')?.id, 'recent');
  assert.equal(resumeChat(chats, 'explicit-empty')?.id, 'explicit-empty');
  assert.equal(chats.length, 3);
  assert.equal(resumeChat([]), undefined);
});
test('cleanup only matches automatically generated empty login conversations', () => {
  assert.equal(isAutomaticEmptyChat(chat('1794036015-256936-first', false)), true);
  assert.equal(isAutomaticEmptyChat(chat('1794036015-256936-first', true)), false);
  assert.equal(isAutomaticEmptyChat(chat('1794036015-256936-chat-1', false)), false);
});
