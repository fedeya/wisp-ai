import { SessionNotActiveError, type Client } from 'eve/client';
import type { Chat } from '../chat/events.ts';
import { withConversationHistory } from '../chat/context.ts';
import { resetContextUsage } from '@wisp/protocol/context-usage';

export function isInactiveSession(error: unknown): boolean {
  return SessionNotActiveError.is(error) && error.code === 'session_not_active';
}

// Retry only an explicit admission rejection. Never replay an accepted turn,
// which might already have performed a tool action before failing.
export async function sendChatTurn(
  client: Pick<Client, 'sessions'>,
  chat: Chat,
  input: string,
  signal?: AbortSignal,
) {
  const resumed = Boolean(chat.eveId);
  if (!resumed) {
    resetContextUsage(chat);
  }
  let session = chat.eveId
    ? client.sessions.attach(chat.eveId)
    : (await client.sessions.create({ signal })).session;
  signal?.throwIfAborted();
  chat.eveId = session.id;
  try {
    return await session.send(resumed ? input : withConversationHistory(input, chat.messages), {
      signal,
    });
  } catch (error) {
    if (!resumed || !isInactiveSession(error)) {
      throw error;
    }
    signal?.throwIfAborted();
    session = (await client.sessions.create({ signal })).session;
    signal?.throwIfAborted();
    resetContextUsage(chat);
    chat.eveId = session.id;
    return session.send(withConversationHistory(input, chat.messages), { signal });
  }
}
