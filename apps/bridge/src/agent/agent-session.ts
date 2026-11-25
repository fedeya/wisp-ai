import type { createAgentEngine, TurnInput } from '@wisp/agent/engine';
import type { Chat } from '../chat/events.ts';
import { withConversationHistory } from '../chat/context.ts';
import { resetContextUsage } from '@wisp/protocol/context-usage';

export type AgentEngine = Pick<
  ReturnType<typeof createAgentEngine>,
  'newSessionId' | 'send' | 'end'
>;

/**
 * Starts a turn on the chat's agent session. A chat without one (new, or reset
 * after a model change or failure) starts a session whose first message carries
 * the recent visible conversation.
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
    resumed ? input : withConversationHistory(input, chat.messages),
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
