import { Context, Effect, Schema } from 'effect';
import type { z } from 'zod';
import type { actionSchema } from '../contract/game-actions.ts';
import type { characterSections, inspectionSchema } from '../contract/game-inspection.ts';

export const gameReading = Schema.Record(Schema.String, Schema.Unknown);
export type GameReading = typeof gameReading.Type;
export type GameInspection = z.input<typeof inspectionSchema>;
export type GameAction = z.input<typeof actionSchema>;
export type CharacterSections = z.infer<typeof characterSections>;

export class GameAccess extends Context.Service<
  GameAccess,
  {
    readCharacter: (
      session: string,
      sections: CharacterSections,
      refresh?: boolean,
    ) => Effect.Effect<GameReading, Error>;
    inspectGame: (session: string, inspection: GameInspection) => Effect.Effect<GameReading, Error>;
    runGameAction: (session: string, action: GameAction) => Effect.Effect<GameReading, Error>;
  }
>()('@wisp/agent/GameAccess') {}

const unavailable = () => Effect.fail(new Error('No active connection for this character'));
export const unavailableGameAccess = GameAccess.of({
  readCharacter: unavailable,
  inspectGame: unavailable,
  runGameAction: unavailable,
});
