import { test } from 'vitest';
import assert from 'node:assert/strict';
import { accountModel, chooseChatModel, resolveDefaultModel } from '../src/chat/chat-model.ts';

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

test('the default model follows the connected providers instead of one vendor', () => {
  const claude = { slug: 'connection:c:claude-sonnet', displayName: 'Claude', efforts: [] };
  const gemini = { slug: 'connection:g:gemini-flash', displayName: 'Gemini', efforts: [] };
  assert.equal(resolveDefaultModel(undefined, [claude, gemini]), claude.slug);
  assert.equal(resolveDefaultModel(gemini.slug, [claude, gemini]), gemini.slug);
  // A saved model whose connection was removed gives way to one that works.
  assert.equal(resolveDefaultModel('gpt-6.1-sol', [claude]), claude.slug);
  // Before the catalog loads, the saved choice stands; with nothing saved there is none.
  assert.equal(resolveDefaultModel('gpt-6.1-sol', []), 'gpt-6.1-sol');
  assert.equal(resolveDefaultModel(undefined, []), '');
});
