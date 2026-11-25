import { Effect, Exit, Scope } from 'effect';
import type { AppRuntime, AppServices } from './app-runtime.ts';

/**
 * The bridge's lifetime as an Effect scope. Cleanup registered with `defer`
 * runs in reverse order when the scope closes, and fibers started with `fork`
 * are interrupted then; a failing cleanup does not stop the rest, and the
 * failures are reported together once everything has run.
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

  /** Runs a long-lived Effect on the app runtime until the bridge scope closes. */
  fork<E>(runtime: AppRuntime, effect: Effect.Effect<unknown, E, AppServices>) {
    runtime.runSync(Effect.forkIn(effect, this.scope));
  }

  close(): Promise<void> {
    return (this.closing ??= Effect.runPromise(Scope.close(this.scope, Exit.void)).then(() => {
      if (this.errors.length) {
        throw new AggregateError(this.errors, 'Runtime cleanup failed');
      }
    }));
  }
}
