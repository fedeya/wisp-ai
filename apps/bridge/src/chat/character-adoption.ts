import { Effect } from 'effect';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { adoptCharacterKey, saveCharacterName } from '../db/character-keys.ts';
import { errorMessage } from '../errors.ts';
import type { PanelStore } from '../addon/panels.ts';
import type { Chat } from './chat.ts';
import type { CharacterProfile } from './context.ts';

interface CharacterAdoptionDependencies {
  database: Pick<ApplicationDatabase, 'transactionSync'>;
  panelStore: Pick<PanelStore, 'refresh'>;
  chats: () => Chat[];
  changed: () => void;
}

/**
 * The first time a character shows up with a GUID key in this bridge, save
 * its name for labels and move what was saved under its pre-GUID keys to it.
 * GUID keys never change, so this happens once per character.
 *
 * Runs synchronously, so the packet that reported the character, and
 * everything after it, already sees the data under the GUID key.
 */
export function createCharacterAdoption(deps: CharacterAdoptionDependencies) {
  const seen = new Map<string, string>();
  return Effect.fnUntraced(function* (character: CharacterProfile) {
    if (!character.guid) return;
    const label = JSON.stringify([character.name, character.realm]);
    if (seen.get(character.key) === label) return;
    try {
      const merged = deps.database.transactionSync((db) => {
        saveCharacterName(db, character.key, character);
        return adoptCharacterKey(
          db,
          character.key,
          character,
          deps.chats().map((chat) => chat.characterKey),
        );
      });
      seen.set(character.key, label);
      for (const chat of deps.chats()) {
        if (chat.characterKey && merged.includes(chat.characterKey)) {
          chat.characterKey = character.key;
        }
      }
      if (merged.length) {
        deps.panelStore.refresh();
        yield* Effect.logInfo('Saved character data moved to its GUID key').pipe(
          Effect.annotateLogs({ event: 'character.keys_merged', count: merged.length }),
        );
      }
      deps.changed();
    } catch (error) {
      yield* Effect.logWarning('Could not move saved character data').pipe(
        Effect.annotateLogs({ event: 'character.keys_merge_failed', error: errorMessage(error) }),
      );
    }
  });
}
