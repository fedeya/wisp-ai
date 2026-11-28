// @effect-migrated allow=effectRuns: the updater window's one ManagedRuntime, made when it mounts and disposed when it unmounts
import type { InstallerStatus } from '@wisp/protocol/native-commands';
import { Context, Effect, Layer, ManagedRuntime, Schedule } from 'effect';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { nativeCall } from '../../../api/calls';

/** How long the window waits after a status read before the next one. */
export const STATUS_POLL_MS = 120;

const initialStatus: InstallerStatus = {
  phase: 'preparing',
  percent: null,
  log: [],
  error: null,
};

/**
 * The updater window's session: once the window says it is ready, it reads
 * the installer's status until the installation fails. It runs in the scope,
 * so closing it stops the reads.
 */
export const makeSession = (store: StoreApi<InstallerStatus>) =>
  Effect.gen(function* () {
    /** Shows the installer's status and says whether the installation failed. */
    const readStatus = nativeCall('updater_status').pipe(
      Effect.flatMap((status) =>
        Effect.sync(() => {
          store.setState(status, true);
          return status.phase === 'failed';
        }),
      ),
      // The installer can close while the last status request is in flight.
      Effect.orElseSucceed(() => false),
    );
    yield* nativeCall('updater_ready').pipe(
      Effect.andThen(
        readStatus.pipe(
          Effect.repeat({ schedule: Schedule.spaced(STATUS_POLL_MS), until: (failed) => failed }),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    );
    return {
      // The window has nowhere to show a failure, so it only goes to the log.
      close: nativeCall('updater_close').pipe(Effect.ignore({ log: 'Unhandled' })),
    };
  });

class Session extends Context.Service<Session, Effect.Success<ReturnType<typeof makeSession>>>()(
  '@wisp/desktop/updater/Session',
) {}

/**
 * The installer status and actions of the updater window. Each mount runs its
 * own session; actions called while it is not mounted do nothing.
 */
export function createUpdater() {
  const store = createStore<InstallerStatus>(() => initialStatus);
  let mounted: {
    runtime: ManagedRuntime.ManagedRuntime<Session, never>;
    close: Effect.Effect<void>;
  } | null = null;
  return {
    store,
    /** Starts the session; the cleanup it returns disposes it, stopping the reads. */
    mount() {
      // The window's one runtime: every Effect of this webview runs here.
      const runtime = ManagedRuntime.make(Layer.effect(Session, makeSession(store)));
      const session = { runtime, close: runtime.runSync(Effect.service(Session)).close };
      mounted = session;
      return () => {
        if (mounted === session) mounted = null;
        void runtime.dispose();
      };
    },
    /** Asks the host to close the window. */
    close: () => {
      if (mounted) mounted.runtime.runFork(mounted.close);
    },
  };
}
