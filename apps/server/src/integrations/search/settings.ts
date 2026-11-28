// @effect-migrated
import { Effect, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { searchConfig } from '@wisp/protocol/search';
import * as JsonFile from '#/platform/json-file';

export type SearchConfig = typeof searchConfig.Type;

/** The saved settings could not be read or written; `message` is shown as is. */
export class SearchSettingsError extends Schema.TaggedError<SearchSettingsError>()(
  'SearchSettingsError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

// Keeps what Node reported, as the player saw before.
const fileFailed = (error: PlatformError) =>
  new SearchSettingsError({
    message: Predicate.isError(error.cause) ? error.cause.message : error.message,
    cause: error,
  });

/** The saved settings in `search.json`; a missing file is the default, Auto. */
export const readSettings = (file: string) =>
  JsonFile.read(file, searchConfig, (): SearchConfig => ({ provider: 'auto' })).pipe(
    Effect.catchTags({
      JsonFileError: (error) =>
        Effect.fail(new SearchSettingsError({ message: error.message, cause: error })),
      PlatformError: (error) => Effect.fail(fileFailed(error)),
    }),
  );

/** Replaces the saved settings, in the same indented JSON as before. */
export const writeSettings = (file: string, config: SearchConfig) =>
  JsonFile.write(file, searchConfig, config).pipe(
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.fail(
          new SearchSettingsError({ message: 'Cannot save the search settings.', cause }),
        ),
      PlatformError: (error) => Effect.fail(fileFailed(error)),
    }),
  );
