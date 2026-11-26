import { expect, test } from 'vitest';
import { sessionHost, type AgentHostCalls } from '../src/contract/host-calls.ts';

const never = new Promise<never>(() => {});

test('a session host names its session and passes the call through', async () => {
  const seen: unknown[] = [];
  const calls: AgentHostCalls = {
    selectedModel: () => never,
    call: async (session, call, input) => {
      seen.push([session, call, input]);
      return { title: 'Raid prep' } as never;
    },
  };
  const host = sessionHost(calls, 'session-1', new AbortController().signal);
  await expect(host('title', { title: 'Raid prep' })).resolves.toEqual({ title: 'Raid prep' });
  expect(seen).toEqual([['session-1', 'title', { title: 'Raid prep' }]]);
});

test('a call that hangs ends when the tool is cancelled or its time runs out', async () => {
  let received: AbortSignal | undefined;
  const calls: AgentHostCalls = {
    selectedModel: () => never,
    call: (_session, _call, _input, signal) => {
      received = signal;
      return never;
    },
  };
  const cancel = new AbortController();
  const cancelled = sessionHost(calls, 's', cancel.signal)('identity', {});
  cancel.abort(Error('Stopped'));
  await expect(cancelled).rejects.toThrow('Stopped');
  // The host's own work sees the same cancellation.
  expect(received?.aborted).toBe(true);

  await expect(
    sessionHost(calls, 's', new AbortController().signal)('identity', {}, 10),
  ).rejects.toThrow();
});
