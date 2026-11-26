import { Effect, Schedule, type FileSystem, type Path } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import {
  decodeFrame,
  LAST,
  readDownlink,
  readUplink,
  replaceDownlink,
  UPLINK_KIND,
} from './mailbox.ts';
import { luaJson } from './protocol.ts';

export function addonFiles(fs: FileSystem.FileSystem, path: Path.Path, wow: string) {
  function sharedFile<T>(operation: Effect.Effect<T, PlatformError>) {
    return operation.pipe(
      Effect.retry({
        schedule: Schedule.recurs(8).pipe(
          Schedule.addDelay(({ attempt }) => Effect.succeed(4 * attempt)),
        ),
        while: (error) => ['Busy', 'PermissionDenied', 'NotFound'].includes(error.reason._tag),
      }),
    );
  }

  const read = (file: string) => sharedFile(fs.readFileString(file));
  const writeControl = Effect.fnUntraced(function* (
    file: string,
    frame: Buffer,
    isCurrent: () => boolean,
  ) {
    const original = yield* read(file);
    // An empty file is still being rewritten. Never replace a partial game write.
    if (!original.trim() || !isCurrent() || readDownlink(original)?.equals(frame)) return false;
    const uplink = readUplink(original);
    const decoded = uplink && decodeFrame(uplink);
    if (decoded?.kind === UPLINK_KIND && !(decoded.flags & LAST)) return false;

    const temporary = file + '.wisp-control.tmp';
    return yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, replaceDownlink(original, frame));
      if (!isCurrent()) return false;
      // Avoid overwriting packets and unrelated settings changed by the game.
      const latest = yield* read(file);
      if (latest !== original || !isCurrent()) return false;
      yield* sharedFile(fs.rename(temporary, file));
      return true;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === 'Success' && exit.value
          ? Effect.void
          : Effect.ignore(fs.remove(temporary, { force: true })),
      ),
    );
  });

  const payload = path.join(wow, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua');
  const writePayload = (json: string) => {
    const temporary = payload + '.tmp';
    return fs.makeDirectory(path.dirname(payload), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(temporary, luaJson(json))),
      Effect.andThen(
        fs
          .rename(temporary, payload)
          .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced(30) })),
      ),
      Effect.tapError(() => Effect.ignore(fs.remove(temporary, { force: true }))),
    );
  };

  return { read, writeControl, writePayload };
}
