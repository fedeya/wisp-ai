import type { DatabaseSync } from 'node:sqlite';
import { chatSchema } from '../chat.ts';

export function validateLegacyChats(db: DatabaseSync) {
  const messages = new Map<string, unknown[]>();
  for (const row of db.prepare('SELECT * FROM messages ORDER BY chat_id, position').iterate()) {
    const id = String(row.chat_id);
    const content = messages.get(id) ?? [];
    if (Number(row.position) !== content.length) {
      throw Error('Legacy conversation messages are not contiguous.');
    }
    content.push(JSON.parse(String(row.content)));
    messages.set(id, content);
  }
  for (const row of db.prepare('SELECT id, metadata FROM chats').iterate()) {
    const id = String(row.id);
    const chat = { ...JSON.parse(String(row.metadata)), messages: messages.get(id) ?? [] };
    chatSchema.parse(chat);
    if (chat.id !== id) {
      throw Error('Legacy conversation identity does not match its row.');
    }
    messages.delete(id);
  }
  if (messages.size) {
    throw Error('Legacy messages reference a missing conversation.');
  }
}
