// @effect-migrated allow=effectPromises: adapter around @wisp/db's snapshot copy, ApplicationDatabase and ChatStore, which are not on Effect yet
import { copyDatabaseSnapshot } from '@wisp/db/application-file';
import { Effect, Schema } from 'effect';
import { ApplicationDatabase } from '../application-database.ts';
import { ChatStore, conversationInstanceId } from '../chat/chat-store.ts';

/** Copying the previous database or preparing the imported one failed. */
export class DesktopStorageError extends Schema.TaggedError<DesktopStorageError>()(
  'DesktopStorageError',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const attempt = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new DesktopStorageError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

/**
 * Copies the database at `source` to `destination` with SQLite's backup API,
 * so committed WAL pages are included, and publishes it without replacing a
 * file already there.
 */
export const copySnapshot = Effect.fn('DesktopStorage.copySnapshot')(function* (
  source: string,
  destination: string,
) {
  yield* attempt(() => copyDatabaseSnapshot(source, destination));
});

export interface PrepareOptions {
  /** The imported database file. */
  readonly file: string;
  /**
   * The previous installation's runtime folder, when its database was copied:
   * the conversations keep that installation's state and drop their model
   * sessions.
   */
  readonly copiedFrom: string | undefined;
}

/**
 * Opens the imported database, detaches the copied conversations from their
 * model sessions and imports the legacy JSON routines, panels and memory.
 */
export const prepareDatabase = Effect.fn('DesktopStorage.prepareDatabase')(function* ({
  file,
  copiedFrom,
}: PrepareOptions) {
  yield* Effect.acquireUseRelease(
    Effect.sync(() => new ApplicationDatabase(file)),
    (database) =>
      Effect.gen(function* () {
        if (copiedFrom !== undefined) {
          const inheritInstanceId = conversationInstanceId(copiedFrom);
          yield* Effect.acquireUseRelease(
            Effect.sync(() => new ChatStore(database, () => {}, undefined, { inheritInstanceId })),
            (store) =>
              Effect.gen(function* () {
                const chats = yield* attempt(() => store.load());
                // Model histories start over; the visible conversations carry over.
                const detached = chats.map(({ agentSession: _, ...chat }) => chat);
                yield* attempt(() => store.flush(detached));
              }),
            (store) => attempt(() => store.close()).pipe(Effect.orDie),
          );
        }
        yield* attempt(() => database.initializeProducts());
      }),
    (database) => attempt(() => database.close()).pipe(Effect.orDie),
  );
});
