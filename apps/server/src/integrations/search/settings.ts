// @effect-migrated
import { Effect, FileSystem, Path, Schedule, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';
import type { PlatformError } from 'effect/PlatformError';
import { searchConfig } from '@wisp/protocol/search';

export type SearchConfig = typeof searchConfig.Type;

/** `search.json`, written as indented JSON like the other settings files. */
const SettingsJson = Schema.fromJsonString(searchConfig, { space: 2 });

/** The saved settings could not be read or written; `message` is shown as is. */
export class SearchSettingsError extends Schema.TaggedError<SearchSettingsError>()(
  'SearchSettingsError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

// Keeps what the file system reported, as the player saw before.
const fileFailed = (error: PlatformError) =>
  new SearchSettingsError({ message: error.message, cause: error });

/** The saved settings; a missing file is the default, Auto. */
export const readSettings = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.undefined),
    Effect.mapError(fileFailed),
  );
  if (text === undefined) {
    return { provider: 'auto' } satisfies SearchConfig;
  }
  return yield* Schema.decodeEffect(SettingsJson)(text).pipe(
    Effect.mapError(
      (cause) =>
        new SearchSettingsError({
          message: `Cannot load ${path.basename(file)}; the original file was preserved.`,
          cause,
        }),
    ),
  );
});

/**
 * Replaces the saved settings through an owner-only temporary file, retrying
 * the rename briefly while another process holds the file.
 */
export const writeSettings = Effect.fnUntraced(function* (file: string, config: SearchConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const text = yield* Schema.encodeEffect(SettingsJson)(config).pipe(
    Effect.mapError(
      (cause) => new SearchSettingsError({ message: 'Cannot save the search settings.', cause }),
    ),
  );
  const temporary = file + '.' + (yield* random.uuidV4()) + '.tmp';
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(temporary, text, { mode: 0o600 });
    yield* fs.rename(temporary, file).pipe(
      Effect.retry({
        times: 5,
        schedule: Schedule.spaced('30 millis'),
        while: (error) => error.reason._tag === 'PermissionDenied' || error.reason._tag === 'Busy',
      }),
    );
  }).pipe(
    Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
    Effect.mapError(fileFailed),
  );
});
