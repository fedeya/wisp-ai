import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import * as Sql from '@wisp/db/sql-database';
import * as AgentHistories from '../src/agent/agent-history.ts';
import * as Memories from '../src/agent/memory-store.ts';
import * as Chats from '../src/chat/chat-store.ts';
import * as Panels from '../src/panels/panel-store.ts';
import * as Routines from '../src/routines/routine-store.ts';

/** A temporary directory for one test, removed when the test ends. */
export class TestDirectory extends Context.Service<
  TestDirectory,
  { readonly root: string; readonly file: string }
>()('@wisp/server/tests/TestDirectory') {}

export const testDirectory = Layer.effect(
  TestDirectory,
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'wisp-test-'))),
    (root) =>
      Effect.promise(() =>
        rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  ).pipe(Effect.map((root) => TestDirectory.of({ root, file: path.join(root, 'wisp.sqlite') }))),
);

export interface StorageOptions {
  chats?: Partial<Chats.ChatStoreOptions>;
  wispVersion?: string;
  now?: () => number;
}

/** Every store over its own connection to `file`, as the runtime composes them. */
export const storageAt = (file: string, options: StorageOptions = {}) =>
  Layer.mergeAll(
    Routines.layer,
    Panels.layer,
    Memories.layer,
    AgentHistories.layer({ wispVersion: options.wispVersion ?? '9.9.9', now: options.now }),
    Chats.layer({ onError: () => {}, ...options.chats }),
  ).pipe(Layer.provideMerge(Sql.layer(file)));

/** Every store over the test directory's database. */
export const storage = (options: StorageOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { file } = yield* TestDirectory;
      return storageAt(file, options);
    }),
  );

/** A fresh database in its own temporary directory, with every store. */
export const testStorage = (options: StorageOptions = {}) =>
  storage(options).pipe(Layer.provideMerge(testDirectory));

/**
 * Runs `work` against another connection to the same file, as a second
 * process or a restarted bridge would; it closes when `work` ends.
 */
export const reopen = <A, E, R>(work: Effect.Effect<A, E, R>, options: StorageOptions = {}) =>
  Effect.gen(function* () {
    const { file } = yield* TestDirectory;
    return yield* work.pipe(Effect.provide(storageAt(file, options)));
  });

/**
 * Every store over `file`, built outside a test Effect for tests that drive
 * time or callbacks themselves; `close` releases the connection.
 */
export async function openStorage(file: string, options: StorageOptions = {}) {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.build(storageAt(file, options)).pipe(Scope.provide(scope)),
  );
  return {
    context,
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof storageAt>>>) =>
      Effect.runPromise(effect.pipe(Effect.provide(context))),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const unexpected = (store: string) => () =>
  Effect.die(Error(`${store} was called, but this test does not use it`));

/** Stores for tests that build a consumer without using them: any call fails the test. */
export const unusedStores = Layer.mergeAll(
  Layer.succeed(
    Routines.RoutineStore,
    Routines.RoutineStore.of({
      recover: unexpected('RoutineStore'),
      list: unexpected('RoutineStore'),
      history: unexpected('RoutineStore'),
      getRun: unexpected('RoutineStore'),
      mutate: unexpected('RoutineStore'),
      observe: unexpected('RoutineStore'),
      claim: unexpected('RoutineStore'),
      finish: unexpected('RoutineStore'),
      skip: unexpected('RoutineStore'),
      defer: unexpected('RoutineStore'),
    }),
  ),
  Layer.succeed(
    Panels.PanelStore,
    Panels.PanelStore.of({
      all: unexpected('PanelStore'),
      list: unexpected('PanelStore'),
      mutate: unexpected('PanelStore'),
    }),
  ),
  Layer.succeed(
    Memories.MemoryStore,
    Memories.MemoryStore.of({
      read: unexpected('MemoryStore'),
      update: unexpected('MemoryStore'),
    }),
  ),
);

/**
 * The conversation store over its own connection to `file`, in a scope of its
 * own: `close` releases it early, as stopping the bridge would, and the test's
 * scope releases it otherwise.
 */
export const chatsAt = Effect.fnUntraced(function* (
  file: string,
  options: Partial<Chats.ChatStoreOptions> = {},
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.build(
    Chats.layer({ onError: () => {}, ...options }).pipe(Layer.provideMerge(Sql.layer(file))),
  ).pipe(Scope.provide(scope));
  const store = Context.get(context, Chats.ChatStore);
  return { ...store, file, close: () => Scope.close(scope, Exit.void) };
});
