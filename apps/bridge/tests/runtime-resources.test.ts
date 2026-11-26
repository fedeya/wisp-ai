import { test, expect } from 'vitest';
import { RuntimeResources } from '../src/runtime-resources.ts';
test('partial startup cleanup runs in reverse order, continues after failures and is idempotent', async () => {
  const resources = new RuntimeResources();
  const closed: string[] = [];
  const agentError = Error('agent cleanup failed');
  const serverError = Error('server cleanup failed');
  resources.defer(() => {
    closed.push('storage');
  });
  resources.defer(() => {
    closed.push('agent');
    throw agentError;
  });
  resources.defer(async () => {
    closed.push('server');
    throw serverError;
  });
  const closing = resources.close();
  expect(resources.close()).toBe(closing);
  await expect(closing).rejects.toMatchObject({
    message: 'Runtime cleanup failed',
    errors: [serverError, agentError],
  });
  expect(closed).toEqual(['server', 'agent', 'storage']);
});
