import { and, asc, desc, eq, gte, isNotNull, max, notInArray, sql } from 'drizzle-orm';
import type {
  Compaction,
  ModelMessage,
  SessionHistory,
  SessionStart,
  TokenUsage,
} from '@wisp/agent/engine';
import { uuidv7 } from '@wisp/protocol/uuid';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { agentEntries, agentSessions, chatInstanceState } from '../db/schema.ts';

/** How a message entry's `data` is encoded: an AI SDK 7 `ModelMessage` as JSON. */
export const AGENT_MESSAGE_FORMAT = 'ai-sdk-7';

type Transaction = Parameters<Parameters<ApplicationDatabase['transaction']>[0]>[0];

/**
 * Each agent session's model-facing history, as one ordered log in the
 * application database next to the visible conversation. Messages are kept
 * for the life of the session: a compaction is a log entry saying where the
 * model's reading starts and what summarizes the messages before it.
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
      .select({ data: agentEntries.data })
      .from(agentEntries)
      .where(and(eq(agentEntries.sessionId, session), eq(agentEntries.type, 'compaction')))
      .orderBy(desc(agentEntries.seq))
      .limit(1)
      .get();
    const compaction = latest
      ? (JSON.parse(latest.data) as { keptFrom: number; summary?: string })
      : undefined;
    const messages = orm
      .select({ seq: agentEntries.seq, data: agentEntries.data, model: agentEntries.model })
      .from(agentEntries)
      .where(
        and(
          eq(agentEntries.sessionId, session),
          eq(agentEntries.type, 'message'),
          gte(agentEntries.seq, compaction?.keptFrom ?? 0),
        ),
      )
      .orderBy(asc(agentEntries.seq))
      .all()
      .map((row) => ({
        seq: row.seq,
        message: JSON.parse(row.data) as ModelMessage,
        model: row.model,
      }));
    return { summary: compaction?.summary, messages, next: this.next(orm, session) };
  }

  /** Logs a turn's messages from position `from` on, replacing what a retried turn left there. */
  async append(session: string, from: number, messages: ModelMessage[], model: string) {
    await this.database.transaction((db) => {
      db.delete(agentEntries)
        .where(and(eq(agentEntries.sessionId, session), gte(agentEntries.seq, from)))
        .run();
      if (!messages.length) return;
      const createdAt = this.now();
      db.insert(agentEntries)
        .values(
          messages.map((message, index) => ({
            sessionId: session,
            seq: from + index,
            id: uuidv7(createdAt),
            type: 'message' as const,
            role: message.role,
            model,
            createdAt,
            data: JSON.stringify(message),
          })),
        )
        .run();
    });
  }

  /** Logs a compaction after the last entry; the messages it summarizes stay. */
  async compact(session: string, compaction: Compaction) {
    await this.database.transaction((db) => {
      const createdAt = this.now();
      db.insert(agentEntries)
        .values({
          sessionId: session,
          seq: this.next(db, session),
          id: uuidv7(createdAt),
          type: 'compaction',
          model: compaction.model,
          createdAt,
          data: JSON.stringify({ keptFrom: compaction.keptFrom, summary: compaction.summary }),
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

  /** Forgets a session and its log. */
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

  /** The position after the session's last log entry. */
  private next(db: Transaction | ApplicationDatabase['orm'], session: string) {
    const last = db
      .select({ seq: max(agentEntries.seq) })
      .from(agentEntries)
      .where(eq(agentEntries.sessionId, session))
      .get();
    return last?.seq === null || last?.seq === undefined ? 0 : last.seq + 1;
  }
}
