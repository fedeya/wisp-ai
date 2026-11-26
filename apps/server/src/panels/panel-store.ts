import { Effect, Schema } from 'effect';
import type { z } from 'zod';
import { panelContent, type panelInput } from '@wisp/agent/contract/panels';
import type { SqlDatabase } from '@wisp/db/sql-database';
import { readPanels, savePanels } from './panel-record.ts';

/** A panel change the store refuses, with the reason shown to the player. */
export class PanelRejected extends Schema.TaggedError<PanelRejected>()('PanelRejected', {
  message: Schema.String,
}) {}

/** Each character's panels, read from and written to the application database. */
export function makePanelStore({ db }: SqlDatabase['Service']) {
  const all = Effect.fn('PanelStore.all')(function* () {
    return yield* readPanels(db);
  });
  const list = Effect.fn('PanelStore.list')(function* (characterKey: string) {
    return (yield* readPanels(db)).filter((p) => p.characterKey === characterKey);
  });
  const mutate = Effect.fn('PanelStore.mutate')(function* (
    characterKey: string,
    input: z.infer<typeof panelInput>,
  ) {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        if (input.operation !== 'save' && input.operation !== 'remove') return;
        const id = input.operation === 'save' ? input.panel.id : input.id;
        const panels = yield* readPanels(tx);
        const previous = panels.find((p) => p.characterKey === characterKey && p.id === id);
        const next = panels.filter((p) => p !== previous);
        if (input.operation === 'save') {
          // Only new panels count against the limit, so panels merged past it
          // can still be edited.
          if (!previous && next.filter((p) => p.characterKey === characterKey).length >= 12) {
            return yield* new PanelRejected({ message: 'Keep at most 12 panels per character' });
          }
          // Edits keep the key an adopted panel came from, so the addon can
          // still move its saved layout if it has not applied the move yet.
          const formerKey = previous?.formerKey;
          next.push({
            ...panelContent.parse(input.panel),
            characterKey,
            updatedAt: Date.now(),
            ...(formerKey ? { formerKey } : {}),
          });
        }
        yield* savePanels(tx, next);
      }),
    );
    return yield* list(characterKey);
  });
  return { all, list, mutate };
}

export type PanelStore = ReturnType<typeof makePanelStore>;
