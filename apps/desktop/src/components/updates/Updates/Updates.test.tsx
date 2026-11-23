import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { desktop } from '../../../api';
import { chooseOption } from '../../../select-test-helpers';
import Updates, { AUTO_INSTALL_IDLE_MS, GAME_CHECK_MS } from './Updates';

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
    if (command === 'update_auto_install') return (args?.enabled ?? false) as never;
    if (command === 'download_update') return release.version as never;
    return { supported: true, update: release } as never;
  });
});

/** Whether the mocked process list has WoW running. */
let gameRunning = false;
/** Saved automatic installs on; install calls stay pending unless `install` says otherwise. */
function autoInstallOn(install: () => Promise<unknown> = () => new Promise(() => {})) {
  gameRunning = false;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'game_running') return gameRunning as never;
    if (command === 'update_channel') return 'stable' as never;
    if (command === 'update_auto_install') return (args?.enabled ?? true) as never;
    if (command === 'download_update') return release.version as never;
    if (command === 'install_update') return install() as never;
    return { supported: true, update: release } as never;
  });
}

const installCalls = () =>
  vi.mocked(desktop).mock.calls.filter(([command]) => command === 'install_update');
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

test('with automatic installs off, nothing downloads or installs while idle', async () => {
  vi.useFakeTimers();
  render(<Updates {...props()} idle />);
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS * 2));
  expect(desktop).not.toHaveBeenCalledWith('download_update');
  expect(installCalls()).toHaveLength(0);
});

test('a downloaded update installs after Wisp stays idle, and activity restarts the wait', async () => {
  vi.useFakeTimers();
  autoInstallOn();
  const options = props();
  const view = render(<Updates {...options} idle />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(desktop).toHaveBeenCalledWith('download_update');
  expect(screen.getByText(/installs by itself after 10 minutes/)).toBeTruthy();

  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS - 1000));
  view.rerender(<Updates {...options} idle={false} />);
  view.rerender(<Updates {...options} idle />);
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS - 1000));
  expect(installCalls()).toHaveLength(0);

  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(installCalls()).toEqual([['install_update', { automatic: true }]]);
  expect(options.onBusy).toHaveBeenCalledWith('Updating Wisp');
});

test('an automatic install says it is opening the updater, not waiting for a reply', async () => {
  vi.useFakeTimers();
  autoInstallOn();
  render(<Updates {...props()} idle />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS));
  expect(
    screen.getByText('Opening the Windows updater. Wisp will close and reopen automatically…'),
  ).toBeTruthy();
  expect(screen.queryByText('Waiting for the active reply to finish…')).toBeNull();
});

test('a failed background download is retried by the next check', async () => {
  vi.useFakeTimers();
  autoInstallOn();
  const base = vi.mocked(desktop).getMockImplementation()!;
  let failures = 1;
  vi.mocked(desktop).mockImplementation(async (command, args) => {
    if (command === 'download_update' && failures-- > 0) throw Error('offline');
    return base(command, args);
  });
  render(<Updates {...props()} idle />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const downloads = () =>
    vi.mocked(desktop).mock.calls.filter(([command]) => command === 'download_update');
  expect(downloads()).toHaveLength(1);
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS));
  expect(installCalls()).toHaveLength(0);

  await act(() => vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
  expect(downloads()).toHaveLength(2);
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS));
  expect(installCalls()).toHaveLength(1);
});

test('an update waits for WoW to stay closed for the whole idle window', async () => {
  vi.useFakeTimers();
  autoInstallOn();
  gameRunning = true;
  render(<Updates {...props()} idle />);
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS * 3));
  expect(installCalls()).toHaveLength(0);
  expect(desktop).toHaveBeenCalledWith('game_running');

  // Closing WoW starts the wait; the bridge may still report the game connected.
  gameRunning = false;
  await act(() => vi.advanceTimersByTimeAsync(GAME_CHECK_MS));
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS - 1000));
  expect(installCalls()).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(installCalls()).toHaveLength(1);
});

test('an update never installs by itself while a reply keeps Wisp busy', async () => {
  vi.useFakeTimers();
  autoInstallOn();
  render(<Updates {...props()} idle={false} />);
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS * 3));
  expect(installCalls()).toHaveLength(0);
});

test('a reply that starts at the last moment only postpones the automatic install', async () => {
  vi.useFakeTimers();
  autoInstallOn(async () => {
    throw Error('Wisp is busy; the update will install later.');
  });
  render(<Updates {...props()} idle />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS));
  expect(installCalls()).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS));
  expect(installCalls()).toHaveLength(2);
});

test('a failed automatic install is reported and left to the user', async () => {
  vi.useFakeTimers();
  autoInstallOn(async () => {
    throw Error('installer could not start.');
  });
  render(<Updates {...props()} idle />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS));
  expect(screen.getByRole('alert').textContent).toContain(
    'Automatic update failed: installer could not start.',
  );
  await act(() => vi.advanceTimersByTimeAsync(AUTO_INSTALL_IDLE_MS * 2));
  expect(installCalls()).toHaveLength(1);
  expect(
    (screen.getByRole('button', { name: 'Update and restart' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test('the automatic install setting is saved', async () => {
  render(<Updates {...props()} />);
  const toggle = await screen.findByRole('switch', { name: 'Install updates automatically' });
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  await fireEvent.click(toggle);
  await waitFor(() =>
    expect(desktop).toHaveBeenCalledWith('update_auto_install', { enabled: true }),
  );
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
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
