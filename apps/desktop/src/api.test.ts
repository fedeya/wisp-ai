import { test, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { request, desktop } from './api';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test('invalid desktop commands are rejected before crossing IPC', async () => {
  await expect(
    request('/integrations/set', { id: 'tool:query_character', enabled: 'false' }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
test('template import admission rejects invalid/oversized or unconfirmed payloads before IPC', async () => {
  for (const template of ['{}', ' '.repeat(28001)]) {
    await expect(
      request('/panels/import', { characterKey: 'B', template, confirmed: true }),
    ).rejects.toThrow();
  }
  await expect(
    request('/panels/import', { characterKey: 'B', template: '{}', confirmed: false }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
test('malformed status and native info do not become trusted UI state', async () => {
  vi.mocked(invoke).mockResolvedValue({ ready: true });
  await expect(request('/status')).rejects.toThrow();
  await expect(desktop('desktop_info')).rejects.toThrow();
});
test('valid native info preserves an unconfigured installation', async () => {
  const info = {
    configured: false,
    wow: null,
    dataDirectory: 'test',
    platform: 'windows',
    version: '0.0.1',
    addonOutdated: null,
  };
  vi.mocked(invoke).mockResolvedValue(info);
  expect(await desktop('desktop_info')).toEqual(info);
});
