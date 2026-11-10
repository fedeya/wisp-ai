import { test, expect } from 'vitest';
import { RuntimeResources } from '../src/runtime-resources.ts';
test('partial startup cleanup runs in reverse order, continues after failures and is idempotent', async () => {
  const resources = new RuntimeResources();
  const closed: string[] = [];
  resources.defer(() => {
    closed.push('storage');
  });
  resources.defer(() => {
    closed.push('agent');
    throw Error('agent cleanup failed');
  });
  resources.defer(async () => {
    closed.push('server');
  });
  const closing = resources.close();
  expect(resources.close()).toBe(closing);
  await expect(closing).rejects.toThrow('cleanup failed');
  expect(closed).toEqual(['server', 'agent', 'storage']);
});
