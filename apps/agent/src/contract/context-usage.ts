// @effect-migrated
import { Option, Schema } from 'effect';

export const COMPACTION_THRESHOLD = 0.75;

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens?: number;
  compactions: number;
  compacting: boolean;
}

type UsageChat = { usage?: ContextUsage };
export function resetContextUsage(chat: UsageChat) {
  if (chat.usage) {
    chat.usage.contextTokens = undefined;
    chat.usage.compacting = false;
  }
}

/** A token count a model call reported: a non-negative safe integer. */
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const isTokens = Schema.is(Tokens);

/** The usage a model call's `usage.recorded` event reports; other fields are ignored. */
const ReportedUsage = Schema.Struct({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadTokens: Schema.optional(Schema.Unknown),
});
const reportedUsage = Schema.decodeUnknownOption(ReportedUsage);

export function recordContextUsage(
  chat: UsageChat,
  event: { type: string; data: Record<string, unknown> },
): boolean {
  const data = event.data;
  const isChange = ['context.started', 'context.settled'].includes(event.type);
  if (event.type !== 'usage.recorded' && !(isChange && data.kind === 'compaction')) {
    return false;
  }
  const usage = (chat.usage ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    compactions: 0,
    compacting: false,
  });
  if (event.type === 'context.started') {
    usage.compacting = true;
    return true;
  }
  if (event.type === 'context.settled') {
    usage.compacting = false;
    if (data.outcome === 'completed') {
      usage.compactions++;
      // The summary call measures the old input. Wait for the next ordinary
      // model call to report the smaller context rather than inventing a size.
      usage.contextTokens = undefined;
    }
    return true;
  }
  const reported = data.kind === 'model' ? reportedUsage(data.usage) : Option.none();
  if (Option.isNone(reported)) {
    return false;
  }
  const { inputTokens: input, outputTokens: output, cacheReadTokens } = reported.value;
  usage.inputTokens += input;
  usage.outputTokens += output;
  usage.cacheReadTokens += isTokens(cacheReadTokens) ? cacheReadTokens : 0;
  if (!usage.compacting) {
    // Cache hits are already included in inputTokens. This is the most recent
    // measured input plus output, not a tokenizer estimate of the next request.
    usage.contextTokens = input + output;
  }
  return true;
}
