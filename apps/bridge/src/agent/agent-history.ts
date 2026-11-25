import { and, asc, eq, gte, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { ModelMessage, SessionStart, TokenUsage } from '@wisp/agent/engine';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { agentMessages, agentSessions, chatInstanceState } from '../db/schema.ts';

/** How `agent_messages.message` is encoded: an AI SDK 7 `ModelMessage` as JSON. */
export const AGENT_MESSAGE_FORMAT = 'ai-sdk-7';

/**
 * Each agent session's model-facing history, in the application database
 * next to the visible conversation. The agent sends it in full on every turn,
 * so a provider sees a stable prefix and can reuse its cache.
 */
export class AgentHistory {
  readonly database: ApplicationDatabase;
  private readonly wispVersion: string;
  private readonly now: () => number;
  constructor(
    database: ApplicationDatabase,
    options: { wispVersion: string; now?: () => number } = { wispVersion: 'unknown' },
  ) {
    this.database = database;
    this.wispVersion = options.wispVersion;
    this.now = options.now ?? Date.now;
  }

  /** Starts the session on its chat's first turn, or marks a resumed one as used. */
  async begin(session: string, start: SessionStart) {
    await this.database.transaction((db) => {
      const now = this.now();
      db.insert(agentSessions)
        .values({
          id: session,
          chatId: start.chatId,
          model: start.model,
          format: AGENT_MESSAGE_FORMAT,
          wispVersion: this.wispVersion,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({ target: agentSessions.id, set: { updatedAt: now } })
        .run();
    });
  }

  async load(session: string): Promise<ModelMessage[]> {
    await this.database.initialize();
    return this.database.orm
      .select({ message: agentMessages.message })
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, session))
      .orderBy(asc(agentMessages.position))
      .all()
      .map((row) => JSON.parse(row.message) as ModelMessage);
  }

  /** Appends a turn's messages after the `from` messages already stored. */
  async append(session: string, from: number, messages: ModelMessage[]) {
    await this.database.transaction((db) => this.write(db, session, from, messages));
  }

  /** Replaces the whole history with a compacted one. */
  async replace(session: string, messages: ModelMessage[]) {
    await this.database.transaction((db) => {
      this.write(db, session, 0, messages);
      db.update(agentSessions)
        .set({ compactedAt: this.now() })
        .where(eq(agentSessions.id, session))
        .run();
    });
  }

  /** Adds one model call's reported tokens to the session's totals. */
  async addUsage(session: string, usage: TokenUsage) {
    await this.database.transaction((db) => {
      db.update(agentSessions)
        .set({
          tokensInput: sql`${agentSessions.tokensInput} + ${usage.inputTokens}`,
          tokensOutput: sql`${agentSessions.tokensOutput} + ${usage.outputTokens}`,
          tokensReasoning: sql`${agentSessions.tokensReasoning} + ${usage.reasoningTokens ?? 0}`,
          tokensCacheRead: sql`${agentSessions.tokensCacheRead} + ${usage.cacheReadTokens ?? 0}`,
          tokensCacheWrite: sql`${agentSessions.tokensCacheWrite} + ${usage.cacheWriteTokens ?? 0}`,
        })
        .where(eq(agentSessions.id, session))
        .run();
    });
  }

  /** Forgets a session; its messages go with it. */
  async delete(session: string) {
    await this.database.transaction((db) => {
      db.delete(agentSessions).where(eq(agentSessions.id, session)).run();
    });
  }

  /**
   * Removes every session no saved conversation refers to: ones whose chat was
   * deleted or never saved, and ones a failed end left behind. Run it before
   * turns start, because a new session is saved with its chat later.
   */
  async prune() {
    await this.database.transaction((db) => {
      db.delete(agentSessions)
        .where(
          notInArray(
            agentSessions.id,
            db
              .select({ session: chatInstanceState.agentSession })
              .from(chatInstanceState)
              .where(isNotNull(chatInstanceState.agentSession)),
          ),
        )
        .run();
    });
  }

  private write(
    db: Parameters<Parameters<ApplicationDatabase['transaction']>[0]>[0],
    session: string,
    from: number,
    messages: ModelMessage[],
  ) {
    db.delete(agentMessages)
      .where(and(eq(agentMessages.sessionId, session), gte(agentMessages.position, from)))
      .run();
    if (messages.length) {
      const createdAt = this.now();
      db.insert(agentMessages)
        .values(
          messages.map((message, index) => ({
            sessionId: session,
            position: from + index,
            role: message.role,
            createdAt,
            message: JSON.stringify(message),
          })),
        )
        .run();
    }
  }
}
