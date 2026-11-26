import { replayMessages, summaryMessages, type ReplayTarget } from '../session/replay.ts';
import type { LoadedHistory, LoggedMessage } from '../session/session-history.ts';
import type {
  ContextBlock,
  HistoryLine,
  Message,
  StoredMessage,
} from '../session/session-message.ts';

/** A player's turn: what they wrote, and what Wisp sends the model with it. */
export interface TurnInput {
  text: string;
  /** The game and chat as they are now, as named blocks of data. */
  context?: readonly ContextBlock[];
  /**
   * The chat's earlier messages. They are logged only when the session has no
   * log yet, so a session that starts mid-chat, or one the chat points at
   * without a log, still begins with the conversation.
   */
  history?: readonly HistoryLine[];
}

/** The saved memory last sent in this session, so an unchanged one is not sent again. */
function lastMemory(messages: readonly LoggedMessage[]) {
  for (const { message } of messages.toReversed()) {
    if (message.type === 'synthetic' && message.kind === 'memory') return message.text;
  }
  return undefined;
}

/**
 * A turn's log entries: what Wisp adds (saved memory when it changed since it
 * was last sent, the turn's context, the chat's earlier messages), then what
 * the player wrote.
 */
export function turnEntries(input: TurnInput, memory: string, loaded: LoadedHistory): Message[] {
  const logged = loaded.messages;
  const entries: Message[] = [];
  if (memory && memory !== lastMemory(logged)) {
    entries.push({ type: 'synthetic', kind: 'memory', text: memory });
  }
  if (input.context?.length) {
    entries.push({ type: 'synthetic', kind: 'context', blocks: [...input.context] });
  }
  if (input.history?.length && !logged.length && loaded.summary === undefined) {
    entries.push({ type: 'synthetic', kind: 'history', messages: [...input.history] });
  }
  entries.push({ type: 'user', content: [{ type: 'text', text: input.text }] });
  return entries;
}

/** The session as this turn's model reads it, with `next` messages after the stored ones. */
export const turnPrompt = (loaded: LoadedHistory, target: ReplayTarget, next: StoredMessage[]) => [
  ...summaryMessages(loaded.summary),
  ...replayMessages([...loaded.messages, ...next], target),
];
