import { and, asc, desc, eq, gte, isNotNull, max, ne, notInArray, sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { FORMAT as SESSION_FORMAT, type Entry } from '@wisp/agent/session-message';
import {
  HistoryError,
  HistoryStore,
  type SessionStart,
  type StoredRow,
  type TokenUsage,
} from '@wisp/agent/session-history';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { ApplicationDatabase } from '../application-database.ts';
import { agentEntries, agentSessions, chatInstanceState } from '@wisp/db/schema';

/** How entries' `data` is encoded: Wisp's session format (`@wisp/agent/session-message`). */
export const AGENT_MESSAGE_FORMAT = SESSION_FORMAT;

/** What the store reads of a compaction entry; the engine owns the rest of the format. */
const compactionData = z.object({ keptFrom: z.number(), summary: z.string().optional() });

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
  async load(session: string): Promise<{ summary?: string; rows: StoredRow[] }> {
    await this.database.initialize();
    const orm = this.database.orm;
    const latest = orm
      .select({ data: agentEntries.data })
      .from(agentEntries)
      .where(and(eq(agentEntries.sessionId, session), eq(agentEntries.type, 'compaction')))
      .orderBy(desc(agentEntries.seq))
      .limit(1)
      .get();
    const compaction = latest ? compactionData.parse(JSON.parse(latest.data)) : undefined;
    const rows = orm
      .select({ seq: agentEntries.seq, data: agentEntries.data, model: agentEntries.model })
      .from(agentEntries)
      .where(
        and(
          eq(agentEntries.sessionId, session),
          ne(agentEntries.type, 'compaction'),
          gte(agentEntries.seq, compaction?.keptFrom ?? 0),
        ),
      )
      .orderBy(asc(agentEntries.seq))
      .all()
      .map((row): StoredRow => ({ seq: row.seq, model: row.model, data: JSON.parse(row.data) }));
    return compaction?.summary === undefined ? { rows } : { summary: compaction.summary, rows };
  }

  /**
   * Logs entries after the last one. The log only grows: a compaction or
   * another write that lands in between keeps its place instead of being
   * overwritten.
   */
  async append(session: string, entries: readonly Entry[], model: string) {
    if (!entries.length) return;
    await this.database.transaction((db) => {
      const from = this.next(db, session);
      const createdAt = this.now();
      db.insert(agentEntries)
        .values(
          entries.map((entry, index) => ({
            sessionId: session,
            seq: from + index,
            id: uuidv7({ msecs: createdAt }),
            type: entry.type,
            model,
            createdAt,
            data: JSON.stringify(entry),
          })),
        )
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
  private next(db: Transaction, session: string) {
    const last = db
      .select({ seq: max(agentEntries.seq) })
      .from(agentEntries)
      .where(eq(agentEntries.sessionId, session))
      .get();
    return last?.seq === null || last?.seq === undefined ? 0 : last.seq + 1;
  }
}

// Adapter for the agent: its `HistoryStore` over this Promise-based log. Remove
// it when the log moves to `SqlDatabase` with the other repositories.
const call = <A>(operation: HistoryError['operation'], run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new HistoryError({ operation, cause }) });

/** The agent's `HistoryStore` over `history`; a rejected call fails with a `HistoryError`. */
export const historyStoreLayer = (history: AgentHistory) =>
  Layer.succeed(
    HistoryStore,
    HistoryStore.of({
      begin: (session, start) => call('begin', () => history.begin(session, start)),
      load: (session) => call('load', () => history.load(session)),
      append: (session, entries, model) =>
        call('append', () => history.append(session, entries, model)),
      addUsage: (session, usage) => call('addUsage', () => history.addUsage(session, usage)),
      delete: (session) => call('delete', () => history.delete(session)),
    }),
  );
