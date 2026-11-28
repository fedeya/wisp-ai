// @effect-migrated
import { Clock, Effect, FileSystem, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

/** A legacy addon folder cannot be moved out of the AddOns folder safely. */
export class AddonRenameError extends Schema.TaggedError<AddonRenameError>()('AddonRenameError', {
  message: Schema.String,
}) {}

/** Like Node's `readFile(file, 'utf8')`: a byte order mark stays in the text. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

const savedVariables = /^WoWCompanion\.lua(?:\.bak)?$/;

/**
 * Copies the saves of WoWCompanion, the addon's previous name, to WispAI once
 * and renames its key binding. Existing Wisp data always wins; the original
 * saves stay available. Returns how many files it wrote.
 */
export const migrateGameSaves = Effect.fn('AddonRename.migrateGameSaves')(function* (wow: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readText = (file: string) => Effect.map(fs.readFile(file), (bytes) => utf8.decode(bytes));
  let count = 0;
  const visit = (directory: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const entries = yield* fs
        .readDirectoryEntries(directory)
        .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([])));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.type === 'Directory') {
          yield* visit(file);
        } else if (entry.type === 'File' && savedVariables.test(entry.name)) {
          const target = path.join(directory, entry.name.replace('WoWCompanion', 'WispAI'));
          if (yield* fs.exists(target)) {
            continue;
          }
          const data = (yield* readText(file)).replace(/^WoWCompanionDB\s*=/m, 'WispAIDB =');
          yield* fs.writeFileString(target, data, { flag: 'wx' });
          count++;
        } else if (entry.type === 'File' && entry.name === 'bindings-cache.wtf') {
          const data = yield* readText(file);
          const next = data.replaceAll(/\bWOWCOMPANION_INLINE\b/g, 'WISPAI_INLINE');
          if (next !== data) {
            yield* fs
              .writeFileString(file + '.before-wisp', data, { flag: 'wx' })
              .pipe(Effect.catchReason('PlatformError', 'AlreadyExists', () => Effect.void));
            yield* fs.writeFileString(file, next);
            count++;
          }
        }
      }
    });
  yield* visit(path.join(wow, 'WTF', 'Account'));
  return count;
});

const legacyAddon = /^WoWCompanion(?:_Payload|_B\d{3}|_S\d{4})?$/;

/**
 * Moves the WoWCompanion addon folders out of `Interface/AddOns` into a
 * timestamped backup next to it, so the game stops loading them.
 */
export const retireLegacyAddons = Effect.fn('AddonRename.retireLegacyAddons')(function* (
  wow: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const addons = path.resolve(wow, 'Interface', 'AddOns');
  const backup = path.resolve(
    wow,
    'Interface',
    'WispAI-RenameBackup',
    String(yield* Clock.currentTimeMillis),
  );
  let count = 0;
  for (const entry of yield* fs.readDirectoryEntries(addons)) {
    if (entry.type !== 'Directory' || !legacyAddon.test(entry.name)) {
      continue;
    }
    const source = path.resolve(addons, entry.name);
    const target = path.resolve(backup, entry.name);
    if (path.dirname(source) !== addons || path.dirname(target) !== backup) {
      return yield* new AddonRenameError({ message: 'Unsafe addon migration target' });
    }
    if ((yield* fs.lstat(source)).type === 'SymbolicLink') {
      return yield* new AddonRenameError({ message: 'Cannot migrate a linked addon directory' });
    }
    yield* fs.makeDirectory(backup, { recursive: true });
    yield* fs.rename(source, target);
    count++;
  }
  return { count, backup: count ? backup : null };
});
