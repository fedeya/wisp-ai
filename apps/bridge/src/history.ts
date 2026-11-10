import { applyEvent, type Chat, type Message } from './events.ts';
import { ReplyProjection } from './reply-stream.ts';
import { visibleUserText } from './context.ts';
export function rebuildHistory(
  chat: Chat,
  events: { type: string; data: Record<string, unknown> }[],
): Message[] | null {
  const rebuilt: Chat = { ...chat, usage: undefined, messages: [], activity: [] };
  const users = chat.messages.filter((m) => m.role === 'user');
  let userIndex = 0;
  const parts = new ReplyProjection();
  for (const event of events) {
    if (event.type === 'delivery.consumed') {
      const input = event.data.parts as { kind?: string; text?: string }[] | undefined;
      const text = (input || [])
        .filter((p) => p.kind === 'text')
        .map((p) => p.text || '')
        .join('\n');
      if (text) {
        parts.beginTurn();
        const original = users[userIndex++];
        if (!original || original.text !== visibleUserText(text)) {
          return null;
        }
        rebuilt.messages.push({ ...original, id: original.id || chat.id + '-user-' + userIndex });
      }
    } else {
      applyEvent(rebuilt, event, parts);
    }
  }
  parts.finish();
  parts.flush(rebuilt, Date.now(), true);
  // Never replace local history if a snapshot is incomplete or differs from it.
  if (userIndex !== users.length || !userIndex) {
    return null;
  }
  if (
    rebuilt.messages.filter((m) => m.role === 'assistant' && m.phase !== 'narration').length <
    chat.messages.filter((m) => m.role === 'assistant').length
  ) {
    return null;
  }
  return rebuilt.messages;
}
