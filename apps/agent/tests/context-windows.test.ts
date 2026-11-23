import { expect, test } from 'vitest';
import {
  fallbackContextWindow,
  knownContextWindow,
  modelContextWindow,
} from '../src/context-windows.ts';

test.each([
  ['gpt-5', 400_000],
  ['gpt-5.4-mini', 400_000],
  ['gpt-5-codex', 400_000],
  ['gpt-5.1-chat-latest', 128_000],
  ['gpt-4.1-2025-04-14', 1_047_576],
  ['gpt-4o-mini', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4-0613', 8_192],
  ['gpt-4-32k', 32_768],
  ['o1-mini', 128_000],
  ['o3', 200_000],
  ['o4-mini-2025-04-16', 200_000],
  ['claude-sonnet-4-5-20250929', 200_000],
  ['claude-opus-4-6', 200_000],
  ['claude-2.1', 100_000],
  ['anthropic/claude-sonnet-4.5', 200_000],
  ['gemini-2.5-flash', 1_048_576],
  ['grok-4-1-fast-reasoning', 2_000_000],
  ['grok-4-0709', 256_000],
  ['grok-code-fast-1', 256_000],
  ['grok-3-mini', 131_072],
  ['deepseek-chat', 128_000],
  ['deepseek/deepseek-r1:free', 128_000],
  ['kimi-k2-0711-preview', 131_072],
  ['kimi-k2-thinking', 262_144],
  ['moonshot-v1-8k', 8_192],
  ['moonshot-v1-128k', 131_072],
  ['MiniMax-M2', 204_800],
  ['glm-4.5-air', 128_000],
  ['glm-4.6', 200_000],
  ['zai-glm-4.6', 200_000],
  ['qwen3-max', 262_144],
  ['qwen3-coder-plus', 1_000_000],
  ['qwen3-235b-a22b-instruct-2507', 262_144],
  ['qwen3-32b', 32_768],
  ['llama-3.3-70b-versatile', 131_072],
  ['llama3.1-8b', 131_072],
  ['meta-llama/llama-4-maverick', 131_072],
  ['gpt-oss-120b', 131_072],
  ['command-a-03-2025', 256_000],
])('%s has a %i token context window', (id, expected) => {
  expect(knownContextWindow(id)).toBe(expected);
});

test('unknown models fall back to a conservative window', () => {
  expect(knownContextWindow('acme-frontier-9')).toBeUndefined();
  expect(modelContextWindow('openrouter', 'acme/frontier-9')).toBe(128_000);
  expect(modelContextWindow('compatible', 'my-local-model')).toBe(32_768);
  expect(fallbackContextWindow('compatible')).toBeLessThan(fallbackContextWindow('openai'));
});
