import { expect, test } from 'vitest';
import { suggestedModels } from './suggested-models';

test('suggests tool-capable models without snapshots of listed aliases', () => {
  const suggested = suggestedModels([
    { id: 'gpt-4o', contextWindow: 128_000, supportsTools: true },
    { id: 'gpt-4o-2024-08-06', contextWindow: 128_000, supportsTools: true },
    { id: 'claude-sonnet-4-5-20250929', contextWindow: 200_000, supportsTools: true },
    { id: 'gpt-5-chat-latest', contextWindow: 128_000, supportsTools: false },
    { id: 'text-embedding-3-large' },
  ]);
  expect(suggested).toEqual([
    { id: 'gpt-4o', contextWindow: 128_000 },
    { id: 'claude-sonnet-4-5-20250929', contextWindow: 200_000 },
  ]);
});
