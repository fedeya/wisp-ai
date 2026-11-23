import { test, expect, vi } from 'vitest';
import { GameRequests, UNRESPONSIVE_MS } from '../src/addon/game-requests.ts';

test('responses are scoped to both transport session and conversation', async () => {
  const requests = new GameRequests(() => {});
  const result = requests.request({ chat: 'chat', session: 'one', inspection: { kind: 'target' } });
  const [{ id }] = requests.snapshot();
  expect(requests.receive(id, 'two', 'chat', { wrong: true })).toBe(false);
  expect(requests.receive(id, 'one', 'other', { wrong: true })).toBe(false);
  expect(requests.receive(id, 'one', 'chat', { correct: true })).toBe(true);
  expect(await result).toEqual({ correct: true });
  expect(requests.snapshot()).toEqual([]);
});

test('reload, deletion and HTTP cancellation reject requests and release their timers', async () => {
  const requests = new GameRequests(() => {});
  const reload = requests.request({ chat: 'a', session: 'one' });
  const deleted = requests.request({ chat: 'b', session: 'one' });
  const rejectedReload = expect(reload).rejects.toThrow('Reload');
  const rejectedDeleted = expect(deleted).rejects.toThrow('deleted');
  requests.cancelChat('b');
  requests.cancelAll('Reload');
  await Promise.all([rejectedReload, rejectedDeleted]);
  const abort = new AbortController();
  const cancelled = requests.request({ chat: 'c', session: 'two' }, abort.signal);
  const rejectedCancelled = expect(cancelled).rejects.toThrow('cancelled');
  abort.abort();
  await rejectedCancelled;
  expect(requests.snapshot()).toEqual([]);
});

test('timeout removes a request before a late game response can settle it', async () => {
  vi.useFakeTimers();
  try {
    const requests = new GameRequests(() => {});
    const result = requests.request({ chat: 'chat', session: 'one' }, undefined, 50);
    const rejected = expect(result).rejects.toThrow('did not respond');
    const [{ id }] = requests.snapshot();
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(requests.receive(id, 'one', 'chat', {})).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('lost reads recover with fresh IDs within the original deadline; actions never retry', async () => {
  vi.useFakeTimers();
  try {
    const changed = vi.fn();
    const requests = new GameRequests(changed);
    const result = requests.request({ chat: 'chat', session: 'one', sections: ['character'] });
    const [{ id: first }] = requests.snapshot();
    await vi.advanceTimersByTimeAsync(10_000);
    const [{ id: second }] = requests.snapshot();
    expect(second).not.toBe(first);
    expect(requests.receive(first, 'one', 'other', {})).toBe(false);
    expect(requests.receive(first, 'one', 'chat', { xp: 100 })).toBe(true);
    expect(requests.receive(second, 'one', 'chat', {})).toBe(false);
    expect(await result).toEqual({ xp: 100 });
    expect(vi.getTimerCount()).toBe(0);
    const action = requests.request({ chat: 'chat', session: 'one', action: { kind: 'test' } });
    const [{ id }] = requests.snapshot();
    const rejected = expect(action).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(requests.snapshot()[0].id).toBe(id);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('after one timeout, game requests fail at once until WoW answers or a minute passes', async () => {
  vi.useFakeTimers();
  try {
    let clock = 1_000_000;
    const timeouts: unknown[] = [];
    const requests = new GameRequests(() => {}, {
      now: () => clock,
      onTimeout: (timeout) => timeouts.push(timeout),
    });
    requests.heard();
    const first = requests.request({
      chat: 'chat',
      session: 'one',
      agent: true,
      sections: ['gear'],
    });
    const firstRejected = expect(first).rejects.toThrow('Do not call game tools again');
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await firstRejected;
    expect(timeouts).toEqual([{ kind: 'state', addonSilent: true, waitedMs: 30_000 }]);

    // The next read in the same turn does not wait another 30 seconds.
    await expect(
      requests.request({
        chat: 'chat',
        session: 'one',
        agent: true,
        inspection: { kind: 'target' },
      }),
    ).rejects.toThrow('was not sent');
    expect(requests.snapshot()).toEqual([]);

    // A minute later the channel is tried again; an answer clears the state.
    clock += UNRESPONSIVE_MS;
    const retried = requests.request({
      chat: 'chat',
      session: 'one',
      agent: true,
      sections: ['gear'],
    });
    const [{ id }] = requests.snapshot();
    requests.heard();
    expect(requests.receive(id, 'one', 'chat', { ok: true })).toBe(true);
    expect(await retried).toEqual({ ok: true });
    const after = requests.request({
      chat: 'chat',
      session: 'one',
      agent: true,
      sections: ['gear'],
    });
    expect(requests.snapshot()).toHaveLength(1);
    requests.cancelAll('done');
    await expect(after).rejects.toThrow('done');
  } finally {
    vi.useRealTimers();
  }
});

test('a timeout reports whether the addon kept talking while the request waited', async () => {
  vi.useFakeTimers();
  try {
    let clock = 1_000_000;
    const timeouts: { addonSilent: boolean }[] = [];
    const requests = new GameRequests(() => {}, {
      now: () => clock,
      onTimeout: (timeout) => timeouts.push(timeout),
    });
    const action = requests.request({
      chat: 'chat',
      session: 'one',
      agent: true,
      action: { kind: 'test' },
    });
    const rejected = expect(action).rejects.toThrow('did not respond');
    clock += 10_000;
    requests.heard();
    clock += 20_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(timeouts).toEqual([{ kind: 'action', addonSilent: false, waitedMs: 30_000 }]);
    // A reconnection starts over instead of failing the new window's requests.
    requests.cancelAll('reconnected');
    const fresh = requests.request({
      chat: 'chat',
      session: 'two',
      agent: true,
      sections: ['gear'],
    });
    expect(requests.snapshot()).toHaveLength(1);
    requests.cancelAll('done');
    await expect(fresh).rejects.toThrow('done');
  } finally {
    vi.useRealTimers();
  }
});

test('a valid late answer to a timed-out read lets new requests through again', async () => {
  vi.useFakeTimers();
  try {
    let clock = 1_000_000;
    const requests = new GameRequests(() => {}, { now: () => clock });
    const read = requests.request({
      chat: 'chat',
      session: 'one',
      agent: true,
      sections: ['gear'],
    });
    const [{ id: first }] = requests.snapshot();
    await vi.advanceTimersByTimeAsync(10_000);
    const [{ id: retried }] = requests.snapshot();
    const rejected = expect(read).rejects.toThrow('did not respond');
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    await expect(requests.request({ chat: 'chat', session: 'one', agent: true })).rejects.toThrow(
      'was not sent',
    );

    // Answers from the wrong window or conversation do not count.
    expect(requests.receive(first, 'two', 'chat', {})).toBe(false);
    expect(requests.receive(first, 'one', 'other', {})).toBe(false);
    await expect(requests.request({ chat: 'chat', session: 'one', agent: true })).rejects.toThrow(
      'was not sent',
    );

    // WoW answers the original ID late: the rejected read stays rejected, new ones are sent.
    expect(requests.receive(retried, 'one', 'chat', { late: true })).toBe(false);
    const next = requests.request({
      chat: 'chat',
      session: 'one',
      agent: true,
      sections: ['gear'],
    });
    expect(requests.snapshot()).toHaveLength(1);
    requests.cancelAll('done');
    await expect(next).rejects.toThrow('done');
  } finally {
    vi.useRealTimers();
  }
});

test('requests the player starts are still sent while WoW is unresponsive, with a message for the player', async () => {
  vi.useFakeTimers();
  try {
    let clock = 1_000_000;
    const requests = new GameRequests(() => {}, { now: () => clock });
    const settings = requests.request({ chat: 'chat', session: 'one', action: { kind: 'test' } });
    const rejected = expect(settings).rejects.toThrow(
      'WoW did not respond in time. Open Wisp and try again.',
    );
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    // The agent's next call fails at once; the player's next click is sent.
    await expect(requests.request({ chat: 'chat', session: 'one', agent: true })).rejects.toThrow(
      'was not sent',
    );
    const simulation = requests.request({ chat: 'sim', session: 'one', sections: ['gear'] });
    const [{ id }] = requests.snapshot();
    expect(requests.receive(id, 'one', 'sim', { ok: true })).toBe(true);
    expect(await simulation).toEqual({ ok: true });
    // Its answer shows WoW is back, so the agent's calls go through again.
    const agent = requests.request({ chat: 'chat', session: 'one', agent: true });
    expect(requests.snapshot()).toHaveLength(1);
    requests.cancelAll('done');
    await expect(agent).rejects.toThrow('done');
  } finally {
    vi.useRealTimers();
  }
});
