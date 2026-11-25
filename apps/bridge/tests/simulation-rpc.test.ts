import { test, expect, vi } from 'vitest';
import { serveAgent } from './agent-server-fixture.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

test('simulation RPC skips game reads and transport freshness for hypothetical requests only', async () => {
  const chat = { ...newChat('sim', 'old-addon'), status: 'working' as const, agentSession: 'eve' };
  const readSimulationCharacter = vi.fn(async () => ({ sections: {} }));
  const run = vi.fn(async () => ({ status: 'native', result: {} }));
  let enabled = true;
  let transport = 'new-addon';
  const server = await serveAgent({
    token: 'test',
    getChats: () => [chat],
    currentTransport: () => transport,
    capabilitySettings: { enabled: () => enabled } as never,
    readSimulationCharacter,
    simulator: { run } as never,
  });
  const url = server.origin + '/simulate';
  const post = (input: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ agentSession: 'eve', ...(input as object) }),
    });
  try {
    const nativeRequest = { raid: {}, padding: 'x'.repeat(33000) };
    const native = await post({ nativeRequest });
    expect(native.status).toBe(200);
    expect(run).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ nativeRequest }),
      expect.any(AbortSignal),
    );
    const hypothetical = {
      character: { class: 'MAGE', level: 14, raceToken: 'Human' },
      includeCurrentEquipment: false,
      equipmentSets: [{ label: 'Naked', base: 'empty', replacements: [] }],
      plans: [{ label: 'Idle', priority: [] }],
    };
    expect((await post(hypothetical)).status).toBe(200);
    expect(readSimulationCharacter).not.toHaveBeenCalled();
    expect((await post({ plans: hypothetical.plans })).status).toBe(503);
    expect(readSimulationCharacter).not.toHaveBeenCalled();
    transport = 'old-addon';
    expect((await post({ plans: hypothetical.plans })).status).toBe(200);
    expect(readSimulationCharacter).toHaveBeenCalledOnce();
    enabled = false;
    expect((await post({ nativeRequest })).status).toBe(503);
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    await server.close();
  }
});
