import { Effect } from 'effect';
import type { Logger } from '../logger.ts';
import { buildAddonSnapshot, type AddonSnapshotInputs } from './addon-snapshot.ts';
import { errorMessage } from '../errors.ts';
import { makePublishScheduler } from './publish-scheduler.ts';
import type { SessionState } from '../session-state.ts';
import type { SnapshotGate } from './snapshots.ts';
import type { DiskTransport } from './transport.ts';

export interface SnapshotPublisherDependencies {
  state: SessionState;
  snapshots: SnapshotGate;
  transport: () => Pick<DiskTransport, 'publish'> | undefined;
  /** Everything the snapshot shows besides `state`, read at publish time. */
  inputs: () => Omit<AddonSnapshotInputs, 'state'>;
  logger: Pick<Logger, 'warn'>;
}

export interface SnapshotPublisher {
  /** Mark the snapshot stale and schedule a coalesced publish. */
  changed(): void;
  /** Publish on the next microtask, skipping the coalescing window. */
  flush(): void;
  /** Re-schedule a publish that is still stale (no transport, or a failed write). */
  retry(): void;
}

/**
 * Publishes the addon snapshot to the current transport whenever it changes,
 * until the caller's scope closes.
 */
export const makeSnapshotPublisher = Effect.fn('SnapshotPublisher.make')(function* (
  deps: SnapshotPublisherDependencies,
) {
  const { state, snapshots, logger } = deps;
  let dirty = true;
  const scheduler = yield* makePublishScheduler(() => publish());

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
        logger.warn(
          { event: 'transport.publish_failed', error: errorMessage(error) },
          'Failed to publish reply',
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
  } satisfies SnapshotPublisher;
});
