import { describe, expect, it } from '@effect/vitest';
import { Clock, Effect, Exit, Ref, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import {
  make,
  PUBLISH_COALESCE_MS,
  PUBLISH_MIN_INTERVAL_MS,
} from '../../src/game/publish-scheduler.ts';

/** A scheduler whose runs record the virtual time they happened at. */
const recording = Effect.gen(function* () {
  const runs = yield* Ref.make<readonly number[]>([]);
  const scheduler = yield* make(
    Clock.currentTimeMillis.pipe(Effect.flatMap((at) => Ref.update(runs, (all) => [...all, at]))),
  );
  return { schedule: scheduler.schedule, runs: Ref.get(runs) };
});

describe('PublishScheduler', () => {
  it.effect('a single request runs after the short coalescing window', () =>
    Effect.gen(function* () {
      const { schedule, runs } = yield* recording;
      yield* schedule;
      yield* TestClock.adjust(PUBLISH_COALESCE_MS - 1);
      expect(yield* runs).toEqual([]);
      yield* TestClock.adjust(1);
      expect(yield* runs).toEqual([PUBLISH_COALESCE_MS]);
    }).pipe(Effect.scoped),
  );

  it.effect('a burst of requests coalesces into one run', () =>
    Effect.gen(function* () {
      const { schedule, runs } = yield* recording;
      for (let i = 0; i < 20; i++) {
        yield* schedule;
        yield* TestClock.adjust(1);
      }
      yield* TestClock.adjust(PUBLISH_COALESCE_MS);
      expect(yield* runs).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect('runs keep the minimum interval and never wait longer than it', () =>
    Effect.gen(function* () {
      const { schedule, runs } = yield* recording;
      // A request every 10ms for two seconds, like a streaming reply.
      for (let t = 0; t < 2000; t += 10) {
        yield* schedule;
        yield* TestClock.adjust(10);
      }
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS);
      const at = yield* runs;
      expect(at).toEqual([50, 450, 850, 1250, 1650, 2050]);
    }).pipe(Effect.scoped),
  );

  it.effect('a request right after a run waits out the interval, not longer', () =>
    Effect.gen(function* () {
      const { schedule, runs } = yield* recording;
      yield* schedule;
      yield* TestClock.adjust(PUBLISH_COALESCE_MS);
      yield* schedule;
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS - 1);
      expect(yield* runs).toHaveLength(1);
      yield* TestClock.adjust(1);
      expect(yield* runs).toEqual([
        PUBLISH_COALESCE_MS,
        PUBLISH_COALESCE_MS + PUBLISH_MIN_INTERVAL_MS,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect('an idle request after a quiet period runs after the coalescing window', () =>
    Effect.gen(function* () {
      const { schedule, runs } = yield* recording;
      yield* schedule;
      yield* TestClock.adjust(5000);
      yield* schedule;
      yield* TestClock.adjust(PUBLISH_COALESCE_MS);
      expect(yield* runs).toEqual([PUBLISH_COALESCE_MS, 5000 + PUBLISH_COALESCE_MS]);
    }).pipe(Effect.scoped),
  );

  it.effect('closing the scope cancels a pending run', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { schedule, runs } = yield* recording.pipe(Scope.provide(scope));
      yield* schedule;
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS);
      expect(yield* runs).toEqual([]);
    }),
  );
});
