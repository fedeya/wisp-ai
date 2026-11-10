import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createAgentHandler } from '../src/agent-server.ts';
import { newChat } from '../src/chat-lifecycle.ts';

test('simulation RPC skips game reads and transport freshness for hypothetical requests only', async () => {
  const chat = { ...newChat('sim', 'old-addon'), status: 'working' as const, eveId: 'eve' };
  const readSimulationCharacter = vi.fn(async () => ({ sections: {} }));
  const run = vi.fn(async () => ({ status: 'native', result: {} }));
  let enabled = true;
  let transport = 'new-addon';
  const server = createServer(
    createAgentHandler({
      token: 'test',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: { enabled: () => enabled },
      readSimulationCharacter,
      simulator: { run },
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/simulate';
  const post = (input: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ eveSession: 'eve', ...(input as object) }),
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
