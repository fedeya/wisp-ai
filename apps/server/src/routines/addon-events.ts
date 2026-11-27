import { routineEvent, routineInput } from '@wisp/protocol/routines';
import type { GameEvent } from '@wisp/wow-bridge';
import { Clock, Effect } from 'effect';
import { characterIdentity } from '../chat/context.ts';
import { errorMessage } from '../errors.ts';
import type { SessionState } from '../session-state.ts';
import type { RoutineStore } from './routine-store.ts';

export function make(deps: {
  state: SessionState;
  store: Pick<RoutineStore, 'observe' | 'mutate'>;
  enabled: () => boolean;
  invalidateAddonView: () => void;
}) {
  const { state, store, enabled, invalidateAddonView } = deps;
  const presence = Effect.fn('AddonRoutines.presence')(function* (
    packet: Extract<GameEvent, { type: 'routine_tick' | 'routine_event' }>,
  ) {
    const identity = characterIdentity(packet.context);
    const now = yield* Clock.currentTimeMillis;
    if (!identity || Math.abs(now - packet.at * 1000) > 90_000) return;
    const data = packet.data;
    state.routinePresence = {
      identity,
      context: packet.context,
      ready: data?.ready === true,
      at: now,
      session: packet.session,
    };
    if (packet.type !== 'routine_event' || !enabled()) return;
    const event = routineEvent.safeParse({ event: data?.event, values: data?.values });
    if (!event.success) return;
    yield* Effect.tryPromise({
      try: () => store.observe(identity, event.data),
      catch: errorMessage,
    }).pipe(
      Effect.tap(() => Effect.sync(invalidateAddonView)),
      Effect.catch((error) =>
        Effect.logWarning('Routine event failed').pipe(
          Effect.annotateLogs({ event: 'routine.event_failed', error }),
        ),
      ),
    );
  });

  const action = Effect.fn('AddonRoutines.action')(function* (
    packet: Extract<GameEvent, { type: 'routine_action' }>,
  ) {
    const identity = characterIdentity(packet.context);
    const input = routineInput.safeParse(packet.data);
    if (
      !identity ||
      !input.success ||
      !['pause', 'resume', 'remove'].includes(input.data.operation)
    ) {
      return;
    }
    yield* Effect.tryPromise({
      try: () => store.mutate(identity, input.data),
      catch: errorMessage,
    }).pipe(
      Effect.tap(() => Effect.sync(invalidateAddonView)),
      Effect.catch((error) =>
        Effect.logWarning('Routine action failed').pipe(
          Effect.annotateLogs({ event: 'routine.action_failed', error }),
        ),
      ),
    );
  });

  return { presence, action };
}
