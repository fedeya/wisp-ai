import { expect, it } from '@effect/vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event';
import { Effect, Exit, Fiber, Queue, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeEach, vi } from 'vitest';
import {
  AUTO_INSTALL_IDLE_MS,
  createUpdates,
  GAME_CHECK_MS,
  Host,
  makeSession,
  UPDATE_CHECK_MS,
} from './updates-store';
import type { UpdateState } from './updates-store';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const release = { version: '0.3.0', notes: 'Improved game connection.', downgrade: false };

/** What the mocked host answers; `install_update` never settles. */
type Replies = { autoInstall: boolean; gameRunning: boolean };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset().mockResolvedValue(vi.fn());
});

/**
 * Runs a session in its own scope against a mocked host. `commands` receives
 * each native command as it is called, and the host's busy labels.
 */
const start = (replies: Replies, props: Partial<UpdateState> = {}) =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<string>();
    vi.mocked(invoke).mockImplementation((command, args) => {
      Queue.offerUnsafe(commands, command);
      switch (command) {
        case 'update_channel':
          return Promise.resolve('stable');
        case 'update_auto_install':
          return Promise.resolve(replies.autoInstall);
        case 'check_update':
          return Promise.resolve({ supported: true, update: release });
        case 'download_update':
          return Promise.resolve(release.version);
        case 'game_running':
          return Promise.resolve(replies.gameRunning);
        case 'install_update':
          return new Promise(() => {});
        default:
          return Promise.reject(Error(`Unexpected command ${command} ${JSON.stringify(args)}`));
      }
    });
    const { store } = createUpdates();
    store.setState(props);
    const scope = yield* Scope.make();
    const host = Host.of({ busy: (label) => Queue.offer(commands, `busy: ${label}`) });
    const operations = yield* makeSession(store).pipe(
      Effect.provideService(Host, host),
      Scope.provide(scope),
    );
    return {
      store,
      operations,
      stop: Scope.close(scope, Exit.void),
      /** Waits for `command`, skipping the commands before it. */
      called: (command: string) =>
        Effect.repeat(Queue.take(commands), { until: (next) => next === command }),
      /** The commands called since the last look. */
      calledSince: Queue.clear(commands),
      /** Waits for the first state, from now on, that satisfies `holds`. */
      reaches: (holds: (state: UpdateState) => boolean) =>
        Effect.callback<UpdateState>((resume) => {
          const now = store.getState();
          if (holds(now)) return resume(Effect.succeed(now));
          const unsubscribe = store.subscribe((state) => {
            if (holds(state)) resume(Effect.succeed(state));
          });
          return Effect.sync(unsubscribe);
        }),
    };
  });

it.effect('checks at startup and every six hours until the session stops', () =>
  Effect.gen(function* () {
    const { called, calledSince, stop } = yield* start({ autoInstall: false, gameRunning: false });
    yield* called('check_update');
    yield* TestClock.adjust(UPDATE_CHECK_MS - 1);
    expect(yield* calledSince).not.toContain('check_update');
    yield* TestClock.adjust(1);
    yield* called('check_update');

    yield* stop;
    yield* TestClock.adjust(UPDATE_CHECK_MS * 2);
    expect(yield* calledSince).not.toContain('check_update');
  }),
);

it.effect('asks Windows whether WoW runs every 30 seconds while an update waits to install', () =>
  Effect.gen(function* () {
    const { called, calledSince, store } = yield* start({ autoInstall: true, gameRunning: true });
    yield* called('download_update');
    yield* called('game_running');
    yield* TestClock.adjust(GAME_CHECK_MS - 1);
    expect(yield* calledSince).toEqual([]);
    yield* TestClock.adjust(1);
    yield* called('game_running');
    yield* TestClock.adjust(GAME_CHECK_MS);
    yield* called('game_running');

    // An update that no longer installs by itself stops the checks.
    store.setState({ autoFailed: release.version });
    yield* TestClock.adjust(GAME_CHECK_MS * 3);
    expect(yield* calledSince).toEqual([]);
  }),
);

it.effect(
  'installs once WoW stays closed and Wisp idle for ten minutes; activity restarts the wait',
  () =>
    Effect.gen(function* () {
      const { called, calledSince, reaches, store } = yield* start(
        { autoInstall: true, gameRunning: false },
        { idle: true },
      );
      yield* called('game_running');
      yield* reaches((state) => state.gameRunning === false);
      yield* TestClock.adjust(AUTO_INSTALL_IDLE_MS - 1);
      expect(yield* calledSince).not.toContain('install_update');

      store.setState({ idle: false });
      store.setState({ idle: true });
      yield* TestClock.adjust(1);
      expect(yield* calledSince).not.toContain('install_update');
      yield* TestClock.adjust(AUTO_INSTALL_IDLE_MS - 2);
      expect(yield* calledSince).not.toContain('install_update');
      yield* TestClock.adjust(1);
      yield* called('busy: Updating Wisp');
      yield* called('install_update');
      expect(store.getState().operation).toEqual({
        kind: 'installing',
        progress: { phase: 'installing' },
      });
    }),
);

it.effect('a game launch during the wait keeps the update from installing', () =>
  Effect.gen(function* () {
    const replies = { autoInstall: true, gameRunning: false };
    const { called, calledSince, reaches } = yield* start(replies, { idle: true });
    yield* reaches((state) => state.gameRunning === false);
    replies.gameRunning = true;
    yield* TestClock.adjust(GAME_CHECK_MS);
    yield* called('game_running');
    yield* reaches((state) => state.gameRunning === true);
    yield* TestClock.adjust(AUTO_INSTALL_IDLE_MS * 2);
    expect(yield* calledSince).not.toContain('install_update');
  }),
);

it.effect('shows install progress from the host, dropping payloads of another shape', () =>
  Effect.gen(function* () {
    let deliver: EventCallback<unknown> | undefined;
    vi.mocked(listen).mockImplementation(async (_event, handler) => {
      deliver = handler;
      return vi.fn<UnlistenFn>();
    });
    const { called, operations, reaches } = yield* start({
      autoInstall: false,
      gameRunning: false,
    });
    expect(listen).toHaveBeenCalledWith('update-progress', expect.any(Function));
    yield* reaches((state) => state.release !== null && state.operation === null);
    yield* Effect.forkChild(operations.install(null));
    yield* called('install_update');
    deliver?.({ event: 'update-progress', id: 2, payload: { phase: 'downloading', total: '91' } });
    deliver?.({
      event: 'update-progress',
      id: 3,
      payload: { phase: 'downloading', downloaded: 38, total: null },
    });
    const { operation } = yield* reaches(
      (state) =>
        // The first progress shown is the payload of the right shape.
        state.operation?.kind === 'installing' && 'total' in state.operation.progress,
    );
    expect(operation).toEqual({
      kind: 'installing',
      progress: { phase: 'downloading', downloaded: 38, total: null },
    });
  }),
);

it.effect('stopping the session removes the progress listener', () =>
  Effect.gen(function* () {
    const unlisten = vi.fn<UnlistenFn>();
    vi.mocked(listen).mockResolvedValue(unlisten);
    const { called, stop } = yield* start({ autoInstall: false, gameRunning: false });
    yield* called('check_update');
    expect(unlisten).not.toHaveBeenCalled();
    yield* stop;
    expect(unlisten).toHaveBeenCalledOnce();
  }),
);

it.effect('a listener that finishes registering after the session stops is removed at once', () =>
  Effect.gen(function* () {
    let register: ((stop: UnlistenFn) => void) | undefined;
    vi.mocked(listen).mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          register = resolve;
        }),
    );
    const { stop } = yield* start({ autoInstall: false, gameRunning: false });
    const stopping = yield* Effect.forkChild(stop);
    const unlisten = vi.fn<UnlistenFn>();
    register?.(unlisten);
    yield* Fiber.join(stopping);
    expect(unlisten).toHaveBeenCalledOnce();
  }),
);

it.effect('a listener that cannot register is reported', () =>
  Effect.gen(function* () {
    vi.mocked(listen).mockRejectedValue(Error('No event system.'));
    const { reaches } = yield* start({ autoInstall: false, gameRunning: false });
    const { error } = yield* reaches((state) => state.error !== '');
    expect(error).toBe('Update progress is unavailable. Restart Wisp to try again.');
  }),
);
