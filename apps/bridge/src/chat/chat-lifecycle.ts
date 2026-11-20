import { randomUUID } from 'node:crypto';
import type { Chat, ChatStatus } from './chat.ts';
export type { ChatStatus } from './chat.ts';

export function newChat(id: string, owner: string, now = Date.now()): Chat {
  return {
    id,
    owner,
    title: 'New conversation',
    messages: [],
    activity: [],
    status: 'idle',
    lastActivityAt: now,
  };
}
export function beginTurn(
  chat: Chat,
  owner: string,
  characterKey: string | undefined,
  text: string,
  messageId: string = randomUUID(),
) {
  if (chat.status === 'working') {
    throw Error('A turn is already running for this conversation.');
  }
  const retrying = chat.status === 'error';
  chat.status = 'working';
  chat.activity = [];
  chat.owner = owner;
  chat.characterKey = characterKey;
  chat.historyVersion = 3;
  chat.lastUsedAt = chat.lastActivityAt = Date.now();
  const previous = chat.messages.findLast((message) => message.role === 'user');
  if (!retrying || previous?.id !== messageId) {
    chat.messages.push({ id: messageId, role: 'user', text });
  }
}
export function isWorking(chat: Chat) {
  return chat.status === 'working';
}
export function openChat(chat: Chat) {
  if (chat.status === 'working') {
    throw Error('Wait for the conversation to finish.');
  }
  if (chat.proactive) {
    chat.proactive = false;
    chat.dismissed = true;
    chat.titleGenerated = !!chat.routineId;
  }
  chat.unread = false;
  chat.lastUsedAt = Date.now();
}
export function promoteChat(chat: Chat) {
  chat.inline = false;
  chat.titleGenerated = false;
}
export function settleTurn(chat: Chat, status: Exclude<ChatStatus, 'idle' | 'working'>) {
  chat.status = status;
  chat.lastActivityAt = Date.now();
  if (chat.usage) {
    chat.usage.compacting = false;
  }
}
