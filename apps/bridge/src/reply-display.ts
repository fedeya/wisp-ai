import type { Message } from './chat.ts';
import { replyContent } from './reply-content.ts';
import { renderMessageTables } from './reply-tables.ts';

export function renderReply(original: Message): Message | null {
  const message = replyContent(original);
  return message && renderMessageTables(message);
}
