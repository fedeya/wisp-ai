import { Effect } from 'effect';
import { SqlDatabase } from '@wisp/db/sql-database';
import { adoptCharacterKey, saveCharacterName } from './character-keys.ts';
import { errorMessage } from '../errors.ts';
import type { Chat } from './chat.ts';
import type { CharacterProfile } from './context.ts';

interface CharacterAdoptionDependencies {
  chats: () => Chat[];
  changed: () => void;
}

/**
 * The first time a character shows up with a GUID key in this bridge, save
 * its name for labels and move what was saved under its pre-GUID keys to it.
 * GUID keys never change, so this happens once per character.
 *
 * The receiver waits for it before handling anything else, so the packet that
 * reported the character, and everything after it, already sees the data
 * under the GUID key.
 */
export const createCharacterAdoption = Effect.fnUntraced(function* (
  deps: CharacterAdoptionDependencies,
) {
  const { db } = yield* SqlDatabase;
  const seen = new Map<string, string>();
  return Effect.fnUntraced(
    function* (character: CharacterProfile) {
      if (!character.guid) return;
      const label = JSON.stringify([character.name, character.realm]);
      if (seen.get(character.key) === label) return;
      const merged = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* saveCharacterName(tx, character.key, character);
          return yield* adoptCharacterKey(
            tx,
            character.key,
            character,
            deps.chats().map((chat) => chat.characterKey),
          );
        }),
      );
      seen.set(character.key, label);
      for (const chat of deps.chats()) {
        if (chat.characterKey && merged.includes(chat.characterKey)) {
          chat.characterKey = character.key;
        }
      }
      if (merged.length) {
        yield* Effect.logInfo('Saved character data moved to its GUID key').pipe(
          Effect.annotateLogs({ event: 'character.keys_merged', count: merged.length }),
        );
      }
      deps.changed();
    },
    Effect.catch((error) =>
      Effect.logWarning('Could not move saved character data').pipe(
        Effect.annotateLogs({ event: 'character.keys_merge_failed', error: errorMessage(error) }),
      ),
    ),
  );
});
