// @effect-migrated
import type { AddonUpdate } from '@wisp/protocol/native-commands';
import { Context, Effect, Schedule, Schema, Stream } from 'effect';
import type { DesktopInfo } from './api';
import { hostEvents, nativeCall, rejectionText, type DesktopCallError } from './api/calls';

/** What the bridge lifecycle asks of the desktop session that runs it. */
export class Host extends Context.Service<
  Host,
  {
    /** Starts the bridge; the session expects it to come up. */
    readonly launchBridge: Effect.Effect<void, DesktopCallError>;
    /** Starts a status read unless one is in flight, without waiting for it. */
    readonly pollStatus: Effect.Effect<void>;
    /** Reads the status, joining a read in flight. */
    readonly refresh: Effect.Effect<void>;
    readonly desktopInfo: (info: DesktopInfo) => Effect.Effect<void>;
    readonly addonUpdate: (update: AddonUpdate) => Effect.Effect<void>;
    /** Whether the automatic addon update is running. */
    readonly addonUpdating: (updating: boolean) => Effect.Effect<void>;
    readonly error: (message: string) => Effect.Effect<void>;
    readonly initializationError: (message: string) => Effect.Effect<void>;
  }
>()('@wisp/desktop/bridge-lifecycle/Host') {}

/** How often the session reads the bridge status. */
export const statusPollInterval = '3 seconds';

/** Launches the bridge, reads what the host reports and listens for its errors. */
const initialize = Effect.gen(function* () {
  const host = yield* Host;
  yield* host.launchBridge.pipe(Effect.catch((error) => host.error(rejectionText(error))));
  const info = yield* nativeCall('desktop_info');
  yield* host.desktopInfo(info);
  if (info.addonUpdatePending) yield* host.addonUpdating(true);
  yield* nativeCall('auto_update_addon').pipe(
    Effect.flatMap((update) => (update ? host.addonUpdate(update) : Effect.void)),
    Effect.catch((error) => host.error(rejectionText(error))),
    Effect.ensuring(info.addonUpdatePending ? host.addonUpdating(false) : Effect.void),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* host.refresh;
  return yield* hostEvents('desktop-error', Schema.String);
});

/**
 * The bridge's lifetime in a desktop session: the status poll, launching the
 * bridge and the host's error events. It runs until it is interrupted, which
 * stops the poll and removes the listener.
 */
export const run = Effect.gen(function* () {
  const host = yield* Host;
  // Every tick starts a read at a fixed cadence and never waits for one in flight.
  yield* host.pollStatus.pipe(
    Effect.schedule(Schedule.fixed(statusPollInterval)),
    Effect.forkScoped,
  );
  const errors = yield* initialize.pipe(
    Effect.catch((error) =>
      host.initializationError(rejectionText(error)).pipe(Effect.as(Stream.never)),
    ),
  );
  return yield* Stream.runForEach(errors, host.error).pipe(Effect.andThen(Effect.never));
}).pipe(Effect.scoped);
