import type { createOpenAI } from '@ai-sdk/openai';
type CallOptions = Parameters<
  ReturnType<ReturnType<typeof createOpenAI>['responses']>['doStream']
>[0];

export function subscriptionCallOptions(options: CallOptions): CallOptions {
  const openai = { ...options.providerOptions?.openai };
  // The SDK must know this before it serializes reasoning/tool history. Setting
  // it only in the HTTP proxy makes the next turn reference unpersisted items.
  openai.store = false;
  // Eve adds this for API-key providers. ChatGPT subscription grants reject it.
  delete openai.safetyIdentifier;
  return { ...options, providerOptions: { ...options.providerOptions, openai } };
}

export function filterWebSearch(options: CallOptions, enabled: boolean): CallOptions {
  if (enabled) {
    return options;
  }
  const blocked = (options.tools || []).filter(
    (tool) =>
      tool.name === 'web_search' ||
      tool.name === 'web__web_search' ||
      tool.name === 'wowhead__web_search' ||
      (tool.type !== 'function' && tool.id.startsWith('openai.web_search')),
  );
  const names = new Set(blocked.map((tool) => tool.name));
  // Filtering preserves the input model's tool version (v2/v3/v4).
  return {
    ...options,
    tools: options.tools?.filter((tool) => !names.has(tool.name)),
    toolChoice:
      options.toolChoice?.type === 'tool' && names.has(options.toolChoice.toolName)
        ? { type: 'auto' }
        : options.toolChoice,
  } as CallOptions;
}
