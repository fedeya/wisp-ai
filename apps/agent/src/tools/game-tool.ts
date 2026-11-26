import { Effect } from 'effect';
import type { CharacterSections, GameAction, GameInspection } from '../host/game-access.ts';
import type { ToolContext } from './tool.ts';

export const readCharacter = (ctx: ToolContext, sections: CharacterSections, refresh?: boolean) =>
  runGame(ctx, (game) => game.readCharacter(ctx.session.id, sections, refresh));

export const inspectGame = <I extends GameInspection>(
  ctx: ToolContext,
  inspection: I,
  timeout = 35_000,
) => runGame(ctx, (game) => game.inspectGame(ctx.session.id, inspection), timeout);

export const runGameAction = (ctx: ToolContext, action: GameAction) =>
  runGame(ctx, (game) => game.runGameAction(ctx.session.id, action));

function runGame<A>(
  ctx: ToolContext,
  call: (game: NonNullable<ToolContext['gameAccess']>) => Effect.Effect<A, Error>,
  timeout = 35_000,
) {
  const { gameAccess, runEffect } = ctx;
  if (!gameAccess || !runEffect) throw Error('No active connection for this character');
  return runEffect(
    Effect.suspend(() => call(gameAccess)),
    {
      signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeout)]),
    },
  );
}
