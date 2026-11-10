import { test } from 'vitest';
import assert from 'node:assert/strict';
import { accountModel, chooseChatModel } from '../src/chat-model.ts';

test('account metadata controls models and supported efforts without inventing levels', () => {
  const model = accountModel({
    slug: 'test',
    display_name: 'Test',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'max' },
      { effort: 'ultra' },
      { effort: 'invalid' },
    ],
    context_window: 200000,
  });
  assert.deepEqual(model.efforts, ['low', 'medium', 'max', 'ultra']);
  assert.equal(model.contextWindow, 200000);
  assert.deepEqual(chooseChatModel([model], 'test'), { model: 'test', effort: 'medium' });
  assert.equal(chooseChatModel([model], 'test', 'ultra').effort, 'ultra');
  assert.throws(() => chooseChatModel([model], 'test', 'high'), /supported effort/);
  assert.throws(() => chooseChatModel([model], 'missing'), /not available/);
  const limited = accountModel({
    slug: 'limited',
    supported_reasoning_levels: [{ effort: 'low' }],
  });
  assert.equal(chooseChatModel([limited], 'limited').effort, 'low');
  assert.throws(() => chooseChatModel([limited], 'limited', 'medium'), /supported effort/);
  const unknown = accountModel({ slug: 'unknown' });
  assert.equal(chooseChatModel([unknown], 'unknown').effort, 'provider-default');
  assert.throws(() => chooseChatModel([unknown], 'unknown', 'high'), /supported effort/);
});
