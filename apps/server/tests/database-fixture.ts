import { Effect, Exit, Scope } from 'effect';
import * as Sql from '@wisp/db/sql-database';
import { openChatStore, type ChatStore, type ChatStoreOptions } from '../src/chat/chat-store.ts';
import type { Chat } from '../src/chat/chat.ts';

/** Opens application databases for a test and closes them all at the end. */
export function databaseScope() {
  const scope = Effect.runSync(Scope.make());
  return {
    open(file: string): Promise<Sql.SqlDatabase['Service']> {
      return Effect.runPromise(Sql.make(file).pipe(Scope.provide(scope)));
    },
    /** Runs a scoped Effect, such as a store constructor, in this test's scope. */
    run<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
      return Effect.runPromise(effect.pipe(Scope.provide(scope)));
    },
    close(): Promise<void> {
      return Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

type Promised<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : T[K];
};

/** A store's Effect operations as Promises, for tests that call them one by one. */
export function promised<T extends object>(store: T): Promised<T> {
  return Object.fromEntries(
    Object.entries(store).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            const result: unknown = value(...args);
            return Effect.isEffect(result)
              ? Effect.runPromise(result as Effect.Effect<unknown, unknown>)
              : result;
          }
        : value,
    ]),
  ) as Promised<T>;
}

/**
 * A conversation store over its own connection to `file`, with the Promise
 * methods the tests use; `close` waits for saves and closes the connection.
 */
export function chatStoreAt(
  file: string,
  onError: (error: unknown) => void,
  legacyFile?: string,
  options: Omit<ChatStoreOptions, 'onError' | 'legacyFile'> = {},
) {
  const scope = Effect.runSync(Scope.make());
  let opening: Promise<ChatStore> | undefined;
  const store = () =>
    (opening ??= Effect.runPromise(
      openChatStore(file, { onError, legacyFile, ...options }).pipe(Scope.provide(scope)),
    ));
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return {
    file,
    async load() {
      try {
        return await Effect.runPromise((await store()).load());
      } catch (error) {
        await close();
        throw error;
      }
    },
    async flush(chats: Chat[]) {
      await Effect.runPromise((await store()).flush(chats));
    },
    schedule(snapshot: () => Chat[]) {
      void store().then((opened) => opened.schedule(snapshot));
    },
    close,
  };
}
