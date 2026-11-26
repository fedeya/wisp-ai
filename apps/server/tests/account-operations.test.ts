import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAccountOperations } from '../src/account-operations.ts';

function setup({ stopping = false, activeTurn = false } = {}) {
  const flags = { stopping, activeTurn, after: 0 };
  const accounts = createAccountOperations({
    isStopping: () => flags.stopping,
    hasActiveTurn: () => flags.activeTurn,
    afterOperation: () => flags.after++,
  });
  return { flags, accounts };
}

test('runs one account operation at a time and refreshes afterwards', async () => {
  const { flags, accounts } = setup();
  let finish!: (value: string) => void;
  const first = accounts.run(() => new Promise<string>((resolve) => (finish = resolve)));
  assert.equal(accounts.busy(), true);
  await assert.rejects(
    accounts.run(async () => 'second'),
    /Wait for the active operation/,
  );
  const drained = accounts.drain();
  finish('done');
  assert.equal(await first, 'done');
  await drained;
  assert.equal(accounts.busy(), false);
  assert.equal(flags.after, 1);
});

test('refuses while a turn runs or the bridge stops', async () => {
  await assert.rejects(
    setup({ activeTurn: true }).accounts.run(async () => 1),
    /Wait/,
  );
  await assert.rejects(
    setup({ stopping: true }).accounts.run(async () => 1),
    /Wait/,
  );
});

test('skips the refresh when the bridge stopped during the operation', async () => {
  const { flags, accounts } = setup();
  await assert.rejects(
    accounts.run(async () => {
      flags.stopping = true;
      throw Error('failed');
    }),
    /failed/,
  );
  assert.equal(flags.after, 0);
  assert.equal(accounts.busy(), false);
});
