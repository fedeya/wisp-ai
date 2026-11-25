import { expect, test } from 'vitest';
import { desktopPackageTask } from '../run-desktop-package.ts';

test('the requested desktop package is checked against the host', () => {
  expect(desktopPackageTask('linux')).toBe('package:linux');
  expect(desktopPackageTask('linux', 'linux')).toBe('package:linux');
  expect(desktopPackageTask('win32')).toBe('package:windows');
  expect(desktopPackageTask('win32', 'windows')).toBe('package:windows');
  expect(() => desktopPackageTask('win32', 'linux')).toThrow('package:linux runs on Linux.');
  expect(() => desktopPackageTask('linux', 'windows')).toThrow('package:windows runs on Windows.');
  expect(() => desktopPackageTask('darwin')).toThrow(
    'Desktop packaging supports Windows and Linux.',
  );
});
