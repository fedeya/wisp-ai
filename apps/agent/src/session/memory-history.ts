// @effect-migrated
import { Context, Effect, Layer, Ref } from 'effect';
import { HistoryStore, type SessionStart, type StoredRow } from './session-history.ts';
import type { Entry } from './session-message.ts';

/** An entry of a session's log and the model it was logged for. */
export interface Logged {
  readonly entry: Entry;
  readonly model: string;
}

/** A session the log knows: the chat and model it began with, and its token totals. */
export interface SessionTotals extends SessionStart {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface Log {
  readonly sessions: ReadonlyMap<string, SessionTotals>;
  readonly entries: ReadonlyMap<string, readonly Logged[]>;
}

/**
 * A session log kept in memory, with the bridge store's rules: entries are
 * only appended, as copies, and a load reads from the latest compaction's
 * `keptFrom` on. For tests and evals, which also read what it holds.
 */
export class Service extends Context.Service<
  Service,
  HistoryStore['Service'] & {
    /** Every entry of a session's log, compactions included, with its model. */
    readonly entries: (session: string) => Effect.Effect<readonly Logged[]>;
    readonly session: (session: string) => Effect.Effect<SessionTotals | undefined>;
    readonly has: (session: string) => Effect.Effect<boolean>;
  }
>()('@wisp/agent/MemoryHistory') {}

const updated = <V>(map: ReadonlyMap<string, V>, key: string, value: V) =>
  new Map(map).set(key, value);
const without = <V>(map: ReadonlyMap<string, V>, key: string) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** An empty log. */
export const make = Effect.gen(function* () {
  const log = yield* Ref.make<Log>({ sessions: new Map(), entries: new Map() });
  const entries = (session: string) =>
    Effect.map(Ref.get(log), (state) => state.entries.get(session) ?? []);
  return Service.of({
    begin: (session, start) =>
      Ref.update(log, (state) => {
        const known = state.sessions.get(session);
        return {
          ...state,
          sessions: updated(
            state.sessions,
            session,
            known
              ? { ...known, model: start.model }
              : { ...start, inputTokens: 0, outputTokens: 0 },
          ),
        };
      }),
    load: (session) =>
      Effect.map(entries(session), (logged) => {
        const latest = logged.findLast(({ entry }) => entry.type === 'compaction')?.entry;
        const keptFrom = latest?.type === 'compaction' ? latest.keptFrom : 0;
        const rows = logged.flatMap(({ entry, model }, seq): StoredRow[] =>
          entry.type !== 'compaction' && seq >= keptFrom
            ? [{ seq, model, data: structuredClone(entry) }]
            : [],
        );
        return latest?.type === 'compaction' && latest.summary !== undefined
          ? { summary: latest.summary, rows }
          : { rows };
      }),
    append: (session, appended, model) =>
      Ref.update(log, (state) => ({
        ...state,
        entries: updated(state.entries, session, [
          ...(state.entries.get(session) ?? []),
          ...appended.map((entry) => ({ entry: structuredClone(entry), model })),
        ]),
      })),
    addUsage: (session, usage) =>
      Ref.update(log, (state) => {
        const totals = state.sessions.get(session);
        return totals
          ? {
              ...state,
              sessions: updated(state.sessions, session, {
                ...totals,
                inputTokens: totals.inputTokens + usage.inputTokens,
                outputTokens: totals.outputTokens + usage.outputTokens,
              }),
            }
          : state;
      }),
    delete: (session) =>
      Ref.update(log, (state) => ({
        sessions: without(state.sessions, session),
        entries: without(state.entries, session),
      })),
    entries,
    session: (session) => Effect.map(Ref.get(log), (state) => state.sessions.get(session)),
    has: (session) => Effect.map(Ref.get(log), (state) => state.entries.has(session)),
  });
});

/** An empty log, as the session's `HistoryStore` and as the `Service` that reads it back. */
export const layer = Layer.effectContext(
  Effect.map(make, (memory) =>
    Context.make(Service, memory).pipe(Context.add(HistoryStore, memory)),
  ),
);
