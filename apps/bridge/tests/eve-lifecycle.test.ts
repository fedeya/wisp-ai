import { afterEach, expect, test, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/app-paths.ts', () => ({ prepareEngine: async () => {} }));

const { createEveLifecycle } = await import('../src/agent/eve-lifecycle.ts');

interface FakeEve {
  child: ChildProcess;
  exit: (code: number | null) => void;
}

function harness({ stopping = (): boolean => false } = {}) {
  const spawned: FakeEve[] = [];
  const info = vi.fn();
  const eve = createEveLifecycle({
    agentRoot: 'agent',
    engineRoot: 'engine',
    port: 1,
    logPath: path.join(os.tmpdir(), 'wisp-eve-lifecycle-test.log'),
    environment: () => ({}),
    client: { health: async () => ({}) as never, info: async () => ({ agent: {} }) as never },
    restartDelaysMs: [10, 20],
    startAgent: (options) => {
      // exitCode set: stopEveProcess treats the fake as already ended.
      const child = { pid: 1000 + spawned.length, exitCode: 0 } as unknown as ChildProcess;
      spawned.push({ child, exit: options.onExit });
      return child;
    },
    changed: () => {},
    isStopping: stopping,
    logger: { info, error: vi.fn() },
  });
  eve.openLog();
  return { eve, spawned, info };
}

afterEach(() => {
  vi.useRealTimers();
});

test('Eve is started again with growing delays after it exits on its own', async () => {
  const { eve, spawned } = harness();
  await eve.prepare();
  expect(spawned).toHaveLength(1);
  vi.useFakeTimers();
  try {
    spawned[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(2);
    spawned[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(19);
    expect(spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(3);
  } finally {
    await eve.stop();
    eve.closeLog();
  }
});

test('a stopped or replaced Eve is not restarted when its exit arrives', async () => {
  const { eve, spawned } = harness();
  await eve.prepare();
  vi.useFakeTimers();
  try {
    await eve.restart();
    expect(spawned).toHaveLength(2);
    spawned[0]!.exit(0);
    await eve.stop();
    spawned[1]!.exit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(spawned).toHaveLength(2);
  } finally {
    eve.closeLog();
  }
});

test('stopping the bridge cancels a pending restart', async () => {
  let stopping = false;
  const { eve, spawned } = harness({ stopping: () => stopping });
  await eve.prepare();
  vi.useFakeTimers();
  try {
    spawned[0]!.exit(1);
    stopping = true;
    await eve.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(spawned).toHaveLength(1);
  } finally {
    eve.closeLog();
  }
});
