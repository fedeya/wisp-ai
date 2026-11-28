// @effect-migrated
import { Schema, Struct } from 'effect';
import { TrimmedString, UrlString } from './checks.js';

// API-key language providers only. Cloud accounts with regions/deployments are
// deliberately outside this registry. Keep transport/auth details out of the UI.
export const providerDefinitions = [
  {
    id: 'gateway',
    name: 'Vercel AI Gateway',
    baseURL: 'https://ai-gateway.vercel.sh/v4/ai',
    example: 'anthropic/claude-sonnet-4.6',
  },
  { id: 'openai', name: 'OpenAI API', baseURL: 'https://api.openai.com/v1', example: 'gpt-5.4' },
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    baseURL: 'https://api.anthropic.com/v1',
    example: 'claude-sonnet-4-6',
  },
  {
    id: 'google',
    name: 'Google / Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    example: 'gemini-2.5-flash',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    example: 'deepseek-flash',
  },
  { id: 'xai', name: 'xAI / Grok', baseURL: 'https://api.x.ai/v1', example: 'grok-4' },
  {
    id: 'groq',
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    example: 'llama-3.3-70b-versatile',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    example: 'mistral-small-latest',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    example: 'gpt-oss-120b',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseURL: 'https://api.cohere.com/v2',
    example: 'command-a-03-2025',
  },
  {
    id: 'togetherai',
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    example: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    example: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    baseURL: 'https://api.deepinfra.com/v1',
    example: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'alibaba',
    name: 'Alibaba / Qwen',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    example: 'qwen-plus',
  },
  {
    id: 'moonshotai',
    name: 'Moonshot / Kimi',
    baseURL: 'https://api.moonshot.ai/v1',
    example: 'kimi-k2.5',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimax.io/anthropic/v1',
    example: 'MiniMax-M2.5',
  },
  {
    id: 'baseten',
    name: 'Baseten',
    baseURL: 'https://inference.baseten.co/v1',
    example: 'moonshotai/Kimi-K2.5',
  },
  { id: 'zai', name: 'Z.AI / GLM', baseURL: 'https://api.z.ai/api/paas/v4', example: 'glm-4.7' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    example: 'anthropic/claude-sonnet-4.6',
  },
  { id: 'compatible', name: 'OpenAI compatible / Local', baseURL: '', example: 'your-model-id' },
] as const;
export const providerId = Schema.Literals(providerDefinitions.map((p) => p.id));
export type ProviderId = typeof providerId.Type;
export const reasoningEffort = Schema.Literals([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'enabled',
]);
export type ReasoningEffort = typeof reasoningEffort.Type;
/** A context window in tokens. */
export const contextWindow = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(100_000_000),
);
export const connectionModel = Schema.Struct({
  id: TrimmedString({ minLength: 1, maxLength: 200 }).check(
    Schema.makeFilter((id) => !/[\s?#]/u.test(id), {
      message: 'Use a model ID without spaces or URL parameters.',
    }),
  ),
  name: Schema.optional(TrimmedString({ minLength: 1, maxLength: 200 })),
  contextWindow: Schema.optional(contextWindow),
  reasoningEfforts: Schema.optional(Schema.Array(reasoningEffort).check(Schema.isMaxLength(8))),
});
export const discoveredConnectionModel = connectionModel.mapFields(
  Struct.assign({ supportsTools: Schema.optional(Schema.Boolean) }),
);
export const maxConnectionModels = 200;

const connectionId = Schema.String.check(Schema.isUUID());
const connectionName = TrimmedString({ minLength: 1, maxLength: 80 });
export const connectionConfig = Schema.Struct({
  id: connectionId,
  provider: providerId,
  name: connectionName,
  baseURL: Schema.optional(UrlString.check(Schema.isMaxLength(1000))),
  models: Schema.Array(connectionModel).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxConnectionModels),
  ),
});
export const connectionSetup = connectionConfig.mapFields(
  Struct.assign({
    id: Schema.optional(connectionId),
    // Optional: the bridge names a new connection after its provider.
    name: Schema.optional(connectionName),
    apiKey: Schema.optional(TrimmedString({ maxLength: 4096 })),
  }),
);
export const connectionDiscovery = connectionSetup.mapFields(Struct.omit(['models']));
export const connectionView = connectionConfig.mapFields(Struct.assign({ hasKey: Schema.Boolean }));
export type ConnectionConfig = typeof connectionConfig.Type;
export type ConnectionSetup = typeof connectionSetup.Type;
export type ConnectionModel = typeof connectionModel.Type;
export type DiscoveredConnectionModel = typeof discoveredConnectionModel.Type;
export type ConnectionView = typeof connectionView.Type;

export function connectionModelSlug(connection: string, model: string) {
  return `connection:${connection}:${model}`;
}
export function parseConnectionModel(slug: string) {
  const [, connection, model] = /^connection:([0-9a-f-]{36}):(.+)$/i.exec(slug) ?? [];
  return connection && model ? { connection, model } : undefined;
}
