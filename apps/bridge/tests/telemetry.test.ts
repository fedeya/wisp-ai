import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { UsageTelemetry } from '../src/telemetry.ts';

let directory: string;
const installationId = randomUUID();
const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
async function preference(enabled: boolean) {
  await writeFile(
    path.join(directory, 'telemetry.json'),
    JSON.stringify({ enabled, installationId, firstOpenSent: true }),
  );
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'wisp-telemetry-'));
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
function events() {
  return fetch.mock.calls.map((call) =>
    JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
  );
}

test('development runs never send or create telemetry preferences', async () => {
  const telemetry = new UsageTelemetry(directory, '0.1.0', false);
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  expect(fetch).not.toHaveBeenCalled();
  await expect(readFile(path.join(directory, 'telemetry.json'))).rejects.toThrow();
});

test('missing and corrupt preferences fail closed', async () => {
  const telemetry = new UsageTelemetry(directory, '0.1.0', true);
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  await writeFile(path.join(directory, 'telemetry.json'), '{broken');
  telemetry.chat('hover', 'failed', 20);
  await telemetry.drain();
  expect(fetch).not.toHaveBeenCalled();
});

test('the live native opt-out stops new events without restarting the bridge', async () => {
  await preference(true);
  const telemetry = new UsageTelemetry(directory, '0.1.1-nightly.53.1', true);
  telemetry.chat('hover', 'completed', 120.8);
  await telemetry.drain();
  const event = events().find((event) => event.event === 'chat_completed');
  expect(event.distinct_id).toBe(installationId);
  expect(event.properties).toMatchObject({
    surface: 'desktop',
    app_version: '0.1.1-nightly.53.1',
    channel: 'nightly',
    mode: 'hover',
    duration_ms: 121,
  });
  expect(event.properties.$process_person_profile).toBe(false);
  const count = fetch.mock.calls.length;
  await preference(false);
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  expect(fetch).toHaveBeenCalledTimes(count);
  await preference(true);
  telemetry.chat('routine', 'completed', 10);
  await telemetry.drain();
  expect(
    events()
      .filter((event) => event.event === 'chat_completed')
      .at(-1).properties.mode,
  ).toBe('routine');
});

test('tool telemetry drops private labels, inputs, results and custom tool names', async () => {
  await preference(true);
  const telemetry = new UsageTelemetry(directory, '0.1.0', true);
  const observe = telemetry.toolObserver();
  for (const [id, name] of [
    ['a', 'wow__query_character'],
    ['b', 'my-private-server__Alice-email'],
  ]) {
    observe({
      type: 'call.requested',
      data: { callId: id, capability: { name, label: 'PRIVATE LABEL' }, input: 'PRIVATE PROMPT' },
    });
    observe({
      type: 'call.settled',
      data: { callId: id, outcome: 'completed', output: 'PRIVATE OUTPUT' },
    });
    observe({ type: 'call.settled', data: { callId: id, outcome: 'completed' } });
  }
  await telemetry.drain();
  expect(
    events()
      .map((event) => event.properties.tool)
      .sort(),
  ).toEqual(['external_tool', 'query_character']);
  expect(JSON.stringify(events())).not.toMatch(/PRIVATE|Alice|my-private|callId/);
});

test('addon polls are deduplicated and only valid versions are sent', async () => {
  await preference(true);
  const telemetry = new UsageTelemetry(directory, '0.1.0', true);
  telemetry.game('0.1.0');
  telemetry.game('0.1.0');
  telemetry.game('a character name');
  await telemetry.drain();
  expect(
    events()
      .filter((event) => event.event === 'game_connected')
      .map((event) => event.properties.addon_version)
      .sort(),
  ).toEqual(['0.1.0', 'unknown']);
});

test('network failures never escape to gameplay and shutdown cancels telemetry', async () => {
  await preference(true);
  fetch.mockRejectedValueOnce(Error('offline'));
  const telemetry = new UsageTelemetry(directory, '0.1.0', true);
  telemetry.chat('chat', 'completed', 10);
  await expect(telemetry.drain()).resolves.toBeUndefined();
  telemetry.close();
  const count = fetch.mock.calls.length;
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  expect(fetch).toHaveBeenCalledTimes(count);
});
