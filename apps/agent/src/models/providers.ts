import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createCerebras } from '@ai-sdk/cerebras';
import { createCohere } from '@ai-sdk/cohere';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createFireworks } from '@ai-sdk/fireworks';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createGateway } from '@ai-sdk/gateway';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createMiniMax } from '@ai-sdk/minimax';
import { createBaseten } from '@ai-sdk/baseten';
import { createZai } from '@ai-sdk/zai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ProviderId } from '@wisp/protocol/providers';
import type { LanguageModelV4 } from '@ai-sdk/provider';

interface ProviderOptions {
  apiKey: string;
  baseURL: string;
  fetch?: typeof fetch;
}
// Return native language models: history, reasoning signatures and tool streams
// stay in their provider's format instead of being translated to OpenAI JSON.
export function createProviderModel(
  provider: ProviderId,
  id: string,
  options: ProviderOptions,
): LanguageModelV4 {
  switch (provider) {
    case 'openai':
      return createOpenAI(options).responses(id);
    case 'anthropic':
      return createAnthropic(options)(id);
    case 'google':
      return createGoogle(options)(id);
    case 'xai':
      return createXai(options)(id);
    case 'groq':
      return createGroq(options)(id);
    case 'mistral':
      return createMistral(options)(id);
    case 'deepseek':
      return createDeepSeek(options)(id);
    case 'cerebras':
      return createCerebras(options)(id);
    case 'cohere':
      return createCohere(options)(id);
    case 'togetherai':
      return createTogetherAI(options)(id);
    case 'fireworks':
      return createFireworks(options)(id);
    case 'deepinfra':
      return createDeepInfra(options)(id);
    case 'gateway':
      return createGateway(options)(id);
    case 'alibaba':
      return createAlibaba(options)(id);
    case 'moonshotai':
      return createMoonshotAI(options)(id);
    case 'minimax':
      return createMiniMax(options)(id);
    case 'baseten':
      return createBaseten(options)(id);
    case 'zai':
      return createZai(options)(id);
    case 'openrouter':
      return createOpenRouter(options)(id);
    case 'compatible':
      return createOpenAICompatible({
        ...options,
        name: provider,
      })(id);
  }
}
