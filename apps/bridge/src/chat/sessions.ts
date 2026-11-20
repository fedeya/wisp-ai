import type { Chat } from './events.ts';
export function isEmptyDraft(chat: Chat): boolean {
  return (
    chat.title === 'New conversation' &&
    !chat.eveId &&
    !chat.routineId &&
    !chat.inline &&
    !chat.proactive &&
    !chat.messages.length &&
    !chat.activity.length &&
    chat.status === 'idle'
  );
}
export function isAutomaticEmptyChat(chat: Chat): boolean {
  return (
    /^\d+-\d+-first$/.test(chat.id) &&
    chat.title === 'New conversation' &&
    !chat.eveId &&
    !chat.messages.length &&
    chat.status === 'idle'
  );
}
export function resumeChat(chats: Chat[], requested?: string): Chat | undefined {
  const requestedRun = chats.find(
    (chat) => chat.id === requested && chat.routineId && !chat.proactive,
  );
  if (requestedRun) {
    return requestedRun;
  }
  chats = chats.filter((chat) => !chat.inline && !chat.proactive && !chat.routineId);
  const saved = chats.find((c) => c.id === requested);
  if (saved) {
    return saved;
  }
  const populated = chats.filter((c) => c.messages.length > 0);
  return (
    populated.reduce<Chat | undefined>(
      (latest, chat) =>
        !latest || (chat.lastUsedAt || 0) >= (latest.lastUsedAt || 0) ? chat : latest,
      undefined,
    ) || chats.at(-1)
  );
}
