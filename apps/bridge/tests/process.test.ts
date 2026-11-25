import { assert, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { ProcessFailed, ProcessLayer, runProcess } from '../src/process.ts';

// Node itself is the helper: each test runs a one-line script.
const node = (script: string, options: { input?: string; maxOutputBytes?: number } = {}) =>
  runProcess(process.execPath, ['-e', script], {
    timeout: '10 seconds',
    maxOutputBytes: 1024,
    ...options,
  });

const failure = <A>(exit: Exit.Exit<A, ProcessFailed>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error
    : undefined;

it.layer(ProcessLayer)('runProcess', (it) => {
  it.effect('passes stdin through and returns stdout as UTF-8', () =>
    Effect.gen(function* () {
      const output = yield* node('process.stdin.pipe(process.stdout)', { input: 'héllo 测试' });
      assert.equal(output, 'héllo 测试');
    }),
  );

  it.effect('inherits the environment', () =>
    Effect.gen(function* () {
      const output = yield* node('process.stdout.write(process.env.PATH ? "yes" : "no")');
      assert.equal(output, 'yes');
    }),
  );

  it.effect('fails on a non-zero exit, too much output, or a missing program', () =>
    Effect.gen(function* () {
      assert.equal(failure(yield* Effect.exit(node('process.exit(3)')))?.reason, 'exit');
      assert.equal(
        failure(yield* Effect.exit(node('process.stdout.write("x".repeat(5000))')))?.reason,
        'output',
      );
      const missing = yield* Effect.exit(
        runProcess('wisp-missing-helper.exe', [], { timeout: '5 seconds', maxOutputBytes: 10 }),
      );
      assert.equal(failure(missing)?.reason, 'spawn');
    }),
  );
});

// The real clock: the test clock would never reach the timeout.
it.live('runProcess kills a process that outlives its timeout', () =>
  Effect.gen(function* () {
    const started = Date.now();
    const exit = yield* Effect.exit(
      runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        timeout: '300 millis',
        maxOutputBytes: 10,
      }),
    );
    assert.equal(failure(exit)?.reason, 'timeout');
    assert.isBelow(Date.now() - started, 10000);
  }).pipe(Effect.provide(ProcessLayer)),
);
