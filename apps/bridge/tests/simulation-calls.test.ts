import { test, expect, vi } from 'vitest';
import { createAgentCalls } from '../src/agent/agent-calls.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

test('simulation calls skip game reads and transport freshness for hypothetical requests only', async () => {
  const chat = { ...newChat('sim', 'old-addon'), status: 'working' as const, agentSession: 'eve' };
  const readSimulationCharacter = vi.fn(async () => ({ sections: {} }));
  const run = vi.fn(async () => ({ status: 'native', result: {} }));
  let enabled = true;
  let transport = 'new-addon';
  const agent = createAgentCalls({
    getChats: () => [chat],
    currentTransport: () => transport,
    capabilitySettings: { enabled: () => enabled },
    readSimulationCharacter,
    simulator: { run },
  } as unknown as Parameters<typeof createAgentCalls>[0]);
  const simulate = (input: unknown) =>
    agent.call('eve', 'simulate', input as never, new AbortController().signal);

  const nativeRequest = { raid: {} };
  await simulate({ nativeRequest });
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
  await simulate(hypothetical);
  expect(readSimulationCharacter).not.toHaveBeenCalled();
  // A plan for the live character needs the chat's own game connection.
  await expect(simulate({ plans: hypothetical.plans })).rejects.toThrow('No active connection');
  expect(readSimulationCharacter).not.toHaveBeenCalled();
  transport = 'old-addon';
  await simulate({ plans: hypothetical.plans });
  expect(readSimulationCharacter).toHaveBeenCalledOnce();
  enabled = false;
  await expect(simulate({ nativeRequest })).rejects.toThrow('DPS simulation is disabled');
  expect(run).toHaveBeenCalledTimes(3);
});
