import { expect, test, vi } from 'vitest';
import { shortcutFor, shortcutTarget } from './native-shell';

vi.mock('./api', () => ({ native: true, desktop: vi.fn(), request: vi.fn() }));

function press(key: string, options: Partial<KeyboardEvent> = {}) {
  return {
    key,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target: document.body,
    ...options,
  } as KeyboardEvent;
}

test('Ctrl+number opens sections in sidebar order and Ctrl+, opens Settings', () => {
  expect(shortcutTarget(press('1'))).toBe('/');
  expect(shortcutTarget(press('2'))).toBe('/connections');
  expect(shortcutTarget(press(','))).toBe('/settings');
  expect(shortcutFor('/connections')).toBe('Ctrl+2');
  expect(shortcutFor('/settings')).toBe('Ctrl+,');
});

test('other keys and modifier combinations are left alone', () => {
  expect(shortcutTarget(press('1', { ctrlKey: false }))).toBeUndefined();
  expect(shortcutTarget(press('1', { shiftKey: true }))).toBeUndefined();
  expect(shortcutTarget(press('c'))).toBeUndefined();
  expect(shortcutTarget(press('9'))).toBeUndefined();
});

test('shortcuts do not navigate away from an open dialog', () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const field = document.createElement('input');
  dialog.append(field);
  document.body.append(dialog);
  expect(shortcutTarget(press('2', { target: field }))).toBeUndefined();
  dialog.remove();
});
