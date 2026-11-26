import { Effect } from 'effect';
import { buildAddonSnapshot, type AddonSnapshotInputs } from './addon-snapshot.ts';
import { errorMessage } from '../errors.ts';
import { createPublishScheduler } from './publish-scheduler.ts';
import type { SessionState } from '../session-state.ts';
import type { SnapshotGate } from './snapshots.ts';
import type { Connection } from '@wisp/wow-bridge';

export interface SnapshotPublisherDependencies {
  state: SessionState;
  snapshots: SnapshotGate;
  transport: () => Pick<Connection, 'publish'> | undefined;
  /** Everything the snapshot shows besides `state`, read at publish time. */
  inputs: () => Omit<AddonSnapshotInputs, 'state'>;
}

export interface SnapshotPublisher {
  /** Mark the snapshot stale and schedule a coalesced publish. */
  changed(): void;
  /** Publish on the next microtask, skipping the coalescing window. */
  flush(): void;
  /** Re-schedule a publish that is still stale (no transport, or a failed write). */
  retry(): void;
  stop(): void;
}

/** Publishes the addon snapshot to the current transport whenever it changes. */
export const createSnapshotPublisher = Effect.fnUntraced(function* (
  deps: SnapshotPublisherDependencies,
): Effect.fn.Return<SnapshotPublisher> {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const { state, snapshots } = deps;
  let dirty = true;
  const scheduler = createPublishScheduler(() => publish());

  function publish() {
    const transport = deps.transport();
    if (!transport || !dirty || !state.activeTransport) {
      return;
    }
    dirty = false;
    const inputs = deps.inputs();
    const snapshot = snapshots.next(buildAddonSnapshot({ state, ...inputs }));
    if (snapshot && inputs.connected && !state.firstReadyRevision) {
      state.firstReadyRevision = snapshot.rev;
    }
    if (snapshot) {
      void transport.publish(snapshot).catch((error) => {
        snapshots.invalidate();
        dirty = true;
        runFork(
          Effect.logWarning('Failed to publish reply').pipe(
            Effect.annotateLogs({ event: 'transport.publish_failed', error: errorMessage(error) }),
          ),
        );
      });
    }
  }

  return {
    changed() {
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
    stop: () => scheduler.stop(),
  };
});
