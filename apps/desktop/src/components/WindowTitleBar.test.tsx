import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import WindowTitleBar from './WindowTitleBar';

const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async (_handler: () => void) => () => {}),
}));

vi.mock('../api', () => ({ native: true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test('the caption buttons control the window and close sends Wisp to the tray', async () => {
  render(<WindowTitleBar controls />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close to tray' }));
  expect(appWindow.minimize).toHaveBeenCalledOnce();
  expect(appWindow.toggleMaximize).toHaveBeenCalledOnce();
  expect(appWindow.close).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Minimize' }).querySelector('svg')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close to tray' }).querySelector('svg')).toBeTruthy();
});

test('the maximize button turns into restore when the window is maximized', async () => {
  appWindow.isMaximized.mockResolvedValue(true);
  render(<WindowTitleBar controls />);
  expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
});

test('the bar is a drag region and hides the buttons when asked', () => {
  const { container } = render(<WindowTitleBar />);
  expect(container.firstElementChild?.hasAttribute('data-tauri-drag-region')).toBe(true);
  expect(screen.queryByRole('group', { name: 'Window controls' })).toBeNull();
});
