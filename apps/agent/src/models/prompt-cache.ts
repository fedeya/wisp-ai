import type { LanguageModelV4Prompt } from '@ai-sdk/provider';

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Anthropic caches a prompt only up to explicit breakpoints. Marks the last
 * system message, which caches the tools and instructions before it, and the
 * last two messages: each step of the tool loop then reads everything up to
 * the previous step from cache, and so does the next turn. That is three of
 * the four breakpoints Anthropic allows.
 */
export function withAnthropicCache(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const marked = new Set<number>();
  const lastSystem = prompt.findLastIndex((message) => message.role === 'system');
  if (lastSystem >= 0) marked.add(lastSystem);
  const conversation = prompt.flatMap((message, index) =>
    message.role === 'system' ? [] : [index],
  );
  for (const index of conversation.slice(-2)) marked.add(index);
  return prompt.map((message, index) =>
    marked.has(index)
      ? {
          ...message,
          providerOptions: {
            ...message.providerOptions,
            anthropic: { ...message.providerOptions?.anthropic, cacheControl: EPHEMERAL },
          },
        }
      : message,
  );
}
