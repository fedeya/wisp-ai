import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeRequest } from './api/bridge-request';
import { desktopStore, mountDesktop } from './desktop-controller';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('./api/bridge-request', () => ({ bridgeRequest: vi.fn() }));

const status = {
  ready: true,
  gameConnected: true,
  activeTurns: 0,
  connections: [],
  model: 'luna',
  auth: { status: 'connected', revision: 1, activeId: 'first', profiles: [] },
  mcps: [],
  integrations: [],
  panels: [],
  routines: [],
  routineRuns: [],
  characters: {},
  appUpdate: null,
  features: { channel: 'stable', flags: [] },
};
const info = {
  configured: true,
  wow: 'E:\\WoW',
  dataDirectory: 'userdata',
  platform: 'windows',
  version: '0.0.1',
};
const statusReads = () =>
  vi.mocked(bridgeRequest).mock.calls.filter(([route]) => route === '/status').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'desktop_info' ? info : null,
  );
  vi.mocked(listen).mockResolvedValue(vi.fn());
  vi.mocked(bridgeRequest).mockImplementation(async (route) =>
    route === '/status' ? status : { models: [] },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('a mounted desktop reads the status every 3 seconds until it unmounts', async () => {
  const unmount = mountDesktop();
  await vi.advanceTimersByTimeAsync(0);
  expect(desktopStore.getState().status).toEqual(status);
  expect(statusReads()).toBe(1);

  await vi.advanceTimersByTimeAsync(2999);
  expect(statusReads()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(statusReads()).toBe(2);
  await vi.advanceTimersByTimeAsync(6000);
  expect(statusReads()).toBe(4);

  unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(statusReads()).toBe(4);
});

test('a poll tick joins a status read in flight instead of starting another', async () => {
  let finish: (value: unknown) => void = () => {};
  const unmount = mountDesktop();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(bridgeRequest).mockImplementation(
    (route) =>
      new Promise((resolve) => {
        if (route === '/status') finish = resolve;
        else resolve({ models: [] });
      }),
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect(statusReads()).toBe(2);
  // The read takes longer than the poll interval: the next ticks start nothing.
  await vi.advanceTimersByTimeAsync(4000);
  expect(statusReads()).toBe(2);
  finish(status);
  // The tick after the read completes starts a new one, on the same cadence.
  await vi.advanceTimersByTimeAsync(2000);
  expect(statusReads()).toBe(3);
  unmount();
});

test('host errors show until the desktop unmounts, which removes the listener', async () => {
  const stop = vi.fn<() => void>();
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    handler({ event: 'desktop-error', id: 1, payload: 'The bridge stopped.' });
    return stop;
  });
  const unmount = mountDesktop();
  await vi.advanceTimersByTimeAsync(0);
  expect(desktopStore.getState()).toMatchObject({ failed: true, feedback: 'The bridge stopped.' });
  unmount();
  expect(stop).toHaveBeenCalledOnce();
});
