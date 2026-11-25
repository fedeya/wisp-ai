import { z } from 'zod';

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
export const providerId = z.enum(providerDefinitions.map((p) => p.id));
export type ProviderId = z.infer<typeof providerId>;
export const reasoningEffort = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'enabled',
]);
export type ReasoningEffort = z.infer<typeof reasoningEffort>;
export const connectionModel = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((id) => !/[\s?#]/.test(id), 'Use a model ID without spaces or URL parameters.'),
  name: z.string().trim().min(1).max(200).optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  reasoningEfforts: z.array(reasoningEffort).max(8).optional(),
});
export const discoveredConnectionModel = connectionModel.extend({
  supportsTools: z.boolean().optional(),
});
export const maxConnectionModels = 200;

export const connectionConfig = z.object({
  id: z.string().uuid(),
  provider: providerId,
  name: z.string().trim().min(1).max(80),
  baseURL: z.string().url().max(1000).optional(),
  models: z.array(connectionModel).min(1).max(maxConnectionModels),
});
export const connectionSetup = connectionConfig.omit({ id: true }).extend({
  id: z.string().uuid().optional(),
  // Optional: the bridge names a new connection after its provider.
  name: connectionConfig.shape.name.optional(),
  apiKey: z.string().trim().max(4096).optional(),
});
export const connectionDiscovery = connectionSetup.omit({ models: true });
export const connectionView = connectionConfig.extend({ hasKey: z.boolean() });
export type ConnectionConfig = z.infer<typeof connectionConfig>;
export type ConnectionSetup = z.infer<typeof connectionSetup>;
export type ConnectionModel = z.infer<typeof connectionModel>;
export type DiscoveredConnectionModel = z.infer<typeof discoveredConnectionModel>;
export type ConnectionView = z.infer<typeof connectionView>;

/** Stable connection id for a signed-in Grok account. It is not an API-key connection. */
export const GROK_SUBSCRIPTION_ID = '6f0e2c1a-9b4d-4e7a-8c31-0a5d7e9b2f14';

export function connectionModelSlug(connection: string, model: string) {
  return `connection:${connection}:${model}`;
}
export function parseConnectionModel(slug: string) {
  const match = /^connection:([0-9a-f-]{36}):(.+)$/i.exec(slug);
  return match ? { connection: match[1]!, model: match[2]! } : undefined;
}
