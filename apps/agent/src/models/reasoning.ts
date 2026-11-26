import { openaiModelCatalog } from '@ai-sdk/openai/internal';
import { getAnthropicLanguageModelEntry } from '@ai-sdk/anthropic/internal';
import { getGoogleLanguageModelEntry } from '@ai-sdk/google/internal';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { reasoningEffort, type ProviderId, type ReasoningEffort } from '@wisp/protocol/providers';

const levels: ReasoningEffort[] = ['low', 'medium', 'high'];
const toggle: ReasoningEffort[] = ['none', 'enabled'];
const budget: ReasoningEffort[] = ['none', ...levels];

// The pinned SDK catalogs are the source of truth where they are exported.
// Other entries mirror the pinned adapters' request policies. Unknown model
// names do not inherit a provider-wide claim that reasoning is configurable.
export function modelReasoningEfforts(provider: ProviderId, id: string): ReasoningEffort[] {
  if (provider === 'gateway' || provider === 'openrouter') {
    const separator = id.indexOf('/');
    if (separator < 0) {
      return [];
    }
    const vendor = id.slice(0, separator);
    const model = id.slice(separator + 1);
    const aliases: Record<string, ProviderId> = {
      anthropic: 'anthropic',
      openai: 'openai',
      google: 'google',
      xai: 'xai',
      deepseek: 'deepseek',
      mistral: 'mistral',
      mistralai: 'mistral',
      moonshotai: 'moonshotai',
      minimax: 'minimax',
      alibaba: 'alibaba',
      zai: 'zai',
      'z-ai': 'zai',
      cohere: 'cohere',
    };
    const native = aliases[vendor];
    return native
      ? modelReasoningEfforts(
          native,
          native === 'anthropic' ? model.replace(/(\d)\.(\d)/g, '$1-$2') : model,
        )
      : [];
  }
  if (provider === 'openai') {
    const snapshotBase = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const entry = openaiModelCatalog[id] || openaiModelCatalog[snapshotBase];
    if (!entry && ['o3', 'o3-mini', 'o4-mini'].includes(snapshotBase)) {
      return [...levels];
    }
    return (entry?.capabilities.language?.reasoning.efforts || []).filter(
      (value): value is ReasoningEffort => reasoningEffort.safeParse(value).success,
    );
  }
  if (provider === 'anthropic') {
    const entry = getAnthropicLanguageModelEntry(id);
    if (!entry.requestConfig.language.knownModel) {
      return [];
    }
    const capability = entry.capabilities.language.reasoning;
    if (capability.support !== true) {
      return [];
    }
    const result: ReasoningEffort[] = [...levels];
    if (capability.canDisable) {
      result.unshift('none');
    }
    if (capability.adaptive && id.startsWith('claude-opus-')) {
      result.push('max');
    }
    if (capability.supportsXhighEffort) {
      result.splice(result.indexOf('high') + 1, 0, 'xhigh');
    }
    return result;
  }
  if (provider === 'google') {
    if (
      !/^gemini-(?:2\.5|3(?:\.\d+)?)-(?:pro|flash)(?:-|$)/.test(id) ||
      /image|audio|tts/.test(id)
    ) {
      return [];
    }
    const entry = getGoogleLanguageModelEntry(id);
    const capability = entry.capabilities.language.reasoning;
    if (entry.requestConfig.language.thinkingFormat === 'level') {
      return [...(capability.efforts || [])].filter(
        (value): value is ReasoningEffort => reasoningEffort.safeParse(value).success,
      );
    }
    return capability.minBudget === 0 ? [...budget] : [...levels];
  }
  switch (provider) {
    case 'deepseek':
      return /^(deepseek-flash|deepseek-v4-(?:flash|pro|flash-vision-exp))$/.test(id)
        ? ['none', 'low', 'high', 'max']
        : [];
    case 'xai':
      if (/^grok-4\.[67]$/.test(id)) {
        return [...levels, 'xhigh'];
      }
      if (id === 'grok-4.5') {
        return [...levels];
      }
      if (id === 'grok-3-mini') {
        return ['low', 'high'];
      }
      return [];
    case 'groq':
      if (/^openai\/gpt-oss-(20|120)b$/.test(id)) {
        return [...levels];
      }
      return id === 'qwen/qwen3.6-27b' ? [...toggle] : [];
    case 'cerebras':
      return id === 'gpt-oss-120b' ? [...levels] : [];
    case 'cohere':
      return id === 'command-a-reasoning-08-2025' ? [...budget] : [];
    case 'alibaba':
      return /^(qwen3(?:[.-]|$)|qwen-(?:plus|turbo)(?:-|$))/.test(id) &&
        !/instruct|non-thinking|coder|vl/.test(id)
        ? [...budget]
        : [];
    case 'moonshotai':
      if (/^kimi-k3(?:[.-]|$)/.test(id)) {
        return ['low', 'high', 'max'];
      }
      return /^kimi-k2\.[56]$/.test(id) ? [...toggle] : [];
    case 'minimax':
      return /^MiniMax-M(?:3\.[1-9]|[4-9])(?:[.-]|$)/i.test(id) ? [...levels, 'xhigh', 'max'] : [];
    case 'mistral':
      if (['mistral-large-4', 'mistral-large-4-0'].includes(id)) {
        return [...levels];
      }
      if (['zai-glm-5', 'zai-glm-5-3', 'zai-glm-5-3-flash', 'zai-glm-latest'].includes(id)) {
        return ['low', 'high', 'max'];
      }
      return [
        'magistral-medium-latest',
        'magistral-small-latest',
        'mistral-medium-latest',
        'mistral-small-latest',
        'mistral-medium-2604',
        'mistral-small-2603',
        'labs-leanstral-1-5',
      ].includes(id)
        ? [...toggle]
        : [];
    case 'zai':
      if (/^glm-5\.[23](?:-|$)/.test(id)) {
        return ['low', 'high', 'max'];
      }
      return /^glm-(?:4\.[567]|5)(?:-|$)/.test(id) ? [...toggle] : [];
    case 'togetherai':
    case 'deepinfra':
    case 'baseten':
    case 'compatible':
      return /^(?:openai\/)?gpt-oss-(?:20|120)b$/.test(id) ? [...levels] : [];
    case 'fireworks':
      return /^accounts\/fireworks\/models\/gpt-oss-(?:20|120)b$/.test(id) ? [...levels] : [];
  }
}

export function applyModelReasoning(
  params: LanguageModelV4CallOptions,
  provider: ProviderId,
  effort: string,
): LanguageModelV4CallOptions {
  if (effort === 'provider-default') {
    return params;
  }
  const chosen = reasoningEffort.parse(effort);
  // Toggle-only APIs should show On/Off, rather than three effort levels that
  // would all enable the same mode. The native SDK still encodes the request.
  const reasoning = chosen === 'enabled' ? 'high' : chosen;
  if (provider === 'openrouter') {
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openrouter: {
          ...params.providerOptions?.openrouter,
          reasoning: chosen === 'enabled' ? { enabled: true } : { effort: chosen },
        },
      },
    };
  }
  if (provider === 'zai' && (chosen === 'enabled' || chosen === 'none')) {
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        zai: {
          ...params.providerOptions?.zai,
          thinking: { type: chosen === 'none' ? 'disabled' : 'enabled' },
        },
      },
    };
  }
  if (provider === 'xai') {
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        xai: { ...params.providerOptions?.xai, reasoningEffort: chosen },
      },
    };
  }
  if (provider === 'groq' && chosen === 'enabled') {
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        groq: { ...params.providerOptions?.groq, reasoningEffort: 'default' },
      },
    };
  }
  return { ...params, reasoning };
}
