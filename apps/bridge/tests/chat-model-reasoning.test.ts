import { expect, test } from 'vitest';

import { chooseChatModel } from '@wisp/bridge/chat-model';

test('API chats preserve provider defaults, allow reverting, and reject unsupported efforts', () => {
  const catalog = [
    {
      slug: 'api',
      displayName: 'API',
      efforts: ['provider-default', 'low', 'high'],
      defaultEffort: 'provider-default',
    },
  ];
  expect(chooseChatModel(catalog, 'api').effort).toBe('provider-default');
  expect(chooseChatModel(catalog, 'api', 'high').effort).toBe('high');
  expect(chooseChatModel(catalog, 'api', 'provider-default').effort).toBe('provider-default');
  expect(() => chooseChatModel(catalog, 'api', 'medium')).toThrow('supported effort');
});
