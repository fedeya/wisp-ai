import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { dynamicEvaluate } from './node_modules/eve/dist/src/dynamic/definition.js';
import definition from '../apps/agent/agent/tools/wow__inspect_lockouts.ts';
import { CapabilitySettings } from '../apps/bridge/src/capabilities.ts';
import { createAgentHandler } from '../apps/bridge/src/agent-server.ts';
import { newChat } from '../apps/bridge/src/chat-lifecycle.ts';
import { GameRequests } from '../apps/bridge/src/game-requests.ts';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { lockoutsReading } from '@wisp/protocol/lockouts';

// Real native Lua 5.1 modules, isolated public API fixtures. Only JSON encoding
// lives in the fixture; there is no parallel lockout implementation here.
function nativeReading(updated: boolean | 'oversized' = false) {
  return JSON.parse(
    execFileSync(
      'lua',
      [
        'addon/tests/fixtures/lockouts-rpc.lua',
        updated === 'oversized' ? updated : updated ? 'updated' : 'initial',
      ],
      { encoding: 'utf8', timeout: 5000 },
    ),
  );
}

test('deferred Eve lockout tool -> authenticated active-session RPC -> native Lua cached read', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-lockouts-'));
  const settings = new CapabilitySettings(path.join(directory, 'choices.json'));
  settings.agentFile = path.join(directory, 'agent.json');
  vi.stubEnv('WOW_CAPABILITIES_FILE', settings.agentFile);
  const chat = newChat('lockouts', 'addon');
  chat.eveId = 'eve-lockouts';
  chat.status = 'working';
  let transport = 'addon';
  let changed = false;
  let served = 0;
  let replaceInFlight = false;
  let revokeInFlight = false;
  const pending = new GameRequests(() => {
    const request = pending.snapshot()[0];
    if (!request) return;
    queueMicrotask(() => {
      expect(request.inspection).toEqual({ kind: 'lockouts', args: { limit: 20 } });
      expect(pending.receive(request.id, 'wrong-session', chat.id, {})).toBe(false);
      expect(pending.receive(request.id, 'addon', 'wrong-chat', {})).toBe(false);
      served++;
      if (replaceInFlight) transport = 'other';
      if (revokeInFlight) {
        settings.availability.set('tool:inspect_lockouts', {
          available: false,
          status: 'unavailable',
        });
      }
      pending.receive(request.id, 'addon', chat.id, nativeReading(changed));
    });
  });
  const server = createServer(
    createAgentHandler({
      token: 'fixture-token',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: settings,
      pending,
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  vi.stubEnv('WOW_BRIDGE_URL', origin);
  vi.stubEnv('WOW_BRIDGE_TOKEN', 'fixture-token');
  const resolve = () => dynamicEvaluate(definition)({} as never);
  const payload = { eveSession: 'eve-lockouts', inspection: { kind: 'lockouts', args: {} } };
  const post = (body = payload, token = 'fixture-token') =>
    fetch(origin + '/inspect', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
  try {
    await settings.publish();
    expect(
      defaultCapabilities().find((entry) => entry.id === 'tool:inspect_lockouts'),
    ).toMatchObject({ parent: 'core:wow', toolName: 'wow__inspect_lockouts' });
    const tool = (await resolve())!;
    expect(tool.deferred).toBe(true);
    expect((await post(payload, 'wrong')).status).toBe(403);
    expect((await post({ ...payload, eveSession: 'other' })).status).toBe(503);
    transport = 'other';
    expect((await post()).status).toBe(503);
    transport = 'addon';
    chat.status = 'done';
    expect((await post()).status).toBe(503);
    chat.status = 'working';
    settings.availability.set('tool:inspect_lockouts', { available: false, status: 'unavailable' });
    await settings.publish();
    expect(await resolve()).toBeNull();
    expect((await post()).status).toBe(503);
    expect(served).toBe(0);
    settings.availability.delete('tool:inspect_lockouts');
    await settings.publish();
    const execute = async () =>
      lockoutsReading.parse(
        await tool.execute({ limit: 20 }, {
          session: { id: 'eve-lockouts' },
          abortSignal: new AbortController().signal,
        } as never),
      );
    const first = await execute();
    if (first.status === 'unavailable') throw Error(first.error);
    expect(first.data?.records.map((record) => record.name)).toEqual([
      'Soon',
      'Later',
      'Expired',
      'Unknown',
    ]);
    expect(first.data?.cache.status).toBe('unobserved');
    expect(first.data?.records[0]).toMatchObject({
      difficultyId: 1,
      resetSeconds: 300,
      locked: true,
    });
    changed = true;
    const next = await execute();
    if (next.status === 'unavailable') throw Error(next.error);
    expect(next.data?.records[0].resetSeconds).toBe(60);
    expect(next.data?.cache).toMatchObject({
      status: 'update_observed',
      ageSeconds: 42,
      observedAt: 1000,
    });
    expect(next.capturedAt).toBe(1042);
    expect(served).toBe(2);
    replaceInFlight = true;
    await expect(execute()).rejects.toThrow('obsolete character session');
    replaceInFlight = false;
    transport = 'addon';
    revokeInFlight = true;
    await expect(execute()).rejects.toThrow('disabled');
    expect(Buffer.byteLength(JSON.stringify(next)) + 4096).toBeLessThanOrEqual(
      next.data!.wireUpperBoundBytes,
    );
    expect(
      (
        await post({
          ...payload,
          inspection: { kind: 'lockouts', args: { refresh: true } },
        } as never)
      ).status,
    ).toBe(503);
    expect(served).toBe(4);
  } finally {
    pending.cancelAll('test cleanup');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native escaped UTF-8 output includes envelope budget, clipping and omitted coverage', () => {
  const result = lockoutsReading.parse(nativeReading('oversized'));
  if (result.status === 'unavailable') throw Error(result.error);
  expect(result.status).toBe('partial');
  expect(result.data).toMatchObject({
    cachedCount: 10000,
    scannedCount: 100,
    truncated: true,
    textTruncated: true,
    budgetOmitted: true,
  });
  expect(result.data.records.length).toBeGreaterThan(0);
  for (const record of result.data.records) {
    expect(Buffer.byteLength(record.name!)).toBeLessThanOrEqual(160);
    expect(Buffer.byteLength(record.difficultyName!)).toBeLessThanOrEqual(96);
    expect(record.difficultyName).not.toContain('\uFFFD');
  }
  expect(Buffer.byteLength(JSON.stringify(result)) + 4096).toBeLessThanOrEqual(
    result.data.wireUpperBoundBytes,
  );
  expect(result.data.wireUpperBoundBytes).toBeLessThanOrEqual(20000);
  const envelope = {
    type: 'state_result',
    session: '\u0001'.repeat(100),
    chat: '\u0001'.repeat(200),
    requestId: '\u0001'.repeat(200),
    seq: Number.MAX_SAFE_INTEGER,
    at: Number.MAX_SAFE_INTEGER,
    data: result,
  };
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
    result.data.wireUpperBoundBytes,
  );
});
