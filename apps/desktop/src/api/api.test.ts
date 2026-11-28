import { test, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bridge, call, desktop } from './index';
import { bridgeRequest } from './bridge-request';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test('invalid desktop commands are rejected before crossing IPC', async () => {
  await expect(
    bridgeRequest('/integrations/set', { id: 'tool:query_character', enabled: 'false' }),
  ).rejects.toThrow();
  await expect(bridgeRequest('/addon/transport', { action: 'pause' })).rejects.toThrow(
    'Unsupported desktop operation.',
  );
  expect(invoke).not.toHaveBeenCalled();
});
test('malformed replies and native info do not become trusted UI state', async () => {
  vi.mocked(invoke).mockResolvedValue({ ready: true });
  await expect(call(bridge.status.$get())).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValue({ ok: 'yes' });
  await expect(call(bridge.routines.open.$post({ json: { id: 'run-one' } }))).rejects.toThrow();
  await expect(desktop('desktop_info')).rejects.toThrow();
});
test('the typed client forwards through the Rust bridge command', async () => {
  vi.mocked(invoke).mockResolvedValue({ ok: true, model: 'sol' });
  await expect(call(bridge.auth.model.$post({ json: { model: 'sol' } }))).resolves.toEqual({
    ok: true,
    model: 'sol',
  });
  expect(invoke).toHaveBeenCalledWith('bridge_request', {
    method: 'POST',
    route: '/auth/model',
    body: { model: 'sol' },
  });
  vi.mocked(invoke).mockResolvedValue({ revision: 2, status: 'signed_out', profiles: [] });
  await call(bridge.auth.cancel.$post());
  expect(invoke).toHaveBeenLastCalledWith('bridge_request', {
    method: 'POST',
    route: '/auth/cancel',
    body: null,
  });
});
test('bridge failures reject with the bridge message', async () => {
  vi.mocked(invoke).mockRejectedValue('Choose an available model.');
  await expect(call(bridge.auth.model.$post({ json: { model: 'nope' } }))).rejects.toBe(
    'Choose an available model.',
  );
});
test('every native reply is decoded with its command contract', async () => {
  vi.mocked(invoke).mockResolvedValue('yes');
  await expect(desktop('autostart_enabled')).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValue(true);
  await expect(desktop('set_autostart', { enabled: true })).resolves.toBe(true);
  expect(invoke).toHaveBeenLastCalledWith('set_autostart', { enabled: true });

  vi.mocked(invoke).mockResolvedValue('beta');
  await expect(desktop('update_channel')).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValue('nightly');
  await expect(desktop('update_channel')).resolves.toBe('nightly');

  const update = { version: '0.4.0', notes: null, downgrade: false };
  vi.mocked(invoke).mockResolvedValue({ supported: true, update });
  await expect(desktop('check_update')).resolves.toEqual({ supported: true, update });
  vi.mocked(invoke).mockResolvedValue({ supported: true, update: { version: '0.4.0' } });
  await expect(desktop('check_update')).rejects.toThrow();

  vi.mocked(invoke).mockResolvedValue(['C:\\WoW', 7]);
  await expect(desktop('detect_game_folders')).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValue({ enabled: true });
  await expect(desktop('telemetry_settings')).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValue({ wow: 'C:\\WoW', addonOutdated: 'no' });
  await expect(desktop('auto_update_addon')).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValue(null);
  await expect(desktop('auto_update_addon')).resolves.toBeNull();
  await expect(desktop('pick_folder')).resolves.toBeNull();
});
test('a command that returns nothing answers null', async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await expect(desktop('start_bridge')).resolves.toBeNull();
  vi.mocked(invoke).mockResolvedValue({ started: true });
  await expect(desktop('start_bridge')).rejects.toThrow();
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
