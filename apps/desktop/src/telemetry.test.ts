import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTelemetry } from './telemetry';
import type { DesktopInfo, Status } from './api';

const info: DesktopInfo = {
  configured: true,
  version: '0.0.7',
  platform: 'windows',
  dataDirectory: 'SECRET PATH',
  wow: 'SECRET CHARACTER',
};
const status = (at: number) =>
  ({
    modelConnected: true,
    lastSuccessfulReplyAt: at,
    model: 'SECRET MODEL',
    ready: true,
    gameConnected: true,
    activeTurns: 0,
    connections: [],
    mcps: [],
    integrations: [],
    panels: [],
    routines: [],
    routineRuns: [],
    auth: { account: 'SECRET EMAIL', status: 'connected', revision: 0, profiles: [] },
  }) as Status;
const payloads = () =>
  vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

test('disabled by default and never sends in development/preview', () => {
  const telemetry = createTelemetry(localStorage, true);
  telemetry.observe(info, status(Date.now()));
  expect(fetch).not.toHaveBeenCalled();
  telemetry.setEnabled(true);
  createTelemetry(localStorage, false).observe(info, status(Date.now()));
  expect(fetch).not.toHaveBeenCalled();
});

test('persists installation ID, deduplicates milestones and only sends allowed metadata', () => {
  const telemetry = createTelemetry(localStorage, true);
  telemetry.setEnabled(true);
  telemetry.observe(info, status(Date.now() + 1));
  telemetry.observe(info, status(Date.now() + 2));
  expect(payloads().map((p) => p.event_name)).toEqual([
    'desktop_first_open',
    'desktop_opened',
    'desktop_addon_configured',
    'desktop_ai_connected',
    'desktop_first_response',
    'desktop_active',
  ]);
  expect(JSON.stringify(payloads())).not.toContain('SECRET');
  const id = payloads()[0].user_id;
  createTelemetry(localStorage, true).observe(info, status(Date.now() + 3));
  expect(payloads().at(-1).event_name).toBe('desktop_opened');
  expect(payloads().at(-1).user_id).toBe(id);
});

test('counts new active days, ignores replies before consent, and revokes immediately', () => {
  const telemetry = createTelemetry(localStorage, true);
  telemetry.setEnabled(true);
  telemetry.observe(info, status(Date.now() - 1000));
  expect(payloads().some((p) => p.event_name === 'desktop_active')).toBe(false);
  telemetry.observe(info, status(Date.now() + 1));
  telemetry.observe(info, status(Date.now() + 86400000));
  expect(payloads().filter((p) => p.event_name === 'desktop_active')).toHaveLength(2);
  const oldId = payloads()[0].user_id;
  const count = payloads().length;
  const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  telemetry.setEnabled(false);
  expect(signal?.aborted).toBe(true);
  expect(localStorage.length).toBe(0);
  telemetry.observe(info, status(Date.now()));
  expect(payloads()).toHaveLength(count);
  telemetry.setEnabled(true);
  telemetry.observe(info, null);
  expect(payloads().at(-1).user_id).not.toBe(oldId);
});

test('offline ingestion never rejects into the app', async () => {
  vi.mocked(fetch).mockRejectedValue(Error('offline'));
  const telemetry = createTelemetry(localStorage, true);
  telemetry.setEnabled(true);
  expect(() => telemetry.observe(info, null)).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  telemetry.dispose();
});
