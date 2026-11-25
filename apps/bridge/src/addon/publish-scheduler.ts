import { Clock, Effect, FiberHandle } from 'effect';

/** Trailing window that coalesces a burst of `changed()` calls into one snapshot. */
export const PUBLISH_COALESCE_MS = 50;
/**
 * Minimum spacing between snapshot publishes. This was the old fixed poll
 * period; keeping it as a floor preserves the addon's disk pacing (a legacy
 * addon rewrites Payload.lua and the control file on every publish) while
 * still bounding change-to-publish latency by the same 400ms.
 */
export const PUBLISH_MIN_INTERVAL_MS = 400;

export interface PublishScheduler {
  /** Request a publish; repeated calls before it fires coalesce into one. */
  schedule(): void;
}

/**
 * Publishes after a burst of changes settles, at most once per interval. The
 * pending publish is a fiber in the caller's scope; closing the scope cancels
 * it and ignores later requests.
 */
export const makePublishScheduler = Effect.fn('PublishScheduler.make')(function* (
  publish: () => void,
  {
    coalesceMs = PUBLISH_COALESCE_MS,
    minIntervalMs = PUBLISH_MIN_INTERVAL_MS,
  }: { coalesceMs?: number; minIntervalMs?: number } = {},
) {
  const run = yield* FiberHandle.makeRuntime<never, never, void>();
  let lastPublishAt = -Infinity;
  const pending = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.sleep(Math.max(coalesceMs, lastPublishAt + minIntervalMs - now));
    lastPublishAt = yield* Clock.currentTimeMillis;
    publish();
  });
  return {
    schedule: () => void run(pending, { onlyIfMissing: true }),
  } satisfies PublishScheduler;
});
