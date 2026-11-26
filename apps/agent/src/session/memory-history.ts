import { Effect } from 'effect';
import type {
  HistoryStoreError,
  HistoryStore,
  SessionStart,
  StoredRow,
  TokenUsage,
} from './session-history.ts';
import type { Entry } from './session-message.ts';

interface Logged {
  entry: Entry;
  model: string;
}

/**
 * A session log kept in memory, with the bridge store's rules: entries are
 * only appended, as copies, and a load reads from the latest compaction's
 * `keptFrom` on. For tests and evals.
 */
export class MemoryHistory implements HistoryStore {
  readonly sessions = new Map<
    string,
    SessionStart & { inputTokens: number; outputTokens: number }
  >();
  private readonly logs = new Map<string, Logged[]>();

  begin(session: string, start: SessionStart) {
    return Effect.sync(() => {
      const known = this.sessions.get(session);
      this.sessions.set(
        session,
        known ? { ...known, model: start.model } : { ...start, inputTokens: 0, outputTokens: 0 },
      );
    });
  }

  load(session: string) {
    return Effect.sync(() => {
      const log = this.logs.get(session) ?? [];
      const latest = log.findLast(({ entry }) => entry.type === 'compaction')?.entry;
      const keptFrom = latest?.type === 'compaction' ? latest.keptFrom : 0;
      const rows = log.flatMap(({ entry, model }, seq): StoredRow[] =>
        entry.type !== 'compaction' && seq >= keptFrom
          ? [{ seq, model, data: structuredClone(entry) }]
          : [],
      );
      return latest?.type === 'compaction' && latest.summary !== undefined
        ? { summary: latest.summary, rows }
        : { rows };
    });
  }

  append(
    session: string,
    entries: readonly Entry[],
    model: string,
  ): Effect.Effect<void, HistoryStoreError> {
    return Effect.sync(() => {
      const log = this.logs.get(session) ?? [];
      for (const entry of entries) {
        log.push({ entry: structuredClone(entry), model });
      }
      this.logs.set(session, log);
    });
  }

  addUsage(session: string, usage: TokenUsage) {
    return Effect.sync(() => {
      const totals = this.sessions.get(session);
      if (totals) {
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
      }
    });
  }

  delete(session: string) {
    return Effect.sync(() => {
      this.logs.delete(session);
      this.sessions.delete(session);
    });
  }

  /** Every entry of a session's log, compactions included, with its model. */
  entries(session: string): readonly Logged[] {
    return this.logs.get(session) ?? [];
  }

  has(session: string) {
    return this.logs.has(session);
  }
}
