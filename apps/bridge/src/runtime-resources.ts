import { Effect, Exit, Scope } from 'effect';
import { bridgeRuntime } from './logger.ts';

/**
 * The bridge's lifetime as an Effect scope. Cleanup registered with `defer`
 * (or `acquire` for Effect resources) runs in reverse order when the scope
 * closes; a failing cleanup does not stop the rest, and the failures are
 * reported together once everything has run.
 */
export class RuntimeResources {
  readonly scope = Scope.makeUnsafe('sequential');
  private errors: unknown[] = [];
  private closing?: Promise<void>;

  defer(dispose: () => void | Promise<unknown>) {
    Effect.runSync(
      Scope.addFinalizer(
        this.scope,
        Effect.tryPromise({ try: async () => dispose(), catch: (error) => error }).pipe(
          Effect.catch((error) => Effect.sync(() => void this.errors.push(error))),
        ),
      ),
    );
  }

  /** Runs an Effect resource in the bridge scope; its release runs on close. */
  acquire<A, E>(resource: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
    return bridgeRuntime.runPromise(Scope.provide(resource, this.scope));
  }

  close(): Promise<void> {
    return (this.closing ??= Effect.runPromise(Scope.close(this.scope, Exit.void)).then(() => {
      if (this.errors.length) {
        throw new AggregateError(this.errors, 'Runtime cleanup failed');
      }
    }));
  }
}
