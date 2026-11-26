import { Context, Effect, Schema } from 'effect';
import type { z } from 'zod';
import type { actionSchema } from '../contract/game-actions.ts';
import type { characterSections, inspectionSchema } from '../contract/game-inspection.ts';
import { itemSourcesResult } from '../contract/item-sources-result.ts';
export type { ItemSourcesResult } from '../contract/item-sources-result.ts';

export const gameReading = Schema.Record(Schema.String, Schema.Unknown);
export type GameReading = typeof gameReading.Type;
export type GameInspection = z.input<typeof inspectionSchema>;
export type GameAction = z.input<typeof actionSchema>;
export type CharacterSections = z.infer<typeof characterSections>;

const inspectionResults = { item_sources: itemSourcesResult };
const inspectionSchemas: Partial<Record<GameInspection['kind'], Schema.Decoder<GameReading>>> =
  inspectionResults;
type InspectionResults = typeof inspectionResults;
export type InspectionResult<Kind extends GameInspection['kind']> =
  Kind extends keyof InspectionResults ? InspectionResults[Kind]['Type'] : GameReading;

type InspectGame = <I extends GameInspection>(
  session: string,
  inspection: I,
) => Effect.Effect<InspectionResult<I['kind']>, Error>;

/** Decode the result with the schema for the request's kind. */
export function inspectWith(
  read: (session: string, inspection: GameInspection) => Effect.Effect<unknown, Error>,
): InspectGame {
  function inspect<I extends GameInspection>(
    session: string,
    inspection: I,
  ): Effect.Effect<InspectionResult<I['kind']>, Error>;
  function inspect(session: string, inspection: GameInspection): Effect.Effect<GameReading, Error> {
    const schema = inspectionSchemas[inspection.kind] ?? gameReading;
    return read(session, inspection).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
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
