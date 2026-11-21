import { parseCharacterKey, sameCharacter } from '@wisp/protocol/character-key';
import type { Logger } from 'pino';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { adoptCharacterKey } from '../db/character-keys.ts';
import { errorMessage } from '../errors.ts';
import type { PanelStore } from '../addon/panels.ts';
import type { Chat } from './chat.ts';

interface CharacterAdoptionDependencies {
  database: ApplicationDatabase;
  panelStore: Pick<PanelStore, 'reload'>;
  chats: () => Chat[];
  changed: () => void;
  logger: Pick<Logger, 'info' | 'warn'>;
}

function guidOf(key: string) {
  try {
    return parseCharacterKey(key).guid;
  } catch {
    return undefined;
  }
}

/**
 * Whenever a GUID shows up under a new key, move chats, routines, panels and
 * character memory saved under that character's older keys to it.
 */
export function createCharacterAdoption(deps: CharacterAdoptionDependencies) {
  // The key each GUID's data was last moved to. If the key changes and later
  // changes back, the data must move back too.
  const adopted = new Map<string, string>();
  let queue = Promise.resolve();
  return function adoptCharacter(key: string): Promise<void> {
    const guid = guidOf(key);
    if (!guid || adopted.get(guid) === key) return queue;
    adopted.set(guid, key);
    // In-memory chats are persisted from state, so they move first.
    for (const chat of deps.chats()) {
      if (chat.characterKey && chat.characterKey !== key && sameCharacter(chat.characterKey, key)) {
        chat.characterKey = key;
      }
    }
    queue = queue
      .then(async () => {
        await deps.database.initializeProducts();
        const merged = await deps.database.transaction((db) => adoptCharacterKey(db, key));
        if (merged.length) {
          await deps.panelStore.reload();
          deps.logger.info(
            { event: 'character.keys_merged', count: merged.length },
            'Saved character data moved to its current identity',
          );
          deps.changed();
        }
      })
      .catch((error) => {
        if (adopted.get(guid) === key) adopted.delete(guid);
        deps.logger.warn(
          { event: 'character.keys_merge_failed', error: errorMessage(error) },
          'Could not move saved character data',
        );
      });
    return queue;
  };
}
