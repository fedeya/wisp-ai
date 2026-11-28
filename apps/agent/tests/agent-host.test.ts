import { afterEach, expect, it } from '@effect/vitest';
import { agentHost, setAgentHost } from '../src/host/agent-host.ts';

afterEach(() => setAgentHost(undefined));

it('the registered host is shared through globalThis', () => {
  expect(agentHost()).toBeUndefined();
  setAgentHost({ origin: 'http://127.0.0.1:1', token: 'secret', capabilitiesFile: 'agent.json' });
  // Another copy of this module reads the same slot.
  expect(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('wisp.agent-host'))).toMatchObject({
    value: {
      origin: 'http://127.0.0.1:1',
      token: 'secret',
      capabilitiesFile: 'agent.json',
    },
  });
  expect(agentHost()).toEqual({
    origin: 'http://127.0.0.1:1',
    token: 'secret',
    capabilitiesFile: 'agent.json',
  });
  setAgentHost(undefined);
  expect(agentHost()).toBeUndefined();
});

it('a slot another copy left in a shape this one does not know reads as no host', () => {
  Object.assign(globalThis, { [Symbol.for('wisp.agent-host')]: { origin: 1 } });
  expect(agentHost()).toBeUndefined();
});
