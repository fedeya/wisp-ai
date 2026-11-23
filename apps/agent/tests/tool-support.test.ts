import { expect, test } from 'vitest';
import { modelToolSupport } from '../src/tool-support.ts';

test.each([
  ['google', 'gemini-2.5-flash', true],
  ['google', 'gemini-2.5-pro', true],
  ['google', 'gemini-3-pro-preview', true],
  ['google', 'gemini-pro-latest', true],
  ['google', 'gemma-3-27b-it', undefined],
  ['google', 'gemini-2.5-flash-preview-tts', undefined],
  ['google', 'gemini-2.5-flash-image', undefined],
  ['google', 'imagen-4.0-generate-001', undefined],
  ['openai', 'gpt-5', true],
  ['openai', 'gpt-4.1-2025-04-14', true],
  ['openai', 'o4-mini', true],
  ['openai', 'gpt-5-chat-latest', false],
  ['openai', 'text-embedding-3-large', undefined],
  ['openai', 'dall-e-3', undefined],
  ['openai', 'gpt-realtime', undefined],
  ['openai', 'gpt-3.5-turbo', undefined],
  ['groq', 'llama-3.3-70b-versatile', undefined],
] as const)('%s %s tool support is %s', (provider, id, expected) => {
  expect(modelToolSupport(provider, id)).toBe(expected);
});
