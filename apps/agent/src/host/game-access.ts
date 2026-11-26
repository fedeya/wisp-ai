import { Context, Effect, Schema } from 'effect';
import type { z } from 'zod';
import type { actionSchema } from '../contract/game-actions.ts';
import { inspectionSchema, type characterSections } from '../contract/game-inspection.ts';
import { itemSourcesResult } from '../contract/item-sources-result.ts';
export type { ItemSourcesResult } from '../contract/item-sources-result.ts';

export const gameReading = Schema.Record(Schema.String, Schema.Unknown);
export type GameReading = typeof gameReading.Type;
export type GameInspection = z.input<typeof inspectionSchema>;
type ParsedInspection = z.output<typeof inspectionSchema>;
export type GameAction = z.input<typeof actionSchema>;
export type CharacterSections = z.infer<typeof characterSections>;

const inspectionResults = { item_sources: itemSourcesResult };
type InspectionResults = typeof inspectionResults;
type TypedInspectionKind = keyof InspectionResults;
export type InspectionResult<Kind extends GameInspection['kind']> =
  Kind extends keyof InspectionResults ? InspectionResults[Kind]['Type'] : GameReading;

export type InspectionHandlers = {
  [Kind in TypedInspectionKind]: (
    session: string,
    inspection: Extract<ParsedInspection, { kind: Kind }>,
  ) => Effect.Effect<InspectionResult<Kind>, Error>;
};

export type RawInspection = Exclude<ParsedInspection, { kind: TypedInspectionKind }>;

type InspectGame = <I extends GameInspection>(
  session: string,
  inspection: I,
) => Effect.Effect<InspectionResult<I['kind']>, Error>;

/** Typed inspections must implement a handler; only raw addon reads use the fallback. */
export function inspectWith(
  handlers: InspectionHandlers,
  read: (session: string, inspection: RawInspection) => Effect.Effect<unknown, Error>,
): InspectGame {
  function inspect<I extends GameInspection>(
    session: string,
    inspection: I,
  ): Effect.Effect<InspectionResult<I['kind']>, Error>;
  function inspect(session: string, inspection: GameInspection): Effect.Effect<GameReading, Error> {
    return Effect.suspend(() => {
      const parsed = inspectionSchema.safeParse(inspection);
      if (!parsed.success) return Effect.fail(parsed.error);
      if (parsed.data.kind === 'item_sources') {
        return handlers
          .item_sources(session, parsed.data)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(inspectionResults.item_sources)));
      }
      return read(session, parsed.data).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(gameReading)),
      );
    });
  }
  return inspect;
}

export class GameAccess extends Context.Service<
  GameAccess,
  {
    readCharacter: (
      session: string,
      sections: CharacterSections,
      refresh?: boolean,
    ) => Effect.Effect<GameReading, Error>;
    inspectGame: InspectGame;
    runGameAction: (session: string, action: GameAction) => Effect.Effect<GameReading, Error>;
  }
>()('@wisp/agent/GameAccess') {}

const unavailable = () => Effect.fail(new Error('No active connection for this character'));
export const unavailableGameAccess = GameAccess.of({
  readCharacter: unavailable,
  inspectGame: unavailable,
  runGameAction: unavailable,
});
