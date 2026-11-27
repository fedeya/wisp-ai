import { Effect } from 'effect';
import type { SqlOrm } from '@wisp/db/sql-database';
import { adoptCharacterKey, saveCharacterName } from './character-keys.ts';
import { errorMessage } from '../errors.ts';
import type { Chat } from './chat.ts';
import type { CharacterProfile } from './context.ts';

interface CharacterAdoptionDependencies {
  db: SqlOrm;
  chats: () => Chat[];
  saveChats: () => void;
}

/**
 * The first time a character shows up with a GUID key in this bridge, save
 * its name for labels and move what was saved under its pre-GUID keys to it.
 * GUID keys never change, so this happens once per character.
 *
 * Returns whether data moved, so the receiver can refresh the view alongside
 * any change to the active character.
 */
export function createCharacterAdoption(deps: CharacterAdoptionDependencies) {
  const seen = new Map<string, string>();
  const adopt = Effect.fn('CharacterAdoption.adopt')(function* (character: CharacterProfile) {
    if (!character.guid) return false;
    const label = JSON.stringify([character.name, character.realm]);
    if (seen.get(character.key) === label) return false;
    const { db } = deps;
    const merged = yield* db.$client.withTransaction(
      Effect.gen(function* () {
        yield* saveCharacterName(db, character.key, character);
        return yield* adoptCharacterKey(
          db,
          character.key,
          character,
          deps.chats().map((chat) => chat.characterKey),
        );
      }),
    );
    seen.set(character.key, label);
    let chatsMoved = false;
    for (const chat of deps.chats()) {
      if (chat.characterKey && merged.includes(chat.characterKey)) {
        chat.characterKey = character.key;
        chatsMoved = true;
      }
    }
    if (merged.length) {
      if (chatsMoved) deps.saveChats();
      yield* Effect.logInfo('Saved character data moved to its GUID key').pipe(
        Effect.annotateLogs({ event: 'character.keys_merged', count: merged.length }),
      );
    }
    return merged.length > 0;
  }, Effect.uninterruptible);
  const logFailure = (error: unknown) =>
    Effect.logWarning('Could not move saved character data').pipe(
      Effect.annotateLogs({ event: 'character.keys_merge_failed', error: errorMessage(error) }),
      Effect.as(false),
    );
  return (character: CharacterProfile) =>
    adopt(character).pipe(Effect.catch(logFailure), Effect.catchDefect(logFailure));
}
