import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { desktop } from '../../api';
import StartupSettings from './StartupSettings';

vi.mock('../../api', () => ({ native: true, desktop: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

async function findToggle() {
  const toggle = (await screen.findByRole('switch', {
    name: 'Start Wisp with Windows',
  })) as HTMLButtonElement;
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  return toggle;
}

test('starting with Windows can be turned on and reflects the saved value', async () => {
  vi.mocked(desktop).mockImplementation(
    async (command, args) => (command === 'set_autostart' ? args?.enabled : false) as never,
  );
  render(<StartupSettings />);
  const toggle = await findToggle();
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  await fireEvent.click(toggle);
  await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  expect(desktop).toHaveBeenCalledWith('set_autostart', { enabled: true });
});

test('a failed change keeps the current value and reports the error', async () => {
  vi.mocked(desktop).mockResolvedValueOnce(true as never);
  vi.mocked(desktop).mockRejectedValueOnce(Error('registry denied'));
  render(<StartupSettings />);
  const toggle = await findToggle();
  await fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});
