import { test, expect, vi } from 'vitest';
import { GameRequests } from '../src/game-requests.ts';

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
