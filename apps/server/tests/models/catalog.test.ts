import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from 'effect';
import * as ModelCatalog from '../../src/models/catalog.ts';
import { ModelConnections } from '../../src/models/connections.ts';
import { ChatGPTAuthError } from '#/auth';
import type { AccountModel } from '../../src/chat/chat-model.ts';

const model: AccountModel = { slug: 'luna', displayName: 'Luna', efforts: [] };

/** Connections whose `models` runs `load`; nothing else is used by the catalog. */
const connectionsLayer = (load: Effect.Effect<AccountModel[], ChatGPTAuthError>) =>
  Layer.succeed(
    ModelConnections,
    ModelConnections.of({
      list: Effect.succeed([]),
      hasProvider: Effect.succeed(true),
      connected: () => Effect.succeed(true),
      provider: () => Effect.succeed('chatgpt'),
      selection: () => Effect.succeedNone,
      save: () => Effect.die('Unused'),
      remove: () => Effect.die('Unused'),
      models: load,
      prepare: () => Effect.die('Unused'),
      complete: () => Effect.die('Unused'),
      test: () => Effect.die('Unused'),
      discover: () => Effect.die('Unused'),
      forward: () => Effect.die('Unused'),
    }),
  );

const catalogWith = (load: Effect.Effect<AccountModel[], ChatGPTAuthError>) =>
  ModelCatalog.layer.pipe(Layer.provide(connectionsLayer(load)));

describe('ModelCatalog', () => {
  it.effect('a refresh stores the models and emits them once', () =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog.ModelCatalog;
      const changes = yield* catalog.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* catalog.refresh;
      expect(yield* Fiber.join(changes)).toEqual([{ models: [model], error: Option.none() }]);
      expect(yield* catalog.current).toEqual({ models: [model], error: Option.none() });
    }).pipe(Effect.provide(catalogWith(Effect.succeed([model])))),
  );

  it.effect('a failed load empties the catalog and records why', () =>
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog.ModelCatalog;
      yield* catalog.refresh;
      expect(yield* catalog.current).toEqual({
        models: [],
        error: Option.some('Could not load models for this ChatGPT account.'),
      });
    }).pipe(
      Effect.provide(
        catalogWith(
          Effect.fail(
            new ChatGPTAuthError({ message: 'Could not load models for this ChatGPT account.' }),
          ),
        ),
      ),
    ),
  );

  // `startServer` keeps the server running after the effect that built its services returns.
  it.effect('a refresh still loads after the layer that built the catalog is released', () =>
    Effect.gen(function* () {
      const catalog = yield* Effect.scoped(
        Layer.build(catalogWith(Effect.succeed([model]))).pipe(
          Effect.map((context) => Context.get(context, ModelCatalog.ModelCatalog)),
        ),
      );
      yield* catalog.refresh;
      expect((yield* catalog.current).models).toEqual([model]);
    }),
  );

  it.effect('refreshes made while a reload runs share it', () => {
    let loads = 0;
    return Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      return { release };
    }).pipe(
      Effect.flatMap(({ release }) =>
        Effect.gen(function* () {
          const catalog = yield* ModelCatalog.ModelCatalog;
          const first = yield* Effect.forkChild(catalog.refresh, { startImmediately: true });
          const second = yield* Effect.forkChild(catalog.refresh, { startImmediately: true });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(loads).toBe(1);
          // The next refresh loads again.
          yield* catalog.refresh;
          expect(loads).toBe(2);
        }).pipe(
          Effect.provide(
            catalogWith(
              Effect.suspend(() => {
                loads++;
                return Deferred.await(release).pipe(Effect.as([model]));
              }),
            ),
          ),
        ),
      ),
    );
  });
});
