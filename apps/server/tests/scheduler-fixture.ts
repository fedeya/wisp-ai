import { Context, Effect, Exit, Scope } from 'effect';
import { bridgeLogging } from '../src/logger.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { startRoutineScheduler } from '../src/routines/routine-scheduler.ts';
import type { openStorage } from './storage-fixture.ts';

type Storage = Awaited<ReturnType<typeof openStorage>>;

/** Starts the scheduler in its own scope; the returned stop waits for a routine in progress. */
export function startScheduler(
  storage: Storage,
  deps: Parameters<typeof startRoutineScheduler>[0],
) {
  const scope = Effect.runSync(Scope.make());
  Effect.runSync(
    startRoutineScheduler(deps).pipe(
      Effect.provide(storage.context),
      Effect.provide(bridgeLogging),
      Scope.provide(scope),
    ),
  );
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}

/** The routine store with Promise methods, for assertions between timer steps. */
export function routineStoreOf(storage: Storage) {
  const routines = Context.get(storage.context, RoutineStore);
  return {
    routines,
    store: {
      mutate: (...args: Parameters<typeof routines.mutate>) =>
        storage.run(routines.mutate(...args)),
      observe: (...args: Parameters<typeof routines.observe>) =>
        storage.run(routines.observe(...args)),
      history: () => storage.run(routines.history()),
      list: (characterKey: string) => storage.run(routines.list(characterKey)),
    },
  };
}
