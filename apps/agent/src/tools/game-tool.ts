import { Effect } from 'effect';
import type {
  CharacterSections,
  GameAction,
  GameInspection,
  ItemSourcesInput,
} from '../host/game-access.ts';
import type { ToolContext } from './tool.ts';

export const readCharacter = (ctx: ToolContext, sections: CharacterSections, refresh?: boolean) =>
  runGame(ctx, (game) => game.readCharacter(ctx.session.id, sections, refresh));

export const inspectGame = (ctx: ToolContext, inspection: GameInspection, timeout = 35_000) =>
  runGame(ctx, (game) => game.inspectGame(ctx.session.id, inspection), timeout);

export const readItemSources = (ctx: ToolContext, input: ItemSourcesInput) =>
  runGame(ctx, (game) => game.itemSources(ctx.session.id, input), 60_000);

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
