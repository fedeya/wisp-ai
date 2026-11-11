import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { desktop } from './api';
import TelemetrySettings from './TelemetrySettings.svelte';

vi.mock('./api', () => ({ native: true, desktop: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test('usage analytics can be disabled before the bridge is configured', async () => {
  vi.mocked(desktop).mockImplementation(
    async (_command, args) => ({ enabled: args?.enabled ?? true }) as never,
  );
  render(TelemetrySettings);
  const toggle = (await screen.findByRole('checkbox', {
    name: 'Share usage analytics',
  })) as HTMLInputElement;
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  await fireEvent.click(toggle);
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(false);
  expect(desktop).toHaveBeenCalledWith('telemetry_settings', { enabled: false });
});

test('failed preference writes keep the saved value and report the error', async () => {
  vi.mocked(desktop).mockResolvedValueOnce({ enabled: false });
  vi.mocked(desktop).mockRejectedValueOnce(Error('read-only'));
  render(TelemetrySettings);
  const toggle = (await screen.findByRole('checkbox', {
    name: 'Share usage analytics',
  })) as HTMLInputElement;
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  await fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle.checked).toBe(false);
});
