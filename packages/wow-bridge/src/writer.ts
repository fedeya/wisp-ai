// @effect-migrated
import { type Cause, Deferred, Effect, Fiber, Queue } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

interface Write {
  readonly work: Effect.Effect<void, PlatformError>;
  readonly done: Deferred.Deferred<void, PlatformError>;
}

/** The only fiber allowed to write the game files for a connection. */
export const makeWriter = Effect.fnUntraced(function* () {
  const queue = yield* Queue.bounded<Write, Cause.Done>(32);
  const worker = yield* Effect.gen(function* () {
    const write = yield* Queue.take(queue);
    yield* write.work.pipe(
      Effect.onExit((exit) => Effect.sync(() => Deferred.doneUnsafe(write.done, exit))),
      Effect.exit,
      Effect.uninterruptible,
    );
  }).pipe(
    Effect.forever,
    Effect.catchTag('Done', () => Effect.void),
    Effect.forkScoped({ uninterruptible: false }),
  );

  return {
    submit: Effect.fnUntraced(function* (work: Write['work']) {
      const done = yield* Deferred.make<void, PlatformError>();
      if (yield* Queue.offer(queue, { work, done })) {
        yield* Deferred.await(done);
      }
    }),
    close: Effect.andThen(Queue.end(queue), Fiber.join(worker)),
  };
});
