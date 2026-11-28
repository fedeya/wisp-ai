import { expect, it } from '@effect/vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { Clock, Effect, Fiber, Option, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeEach, vi } from 'vitest';
import { Host, run } from './bridge-lifecycle';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const info = {
  configured: true,
  wow: 'E:\\WoW',
  dataDirectory: 'userdata',
  platform: 'windows',
  version: '0.0.1',
};

beforeEach(() => {
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) => (command === 'desktop_info' ? info : null));
  vi.mocked(listen).mockReset().mockResolvedValue(vi.fn());
});

/** A desktop session that reports, in order, what the lifecycle asks of it. */
const recordingHost = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<string>();
  const record = (request: string) => Queue.offer(requests, request);
  const host = Host.of({
    launchBridge: record('launch'),
    pollStatus: Effect.flatMap(Clock.currentTimeMillis, (now) => record(`poll at ${now}`)),
    refresh: record('refresh'),
    desktopInfo: (desktop) => record(`info for ${desktop.wow}`),
    addonUpdate: () => record('addon update'),
    addonUpdating: (updating) => record(`addon updating: ${updating}`),
    error: (message) => record(`error: ${message}`),
    initializationError: (message) => record(`initialization error: ${message}`),
  });
  const lifecycle = yield* run.pipe(Effect.provideService(Host, host), Effect.forkChild);
  return { lifecycle, next: Queue.take(requests), pending: Queue.poll(requests) };
});

/** Waits until the lifecycle has asked the host to listen for `desktop-error`. */
const listening = Effect.promise(() => vi.waitUntil(() => vi.mocked(listen).mock.calls.length > 0));

it.effect('starts the bridge, then reads the host info and the status', () =>
  Effect.gen(function* () {
    const { next } = yield* recordingHost;
    expect(yield* next).toBe('launch');
    expect(yield* next).toBe('info for E:\\WoW');
    expect(yield* next).toBe('refresh');
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      'desktop_info',
      'auto_update_addon',
    ]);
  }),
);

it.effect('polls the status every 3 seconds from mount until the lifecycle stops', () =>
  Effect.gen(function* () {
    const { lifecycle, next, pending } = yield* recordingHost;
    yield* Effect.repeat(next, { until: (request) => request === 'refresh' });
    yield* TestClock.adjust('2999 millis');
    expect(yield* pending).toEqual(Option.none());
    yield* TestClock.adjust('1 milli');
    expect(yield* next).toBe('poll at 3000');
    yield* TestClock.adjust('6 seconds');
    expect(yield* next).toBe('poll at 6000');
    expect(yield* next).toBe('poll at 9000');

    yield* Fiber.interrupt(lifecycle);
    yield* TestClock.adjust('30 seconds');
    expect(yield* pending).toEqual(Option.none());
  }),
);

it.effect('the poll keeps running when the host info cannot be read', () =>
  Effect.gen(function* () {
    vi.mocked(invoke).mockRejectedValue(Error('The host is gone.'));
    const { next } = yield* recordingHost;
    expect(yield* next).toBe('launch');
    expect(yield* next).toBe('initialization error: Error: The host is gone.');
    yield* TestClock.adjust('3 seconds');
    expect(yield* next).toBe('poll at 3000');
    expect(listen).not.toHaveBeenCalled();
  }),
);

it.effect('host errors reach the session until the lifecycle stops and removes the listener', () =>
  Effect.gen(function* () {
    let deliver: EventCallback<unknown> = () => {};
    const stop = vi.fn<UnlistenFn>();
    vi.mocked(listen).mockImplementation(async (_event, handler) => {
      deliver = handler;
      return stop;
    });
    const { lifecycle, next } = yield* recordingHost;
    yield* listening;
    expect(listen).toHaveBeenCalledWith('desktop-error', expect.any(Function));
    yield* Effect.repeat(next, { until: (request) => request === 'refresh' });

    deliver({ event: 'desktop-error', id: 1, payload: 'The bridge stopped.' });
    expect(yield* next).toBe('error: The bridge stopped.');
    // A payload of another shape is not shown.
    deliver({ event: 'desktop-error', id: 2, payload: { message: 'Not text.' } });
    deliver({ event: 'desktop-error', id: 3, payload: 'Wisp restarted the bridge.' });
    expect(yield* next).toBe('error: Wisp restarted the bridge.');

    expect(stop).not.toHaveBeenCalled();
    yield* Fiber.interrupt(lifecycle);
    expect(stop).toHaveBeenCalledOnce();
  }),
);

it.effect('a listener that finishes registering after the lifecycle stops is removed at once', () =>
  Effect.gen(function* () {
    let register: (stop: UnlistenFn) => void = () => {};
    vi.mocked(listen).mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          register = resolve;
        }),
    );
    const { lifecycle } = yield* recordingHost;
    yield* listening;
    const stopping = yield* Effect.forkChild(Fiber.interrupt(lifecycle));
    const stop = vi.fn<UnlistenFn>();
    register(stop);
    yield* Fiber.join(stopping);
    expect(stop).toHaveBeenCalledOnce();
  }),
);
