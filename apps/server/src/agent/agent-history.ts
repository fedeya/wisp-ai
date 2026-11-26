import { and, asc, desc, eq, gte, isNotNull, max, ne, notInArray, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { FORMAT as SESSION_FORMAT, type Entry } from '@wisp/agent/session-message';
import {
  HistoryStoreError,
  type HistoryStore,
  type SessionStart,
  type StoredRow,
  type TokenUsage,
} from '@wisp/agent/session-history';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { SqlDatabase, type SqlExecutor } from '@wisp/db/sql-database';
import { agentEntries, agentSessions, chatInstanceState } from '@wisp/db/schema';

/** How entries' `data` is encoded: Wisp's session format (`@wisp/agent/session-message`). */
export const AGENT_MESSAGE_FORMAT = SESSION_FORMAT;

/** What the store reads of a compaction entry; the engine owns the rest of the format. */
const compactionData = z.object({ keptFrom: z.number(), summary: z.string().optional() });

/** The position after the session's last log entry. */
const nextSeq = (db: SqlExecutor, session: string) =>
  db
    .select({ seq: max(agentEntries.seq) })
    .from(agentEntries)
    .where(eq(agentEntries.sessionId, session))
    .get()
    .pipe(Effect.map((last) => (last?.seq === null || last?.seq === undefined ? 0 : last.seq + 1)));

interface AgentHistoryOptions {
  wispVersion: string;
  now?: () => number;
}

/**
 * Each agent session's model-facing history, as one ordered log in the
 * application database next to the visible conversation. Messages are kept
 * for the life of the session: a compaction is a log entry saying where the
 * model's reading starts and what summarizes the messages before it.
 */
export class AgentHistory extends Context.Service<
  AgentHistory,
  HistoryStore & {
    /**
     * Removes every session no saved conversation refers to: ones whose chat was
     * deleted or never saved, and ones a failed end left behind. Run it before
     * turns start, because a new session is saved with its chat later.
     */
    readonly prune: () => Effect.Effect<void, HistoryStoreError>;
  }
>()('@wisp/server/AgentHistory') {}

/** Every failure, from SQLite or a damaged entry, reaches the engine as a store error. */
const historyErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchDefect((cause) => Effect.fail(cause)),
    Effect.mapError((cause) => new HistoryStoreError({ cause })),
  );

export const layer = ({ wispVersion, now = Date.now }: AgentHistoryOptions) =>
  Layer.effect(
    AgentHistory,
    Effect.gen(function* () {
      const { db } = yield* SqlDatabase;
      /** Starts the session on its chat's first turn; later turns record their model. */
      const begin = Effect.fn('AgentHistory.begin')(function* (
        session: string,
        start: SessionStart,
      ) {
        const at = now();
        yield* db
          .insert(agentSessions)
          .values({
            id: session,
            chatId: start.chatId,
            model: start.model,
            format: AGENT_MESSAGE_FORMAT,
            wispVersion,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoUpdate({
            target: agentSessions.id,
            set: { model: start.model, updatedAt: at },
          })
          .run();
      }, historyErrors);

      /** The latest compaction's summary and the messages from where it keeps them. */
      const load = Effect.fn('AgentHistory.load')(function* (session: string) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const latest = yield* tx
              .select({ data: agentEntries.data })
              .from(agentEntries)
              .where(and(eq(agentEntries.sessionId, session), eq(agentEntries.type, 'compaction')))
              .orderBy(desc(agentEntries.seq))
              .limit(1)
              .get();
            const compaction = latest ? compactionData.parse(JSON.parse(latest.data)) : undefined;
            const rows = (yield* tx
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
              .all()).map((row): StoredRow => ({
              seq: row.seq,
              model: row.model,
              data: JSON.parse(row.data),
            }));
            return compaction?.summary === undefined
              ? { rows }
              : { summary: compaction.summary, rows };
          }),
        );
      }, historyErrors);

      /**
       * Logs entries after the last one. The log only grows: a compaction or
       * another write that lands in between keeps its place instead of being
       * overwritten.
       */
      const append = Effect.fn('AgentHistory.append')(function* (
        session: string,
        entries: readonly Entry[],
        model: string,
      ) {
        if (!entries.length) return;
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const from = yield* nextSeq(tx, session);
            const createdAt = now();
            yield* tx
              .insert(agentEntries)
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
          }),
        );
      }, historyErrors);

      /** Adds one model call's reported tokens to the session's totals. */
      const addUsage = Effect.fn('AgentHistory.addUsage')(function* (
        session: string,
        usage: TokenUsage,
      ) {
        yield* db
          .update(agentSessions)
          .set({
            tokensInput: sql`${agentSessions.tokensInput} + ${usage.inputTokens}`,
            tokensOutput: sql`${agentSessions.tokensOutput} + ${usage.outputTokens}`,
            tokensReasoning: sql`${agentSessions.tokensReasoning} + ${usage.reasoningTokens ?? 0}`,
            tokensCacheRead: sql`${agentSessions.tokensCacheRead} + ${usage.cacheReadTokens ?? 0}`,
            tokensCacheWrite: sql`${agentSessions.tokensCacheWrite} + ${usage.cacheWriteTokens ?? 0}`,
          })
          .where(eq(agentSessions.id, session))
          .run();
      }, historyErrors);

      /** Forgets a session and its log. */
      const remove = Effect.fn('AgentHistory.delete')(function* (session: string) {
        yield* db.delete(agentSessions).where(eq(agentSessions.id, session)).run();
      }, historyErrors);

      /**
       * Removes every session no saved conversation refers to: ones whose chat was
       * deleted or never saved, and ones a failed end left behind. Run it before
       * turns start, because a new session is saved with its chat later.
       */
      const prune = Effect.fn('AgentHistory.prune')(function* () {
        yield* db
          .delete(agentSessions)
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
      }, historyErrors);

      return AgentHistory.of({ begin, load, append, addUsage, delete: remove, prune });
    }),
  );
