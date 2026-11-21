import { parseCharacterKey } from '@wisp/protocol/character-key';
import type { Logger } from 'pino';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { adoptCharacterKey } from '../db/character-keys.ts';
import { errorMessage } from '../errors.ts';
import type { PanelStore } from '../addon/panels.ts';
import type { Chat } from './chat.ts';

interface CharacterAdoptionDependencies {
  database: Pick<ApplicationDatabase, 'transactionSync' | 'characterKeys'>;
  panelStore: Pick<PanelStore, 'refresh'>;
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
 *
 * Runs synchronously, so the packet that reported the key, and everything
 * after it, already sees the data under the new key.
 */
export function createCharacterAdoption(deps: CharacterAdoptionDependencies) {
  // The key each GUID's data was last moved to. If the key changes and later
  // changes back, the data must move back too.
  const adopted = new Map<string, string>();
  return function adoptCharacter(key: string): void {
    const guid = guidOf(key);
    if (!guid || adopted.get(guid) === key) return;
    try {
      const merged = deps.database.transactionSync((db) =>
        adoptCharacterKey(
          db,
          key,
          deps.chats().map((chat) => chat.characterKey),
        ),
      );
      adopted.set(guid, key);
      deps.database.characterKeys.record(merged, key);
      for (const chat of deps.chats()) {
        if (chat.characterKey && merged.includes(chat.characterKey)) {
          chat.characterKey = key;
        }
      }
      if (merged.length) {
        deps.panelStore.refresh();
        deps.logger.info(
          { event: 'character.keys_merged', count: merged.length },
          'Saved character data moved to its current identity',
        );
        deps.changed();
      }
    } catch (error) {
      deps.logger.warn(
        { event: 'character.keys_merge_failed', error: errorMessage(error) },
        'Could not move saved character data',
      );
    }
  };
}
