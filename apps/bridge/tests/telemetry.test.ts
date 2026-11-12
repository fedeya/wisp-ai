import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { UsageTelemetry, type ChatErrorCode } from '../src/telemetry.ts';

let directory: string;
const installationId = randomUUID();
const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
const instances: UsageTelemetry[] = [];
function createTelemetry(version = '0.1.0', release = true) {
  const instance = new UsageTelemetry(directory, version, release);
  instances.push(instance);
  return instance;
}
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
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
function events() {
  return fetch.mock.calls.flatMap((call) => {
    const body = (call as unknown as [string, RequestInit])[1].body;
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);
    const payload = JSON.parse(
      (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString(),
    );
    return (payload.batch ?? [payload]).map(
      (event: { distinct_id?: string; properties: Record<string, unknown> }) => ({
        ...event,
        distinct_id: event.distinct_id ?? event.properties.distinct_id,
      }),
    );
  });
}

test('development runs never send or create telemetry preferences', async () => {
  const telemetry = createTelemetry('0.1.0', false);
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  expect(fetch).not.toHaveBeenCalled();
  await expect(readFile(path.join(directory, 'telemetry.json'))).rejects.toThrow();
});

test('missing and corrupt preferences fail closed', async () => {
  const telemetry = createTelemetry();
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  await writeFile(path.join(directory, 'telemetry.json'), '{broken');
  telemetry.chat('hover', 'failed', 20);
  await telemetry.drain();
  expect(fetch).not.toHaveBeenCalled();
});

test('the live native opt-out stops new events without restarting the bridge', async () => {
  await preference(true);
  const telemetry = createTelemetry('0.1.1-nightly.53.1');
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
  const telemetry = createTelemetry();
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

test('chat telemetry only sends allowlisted failure codes', async () => {
  await preference(true);
  const telemetry = createTelemetry();
  telemetry.chat('chat', 'failed', 10, 'model_auth_failed');
  telemetry.chat('hover', 'failed', 20, 'PRIVATE PROVIDER ERROR' as ChatErrorCode);
  telemetry.chat('routine', 'timeout', 30);
  telemetry.chat('chat', 'completed', 40, 'turn_stream_failed');
  telemetry.chat('chat', 'cancelled', 50, 'turn_stream_failed');
  telemetry.chat('chat', 'needs_input', 60);
  await telemetry.drain();

  const chats = events()
    .filter((event) => event.event === 'chat_completed')
    .map((event) => event.properties)
    .sort((a, b) => a.duration_ms - b.duration_ms);
  expect(chats.map(({ error_code }) => error_code)).toEqual([
    'model_auth_failed',
    'unknown',
    'timeout',
    undefined,
    undefined,
    undefined,
  ]);
  expect(JSON.stringify(chats)).not.toContain('PRIVATE PROVIDER ERROR');
});

test('addon polls are deduplicated and only valid versions are sent', async () => {
  await preference(true);
  const telemetry = createTelemetry();
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

test('game handshakes record one stable outcome per observed session', async () => {
  await preference(true);
  const telemetry = createTelemetry();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    telemetry.gameConnectionProgress(false, false);
    telemetry.gameConnectionStarted();
    clock.mockReturnValue(2000);
    telemetry.gameConnectionProgress(true, true);
    telemetry.gameConnectionProgress(true, true);

    telemetry.gameConnectionStarted();
    clock.mockReturnValue(31_999);
    telemetry.gameConnectionProgress(false, false);
    clock.mockReturnValue(32_000);
    telemetry.gameConnectionProgress(false, false);
    telemetry.gameConnectionProgress(true, true);

    telemetry.gameConnectionStarted();
    clock.mockReturnValue(62_000);
    telemetry.gameConnectionProgress(false, true);

    telemetry.gameConnectionStarted();
    clock.mockReturnValue(63_000);
    telemetry.gameConnectionStarted();

    await telemetry.drain();
    const attempts = events().filter((event) => event.event === 'game_connection_finished');
    expect(attempts).toHaveLength(4);
    expect(attempts.map((event) => event.properties)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'stable',
          app_version: '0.1.0',
          outcome: 'connected',
          duration_ms: 2000,
        }),
        expect.objectContaining({
          outcome: 'timeout',
          error_code: 'engine_not_ready',
          duration_ms: 30_000,
        }),
        expect.objectContaining({
          outcome: 'timeout',
          error_code: 'addon_ack_missing',
          duration_ms: 30_000,
        }),
        expect.objectContaining({
          outcome: 'failed',
          error_code: 'session_replaced',
          duration_ms: 1000,
        }),
      ]),
    );
    expect(
      attempts.find((event) => event.properties.outcome === 'connected').properties,
    ).not.toHaveProperty('error_code');
  } finally {
    clock.mockRestore();
  }
});

test('network failures never escape to gameplay and shutdown stops future telemetry', async () => {
  await preference(true);
  fetch.mockRejectedValueOnce(Error('offline'));
  const telemetry = createTelemetry();
  telemetry.chat('chat', 'completed', 10);
  await expect(telemetry.drain()).resolves.toBeUndefined();
  await telemetry.close();
  const count = fetch.mock.calls.length;
  telemetry.chat('chat', 'completed', 10);
  await telemetry.drain();
  expect(fetch).toHaveBeenCalledTimes(count);
});
