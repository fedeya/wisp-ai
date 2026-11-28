// @effect-migrated
import { Effect, Option, Schema } from 'effect';
import type { TokenUsage } from '../session/session-history.ts';
import type * as SessionHistory from '../session/session-history.ts';
import type { Assistant } from '../session/session-message.ts';

// zod's `nullish()`: a missing key, `undefined` or `null`, as providers report a count they lack.
const nullish = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const tokenCount = nullish(Schema.Finite);
const tokenDetails = Schema.Struct({
  total: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
  reasoning: tokenCount,
});
/** Provider usage: counts arrive as numbers or as `{ total, cacheRead, ... }` objects. */
const providerUsage = Schema.Struct({
  inputTokens: nullish(Schema.Union([Schema.Finite, tokenDetails])),
  outputTokens: nullish(Schema.Union([Schema.Finite, tokenDetails])),
  cachedInputTokens: tokenCount,
  reasoningTokens: tokenCount,
});
const decodeUsage = Schema.decodeUnknownOption(providerUsage);

export function stepUsage(raw: unknown): TokenUsage | undefined {
  const decoded = decodeUsage(raw);
  if (Option.isNone(decoded)) {
    return undefined;
  }
  const parsed = decoded.value;
  const { inputTokens: input, outputTokens: output } = parsed;
  const details = (value: typeof input) =>
    typeof value === 'object' && value !== null ? value : undefined;
  const inputTokens = typeof input === 'number' ? input : details(input)?.total;
  const outputTokens = typeof output === 'number' ? output : details(output)?.total;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return undefined;
  }
  const usage: TokenUsage = { inputTokens, outputTokens };
  const cacheReadTokens = parsed.cachedInputTokens ?? details(input)?.cacheRead;
  if (typeof cacheReadTokens === 'number') usage.cacheReadTokens = cacheReadTokens;
  const reasoningTokens = parsed.reasoningTokens ?? details(output)?.reasoning;
  if (typeof reasoningTokens === 'number') usage.reasoningTokens = reasoningTokens;
  const cacheWriteTokens = details(input)?.cacheWrite;
  if (typeof cacheWriteTokens === 'number') usage.cacheWriteTokens = cacheWriteTokens;
  return usage;
}

/** Adds one model call's reported tokens to its session's totals. */
export const recordUsage = (
  history: SessionHistory.Service['Service'],
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
