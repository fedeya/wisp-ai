// @effect-migrated
import { Effect, FileSystem, Path, Schedule, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import {
  decodeFrame,
  LAST,
  readDownlink,
  readUplink,
  replaceDownlink,
  UPLINK_KIND,
} from './wire/mailbox.ts';
import { luaJson } from './wire/protocol.ts';
import { logTransportError } from './logging.ts';

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

export const make = Effect.fnUntraced(function* (wow: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) => sharedFile(fs.readFileString(file));
  const watch = (directory: string) =>
    fs
      .watch(directory)
      .pipe(Stream.filter((event) => path.basename(event.path).toLowerCase() === 'addons.txt'));

  function scan(visit: (file: string, directory: string) => Effect.Effect<void, PlatformError>) {
    const walk = (directory: string, depth: number): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        if (depth > 4) return;
        const entries = yield* fs
          .readDirectoryEntries(directory)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === 'NotFound'
                ? Effect.succeed([])
                : logTransportError(error).pipe(Effect.as([])),
            ),
          );
        for (const entry of entries) {
          const file = path.join(directory, entry.name);
          if (entry.type === 'Directory') {
            yield* walk(file, depth + 1);
          } else if (entry.name.toLowerCase() === 'addons.txt') {
            yield* visit(file, directory);
          }
        }
      });
    return walk(path.join(wow, 'WTF', 'Account'), 0);
  }

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
      // Recheck on every rename attempt: WoW can save while a retry waits.
      return yield* sharedFile(
        Effect.gen(function* () {
          if (!isCurrent()) return false;
          const latest = yield* fs.readFileString(file);
          if (latest !== original || !isCurrent()) return false;
          yield* fs.rename(temporary, file);
          return true;
        }),
      );
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === 'Success' && exit.value
          ? Effect.void
          : Effect.ignore(fs.remove(temporary, { force: true })),
      ),
    );
  });

  const payload = path.join(wow, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua');
  const writePayload = (json: string, isCurrent: () => boolean) => {
    const temporary = payload + '.tmp';
    return fs.makeDirectory(path.dirname(payload), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(temporary, luaJson(json))),
      Effect.andThen(
        Effect.suspend(() =>
          isCurrent() ? fs.rename(temporary, payload).pipe(Effect.as(true)) : Effect.succeed(false),
        ).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced(30) })),
      ),
      Effect.onExit((exit) =>
        exit._tag === 'Success' && exit.value
          ? Effect.void
          : Effect.ignore(fs.remove(temporary, { force: true })),
      ),
    );
  };

  return { read, watch, scan, writeControl, writePayload };
});

export type AddonFiles = Effect.Success<ReturnType<typeof make>>;
