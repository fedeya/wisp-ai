import { assert, it } from '@effect/vitest';
import { Clock, Effect, Exit, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import {
  makePublishScheduler,
  PUBLISH_COALESCE_MS,
  PUBLISH_MIN_INTERVAL_MS,
} from '../src/addon/publish-scheduler.ts';

/** A scheduler whose publishes are recorded at the test clock's time. */
const recorded = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const at: number[] = [];
  const scheduler = yield* makePublishScheduler(() => at.push(clock.currentTimeMillisUnsafe()));
  return { at, scheduler };
});

it.effect('a single change publishes after the short coalescing window', () =>
  Effect.gen(function* () {
    const { at, scheduler } = yield* recorded;
    scheduler.schedule();
    yield* TestClock.adjust(PUBLISH_COALESCE_MS - 1);
    assert.equal(at.length, 0);
    yield* TestClock.adjust(1);
    assert.equal(at.length, 1);
  }),
);

it.effect('a burst of changes coalesces into one publish', () =>
  Effect.gen(function* () {
    const { at, scheduler } = yield* recorded;
    for (let i = 0; i < 20; i++) {
      scheduler.schedule();
      yield* TestClock.adjust(1);
    }
    yield* TestClock.adjust(PUBLISH_COALESCE_MS);
    assert.equal(at.length, 1);
  }),
);

it.effect('publishes keep the minimum interval and never wait longer than it', () =>
  Effect.gen(function* () {
    const { at, scheduler } = yield* recorded;
    // A change every 10ms for two seconds, like a streaming reply.
    for (let t = 0; t < 2000; t += 10) {
      scheduler.schedule();
      yield* TestClock.adjust(10);
    }
    yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS);
    assert.equal(at[0], PUBLISH_COALESCE_MS);
    for (let i = 1; i < at.length; i++) {
      assert.equal(at[i] - at[i - 1], PUBLISH_MIN_INTERVAL_MS);
    }
    assert.equal(at.length, 6);
  }),
);

it.effect('a change right after a publish waits out the interval, not longer', () =>
  Effect.gen(function* () {
    const { at, scheduler } = yield* recorded;
    scheduler.schedule();
    yield* TestClock.adjust(PUBLISH_COALESCE_MS);
    scheduler.schedule();
    yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS - 1);
    assert.equal(at.length, 1);
    yield* TestClock.adjust(1);
    assert.equal(at.length, 2);
  }),
);

it.effect('an idle change after a quiet period publishes after the coalescing window', () =>
  Effect.gen(function* () {
    const { at, scheduler } = yield* recorded;
    scheduler.schedule();
    yield* TestClock.adjust(5000);
    scheduler.schedule();
    yield* TestClock.adjust(PUBLISH_COALESCE_MS);
    assert.equal(at.length, 2);
  }),
);

it.effect('closing the scope cancels a pending publish and ignores later requests', () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { at, scheduler } = yield* recorded.pipe(Scope.provide(scope));
    scheduler.schedule();
    yield* Scope.close(scope, Exit.void);
    scheduler.schedule();
    yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS * 10);
    assert.equal(at.length, 0);
  }),
);
