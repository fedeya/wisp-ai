import { describe, expect, it } from '@effect/vitest';
import { Clock, Effect, Option, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { layer, SessionState } from '#/session';
import { make } from '../../src/game/snapshot-publisher.ts';
import { PUBLISH_COALESCE_MS, PUBLISH_MIN_INTERVAL_MS } from '../../src/game/publish-scheduler.ts';

/** What the snapshot shows besides the session; the tests only change the session. */
const inputs = {
  connected: true,
  bridgeVersion: '1.0.0',
  expectedAddonVersion: '1.0.0',
  appUpdateVersion: null,
  features: {},
  contextWindowTokens: undefined,
  defaultModel: 'model',
  panels: [],
  routines: [],
  routineRuns: [],
  routinesAllowed: false,
  capabilities: [],
};

interface Publish {
  readonly at: number;
  readonly activeChat: unknown;
}

/**
 * A publisher on the `SessionState` it is given, over a transport that records
 * each snapshot with the virtual time it was written at. `connected` switches
 * the transport, and the session starts on a game session as a hello leaves it.
 */
const publisher = (connected = true) =>
  Effect.gen(function* () {
    const session = yield* SessionState;
    yield* session.update((state) => ({ ...state, activeTransport: 'addon' }));
    const published = yield* Ref.make<readonly Publish[]>([]);
    const transportConnected = yield* Ref.make(connected);
    const transport = {
      publish: (snapshot: unknown) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            Ref.update(published, (all) => [
              ...all,
              {
                at,
                activeChat:
                  typeof snapshot === 'object' && snapshot !== null && 'activeChat' in snapshot
                    ? snapshot.activeChat
                    : undefined,
              },
            ]),
          ),
        ),
    };
    const service = yield* make({
      transport: Ref.get(transportConnected).pipe(
        Effect.map((up) => (up ? Option.some(transport) : Option.none())),
      ),
      inputs: Effect.succeed(inputs),
    });
    // Lets the subscription hear about what was just stored.
    const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 3 }));
    const change = (activeChat: string) =>
      session.update((state) => ({ ...state, activeChat })).pipe(Effect.andThen(settle));
    return {
      service,
      session,
      change,
      settle,
      published: Ref.get(published),
      connect: Ref.set(transportConnected, true),
    };
  });

describe('SnapshotPublisher', () => {
  it.effect('a change publishes once, after the coalescing window', () =>
    Effect.gen(function* () {
      const f = yield* publisher();
      yield* f.change('chat');
      yield* TestClock.adjust(PUBLISH_COALESCE_MS - 1);
      expect(yield* f.published).toEqual([]);
      yield* TestClock.adjust(1);
      expect(yield* f.published).toEqual([{ at: PUBLISH_COALESCE_MS, activeChat: 'chat' }]);
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS * 3);
      expect(yield* f.published).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect('a streamed burst publishes as the scheduler did before the session moved', () =>
    Effect.gen(function* () {
      const f = yield* publisher();
      // A change every 10ms for two seconds, like a streaming reply: 200 changes.
      for (let t = 0; t < 2000; t += 10) {
        yield* f.change('chat-' + t);
        yield* TestClock.adjust(10);
      }
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS);
      const published = yield* f.published;
      // The same six writes, at the same times, that `changed()` gave this burst.
      expect(published.map(({ at }) => at)).toEqual([50, 450, 850, 1250, 1650, 2050]);
      expect(published.at(-1)?.activeChat).toBe('chat-1990');
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect('updates made in one go publish one snapshot of the last one', () =>
    Effect.gen(function* () {
      const f = yield* publisher();
      for (let i = 0; i < 1000; i++) {
        yield* f.session.update((state) => ({ ...state, activeChat: 'chat-' + i }));
      }
      yield* f.settle;
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS * 3);
      expect(yield* f.published).toEqual([{ at: PUBLISH_COALESCE_MS, activeChat: 'chat-999' }]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect('a flush publishes the change it follows now, and only once', () =>
    Effect.gen(function* () {
      const f = yield* publisher();
      yield* f.session.update((state) => ({ ...state, activeChat: 'first-text' }));
      yield* f.service.flush;
      expect(yield* f.published).toEqual([{ at: 0, activeChat: 'first-text' }]);
      yield* f.settle;
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS * 3);
      expect(yield* f.published).toHaveLength(1);
      // The window the flushed change opened still spaces the next publish.
      yield* TestClock.adjust(1);
      yield* f.change('next');
      yield* TestClock.adjust(PUBLISH_COALESCE_MS);
      expect((yield* f.published).map(({ activeChat }) => activeChat)).toEqual([
        'first-text',
        'next',
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect('a staged change waits for an update, and invalidate publishes it', () =>
    Effect.gen(function* () {
      const f = yield* publisher();
      yield* f.change('first');
      yield* TestClock.adjust(PUBLISH_COALESCE_MS);
      yield* f.session.stage((state) => ({ ...state, activeChat: 'staged' }));
      yield* f.settle;
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS * 3);
      expect((yield* f.published).map(({ activeChat }) => activeChat)).toEqual(['first']);
      yield* f.service.invalidate;
      yield* TestClock.adjust(PUBLISH_COALESCE_MS);
      expect((yield* f.published).map(({ activeChat }) => activeChat)).toEqual(['first', 'staged']);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect('a snapshot left stale without a transport is published once one connects', () =>
    Effect.gen(function* () {
      const f = yield* publisher(false);
      yield* f.change('waiting');
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS);
      expect(yield* f.published).toEqual([]);
      yield* f.connect;
      // The next poll schedules it; it is written after the coalescing window.
      yield* TestClock.adjust(PUBLISH_MIN_INTERVAL_MS + PUBLISH_COALESCE_MS);
      const published = yield* f.published;
      expect(published.map(({ activeChat }) => activeChat)).toEqual(['waiting']);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
