import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createPublishScheduler,
  PUBLISH_COALESCE_MS,
  PUBLISH_MIN_INTERVAL_MS,
} from '../src/publish-scheduler.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

test('a single change publishes after the short coalescing window', () => {
  const publish = vi.fn();
  const scheduler = createPublishScheduler(publish);
  scheduler.schedule();
  vi.advanceTimersByTime(PUBLISH_COALESCE_MS - 1);
  expect(publish).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(publish).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

test('a burst of changes coalesces into one publish', () => {
  const publish = vi.fn();
  const scheduler = createPublishScheduler(publish);
  for (let i = 0; i < 20; i++) {
    scheduler.schedule();
    vi.advanceTimersByTime(1);
  }
  vi.advanceTimersByTime(PUBLISH_COALESCE_MS);
  expect(publish).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

test('publishes keep the minimum interval and never wait longer than it', () => {
  const at: number[] = [];
  const scheduler = createPublishScheduler(() => at.push(Date.now()));
  // A change every 10ms for two seconds, like a streaming reply.
  for (let t = 0; t < 2000; t += 10) {
    scheduler.schedule();
    vi.advanceTimersByTime(10);
  }
  vi.advanceTimersByTime(PUBLISH_MIN_INTERVAL_MS);
  expect(at[0]).toBe(PUBLISH_COALESCE_MS);
  for (let i = 1; i < at.length; i++) {
    expect(at[i] - at[i - 1]).toBe(PUBLISH_MIN_INTERVAL_MS);
  }
  expect(at.length).toBe(6);
  scheduler.stop();
});

test('a change right after a publish waits out the interval, not longer', () => {
  const publish = vi.fn();
  const scheduler = createPublishScheduler(publish);
  scheduler.schedule();
  vi.advanceTimersByTime(PUBLISH_COALESCE_MS);
  scheduler.schedule();
  vi.advanceTimersByTime(PUBLISH_MIN_INTERVAL_MS - 1);
  expect(publish).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(publish).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

test('an idle change after a quiet period publishes after the coalescing window', () => {
  const publish = vi.fn();
  const scheduler = createPublishScheduler(publish);
  scheduler.schedule();
  vi.advanceTimersByTime(5000);
  scheduler.schedule();
  vi.advanceTimersByTime(PUBLISH_COALESCE_MS);
  expect(publish).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

test('stop cancels a pending publish and leaves no timers behind', () => {
  const publish = vi.fn();
  const scheduler = createPublishScheduler(publish);
  scheduler.schedule();
  expect(vi.getTimerCount()).toBe(1);
  scheduler.stop();
  expect(vi.getTimerCount()).toBe(0);
  scheduler.schedule();
  expect(vi.getTimerCount()).toBe(0);
  vi.runAllTimers();
  expect(publish).not.toHaveBeenCalled();
});
