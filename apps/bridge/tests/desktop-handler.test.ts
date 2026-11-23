import { test, expect, vi } from 'vitest';
import { createDesktopApp } from '../src/desktop/desktop-handler.ts';
import type { Status } from '@wisp/protocol/desktop';
const authState = { status: 'signed_out', revision: 1, profiles: [] };
const status: Status = {
  ready: true,
  gameConnected: false,
  model: 'luna',
  activeTurns: 0,
  auth: authState,
  connections: [],
  mcps: [],
  integrations: [],
  panels: [],
  routines: [],
  routineRuns: [],
  characters: {},
  appUpdate: null,
  features: { channel: 'stable', flags: [] },
};
function setup() {
  const queue: string[] = [];
  const deps = {
    auth: {
      beginSignIn: vi.fn(async () => ({ authorizationUrl: 'https://auth.example/authorize' })),
      state: vi.fn(() => authState),
      cancel: vi.fn(async () => {}),
    },
    connections: {
      models: vi.fn(async () => [{ slug: 'luna', displayName: 'Luna', efforts: [] }]),
      remove: vi.fn(async () => {}),
    },
    panelStore: {
      list: vi.fn(() => [{ id: 'materials' }]),
      mutate: vi.fn(async () => []),
    },
    accountOperation: vi.fn(async <T>(operation: () => Promise<T>) => {
      queue.push('account');
      return operation();
    }),
    updateModel: vi.fn(async () => {}),
    getStatus: () => status,
    getChats: () => [],
    currentCharacterKey: () => 'mage',
    sendPanelCommand: vi.fn(),
    setCapability: vi.fn(async () => {}),
    setWowTransport: vi.fn(async () => {}),
    setAppUpdate: vi.fn(),
    setFeature: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  const app = createDesktopApp(deps as never);
  const post = (route: string, body: unknown) =>
    app.request(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, deps, post, queue };
}
test('status is served uncached', async () => {
  const { app } = setup();
  const response = await app.request('/status');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(status);
});
test('contract inputs are validated before any service runs', async () => {
  const { post, deps } = setup();
  const response = await post('/integrations/set', { id: 'tool:x', enabled: 'false' });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: expect.stringContaining('enabled') });
  expect(deps.setCapability).not.toHaveBeenCalled();
  const malformed = await post('/connections/remove', '{');
  expect(malformed.status).toBe(400);
  expect(deps.connections.remove).not.toHaveBeenCalled();
});
test('sign-in passes the parsed account choice through the account queue', async () => {
  const { post, deps, queue } = setup();
  const response = await post('/auth/start', { newAccount: true });
  expect(await response.json()).toEqual({ authorizationUrl: 'https://auth.example/authorize' });
  expect(deps.auth.beginSignIn).toHaveBeenCalledWith(undefined, true);
  expect(queue).toEqual(['account']);
});
test('model changes only accept available models', async () => {
  const { post, deps } = setup();
  const rejected = await post('/auth/model', { model: 'sol' });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: 'Choose an available model.' });
  expect(deps.updateModel).not.toHaveBeenCalled();
  const accepted = await post('/auth/model', { model: 'luna' });
  expect(await accepted.json()).toEqual({ ok: true, model: 'luna' });
  expect(deps.updateModel).toHaveBeenCalledWith('luna');
});
test('panel commands require the logged-in character', async () => {
  const { post, deps } = setup();
  const other = await post('/panels/action', {
    characterKey: 'warrior',
    id: 'materials',
    action: 'show',
  });
  expect(await other.json()).toEqual({ error: 'Log into this character first' });
  const shown = await post('/panels/action', {
    characterKey: 'mage',
    id: 'materials',
    action: 'show',
  });
  expect(await shown.json()).toEqual({ ok: true });
  expect(deps.sendPanelCommand).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'materials', characterKey: 'mage', action: 'show' }),
  );
  expect(deps.changed).toHaveBeenCalledOnce();
});
test('the addon installer can pause and resume the WoW transport', async () => {
  const { post, deps } = setup();
  expect((await post('/addon/transport', { action: 'resume', wow: 'E:\\WoW' })).status).toBe(200);
  expect(deps.setWowTransport).toHaveBeenCalledWith({ action: 'resume', wow: 'E:\\WoW' });
  expect((await post('/addon/transport', { action: 'install' })).status).toBe(400);
});
test('the desktop reports the app update the game announces', async () => {
  const { post, deps } = setup();
  expect(await (await post('/app-update', { version: '0.0.9' })).json()).toEqual({ ok: true });
  expect(deps.setAppUpdate).toHaveBeenCalledWith('0.0.9');
  expect(deps.changed).toHaveBeenCalledOnce();
  expect((await post('/app-update', { version: null })).status).toBe(200);
  expect(deps.setAppUpdate).toHaveBeenLastCalledWith(null);
  expect((await post('/app-update', { version: '' })).status).toBe(400);
  expect(deps.setAppUpdate).toHaveBeenCalledTimes(2);
});
test('the desktop saves or clears a feature flag override', async () => {
  const { post, deps } = setup();
  expect(await (await post('/features/set', { id: 'new_panel', enabled: true })).json()).toEqual({
    ok: true,
  });
  expect(deps.setFeature).toHaveBeenCalledWith('new_panel', true);
  expect((await post('/features/set', { id: 'new_panel', enabled: null })).status).toBe(200);
  expect(deps.setFeature).toHaveBeenLastCalledWith('new_panel', null);
  expect((await post('/features/set', { id: 'New Panel', enabled: true })).status).toBe(400);
  expect(deps.setFeature).toHaveBeenCalledTimes(2);
});
test('unknown routes and methods are refused', async () => {
  const { app } = setup();
  for (const response of [
    await app.request('/nope', { method: 'POST' }),
    await app.request('/auth/start'),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unknown desktop request' });
  }
});
