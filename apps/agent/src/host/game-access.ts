import { Context, Effect } from 'effect';
import { z } from 'zod';
import type { actionSchema } from '../contract/game-actions.ts';
import type { inspectionSchema } from '../contract/game-inspection.ts';

export const characterSections = z
  .array(
    z.enum([
      'character',
      'location',
      'group',
      'talents',
      'spells',
      'quests',
      'gear',
      'bags',
      'pvp',
    ]),
  )
  .min(1)
  .max(9);

export const gameReading = z.record(z.string(), z.unknown());
export type GameReading = z.infer<typeof gameReading>;
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
