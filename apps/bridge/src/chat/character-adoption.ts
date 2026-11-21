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

/**
 * Once per character key with a GUID, move chats, routines, panels and
 * character memory saved under that character's older keys to it.
 */
export function createCharacterAdoption(deps: CharacterAdoptionDependencies) {
  const adopted = new Set<string>();
  let queue = Promise.resolve();
  return function adoptCharacter(key: string): Promise<void> {
    if (adopted.has(key)) return queue;
    let guid: string | undefined;
    try {
      guid = parseCharacterKey(key).guid;
    } catch {
      return queue;
    }
    if (!guid) return queue;
    adopted.add(key);
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
        adopted.delete(key);
        deps.logger.warn(
          { event: 'character.keys_merge_failed', error: errorMessage(error) },
          'Could not move saved character data',
        );
      });
    return queue;
  };
}
