import { and, asc, desc, eq, gte, isNotNull, notInArray, sql } from 'drizzle-orm';
import type {
  Compaction,
  ModelMessage,
  SessionHistory,
  SessionStart,
  TokenUsage,
} from '@wisp/agent/engine';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { agentCompactions, agentMessages, agentSessions, chatInstanceState } from '../db/schema.ts';

/** How `agent_messages.message` is encoded: an AI SDK 7 `ModelMessage` as JSON. */
export const AGENT_MESSAGE_FORMAT = 'ai-sdk-7';

type Transaction = Parameters<Parameters<ApplicationDatabase['transaction']>[0]>[0];

/**
 * Each agent session's model-facing history, in the application database
 * next to the visible conversation. Messages are kept for the life of the
 * session: a compaction is a record of where the model's reading starts and
 * what summarizes the messages before it.
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

  /** Starts the session on its chat's first turn; later turns record their model. */
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
        .onConflictDoUpdate({
          target: agentSessions.id,
          set: { model: start.model, updatedAt: now },
        })
        .run();
    });
  }

  /** The latest compaction's summary and the messages from where it keeps them. */
  async load(session: string): Promise<SessionHistory> {
    await this.database.initialize();
    const orm = this.database.orm;
    const latest = orm
      .select({ keptFrom: agentCompactions.keptFrom, summary: agentCompactions.summary })
      .from(agentCompactions)
      .where(eq(agentCompactions.sessionId, session))
      .orderBy(desc(agentCompactions.keptFrom))
      .limit(1)
      .get();
    const start = latest?.keptFrom ?? 0;
    const messages = orm
      .select({ message: agentMessages.message, model: agentMessages.model })
      .from(agentMessages)
      .where(and(eq(agentMessages.sessionId, session), gte(agentMessages.position, start)))
      .orderBy(asc(agentMessages.position))
      .all()
      .map((row) => ({ message: JSON.parse(row.message) as ModelMessage, model: row.model }));
    return { summary: latest?.summary ?? undefined, messages, start };
  }

  /** Stores a turn's messages from position `from` on, replacing what a retried turn left there. */
  async append(session: string, from: number, messages: ModelMessage[], model: string) {
    await this.database.transaction((db) => {
      db.delete(agentMessages)
        .where(and(eq(agentMessages.sessionId, session), gte(agentMessages.position, from)))
        .run();
      this.insert(db, session, from, messages, model);
    });
  }

  /** Records a compaction; the messages it summarizes stay stored. */
  async compact(session: string, compaction: Compaction) {
    await this.database.transaction((db) => {
      db.insert(agentCompactions)
        .values({
          sessionId: session,
          keptFrom: compaction.keptFrom,
          summary: compaction.summary ?? null,
          model: compaction.model,
          createdAt: this.now(),
        })
        .onConflictDoUpdate({
          target: [agentCompactions.sessionId, agentCompactions.keptFrom],
          set: {
            summary: compaction.summary ?? null,
            model: compaction.model,
            createdAt: this.now(),
          },
        })
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

  /** Forgets a session, with its messages and compactions. */
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

  private insert(
    db: Transaction,
    session: string,
    from: number,
    messages: ModelMessage[],
    model: string,
  ) {
    if (!messages.length) return;
    const createdAt = this.now();
    db.insert(agentMessages)
      .values(
        messages.map((message, index) => ({
          sessionId: session,
          position: from + index,
          role: message.role,
          model,
          createdAt,
          message: JSON.stringify(message),
        })),
      )
      .run();
  }
}
