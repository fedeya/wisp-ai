import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { desktop } from '../../../api';
import { chooseOption } from '../../../select-test-helpers';
import Updates from './Updates';

vi.mock('../../../api', () => ({ native: true, desktop: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
const release = { version: '0.3.0', notes: 'Improved game connection.' };
const props = () => ({
  showSettings: true,
  version: '0.0.1',
  locked: false,
  openSettings: vi.fn(),
  onBusy: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'update_channel') {
      return (args?.channel || 'stable') as never;
    }
    return { supported: true, update: release } as never;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('checks on startup and shows the release notes and manual check', async () => {
  render(<Updates {...props()} />);
  await screen.findByText(release.notes);
  expect(desktop).toHaveBeenCalledWith('check_update');
  expect(screen.getByText('Installed version 0.0.1')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Wisp 0.3.0 is available' })).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'check_update'),
  ).toHaveLength(2);
});

test('the global notification opens settings or can be postponed', async () => {
  const options = { ...props(), showSettings: false };
  render(<Updates {...options} />);
  await fireEvent.click(await screen.findByRole('button', { name: 'View update' }));
  expect(options.openSettings).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByText('Wisp 0.3.0 is available.')).toBeNull();
});

test('a failed check keeps the known update and allows another check', async () => {
  render(<Updates {...props()} />);
  await screen.findByText(release.notes);
  vi.mocked(desktop).mockRejectedValueOnce(Error('offline'));
  await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await screen.findByRole('alert');
  expect(screen.getByText(release.notes)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

test('installation locks app operations, reports waiting, and can retry after failure', async () => {
  const options = props();
  render(<Updates {...options} />);
  await screen.findByText(release.notes);
  let reject!: (error: Error) => void;
  vi.mocked(desktop).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));
  expect(options.onBusy).toHaveBeenCalledWith('Updating Wisp');
  expect(desktop).toHaveBeenLastCalledWith('install_update');
  expect(screen.getByRole('heading', { name: 'Updating to Wisp 0.3.0' })).toBe(
    document.activeElement,
  );
  expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  expect(screen.getByRole('progressbar', { name: 'Update download' }).hasAttribute('value')).toBe(
    false,
  );
  const callback = vi.mocked(listen).mock.calls[0][1];
  callback({
    event: 'update-progress',
    id: 0,
    payload: { phase: 'downloading', downloaded: 38_000_000, total: 91_000_000 },
  });
  expect(
    (await screen.findByRole('progressbar', { name: 'Update download' })).getAttribute('value'),
  ).toBe('42');
  expect(screen.getByText('38 of 91 MB')).toBeTruthy();
  callback({ event: 'update-progress', id: 0, payload: { phase: 'waiting' } });
  await screen.findByText('Waiting for the active reply to finish…');
  expect(screen.queryByRole('progressbar')).toBeNull();
  callback({ event: 'update-progress', id: 0, payload: { phase: 'installing' } });
  await screen.findByText('Opening the Windows updater. Wisp will close and reopen automatically…');
  reject(Error('signature verification failed'));
  await screen.findByRole('alert');
  expect(options.onBusy).toHaveBeenLastCalledWith('');
  expect(
    (screen.getByRole('button', { name: 'Update and restart' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test('unsupported builds offer no installer', async () => {
  vi.mocked(desktop).mockImplementation(
    async (command) =>
      (command === 'update_channel' ? 'stable' : { supported: false, update: null }) as never,
  );
  render(<Updates {...props()} />);
  await screen.findByText('Updates are available in the installed Windows x64 release.');
  expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull();
});

test('checks every six hours and stops checking when the app is unmounted', async () => {
  vi.useFakeTimers();
  const view = render(<Updates {...props()} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'check_update'),
  ).toHaveLength(1);
  await act(() => vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'check_update'),
  ).toHaveLength(2);
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'check_update'),
  ).toHaveLength(2);
});

test('switching channels persists the choice and checks the new feed', async () => {
  render(<Updates {...props()} />);
  await screen.findByText(release.notes);
  await chooseOption(screen.getByRole('combobox', { name: 'Update channel' }), 'Nightly');
  await waitFor(() =>
    expect(desktop).toHaveBeenCalledWith('update_channel', { channel: 'nightly' }),
  );
  await screen.findByText('Experimental builds from main. Features may change or break.');
  expect(
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'check_update'),
  ).toHaveLength(2);
});

test('a failed check after switching cannot offer the previous channel installer', async () => {
  render(<Updates {...props()} />);
  await screen.findByText(release.notes);
  vi.mocked(desktop).mockImplementation(async (command) => {
    if (command === 'update_channel') {
      return 'nightly' as never;
    }
    throw Error('Nightly feed unavailable');
  });
  await chooseOption(screen.getByRole('combobox', { name: 'Update channel' }), 'Nightly');
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull();
});
