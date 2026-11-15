import { invoke } from '@tauri-apps/api/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import UpdaterWindow from './UpdaterWindow';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('the updater reports readiness, polls progress and focuses Close on failure', async () => {
  vi.useFakeTimers();
  vi.mocked(invoke)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ phase: 'installing', percent: 42, log: [], error: null })
    .mockResolvedValueOnce({
      phase: 'failed',
      percent: null,
      log: ['Installer failed'],
      error: 'Installation failed.',
    })
    .mockResolvedValueOnce(undefined);
  render(<UpdaterWindow />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(invoke).toHaveBeenNthCalledWith(1, 'updater_ready');
  expect(invoke).toHaveBeenNthCalledWith(2, 'updater_status');
  expect(
    screen.getByRole('progressbar', { name: 'Installing the update' }).getAttribute('value'),
  ).toBe('42');
  await act(() => vi.advanceTimersByTimeAsync(120));
  expect(screen.getByLabelText('Installation log').textContent).toBe('Installer failed');
  const close = screen.getByRole('button', { name: 'Close' });
  expect(document.activeElement).toBe(close);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(invoke).toHaveBeenCalledTimes(3);
  fireEvent.click(close);
  expect(invoke).toHaveBeenLastCalledWith('updater_close');
});

test('unmounting during the readiness handshake prevents a late status request', async () => {
  let ready!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }) as Promise<never>,
  );
  const view = render(<UpdaterWindow />);
  view.unmount();
  await act(async () => {
    ready();
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('updater_ready');
});
