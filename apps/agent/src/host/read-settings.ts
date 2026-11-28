// @effect-migrated
import { Effect, Schema, type FileSystem } from 'effect';
import { HostError } from '../execution/engine-errors.ts';

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** An absent settings file uses defaults; malformed JSON and other I/O errors fail. */
export const readSettings = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  file?: () => string | undefined,
) {
  const path = yield* Effect.try({
    try: () => file?.(),
    catch: (cause) => new HostError({ cause }),
  });
  if (!path) return undefined;
  const text = yield* fs.readFileString(path).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)),
    Effect.mapError((cause) => new HostError({ cause })),
  );
  if (text === undefined) return undefined;
  return yield* decodeJson(text).pipe(Effect.mapError((cause) => new HostError({ cause })));
});
