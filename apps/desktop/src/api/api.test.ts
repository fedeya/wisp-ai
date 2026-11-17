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
