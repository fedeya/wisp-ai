// @effect-migrated
import { Effect } from 'effect';
import type { SqlOrm } from '@wisp/db/sql-database';
import { SessionState } from '#/session';
import { adoptCharacterKey, saveCharacterName } from './character-keys.ts';
import { errorMessage } from '../errors.ts';
import type { PanelStore } from '../panels/panel-store.ts';
import type { CharacterProfile } from './context.ts';

interface CharacterAdoptionDependencies {
  db: SqlOrm;
  panelStore: Pick<PanelStore, 'refresh'>;
}

/**
 * The first time a character shows up with a GUID key in this bridge, save
 * its name for labels and move what was saved under its pre-GUID keys to it,
 * the chats in `SessionState` included. GUID keys never change, so this
 * happens once per character.
 *
 * Packet handling waits for the move, so subsequent packets see the GUID key.
 */
export const createCharacterAdoption = Effect.fnUntraced(function* (
  deps: CharacterAdoptionDependencies,
) {
  const session = yield* SessionState;
  const seen = new Map<string, string>();
  const adopt = Effect.fn('CharacterAdoption.adopt')(function* (character: CharacterProfile) {
    if (!character.guid) return;
    const label = JSON.stringify([character.name, character.realm]);
    if (seen.get(character.key) === label) return;
    const { db } = deps;
    const merged = yield* db.$client.withTransaction(
      Effect.gen(function* () {
        yield* saveCharacterName(db, character.key, character);
        const { chats } = yield* session.get;
        return yield* adoptCharacterKey(
          db,
          character.key,
          character,
          chats.map((chat) => chat.characterKey),
        );
      }),
    );
    seen.set(character.key, label);
    for (const chat of (yield* session.get).chats) {
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
    // The chats were edited in place.
    yield* session.commit;
  }, Effect.uninterruptible);
  const logFailure = (error: unknown) =>
    Effect.logWarning('Could not move saved character data').pipe(
      Effect.annotateLogs({ event: 'character.keys_merge_failed', error: errorMessage(error) }),
    );
  return (character: CharacterProfile) =>
    adopt(character).pipe(Effect.catch(logFailure), Effect.catchDefect(logFailure));
});
