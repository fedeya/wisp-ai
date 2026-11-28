// @effect-migrated
import { Effect, FileSystem, Option, Path, Schedule, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { SecureRandom } from 'effect/crypto';

/** A JSON file did not decode with its schema; the file was left as it was. */
export class JsonFileError extends Schema.TaggedError<JsonFileError>()('JsonFileError', {
  file: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Like Node's `readFile(file, 'utf8')`: a byte order mark stays in the text. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Reads `file` as JSON decoded with `schema`, or `fallback()` when the file
 * does not exist. Content that does not decode fails with a `JsonFileError`;
 * any other read failure fails as is.
 */
export const read = Effect.fn('JsonFile.read')(function* <S extends Schema.Constraint>(
  file: string,
  schema: S,
  fallback: () => S['Type'],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFile(file).pipe(
    Effect.map((bytes) => Option.some(utf8.decode(bytes))),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
  );
  if (Option.isNone(text)) {
    return fallback();
  }
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text.value).pipe(
    Effect.mapError(
      (cause) =>
        new JsonFileError({
          file,
          message: `Cannot load ${path.basename(file)}; the original file was preserved.`,
          cause,
        }),
    ),
  );
});

/** Windows reports a file another process holds open (an editor, antivirus) as one of these. */
const isLocked = (error: PlatformError) =>
  error.reason._tag === 'PermissionDenied' || error.reason._tag === 'Busy';

/**
 * Writes `value`, encoded with `schema`, to `file` as JSON indented by two
 * spaces. The text goes to an owner-only temporary file next to it that
 * replaces `file` in one rename, so readers see the old file or the new one,
 * never part of it. A rename that finds `file` locked is tried 5 more times,
 * 30 ms apart; the temporary file is removed however the write ends.
 */
export const write = Effect.fn('JsonFile.write')(function* <S extends Schema.Constraint>(
  file: string,
  schema: S,
  value: S['Type'],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const temporary = `${file}.${yield* random.uuidV4()}.tmp`;
  yield* Effect.gen(function* () {
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema, { space: 2 }))(value);
    yield* fs.writeFileString(temporary, text, { mode: 0o600 });
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced('30 millis'), while: isLocked }));
  }).pipe(Effect.onExit(() => fs.remove(temporary, { force: true })));
});
