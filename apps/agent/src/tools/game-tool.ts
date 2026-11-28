// @effect-migrated
import { Effect } from 'effect';
import type { CharacterSections, GameAction, ItemSourcesInput } from '../host/game-access.ts';
import type { ToolContext } from './tool.ts';

export const readCharacter = (ctx: ToolContext, sections: CharacterSections, refresh?: boolean) =>
  runGame(ctx, (game) => game.readCharacter(ctx.session.id, sections, refresh));

export const readItemSources = (ctx: ToolContext, input: ItemSourcesInput) =>
  runGame(ctx, (game) => game.itemSources(ctx.session.id, input), 60_000);

export const runGameAction = (ctx: ToolContext, action: GameAction) =>
  runGame(ctx, (game) => game.runGameAction(ctx.session.id, action));

/**
 * Runs a game call for a tool's `execute`, with the session's game access and
 * runner. A tool run outside a turn has neither, and its call rejects.
 */
export function runGame<A>(
  ctx: ToolContext,
  call: (game: NonNullable<ToolContext['gameAccess']>) => Effect.Effect<A, Error>,
  timeout = 35_000,
): Promise<A> {
  const { gameAccess, runEffect } = ctx;
  if (!gameAccess || !runEffect) {
    return Promise.reject(new Error('No active connection for this character'));
  }
  return runEffect(
    Effect.suspend(() => call(gameAccess)),
    {
      signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeout)]),
    },
  );
}
