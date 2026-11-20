import type { Logger } from 'pino';
import { buildAddonSnapshot, type AddonSnapshotInputs } from './addon-snapshot.ts';
import { errorMessage } from './errors.ts';
import { createPublishScheduler } from './publish-scheduler.ts';
import type { SessionState } from './session-state.ts';
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
  stop(): void;
}

/** Publishes the addon snapshot to the current transport whenever it changes. */
export function createSnapshotPublisher(deps: SnapshotPublisherDependencies): SnapshotPublisher {
  const { state, snapshots, logger } = deps;
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
    stop: () => scheduler.stop(),
  };
}
