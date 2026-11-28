import { expect, it } from '@effect/vitest';
import { invoke } from '@tauri-apps/api/core';
import type { InstallerStatus } from '@wisp/protocol/native-commands';
import { Effect, Exit, Queue, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeEach, vi } from 'vitest';
import { createUpdater, makeSession, STATUS_POLL_MS } from './updater-store';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

const installing = (percent: number): InstallerStatus => ({
  phase: 'installing',
  percent,
  log: [],
  error: null,
});
const failed: InstallerStatus = {
  phase: 'failed',
  percent: null,
  log: ['Installer failed'],
  error: 'Installation failed.',
};

/**
 * Runs the window's session in its own scope. Each `updater_status` request
 * waits in `statuses` until the test answers it with `answer`.
 */
const start = (ready: () => Promise<null> = () => Promise.resolve(null)) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<(status: InstallerStatus | Error) => void>();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'updater_ready') return ready();
      if (command === 'updater_close') return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        Queue.offerUnsafe(requests, (status) =>
          status instanceof Error ? reject(status) : resolve(status),
        );
      });
    });
    const { store } = createUpdater();
    const scope = yield* Scope.make();
    const session = yield* makeSession(store).pipe(Scope.provide(scope));
    return {
      store,
      session,
      stop: Scope.close(scope, Exit.void),
      /** Waits for the next status request and answers it. */
      answer: (status: InstallerStatus | Error) =>
        Effect.flatMap(Queue.take(requests), (respond) => Effect.sync(() => respond(status))),
      /** Status requests waiting for an answer. */
      waiting: Queue.size(requests),
      /** Waits until the store shows `phase`. */
      shows: (phase: InstallerStatus['phase']) =>
        Effect.callback<void>((resume) => {
          if (store.getState().phase === phase) return resume(Effect.void);
          return Effect.sync(
            store.subscribe((status) => {
              if (status.phase === phase) resume(Effect.void);
            }),
          );
        }),
    };
  });

it.effect('reads the status 120 ms after each read finishes until the installation fails', () =>
  Effect.gen(function* () {
    const { answer, shows, store, waiting } = yield* start();
    yield* answer(installing(10));
    yield* shows('installing');
    expect(store.getState().percent).toBe(10);
    yield* TestClock.adjust(STATUS_POLL_MS - 1);
    expect(yield* waiting).toBe(0);
    yield* TestClock.adjust(1);
    expect(yield* waiting).toBe(1);

    // A slow read delays the next one: the window waits after each answer.
    yield* TestClock.adjust(STATUS_POLL_MS * 4);
    expect(yield* waiting).toBe(1);
    yield* answer(Error('The installer closed.'));
    yield* TestClock.adjust(STATUS_POLL_MS - 1);
    expect(yield* waiting).toBe(0);
    yield* TestClock.adjust(1);
    yield* answer(failed);
    yield* shows('failed');
    expect(store.getState().log).toEqual(['Installer failed']);

    yield* TestClock.adjust(STATUS_POLL_MS * 10);
    expect(yield* waiting).toBe(0);
  }),
);

it.effect('stopping the session stops the reads', () =>
  Effect.gen(function* () {
    const { answer, stop, waiting } = yield* start();
    yield* answer(installing(10));
    yield* stop;
    yield* TestClock.adjust(STATUS_POLL_MS * 10);
    expect(yield* waiting).toBe(0);
  }),
);

it.effect('a window that cannot report ready reads no status', () =>
  Effect.gen(function* () {
    const { waiting } = yield* start(() => Promise.reject(Error('No installer.')));
    yield* TestClock.adjust(STATUS_POLL_MS * 10);
    expect(yield* waiting).toBe(0);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('updater_ready', undefined);
  }),
);

it.effect('closing the window asks the host to close it', () =>
  Effect.gen(function* () {
    const { session } = yield* start();
    yield* session.close;
    expect(invoke).toHaveBeenCalledWith('updater_close', undefined);
  }),
);
