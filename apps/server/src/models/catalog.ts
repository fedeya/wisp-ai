// @effect-migrated
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { AccountModel } from '../chat/chat-model.ts';
import { errorMessage } from '../errors.ts';
import { ModelConnections } from './connections.ts';

/** The models the player can choose, or why they could not be loaded. */
export interface CatalogState {
  readonly models: readonly AccountModel[];
  /** Why the last load failed; the catalog is then empty. */
  readonly error: Option.Option<string>;
}

/**
 * The account model catalog the addon shows, loaded from `ModelConnections`
 * when something asks for a refresh.
 */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly current: Effect.Effect<CatalogState>;
    /**
     * Each catalog a refresh stores, starting with the next one. Subscribe
     * before asking for the refresh whose result you need.
     */
    readonly changes: Stream.Stream<CatalogState>;
    /**
     * Reloads the catalog and waits for it. A call made while a reload runs
     * shares it. Never fails: a failure empties the catalog and records why.
     */
    readonly refresh: Effect.Effect<void>;
  }
>()('@wisp/server/models/ModelCatalog') {}

const make = Effect.gen(function* () {
  const connections = yield* ModelConnections;
  const ref = yield* SubscriptionRef.make<CatalogState>({ models: [], error: Option.none() });
  // Settles when the reload in progress, if any, ends. It belongs to no scope:
  // the server keeps calling `refresh` after the layer that built it is done.
  const running = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
  // Finding the reload in progress and starting one happen together.
  const starting = yield* Semaphore.make(1);

  const reload = connections.models.pipe(
    Effect.map((models): CatalogState => ({ models, error: Option.none() })),
    Effect.catch((error) =>
      Effect.succeed<CatalogState>({ models: [], error: Option.some(errorMessage(error)) }),
    ),
    Effect.flatMap((next) => SubscriptionRef.set(ref, next)),
    Effect.withSpan('ModelCatalog.reload'),
  );

  // The reload in progress, or a new one this call runs and the calls made meanwhile join.
  const claim = starting.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(running);
      if (Option.isSome(current)) {
        return { runs: false, done: current.value };
      }
      const done = yield* Deferred.make<void>();
      yield* Ref.set(running, Option.some(done));
      return { runs: true, done };
    }),
  );

  const refresh = Effect.gen(function* () {
    const { runs, done } = yield* claim;
    if (!runs) {
      return yield* Deferred.await(done);
    }
    yield* reload.pipe(
      Effect.ensuring(
        Ref.set(running, Option.none()).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      ),
    );
  }).pipe(Effect.withSpan('ModelCatalog.refresh'));

  return ModelCatalog.of({
    current: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    refresh,
  });
});

/** The account model catalog, loaded from the `ModelConnections` it is given. */
export const layer = Layer.effect(ModelCatalog, make);
