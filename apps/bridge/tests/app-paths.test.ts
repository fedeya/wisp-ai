import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appPaths } from '../src/app-paths.ts';

describe('appPaths executables', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('locates the simulator under the root', () => {
    expect(appPaths('/app').simulatorExecutable).toBe(
      path.join('/app', 'simulator', 'wowsimcli.exe'),
    );
  });

  it('defaults the desktop executable to the release build', () => {
    vi.stubEnv('WISP_DESKTOP_EXE', '');
    expect(appPaths('/app').desktopExecutable).toBe(
      path.join(
        '/app',
        'apps',
        'desktop',
        'src-tauri',
        'target',
        'release',
        process.platform === 'win32' ? 'wisp.exe' : 'wisp',
      ),
    );
  });

  it('prefers WISP_DESKTOP_EXE for the desktop executable', () => {
    vi.stubEnv('WISP_DESKTOP_EXE', '/custom/wisp');
    expect(appPaths('/app').desktopExecutable).toBe('/custom/wisp');
  });
});
