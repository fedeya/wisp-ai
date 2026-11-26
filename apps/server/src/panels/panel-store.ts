import { Context, Effect, Layer, Schema } from 'effect';
import type { z } from 'zod';
import { panelContent, type Panel, type panelInput } from '@wisp/agent/contract/panels';
import { CorruptRecord, DatabaseFailure, sqlFailures, type SqlFailure } from '@wisp/db/repository';
import { SqlDatabase } from '@wisp/db/sql-database';
import { DuplicateRecord } from '@wisp/db/sync-rows';
import { readPanels, savePanels } from './panel-record.ts';

/** A panel change the store refuses, with the reason shown to the player. */
export class PanelRejected extends Schema.TaggedError<PanelRejected>()('PanelRejected', {
  message: Schema.String,
}) {}

/** A panel operation failed; `reason` says whether the player or the database caused it. */
export class PanelStoreError extends Schema.TaggedError<PanelStoreError>()('PanelStoreError', {
  reason: Schema.Union([PanelRejected, DatabaseFailure, CorruptRecord, DuplicateRecord]),
}) {
  override get message() {
    return this.reason.message;
  }
}

/** Each character's panels. */
export class PanelStore extends Context.Service<
  PanelStore,
  {
    /** Every character's panels, for the desktop overview. */
    readonly all: () => Effect.Effect<Panel[], PanelStoreError>;
    readonly list: (characterKey: string) => Effect.Effect<Panel[], PanelStoreError>;
    /** Saves or removes a panel and returns the character's panels after the change. */
    readonly mutate: (
      characterKey: string,
      input: z.infer<typeof panelInput>,
    ) => Effect.Effect<Panel[], PanelStoreError>;
  }
>()('@wisp/server/PanelStore') {}

const MAX_PANELS = 12;

const panelErrors = <A, R>(self: Effect.Effect<A, PanelStoreError['reason'] | SqlFailure, R>) =>
  sqlFailures(self).pipe(Effect.mapError((reason) => new PanelStoreError({ reason })));

const ofCharacter = (panels: Panel[], characterKey: string) =>
  panels.filter((panel) => panel.characterKey === characterKey);

export const layer = Layer.effect(
  PanelStore,
  Effect.gen(function* () {
    const { db } = yield* SqlDatabase;
    return PanelStore.of({
      all: Effect.fn('PanelStore.all')(function* () {
        return yield* readPanels(db);
      }, panelErrors),

      list: Effect.fn('PanelStore.list')(function* (characterKey: string) {
        return ofCharacter(yield* readPanels(db), characterKey);
      }, panelErrors),

      mutate: Effect.fn('PanelStore.mutate')(function* (
        characterKey: string,
        input: z.infer<typeof panelInput>,
      ) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const panels = yield* readPanels(tx);
            if (input.operation !== 'save' && input.operation !== 'remove') {
              return ofCharacter(panels, characterKey);
            }
            const id = input.operation === 'save' ? input.panel.id : input.id;
            const previous = panels.find(
              (panel) => panel.characterKey === characterKey && panel.id === id,
            );
            const next = panels.filter((panel) => panel !== previous);
            if (input.operation === 'save') {
              // Only new panels count against the limit, so panels merged past it
              // can still be edited.
              if (!previous && ofCharacter(next, characterKey).length >= MAX_PANELS) {
                return yield* new PanelRejected({
                  message: `Keep at most ${MAX_PANELS} panels per character`,
                });
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
            return ofCharacter(next, characterKey);
          }),
        );
      }, panelErrors),
    });
  }),
);
