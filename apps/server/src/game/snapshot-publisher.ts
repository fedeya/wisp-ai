// @effect-migrated
import { Array as Arr, Context, Effect, Option, Ref, Schedule, Stream } from 'effect';
import type { Connection } from '@wisp/wow-bridge';
import { SessionState, type Session } from '#/session';
import { buildAddonSnapshot, type AddonSnapshotInputs } from './addon-snapshot.ts';
import * as PublishScheduler from './publish-scheduler.ts';

/**
 * Publishes the addon snapshot to the current transport: after each change of
 * `SessionState`, coalesced by `PublishScheduler`, and when told that
 * something else the snapshot shows changed.
 */
export class SnapshotPublisher extends Context.Service<
  SnapshotPublisher,
  {
    /**
     * Something the snapshot shows outside `SessionState` changed: the
     * routines, panels, capabilities or flags, or whether the agent is ready.
     * Publishes with the next coalesced snapshot. Each source moves to a change
     * stream of its own as it migrates.
     */
    readonly invalidate: Effect.Effect<void>;
    /**
     * Publishes now, skipping the coalescing window. Call it after the update
     * it should show: the snapshot is built from the session as it is.
     */
    readonly flush: Effect.Effect<void>;
  }
>()('@wisp/server/game/SnapshotPublisher') {}

export interface SnapshotSources {
  /** The transport to publish to, if WoW is connected. */
  readonly transport: Effect.Effect<Option.Option<Pick<Connection, 'publish'>>>;
  /** Everything the snapshot shows besides the session, read at publish time. */
  readonly inputs: Effect.Effect<Omit<AddonSnapshotInputs, 'state'>>;
}

/** The session the last snapshot showed, and whether a flush or the scheduler published it. */
interface Published {
  readonly session: Session;
  readonly by: 'flush' | 'schedule';
}

/**
 * A publisher of the snapshot of the `SessionState` it is given, subscribed
 * to its changes before this returns. Its work stops when the scope closes.
 */
export const make = Effect.fn('SnapshotPublisher.make')(function* (sources: SnapshotSources) {
  const session = yield* SessionState;
  const scope = yield* Effect.scope;
  // Stale until a snapshot is written: no transport yet, or nothing published.
  const dirty = yield* Ref.make(true);
  const published = yield* Ref.make(Option.none<Published>());

  const publish = (by: Published['by']) =>
    Effect.gen(function* () {
      const transport = yield* sources.transport;
      const state = yield* session.get;
      if (Option.isNone(transport) || !(yield* Ref.get(dirty)) || !state.activeTransport) {
        return;
      }
      yield* Ref.set(dirty, false);
      yield* Ref.set(published, Option.some({ session: state, by }));
      const snapshot = buildAddonSnapshot({ state, ...(yield* sources.inputs) });
      // Written beside the publisher, which does not wait for the addon's disk.
      yield* transport.value
        .publish(snapshot)
        .pipe(Effect.forkIn(scope, { startImmediately: true }));
    });

  const scheduler = yield* PublishScheduler.make(publish('schedule'));
  const invalidate = Ref.set(dirty, true).pipe(Effect.andThen(scheduler.schedule));

  // Each change marks the snapshot stale and schedules it, as `changed()` did.
  // The subscription usually hears about a change as it is stored, but when it
  // hears later, a publish may already have shown it: then the scheduler's
  // publish needs nothing more, and a flush keeps the coalescing window that
  // its change opened.
  const heard = (changes: Arr.NonEmptyReadonlyArray<Session>) =>
    Effect.gen(function* () {
      const latest = Arr.lastNonEmpty(changes);
      const last = yield* Ref.get(published);
      if (Option.isNone(last) || last.value.session !== latest) {
        return yield* invalidate;
      }
      if (last.value.by === 'flush') {
        yield* scheduler.schedule;
      }
    });
  yield* session.changes.pipe(
    Stream.runForEachArray(heard),
    Effect.forkScoped({ startImmediately: true }),
  );

  // Polls what has no event: a snapshot still stale because there was no transport.
  yield* Stream.fromSchedule(Schedule.fixed(PublishScheduler.PUBLISH_MIN_INTERVAL_MS)).pipe(
    Stream.runForEach(() =>
      Ref.get(dirty).pipe(Effect.flatMap((stale) => (stale ? scheduler.schedule : Effect.void))),
    ),
    Effect.forkScoped,
  );

  return SnapshotPublisher.of({
    invalidate,
    flush: Ref.set(dirty, true).pipe(Effect.andThen(publish('flush'))),
  });
});
