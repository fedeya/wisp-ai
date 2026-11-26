import type { createAgentEngine, TurnInput } from '@wisp/agent/engine';
import type { Chat } from '../chat/events.ts';
import { withConversationHistory } from '../chat/context.ts';
import { resetContextUsage } from '@wisp/agent/contract/context-usage';

export type AgentEngine = Pick<
  ReturnType<typeof createAgentEngine>,
  'newSessionId' | 'send' | 'end'
>;

/**
 * Starts a turn on the chat's agent session, or a new one when the chat has
 * none (new, carried over from an older version, or reset after the provider
 * rejected a request). The turn carries the recent visible conversation; the
 * engine logs it only when the session has no log yet.
 */
export function sendChatTurn(
  engine: AgentEngine,
  chat: Chat,
  input: TurnInput,
  signal: AbortSignal,
) {
  const resumed = Boolean(chat.agentSession);
  if (!resumed) {
    resetContextUsage(chat);
    chat.agentSession = engine.newSessionId();
  }
  return engine.send(
    chat.agentSession!,
    withConversationHistory(input, chat.messages),
    signal,
    chat.id,
  );
}

/** Forgets a session's model history; failures only leave unused rows behind. */
export function endSession(engine: Pick<AgentEngine, 'end'>, session: string | undefined) {
  if (session) {
    void engine.end(session).catch(() => {});
  }
}
