import { expect, test } from 'vitest';
import { overviewChecks, overviewHeader, type OverviewInput } from './overview-checks';

const healthy: OverviewInput = {
  readiness: 'ready',
  addonUpdateNotice: null,
  status: { ready: true, gameConnected: true, model: 'luna' },
  starting: false,
  providerConnected: true,
  modelName: 'GPT-5.5',
};

function check(input: Partial<OverviewInput>, id: string) {
  return overviewChecks({ ...healthy, ...input }).find((item) => item.id === id)!;
}

test('a healthy setup passes every check in display order', () => {
  const checks = overviewChecks(healthy);
  expect(checks.map(({ id }) => id)).toEqual(['addon', 'service', 'provider', 'game']);
  expect(checks.every(({ tone }) => tone === 'ok')).toBe(true);
  expect(check({}, 'provider')).toMatchObject({ detail: 'GPT-5.5', action: 'change-provider' });
});

test('WoW not running is neutral and keeps the header ready', () => {
  const status = { ready: true, gameConnected: false, model: 'luna' };
  expect(check({ readiness: 'waiting', status }, 'game')).toMatchObject({
    tone: 'idle',
    status: 'Not connected',
  });
  expect(overviewHeader('waiting')).toMatchObject({ title: 'Wisp is ready', tone: 'ok' });
});

test('an outdated addon offers the update, and a failed update says so', () => {
  expect(check({ readiness: 'update' }, 'addon')).toMatchObject({
    tone: 'problem',
    title: 'Addon out of date',
    action: 'update-addon',
  });
  expect(check({ readiness: 'update', addonUpdateNotice: 'failed' }, 'addon').title).toBe(
    'Addon update failed',
  );
  expect(overviewHeader('update', 'failed').description).toMatch(/couldn’t update the addon/);
});

test('an addon updated by Wisp asks for /reload until dismissed', () => {
  expect(check({ addonUpdateNotice: 'reload_required' }, 'addon')).toMatchObject({
    tone: 'ok',
    title: 'Addon updated',
    action: 'dismiss-reload',
  });
});

test('the service check follows the local service lifecycle', () => {
  expect(
    check({ status: { ready: false, gameConnected: false, model: '' } }, 'service'),
  ).toMatchObject({ tone: 'pending', title: 'Starting the agent', action: 'view-diagnostics' });
  expect(check({ status: null, starting: true }, 'service')).toMatchObject({
    tone: 'pending',
    title: 'Starting the Wisp service',
  });
  expect(check({ status: null, readiness: 'unavailable' }, 'service')).toMatchObject({
    tone: 'problem',
    action: 'view-diagnostics',
  });
});

test('the provider check waits for the service, then asks to connect', () => {
  expect(check({ status: null }, 'provider')).toMatchObject({ tone: 'idle', title: 'AI provider' });
  expect(check({ providerConnected: false }, 'provider')).toMatchObject({
    tone: 'problem',
    action: 'connect-provider',
  });
  expect(check({ modelName: undefined }, 'provider').detail).toBe('luna');
});
