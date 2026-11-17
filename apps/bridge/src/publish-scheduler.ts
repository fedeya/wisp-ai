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
  /** Cancel any pending publish and ignore later requests. */
  stop(): void;
}

export function createPublishScheduler(
  publish: () => void,
  {
    coalesceMs = PUBLISH_COALESCE_MS,
    minIntervalMs = PUBLISH_MIN_INTERVAL_MS,
    now = Date.now,
  }: { coalesceMs?: number; minIntervalMs?: number; now?: () => number } = {},
): PublishScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPublishAt = -Infinity;
  let stopped = false;
  function run() {
    timer = undefined;
    lastPublishAt = now();
    publish();
  }
  return {
    schedule() {
      if (stopped || timer) return;
      const wait = Math.max(coalesceMs, lastPublishAt + minIntervalMs - now());
      timer = setTimeout(run, wait);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
