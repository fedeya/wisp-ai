import { createProviderModel } from './providers.ts';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { normalizeModelError } from '@wisp/protocol/model-errors';
import { selectedModel } from '@wisp/protocol/agent-rpc';
import type { z } from 'zod';
import { subscriptionCallOptions, filterWebSearch, filterModelTools } from './model-tools.ts';
import { applyModelReasoning } from './reasoning.ts';

export function connectionModel(
  selected: z.infer<typeof selectedModel>,
  origin: string,
  token: string,
  webSearchEnabled: () => Promise<boolean>,
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
        params = filterModelTools(params);
        if (!native) {
          return filterWebSearch(
            subscriptionCallOptions(params),
            selected.webSearchAvailable !== false && (await webSearchEnabled()),
          );
        }
        params = applyModelReasoning(params, selected.provider!, selected.effort);
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
