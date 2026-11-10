import { afterEach, expect, test, vi } from 'vitest';
import { connectionModel } from '@wisp/agent/connection-model';
import { modelReasoningEfforts } from '@wisp/agent/reasoning';

import type { ProviderId } from '@wisp/protocol/providers';
afterEach(() => vi.unstubAllGlobals());
async function request(provider: ProviderId, modelId: string, effort: string, stream = false) {
  let body: Record<string, any> | undefined;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    throw Error('Captured native request');
  });
  const model = connectionModel(
    {
      model: 'test',
      modelId,
      provider,
      connectionId: '35302f8c-128a-48fb-98a1-9eb03bb71f72',
      effort,
    },
    'http://127.0.0.1:43187',
    'local',
    async () => false,
  );
  const options = {
    prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
  };
  await expect(stream ? model.doStream(options) : model.doGenerate(options)).rejects.toThrow(
    'Captured native request',
  );
  expect(body).toBeDefined();
  return body!;
}
test('model catalogs expose supported reasoning choices without applying them to unknown models', () => {
  expect(modelReasoningEfforts('openai', 'gpt-5.4')).toContain('xhigh');
  expect(modelReasoningEfforts('openai', 'gpt-4.1')).toEqual([]);
  expect(modelReasoningEfforts('anthropic', 'claude-sonnet-4-6')).toEqual([
    'none',
    'low',
    'medium',
    'high',
  ]);
  expect(modelReasoningEfforts('anthropic', 'claude-opus-4-6')).toContain('max');
  expect(modelReasoningEfforts('google', 'gemini-2.5-pro')).not.toContain('none');
  expect(modelReasoningEfforts('google', 'gemini-2.5-flash')).toContain('none');
  expect(modelReasoningEfforts('moonshotai', 'kimi-k2.5')).toEqual(['none', 'enabled']);
  expect(modelReasoningEfforts('moonshotai', 'kimi-k2.7-code')).toEqual([]);
  expect(modelReasoningEfforts('minimax', 'MiniMax-M2.5')).toEqual([]);
  expect(modelReasoningEfforts('gateway', 'anthropic/claude-sonnet-4.6')).toContain('high');
  for (const provider of ['openai', 'anthropic', 'google', 'xai', 'compatible', 'groq'] as const) {
    expect(modelReasoningEfforts(provider, 'unknown-test-model')).toEqual([]);
  }
});
test.each([false, true])(
  'native reasoning is encoded for generate/stream (stream=%s)',
  async (stream) => {
    expect((await request('openai', 'gpt-5.4', 'high', stream)).reasoning.effort).toBe('high');
    const claude = await request('anthropic', 'claude-sonnet-4-6', 'high', stream);
    expect(claude.thinking.type).toBe('adaptive');
    expect(claude.output_config.effort).toBe('high');
    expect((await request('anthropic', 'claude-sonnet-4-6', 'none', stream)).thinking.type).toBe(
      'disabled',
    );
    const gemini = await request('google', 'gemini-3-flash-preview', 'low', stream);
    expect(gemini.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
    expect(
      (await request('google', 'gemini-2.5-flash', 'none', stream)).generationConfig.thinkingConfig
        .thinkingBudget,
    ).toBe(0);
    const deepseek = await request('deepseek', 'deepseek-flash', 'max', stream);
    expect(deepseek.thinking.type).toBe('enabled');
    expect(deepseek.reasoning_effort).toBe('max');
    expect((await request('deepseek', 'deepseek-flash', 'none', stream)).thinking.type).toBe(
      'disabled',
    );
    expect((await request('xai', 'grok-4.6', 'xhigh', stream)).reasoning.effort).toBe('xhigh');
    expect((await request('groq', 'openai/gpt-oss-120b', 'low', stream)).reasoning_effort).toBe(
      'low',
    );
    expect((await request('groq', 'qwen/qwen3.6-27b', 'enabled', stream)).reasoning_effort).toBe(
      'default',
    );
    expect(
      (await request('mistral', 'magistral-small-latest', 'enabled', stream)).reasoning_effort,
    ).toBe('high');
    expect((await request('moonshotai', 'kimi-k2.5', 'enabled', stream)).thinking.type).toBe(
      'enabled',
    );
    expect((await request('moonshotai', 'kimi-k2.5', 'none', stream)).thinking.type).toBe(
      'disabled',
    );
    expect((await request('minimax', 'MiniMax-M3.1', 'high', stream)).output_config.effort).toBe(
      'high',
    );
    expect((await request('zai', 'glm-4.7', 'enabled', stream)).thinking.type).toBe('enabled');
    const glmOff = await request('zai', 'glm-4.7', 'none', stream);
    expect(glmOff.thinking.type).toBe('disabled');
    expect(glmOff.reasoning_effort).toBeUndefined();
    expect((await request('zai', 'glm-5.2', 'max', stream)).reasoning_effort).toBe('max');
    expect((await request('openrouter', 'openai/gpt-5.4', 'high', stream)).reasoning.effort).toBe(
      'high',
    );
    expect((await request('gateway', 'openai/gpt-5.4', 'high', stream)).reasoning).toBe('high');
  },
);
test('budget-based providers use different native token budgets for low and high', async () => {
  for (const [provider, modelId, read] of [
    ['anthropic', 'claude-sonnet-4-5', (body: Record<string, any>) => body.thinking.budget_tokens],
    [
      'google',
      'gemini-2.5-flash',
      (body: Record<string, any>) => body.generationConfig.thinkingConfig.thinkingBudget,
    ],
    [
      'cohere',
      'command-a-reasoning-08-2025',
      (body: Record<string, any>) => body.thinking.token_budget,
    ],
    ['alibaba', 'qwen-plus', (body: Record<string, any>) => body.thinking_budget],
  ] as const) {
    expect(read(await request(provider, modelId, 'high'))).toBeGreaterThan(
      read(await request(provider, modelId, 'low')),
    );
  }
});
test.each(['cerebras', 'togetherai', 'deepinfra', 'baseten', 'compatible', 'fireworks'] as const)(
  '%s passes supported effort to the native chat adapter',
  async (provider) => {
    const id =
      provider === 'fireworks'
        ? 'accounts/fireworks/models/gpt-oss-120b'
        : provider === 'cerebras' || provider === 'compatible'
          ? 'gpt-oss-120b'
          : 'openai/gpt-oss-120b';
    expect((await request(provider, id, 'high')).reasoning_effort).toBe('high');
  },
);
test('provider default omits explicit reasoning configuration', async () => {
  for (const [provider, id] of [
    ['openai', 'gpt-5.4'],
    ['anthropic', 'claude-sonnet-4-6'],
    ['google', 'gemini-2.5-flash'],
    ['openrouter', 'openai/gpt-5.4'],
  ] as const) {
    const body = await request(provider, id, 'provider-default');
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.generationConfig?.thinkingConfig).toBeUndefined();
  }
});
