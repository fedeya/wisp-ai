export interface AccountModel {
  slug: string;
  displayName: string;
  efforts: string[];
  defaultEffort?: string;
  contextWindow?: number;
}
export interface ChatModel {
  model: string;
  effort: string;
}
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export interface AccountModelInput {
  slug?: string;
  display_name?: string;
  supported_reasoning_levels?: { effort?: string }[];
  default_reasoning_level?: string;
  context_window?: number;
}
export function accountModel(input: AccountModelInput): AccountModel {
  const supported = (input.supported_reasoning_levels || [])
    .map((level) => level.effort)
    .filter((effort): effort is string => typeof effort === 'string' && efforts.has(effort));
  return {
    slug: input.slug!,
    displayName: input.display_name || input.slug!,
    efforts: [...new Set(supported)],
    defaultEffort:
      input.default_reasoning_level && supported.includes(input.default_reasoning_level)
        ? input.default_reasoning_level
        : supported[0],
    contextWindow:
      Number.isFinite(input.context_window) && input.context_window! > 0
        ? input.context_window
        : undefined,
  };
}
export function chooseChatModel(models: AccountModel[], model: string, effort?: string): ChatModel {
  const entry = models.find((entry) => entry.slug === model);
  if (!entry) {
    throw Error('This model is not available. Choose a connected provider in Wisp > Connections.');
  }
  const chosen =
    effort ??
    (entry.defaultEffort === 'provider-default'
      ? 'provider-default'
      : entry.efforts.includes('medium')
        ? 'medium'
        : entry.defaultEffort) ??
    'provider-default';
  if (chosen !== 'provider-default' && !entry.efforts.includes(chosen)) {
    throw Error('Choose a supported effort for this model.');
  }
  if (
    chosen === 'provider-default' &&
    entry.efforts.length &&
    !entry.efforts.includes('provider-default')
  ) {
    throw Error('Choose a supported effort for this model.');
  }
  return { model, effort: chosen };
}
