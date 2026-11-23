import { createProviderModel } from './providers.ts';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { normalizeModelError } from '@wisp/protocol/model-errors';
import { MODEL_SESSION_HEADER, selectedModel } from '@wisp/protocol/agent-rpc';
import type { z } from 'zod';
import { subscriptionCallOptions, filterWebSearch } from './model-tools.ts';
import { applyModelReasoning } from './reasoning.ts';

export function connectionModel(
  selected: z.infer<typeof selectedModel>,
  origin: string,
  token: string,
  webSearchEnabled: () => Promise<boolean>,
  cacheKey?: string,
  sessionId?: string,
) {
  const native = !!selected.connectionId;
  const baseURL = native
    ? `${origin}/model/connections/${selected.connectionId}`
    : origin + '/model';
  // Native adapters only see the authenticated loopback transport. Real API
  // keys stay in the bridge's OS vault, including during compaction calls.
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== origin || !url.href.startsWith(baseURL + '/')) {
      throw Error('Unsupported model route');
    }
    const headers = new Headers(init?.headers);
    headers.delete('x-api-key');
    headers.delete('x-goog-api-key');
    headers.set('authorization', 'Bearer ' + token);
    if (sessionId) {
      headers.set(MODEL_SESSION_HEADER, sessionId);
    }
    const response = await fetch(input, { ...init, headers });
    if (response.headers.has('x-wisp-model-error')) {
      const error = (await response.json()) as { error: { message: string } };
      throw Error(error.error.message);
    }
    return native ? response : normalizeModelError(response);
  };
  const options = { apiKey: 'wisp-loopback', baseURL, fetch: transport };
  if (native && (!selected.provider || !selected.modelId)) {
    throw Error('Invalid connection model settings.');
  }
  const model = native
    ? createProviderModel(selected.provider!, selected.modelId!, options)
    : createOpenAI(options).responses(selected.model);
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        if (!native) {
          return filterWebSearch(
            subscriptionCallOptions(withCacheKey(params, cacheKey)),
            selected.webSearchAvailable !== false && (await webSearchEnabled()),
          );
        }
        params = applyModelReasoning(params, selected.provider!, selected.effort);
        if (selected.provider === 'openai') {
          params = withCacheKey(params, cacheKey);
        }
        if (selected.provider === 'openai' || selected.provider === 'xai') {
          const namespace = selected.provider;
          params = {
            ...params,
            providerOptions: {
              ...params.providerOptions,
              [namespace]: { ...params.providerOptions?.[namespace], store: false },
            },
          };
        }
        return filterWebSearch(
          params,
          selected.webSearchAvailable === true && (await webSearchEnabled()),
        );
      },
    },
  });
}

// OpenAI routes requests that share a prompt_cache_key to the same cache, so
// every step of a long tool loop can reuse the conversation's cached prefix.
function withCacheKey<T extends { providerOptions?: Record<string, any> }>(
  params: T,
  cacheKey: string | undefined,
): T {
  if (!cacheKey) {
    return params;
  }
  return {
    ...params,
    providerOptions: {
      ...params.providerOptions,
      openai: { promptCacheKey: cacheKey, ...params.providerOptions?.openai },
    },
  };
}
