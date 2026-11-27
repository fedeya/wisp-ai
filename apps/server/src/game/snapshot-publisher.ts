import { Effect, Fiber } from 'effect';
import { buildAddonSnapshot } from './addon-snapshot.ts';
import type { AddonSnapshotInputs } from './addon-snapshot.ts';
import { createPublishScheduler } from './publish-scheduler.ts';
import type { SessionState } from '../session-state.ts';
import type { Connection } from '@wisp/wow-bridge';

export interface SnapshotPublisherDependencies {
  state: SessionState;
  transport: () => Pick<Connection, 'publish'> | undefined;
  /** Everything the snapshot shows besides `state`, read at publish time. */
  inputs: () => Effect.Effect<Omit<AddonSnapshotInputs, 'state'>, Error>;
}

export interface SnapshotPublisher {
  /** Mark the snapshot stale and schedule a coalesced publish. */
  invalidate(): void;
  /** Publish on the next microtask, skipping the coalescing window. */
  flush(): void;
  /** Re-schedule a publish that is still stale (no transport, or a failed write). */
  retry(): void;
  stop: Effect.Effect<void>;
}

/** Publishes the addon snapshot to the current transport whenever it changes. */
export const createSnapshotPublisher = Effect.fnUntraced(function* (
  deps: SnapshotPublisherDependencies,
): Effect.fn.Return<SnapshotPublisher> {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const { state } = deps;
  let dirty = true;
  let inFlight: Fiber.Fiber<void> | undefined;
  let stopped = false;
  const scheduler = createPublishScheduler(() => publish());

  function publish() {
    const transport = deps.transport();
    const session = state.activeTransport;
    const character = state.currentCharacterKey;
    if (stopped || inFlight || !transport || !dirty || !session) {
      return;
    }
    dirty = false;
    const fiber = runFork(
      Effect.gen(function* () {
        const inputs = yield* deps.inputs();
        if (stopped) return;
        if (
          session !== state.activeTransport ||
          character !== state.currentCharacterKey ||
          transport !== deps.transport()
        ) {
          dirty = true;
        } else {
          yield* transport.publish(buildAddonSnapshot({ state, ...inputs }));
        }
        if (dirty) scheduler.schedule();
      }).pipe(
        Effect.catch((error) => {
          dirty = true;
          return Effect.logWarning('Could not build addon snapshot').pipe(
            Effect.annotateLogs({ event: 'addon.snapshot_failed', error: error.message }),
          );
        }),
      ),
    );
    inFlight = fiber;
    fiber.addObserver(() => {
      inFlight = undefined;
    });
  }

  return {
    invalidate() {
      dirty = true;
      scheduler.schedule();
    },
    flush() {
      queueMicrotask(() => {
        dirty = true;
        publish();
      });
    },
    retry() {
      if (dirty) scheduler.schedule();
    },
    stop: Effect.gen(function* () {
      stopped = true;
      scheduler.stop();
      if (inFlight) yield* Fiber.interrupt(inFlight);
    }),
  };
});
