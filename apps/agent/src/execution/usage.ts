import { Effect } from 'effect';
import { z } from 'zod';
import type { SessionHistory, TokenUsage } from '../session/session-history.ts';
import type { Assistant } from '../session/session-message.ts';

const tokenCount = z.number().nullish();
const tokenDetails = z.object({
  total: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
  reasoning: tokenCount,
});
/** Provider usage: counts arrive as numbers or as `{ total, cacheRead, ... }` objects. */
const providerUsage = z.object({
  inputTokens: z.union([z.number(), tokenDetails]).nullish(),
  outputTokens: z.union([z.number(), tokenDetails]).nullish(),
  cachedInputTokens: tokenCount,
  reasoningTokens: tokenCount,
});

export function stepUsage(raw: unknown): TokenUsage | undefined {
  const parsed = providerUsage.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const { inputTokens: input, outputTokens: output } = parsed.data;
  const details = (value: typeof input) =>
    typeof value === 'object' && value !== null ? value : undefined;
  const inputTokens = typeof input === 'number' ? input : details(input)?.total;
  const outputTokens = typeof output === 'number' ? output : details(output)?.total;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return undefined;
  }
  const usage: TokenUsage = { inputTokens, outputTokens };
  const cacheReadTokens = parsed.data.cachedInputTokens ?? details(input)?.cacheRead;
  if (typeof cacheReadTokens === 'number') usage.cacheReadTokens = cacheReadTokens;
  const reasoningTokens = parsed.data.reasoningTokens ?? details(output)?.reasoning;
  if (typeof reasoningTokens === 'number') usage.reasoningTokens = reasoningTokens;
  const cacheWriteTokens = details(input)?.cacheWrite;
  if (typeof cacheWriteTokens === 'number') usage.cacheWriteTokens = cacheWriteTokens;
  return usage;
}

/** Adds one model call's reported tokens to its session's totals. */
export const recordUsage = (
  history: SessionHistory['Service'],
  session: string,
  usage: TokenUsage | undefined,
) => (usage ? history.addUsage(session, usage) : Effect.void);

/** A step's reported tokens, as the log keeps them. */
export function logTokens(usage: TokenUsage | undefined): Assistant['tokens'] {
  if (!usage) return undefined;
  const tokens: NonNullable<Assistant['tokens']> = {
    input: usage.inputTokens,
    output: usage.outputTokens,
  };
  return {
    ...tokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
  };
}
