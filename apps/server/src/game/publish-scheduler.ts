// @effect-migrated
import { Clock, Effect, Ref } from 'effect';
import type { Scope } from 'effect';

/** Trailing window that coalesces a burst of changes into one snapshot. */
export const PUBLISH_COALESCE_MS = 50;
/**
 * Minimum spacing between snapshot publishes. This was the old fixed poll
 * period; keeping it as a floor preserves the addon's disk pacing (a legacy
 * addon rewrites Payload.lua and the control file on every publish) while
 * still bounding change-to-publish latency by the same 400ms.
 */
export const PUBLISH_MIN_INTERVAL_MS = 400;

export interface PublishScheduler {
  /** Requests a publish; requests made before it runs coalesce into one. */
  readonly schedule: Effect.Effect<void>;
}

export interface PublishSchedulerOptions {
  readonly coalesceMs?: number;
  readonly minIntervalMs?: number;
}

/**
 * Runs `publish` once for each burst of requests: the coalescing window after
 * the first one, and no sooner than the minimum interval after the previous
 * run. A pending run is interrupted when the scope closes.
 */
export const make = Effect.fnUntraced(function* (
  publish: Effect.Effect<void>,
  {
    coalesceMs = PUBLISH_COALESCE_MS,
    minIntervalMs = PUBLISH_MIN_INTERVAL_MS,
  }: PublishSchedulerOptions = {},
): Effect.fn.Return<PublishScheduler, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const pending = yield* Ref.make(false);
  const lastRunAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const run = Effect.gen(function* () {
    yield* Ref.set(pending, false);
    yield* Ref.set(lastRunAt, yield* Clock.currentTimeMillis);
    yield* publish;
  });
  return {
    schedule: Effect.gen(function* () {
      if (yield* Ref.getAndSet(pending, true)) return;
      const wait = Math.max(
        coalesceMs,
        (yield* Ref.get(lastRunAt)) + minIntervalMs - (yield* Clock.currentTimeMillis),
      );
      yield* Effect.sleep(wait).pipe(
        Effect.andThen(run),
        Effect.forkIn(scope, { startImmediately: true }),
      );
    }),
  };
});
