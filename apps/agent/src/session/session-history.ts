// @effect-migrated
import { Context, Effect, Layer, Schema } from 'effect';
import { Message, type Entry, type StoredMessage } from './session-message.ts';

/** The chat a session belongs to and the model it runs on. */
export interface SessionStart {
  chatId: string;
  model: string;
}

/** Tokens one model call reported. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** A logged message and its place in the session's log. */
export interface LoggedMessage extends StoredMessage {
  seq: number;
}

/** What the model reads of a session: the latest compaction's summary and the messages it keeps. */
export interface LoadedHistory {
  summary?: string;
  /** The messages from the latest compaction's `keptFrom` on, oldest first. */
  messages: LoggedMessage[];
}

/** A row of the log as the store returns it; `data` is decoded by the engine. */
export interface StoredRow {
  seq: number;
  model: string;
  data: unknown;
}

/** Reading or writing a session's log failed. */
export class HistoryError extends Schema.TaggedError<HistoryError>()('HistoryError', {
  operation: Schema.Literals(['begin', 'load', 'append', 'addUsage', 'delete']),
  cause: Schema.Defect(),
}) {}

/**
 * Where each session's log is kept (the bridge's SQLite). The log only grows:
 * nothing is replaced, and compaction deletes nothing. The store keeps entries
 * as JSON and reads only what it needs to find the latest compaction. Each
 * operation fails with a `HistoryError` naming it.
 */
export class HistoryStore extends Context.Service<
  HistoryStore,
  {
    /** Called at the start of every turn; the first one starts the session. */
    readonly begin: (session: string, start: SessionStart) => Effect.Effect<void, HistoryError>;
    /** The latest compaction's summary and the message rows from its `keptFrom` on. */
    readonly load: (
      session: string,
    ) => Effect.Effect<{ summary?: string; rows: StoredRow[] }, HistoryError>;
    /** Logs entries after the last one. */
    readonly append: (
      session: string,
      entries: readonly Entry[],
      model: string,
    ) => Effect.Effect<void, HistoryError>;
    readonly addUsage: (session: string, usage: TokenUsage) => Effect.Effect<void, HistoryError>;
    readonly delete: (session: string) => Effect.Effect<void, HistoryError>;
  }
>()('@wisp/agent/HistoryStore') {}

/** A session's log, as the engine reads and writes it. */
export class Service extends Context.Service<
  Service,
  {
    readonly begin: (session: string, start: SessionStart) => Effect.Effect<void, HistoryError>;
    readonly load: (session: string) => Effect.Effect<LoadedHistory, HistoryError>;
    readonly append: (
      session: string,
      entries: readonly Entry[],
      model: string,
    ) => Effect.Effect<void, HistoryError>;
    readonly addUsage: (session: string, usage: TokenUsage) => Effect.Effect<void, HistoryError>;
    readonly delete: (session: string) => Effect.Effect<void, HistoryError>;
  }
>()('@wisp/agent/SessionHistory') {}

const decodeMessage = Schema.decodeUnknownEffect(Message);

/** The service over the session's store, such as the server's SQLite log. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* HistoryStore;
    return Service.of({
      begin: Effect.fn('SessionHistory.begin')(function* (session: string, start: SessionStart) {
        yield* store.begin(session, start);
      }),
      load: Effect.fn('SessionHistory.load')(function* (session: string) {
        const { summary, rows } = yield* store.load(session);
        // Rows that do not decode fail the load rather than replay a broken history.
        const messages = yield* Effect.forEach(rows, (row) =>
          decodeMessage(row.data).pipe(
            Effect.map((message): LoggedMessage => ({ seq: row.seq, model: row.model, message })),
          ),
        ).pipe(Effect.mapError((cause) => new HistoryError({ operation: 'load', cause })));
        const loaded: LoadedHistory = { messages };
        if (summary !== undefined) loaded.summary = summary;
        return loaded;
      }),
      append: Effect.fn('SessionHistory.append')(function* (
        session: string,
        entries: readonly Entry[],
        model: string,
      ) {
        if (entries.length) yield* store.append(session, entries, model);
      }),
      addUsage: Effect.fn('SessionHistory.addUsage')(function* (
        session: string,
        usage: TokenUsage,
      ) {
        yield* store.addUsage(session, usage);
      }),
      delete: Effect.fn('SessionHistory.delete')(function* (session: string) {
        yield* store.delete(session);
      }),
    });
  }),
);
