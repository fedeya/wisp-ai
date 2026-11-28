import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Stream } from 'effect';
import { initialSession, layer, layerFrom, SessionState } from '#/session';
import { newChat } from '../../src/chat/chat-lifecycle.ts';

/** Collects the next `count` changes while `act` runs. */
const changesDuring = (count: number, act: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const session = yield* SessionState;
    const changes = yield* session.changes.pipe(
      Stream.take(count),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* act;
    return yield* Fiber.join(changes);
  });

describe('SessionState', () => {
  it.effect('an update stores the session and tells the subscribers', () =>
    Effect.gen(function* () {
      const session = yield* SessionState;
      const changes = yield* changesDuring(
        1,
        session.update((state) => ({ ...state, activeTransport: 'addon' })),
      );
      expect(changes.map((state) => state.activeTransport)).toEqual(['addon']);
      expect((yield* session.get).activeTransport).toBe('addon');
    }).pipe(Effect.provide(layer)),
  );

  it.effect('a staged change reaches the subscribers with the next update', () =>
    Effect.gen(function* () {
      const session = yield* SessionState;
      const changes = yield* changesDuring(
        1,
        Effect.gen(function* () {
          yield* session.stage((state) => ({ ...state, questRevision: 3 }));
          expect((yield* session.get).questRevision).toBe(3);
          yield* session.update((state) => ({ ...state, activeChat: 'chat' }));
        }),
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ questRevision: 3, activeChat: 'chat' });
    }).pipe(Effect.provide(layer)),
  );

  it.effect('each commit is a new value, so subscribers can tell changes apart', () =>
    Effect.gen(function* () {
      const session = yield* SessionState;
      const chat = (yield* session.get).chats[0];
      const changes = yield* changesDuring(
        2,
        Effect.gen(function* () {
          if (chat) chat.title = 'Edited in place';
          yield* session.commit;
          yield* session.commit;
        }),
      );
      expect(changes).toHaveLength(2);
      expect(changes[0]).not.toBe(changes[1]);
      expect(changes[1]?.chats[0]?.title).toBe('Edited in place');
    }).pipe(Effect.provide(layerFrom(initialSession([newChat('chat', 'addon')])))),
  );

  it.effect('a subscriber starts with the next change, not the current session', () =>
    Effect.gen(function* () {
      const session = yield* SessionState;
      yield* session.update((state) => ({ ...state, activeChat: 'before' }));
      const changes = yield* changesDuring(
        1,
        session.update((state) => ({ ...state, activeChat: 'after' })),
      );
      expect(changes.map((state) => state.activeChat)).toEqual(['after']);
    }).pipe(Effect.provide(layer)),
  );
});
