import { Effect } from 'effect';
import { buildAddonSnapshot, type AddonSnapshotInputs } from './addon-snapshot.ts';
import { createPublishScheduler } from './publish-scheduler.ts';
import type { SessionState } from '../session-state.ts';
import type { Connection } from '@wisp/wow-bridge';

export interface SnapshotPublisherDependencies {
  state: SessionState;
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
  const { state } = deps;
  let dirty = true;
  const scheduler = createPublishScheduler(() => publish());

  function publish() {
    const transport = deps.transport();
    if (!transport || !dirty || !state.activeTransport) {
      return;
    }
    dirty = false;
    runFork(transport.publish(buildAddonSnapshot({ state, ...deps.inputs() })));
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
