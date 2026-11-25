import type { ModelMessage } from 'ai';
import { Context, Effect, Layer, Schema } from 'effect';
import type { StoredMessage } from './replay.ts';

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

/** A stored message and its place in the session's log. */
export interface LoggedMessage extends StoredMessage {
  seq: number;
}

/** What the model reads of a session: the latest compaction's summary and the messages it keeps. */
export interface LoadedHistory {
  summary?: string;
  /** The messages from the latest compaction's `keptFrom` on, oldest first. */
  messages: LoggedMessage[];
}

/** A compaction: messages before `keptFrom` are summarized; no summary when summarizing failed. */
export interface Compaction {
  keptFrom: number;
  summary?: string;
  model: string;
}

/**
 * Where each session's log is kept (the bridge's SQLite). The log only grows:
 * nothing is replaced, and compaction deletes nothing.
 */
export interface HistoryStore {
  /** Called at the start of every turn; the first one starts the session. */
  begin(session: string, start: SessionStart): Promise<void>;
  load(session: string): Promise<LoadedHistory>;
  /** Logs messages after the last entry. */
  append(session: string, messages: readonly ModelMessage[], model: string): Promise<void>;
  /** Logs a compaction after the last entry. */
  compact(session: string, compaction: Compaction): Promise<void>;
  addUsage(session: string, usage: TokenUsage): Promise<void>;
  delete(session: string): Promise<void>;
}

/** Reading or writing a session's log failed. */
export class HistoryError extends Schema.TaggedError<HistoryError>()('HistoryError', {
  operation: Schema.Literals(['begin', 'load', 'append', 'compact', 'addUsage', 'delete']),
  cause: Schema.Defect(),
}) {}

/** A session's model history, as the engine reads and writes it. */
export class SessionHistory extends Context.Service<
  SessionHistory,
  {
    readonly begin: (session: string, start: SessionStart) => Effect.Effect<void, HistoryError>;
    readonly load: (session: string) => Effect.Effect<LoadedHistory, HistoryError>;
    readonly append: (
      session: string,
      messages: readonly ModelMessage[],
      model: string,
    ) => Effect.Effect<void, HistoryError>;
    readonly compact: (
      session: string,
      compaction: Compaction,
    ) => Effect.Effect<void, HistoryError>;
    readonly addUsage: (session: string, usage: TokenUsage) => Effect.Effect<void, HistoryError>;
    readonly delete: (session: string) => Effect.Effect<void, HistoryError>;
  }
>()('@wisp/agent/SessionHistory') {
  /** The service over a store, such as the bridge's SQLite log. */
  static readonly layer = (store: HistoryStore) =>
    Layer.succeed(
      SessionHistory,
      SessionHistory.of({
        begin: (session, start) => call('begin', () => store.begin(session, start)),
        load: (session) => call('load', () => store.load(session)),
        append: (session, messages, model) =>
          messages.length
            ? call('append', () => store.append(session, messages, model))
            : Effect.void,
        compact: (session, compaction) => call('compact', () => store.compact(session, compaction)),
        addUsage: (session, usage) => call('addUsage', () => store.addUsage(session, usage)),
        delete: (session) => call('delete', () => store.delete(session)),
      }),
    );
}

/** A store call, failing with a HistoryError for its operation. */
const call = <A>(operation: HistoryError['operation'], run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new HistoryError({ operation, cause }),
  }).pipe(Effect.withSpan('SessionHistory.' + operation));
