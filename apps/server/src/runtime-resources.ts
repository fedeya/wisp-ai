import { Cause, Effect, Exit, Scope } from 'effect';

export function releaseRuntimeResource(dispose: () => void | Promise<unknown>) {
  return Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: async () => dispose(),
      catch: (error) => error,
    }).pipe(Effect.orDie),
  );
}

export function closeRuntimeScope(scope: Scope.Closeable, exit: Exit.Exit<unknown, unknown>) {
  return Scope.close(scope, exit).pipe(
    Effect.catchCause((cause) => {
      const errors = cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect);
      return Effect.fail(new AggregateError(errors, 'Runtime cleanup failed'));
    }),
  );
}

/** Promise boundary for callers that start and stop the bridge outside Effect. */
export class RuntimeResources {
  readonly scope = Scope.makeUnsafe();
  private closing?: Promise<void>;

  defer(dispose: () => void | Promise<unknown>) {
    Effect.runSync(releaseRuntimeResource(dispose).pipe(Scope.provide(this.scope)));
  }

  close(exit: Exit.Exit<unknown, unknown> = Exit.void): Promise<void> {
    return (this.closing ??= Effect.runPromise(closeRuntimeScope(this.scope, exit)));
  }
}
