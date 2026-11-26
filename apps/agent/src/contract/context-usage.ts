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

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

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
  if (data.kind !== 'model' || !data.usage || typeof data.usage !== 'object') {
    return false;
  }
  const reported = data.usage as Record<string, unknown>;
  const input = tokens(reported.inputTokens);
  const output = tokens(reported.outputTokens);
  if (input === undefined || output === undefined) {
    return false;
  }
  usage.inputTokens += input;
  usage.outputTokens += output;
  usage.cacheReadTokens += tokens(reported.cacheReadTokens) ?? 0;
  if (!usage.compacting) {
    // Cache hits are already included in inputTokens. This is the most recent
    // measured input plus output, not a tokenizer estimate of the next request.
    usage.contextTokens = input + output;
  }
  return true;
}
