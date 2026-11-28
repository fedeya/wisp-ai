import { Effect } from 'effect';
import { initialSession, make, SessionState, type Session } from '#/session';

/**
 * A real `SessionState` that starts as `initial`. `onCommit` runs on each
 * `commit`, before it tells the subscribers, so tests can count them.
 */
export function sessionState(
  initial: Session = initialSession(),
  onCommit?: () => void,
): SessionState['Service'] {
  const service = Effect.runSync(make(initial));
  return onCommit
    ? SessionState.of({
        ...service,
        commit: Effect.sync(onCommit).pipe(Effect.andThen(service.commit)),
      })
    : service;
}

/** The session `service` holds now. */
export const current = (service: SessionState['Service']) => Effect.runSync(service.get);
