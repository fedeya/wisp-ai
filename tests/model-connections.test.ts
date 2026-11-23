import { test, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelConnections } from '@wisp/bridge/model-connections';
import { connectionModel } from '@wisp/agent/connection-model';
import { providerDefinitions, connectionModelSlug } from '@wisp/protocol/providers';
import { desktopRoutes } from '@wisp/protocol/desktop-routes';
import type { ChatGPTAuth } from '@wisp/bridge/chatgpt-auth';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(fetcher: typeof fetch = vi.fn()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wisp-connections-'));
  directories.push(directory);
  const secrets = new Map<string, string>();
  const vault = {
    read: async (key: string) => secrets.get(key) || '',
    write: async (key: string, value: string) => {
      secrets.set(key, value);
    },
  };
  const chatgpt = {
    state: () => ({ status: 'disconnected' }),
    accessToken: vi.fn(async () => {
      throw Error('ChatGPT disconnected');
    }),
    models: vi.fn(async () => []),
  };
  const file = path.join(directory, 'connections.json');
  const manager = new ModelConnections(file, vault, chatgpt as unknown as ChatGPTAuth, fetcher);
  await manager.load();
  return { manager, secrets, vault, chatgpt, file };
}
const setup = {
  provider: 'anthropic',
  name: 'Claude',
  apiKey: 'private-test-key',
  models: [{ id: 'claude-test', contextWindow: 200000 }],
};

test('connections persist metadata separately from secrets and work without ChatGPT', async () => {
  const { manager, file, secrets, vault, chatgpt } = await fixture();
  const { id } = await manager.save(setup);
  expect(await readFile(file, 'utf8')).not.toContain(setup.apiKey);
  expect(JSON.stringify(manager.list())).not.toContain(setup.apiKey);
  expect(secrets.get('ai-connection:' + id)).toBe(setup.apiKey);
  const slug = connectionModelSlug(id, 'claude-test');
  await manager.prepare(slug);
  expect(chatgpt.accessToken).not.toHaveBeenCalled();
  expect(await manager.models()).toEqual([
    { slug, displayName: 'claude-test', efforts: [], contextWindow: 200000 },
  ]);
  const restored = new ModelConnections(file, vault, chatgpt as unknown as ChatGPTAuth);
  await restored.load();
  expect(restored.list()[0]?.hasKey).toBe(true);
  await restored.save({ ...setup, id, name: 'Renamed', apiKey: undefined });
  expect(secrets.get('ai-connection:' + id)).toBe(setup.apiKey);
  await restored.remove(id);
  expect(secrets.get('ai-connection:' + id)).toBe('');
  await expect(restored.prepare(slug)).rejects.toThrow('not found');
});

test('a provider exists once ChatGPT was signed in or an API connection has a key', async () => {
  const { manager, chatgpt } = await fixture();
  let status = 'signed_out';
  chatgpt.state = () => ({ status });
  expect(manager.hasProvider()).toBe(false);
  // An expired or limited ChatGPT account still counts: its own error explains the fix.
  status = 'reauth_required';
  expect(manager.hasProvider()).toBe(true);
  status = 'signed_out';
  const { id } = await manager.save(setup);
  expect(manager.hasProvider()).toBe(true);
  await manager.remove(id);
  expect(manager.hasProvider()).toBe(false);
  await manager.save({
    provider: 'compatible',
    name: 'Local',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'local-test', contextWindow: 32000 }],
  });
  expect(manager.hasProvider()).toBe(true);
});

test('a failed metadata write rolls back the API key', async () => {
  const { manager, file, secrets } = await fixture();
  await mkdir(file);
  await expect(manager.save(setup)).rejects.toThrow();
  expect(manager.list()).toEqual([]);
  expect([...secrets.values()].every((value) => !value)).toBe(true);
});

test('saved API models expose reasoning choices while keeping the existing default', async () => {
  const { manager, file, vault, chatgpt } = await fixture();
  const { id } = await manager.save({
    ...setup,
    models: [{ id: 'claude-sonnet-4-6', contextWindow: 200000 }],
  });
  const restored = new ModelConnections(file, vault, chatgpt as unknown as ChatGPTAuth);
  await restored.load();
  expect((await restored.models())[0]).toMatchObject({
    slug: connectionModelSlug(id, 'claude-sonnet-4-6'),
    efforts: ['provider-default', 'none', 'low', 'medium', 'high'],
    defaultEffort: 'provider-default',
  });
});

test('gateway discovery preserves exact advertised effort values and filters unknown levels', async () => {
  const { manager } = await fixture(async () =>
    Response.json({
      data: [
        {
          id: 'custom/reasoner',
          name: 'Reasoner',
          type: 'language',
          context_window: 64000,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'invented'] }],
        },
      ],
    }),
  );
  const { models } = await manager.discover({
    provider: 'gateway',
    name: 'Gateway',
    apiKey: 'key',
  });
  expect(models[0]?.reasoningEfforts).toEqual(['none', 'low', 'high']);
  await manager.save({ provider: 'gateway', name: 'Gateway', apiKey: 'key', models });
  expect((await manager.models())[0]?.efforts).toEqual(['provider-default', 'none', 'low', 'high']);
});

test.each(['openrouter', 'gateway', 'compatible'] as const)(
  '%s discovery preserves catalog capability metadata through the desktop response',
  async (provider) => {
    const { manager } = await fixture(async () =>
      Response.json({
        data: [
          {
            id: 'lab/tools',
            name: 'Tools',
            context_length: 32000,
            supported_parameters: ['tools'],
          },
          { id: 'lab/text', supported_parameters: ['temperature'] },
          { id: 'lab/unknown', context_length: 0 },
          { id: 'lab/tagged', tags: ['tool-use'] },
          { id: 'lab/invalid id' },
        ],
      }),
    );
    const found = await manager.discover({
      provider,
      name: 'Models',
      apiKey: 'key',
      baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
    });
    const { models } = desktopRoutes['/connections/discover'].output.parse(found);
    expect(models.map(({ id, supportsTools }) => [id, supportsTools])).toEqual([
      ['lab/tools', true],
      ['lab/text', false],
      // A local server's models are the player's own choice; aggregators must say.
      ['lab/unknown', provider === 'compatible' ? true : undefined],
      ['lab/tagged', provider === 'openrouter' ? undefined : true],
    ]);
    expect(models[0]).toMatchObject({ name: 'Tools', contextWindow: 32000 });
    // Unsized models get the conservative fallback instead of asking the player.
    expect(models[2]?.contextWindow).toBe(provider === 'compatible' ? 32_768 : 128_000);
    const { id } = await manager.save({
      provider,
      name: 'Models',
      apiKey: 'key',
      models: [models[0]],
      baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
    });
    expect(manager.get(id).models[0]).not.toHaveProperty('supportsTools');
  },
);

test('anthropic discovery marks native models as supporting tools', async () => {
  const { manager } = await fixture(async () =>
    Response.json({
      data: [
        {
          type: 'model',
          id: 'claude-sonnet-4-6',
          display_name: 'Claude Sonnet 4.6',
          max_input_tokens: 1000000,
        },
      ],
    }),
  );
  const found = await manager.discover({
    provider: 'anthropic',
    name: 'Anthropic / Claude',
    apiKey: 'key',
  });
  const { models } = desktopRoutes['/connections/discover'].output.parse(found);
  expect(models).toEqual([
    expect.objectContaining({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      contextWindow: 1000000,
      supportsTools: true,
    }),
  ]);
  const custom = await manager.discover({
    provider: 'anthropic',
    name: 'Custom Anthropic Proxy',
    apiKey: 'key',
    baseURL: 'https://proxy.example.com/v1',
  });
  const { models: customModels } = desktopRoutes['/connections/discover'].output.parse(custom);
  expect(customModels[0]?.supportsTools).toBeUndefined();
});

test.each([
  {
    provider: 'google',
    body: {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
        {
          name: 'models/gemini-2.5-flash-preview-tts',
          supportedGenerationMethods: ['generateContent'],
        },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    },
    expected: {
      'gemini-2.5-flash': true,
      'gemini-flash-latest': true,
      'gemma-3-27b-it': undefined,
      'gemini-2.5-flash-preview-tts': undefined,
    },
  },
  {
    provider: 'openai',
    body: {
      data: [
        { id: 'gpt-5' },
        { id: 'gpt-4o-2024-08-06' },
        { id: 'o3' },
        { id: 'gpt-5-chat-latest' },
        { id: 'text-embedding-3-small' },
        { id: 'whisper-1' },
      ],
    },
    expected: {
      'gpt-5': true,
      'gpt-4o-2024-08-06': true,
      o3: true,
      'gpt-5-chat-latest': false,
      'text-embedding-3-small': undefined,
      'whisper-1': undefined,
    },
  },
  {
    provider: 'mistral',
    body: {
      data: [
        { id: 'mistral-small-latest', capabilities: { function_calling: true } },
        { id: 'ft:mistral-small:custom', capabilities: { function_calling: false } },
      ],
    },
    expected: { 'mistral-small-latest': true, 'ft:mistral-small:custom': false },
  },
  {
    provider: 'cohere',
    body: {
      models: [
        { name: 'command-a-03-2025', features: ['json_mode', 'tools', 'tool_choice'] },
        { name: 'embed-v4.0', features: [] },
      ],
    },
    expected: { 'command-a-03-2025': true, 'embed-v4.0': false },
  },
  {
    provider: 'fireworks',
    body: {
      data: [
        { id: 'accounts/fireworks/models/kimi-k2p5', supports_tools: true },
        { id: 'accounts/fireworks/models/flux-1-dev', supports_tools: false },
      ],
    },
    expected: {
      'accounts/fireworks/models/kimi-k2p5': true,
      'accounts/fireworks/models/flux-1-dev': false,
    },
  },
  {
    provider: 'deepseek',
    body: { data: [{ id: 'deepseek-chat' }] },
    expected: { 'deepseek-chat': true },
  },
  {
    provider: 'xai',
    body: { data: [{ id: 'grok-4' }, { id: 'grok-code-fast-1' }, { id: 'grok-2-image-1212' }] },
    expected: { 'grok-4': true, 'grok-code-fast-1': true, 'grok-2-image-1212': false },
  },
  {
    provider: 'groq',
    body: {
      data: [
        { id: 'llama-3.3-70b-versatile' },
        { id: 'openai/gpt-oss-120b' },
        { id: 'whisper-large-v3-turbo' },
        { id: 'playai-tts' },
        { id: 'meta-llama/llama-guard-4-12b' },
        { id: 'groq/compound' },
      ],
    },
    expected: {
      'llama-3.3-70b-versatile': true,
      'openai/gpt-oss-120b': true,
      'whisper-large-v3-turbo': false,
      'playai-tts': false,
      'meta-llama/llama-guard-4-12b': false,
      'groq/compound': false,
    },
  },
  {
    provider: 'cerebras',
    body: { data: [{ id: 'gpt-oss-120b' }, { id: 'llama-3.3-70b' }] },
    expected: { 'gpt-oss-120b': true, 'llama-3.3-70b': true },
  },
  {
    provider: 'togetherai',
    body: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat' },
      { id: 'black-forest-labs/FLUX.1-schnell', type: 'image' },
      { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' },
    ],
    expected: {
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': true,
      'black-forest-labs/FLUX.1-schnell': false,
      'BAAI/bge-large-en-v1.5': false,
    },
  },
  {
    provider: 'deepinfra',
    body: {
      data: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct' },
        { id: 'BAAI/bge-m3' },
        { id: 'openai/whisper-large-v3' },
      ],
    },
    expected: {
      'meta-llama/Llama-3.3-70B-Instruct': true,
      'BAAI/bge-m3': false,
      'openai/whisper-large-v3': false,
    },
  },
  {
    provider: 'alibaba',
    body: {
      data: [
        { id: 'qwen-plus' },
        { id: 'qwen3-max' },
        { id: 'text-embedding-v4' },
        { id: 'qwen-image-plus' },
        { id: 'qwen3-tts-flash' },
      ],
    },
    expected: {
      'qwen-plus': true,
      'qwen3-max': true,
      'text-embedding-v4': false,
      'qwen-image-plus': false,
      'qwen3-tts-flash': false,
    },
  },
  {
    provider: 'moonshotai',
    body: { data: [{ id: 'kimi-k2.5' }, { id: 'moonshot-v1-8k-vision-preview' }] },
    expected: { 'kimi-k2.5': true, 'moonshot-v1-8k-vision-preview': true },
  },
  {
    provider: 'minimax',
    body: { data: [{ id: 'MiniMax-M2.5', type: 'model' }] },
    expected: { 'MiniMax-M2.5': true },
  },
  {
    provider: 'baseten',
    body: { data: [{ id: 'moonshotai/Kimi-K2.5' }, { id: 'deepseek-ai/DeepSeek-V3.1' }] },
    expected: { 'moonshotai/Kimi-K2.5': true, 'deepseek-ai/DeepSeek-V3.1': true },
  },
  {
    provider: 'zai',
    body: { data: [{ id: 'glm-4.7' }, { id: 'glm-4.5v' }, { id: 'cogview-4' }] },
    expected: { 'glm-4.7': true, 'glm-4.5v': true, 'cogview-4': false },
  },
] as const)(
  '$provider discovery marks the models that call tools',
  async ({ provider, body, expected }) => {
    const { manager } = await fixture(async () => Response.json(body));
    const found = await manager.discover({ provider, name: provider, apiKey: 'key' });
    const { models } = desktopRoutes['/connections/discover'].output.parse(found);
    expect(Object.fromEntries(models.map((m) => [m.id, m.supportsTools]))).toEqual(expected);
  },
);

// Discovery offers only models marked as calling tools, so a provider with no
// answer shows an empty catalog. These read the answer from each model's metadata.
const metadataProviders = new Set(['gateway', 'openrouter', 'mistral', 'cohere', 'fireworks']);
test.each(providerDefinitions.filter(({ id }) => !metadataProviders.has(id)))(
  '$name discovery offers its example model',
  async ({ id: provider, example }) => {
    const { manager } = await fixture(async () => Response.json({ data: [{ id: example }] }));
    const found = await manager.discover({
      provider,
      name: provider,
      apiKey: 'key',
      baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
    });
    expect(found.models).toEqual([expect.objectContaining({ id: example, supportsTools: true })]);
  },
);

test('deepseek discovery through a custom endpoint makes no claim about tools', async () => {
  const { manager } = await fixture(async () => Response.json({ data: [{ id: 'deepseek-chat' }] }));
  const found = await manager.discover({
    provider: 'deepseek',
    name: 'DeepSeek proxy',
    apiKey: 'key',
    baseURL: 'https://proxy.example.com/v1',
  });
  expect(found.models[0]?.supportsTools).toBeUndefined();
});

test('new connections are named after their provider and models get a known context window', async () => {
  const { manager } = await fixture();
  const models = [{ id: 'claude-sonnet-4-5-20250929' }, { id: 'unknown-model' }];
  const first = await manager.save({ provider: 'anthropic', apiKey: 'key', models });
  const second = await manager.save({ provider: 'anthropic', apiKey: 'key', models });
  expect(manager.get(first.id).name).toBe('Claude');
  expect(manager.get(second.id).name).toBe('Claude 2');
  expect(manager.get(first.id).models.map((m) => m.contextWindow)).toEqual([200_000, 128_000]);
  // The same model in two connections is told apart by the connection name.
  expect((await manager.models()).map((m) => m.displayName)).toEqual([
    'Claude / claude-sonnet-4-5-20250929',
    'Claude / unknown-model',
    'Claude 2 / claude-sonnet-4-5-20250929',
    'Claude 2 / unknown-model',
  ]);
  await manager.remove(second.id);
  expect((await manager.models()).map((m) => m.displayName)).toEqual([
    'claude-sonnet-4-5-20250929',
    'unknown-model',
  ]);
  await manager.save({ id: first.id, provider: 'anthropic', models });
  expect(manager.get(first.id).name).toBe('Claude');
  await manager.save({ id: first.id, provider: 'anthropic', name: 'Work', models });
  expect(manager.get(first.id).name).toBe('Work');
});

test('validates endpoints, credentials, unique model IDs and context capacity', async () => {
  const { manager } = await fixture();
  for (const baseURL of [
    'http://remote.example/v1',
    'https://user:secret@example.com/v1',
    'https://example.com/v1?key=secret',
    'file:///tmp/models',
  ]) {
    await expect(manager.save({ ...setup, baseURL })).rejects.toThrow();
  }
  await expect(manager.save({ ...setup, apiKey: '' })).rejects.toThrow('API key');
  await expect(
    manager.save({ ...setup, models: [setup.models[0], setup.models[0]] }),
  ).rejects.toThrow('unique');
  const { id } = await manager.save({
    ...setup,
    provider: 'compatible',
    apiKey: '',
    baseURL: 'http://127.0.0.1:1234/v1',
  });
  await manager.prepare(connectionModelSlug(id, 'claude-test'));
});

test('the connection check verifies a native tool request without executing tools', async () => {
  let toolSupport = true;
  const { manager } = await fixture(async () =>
    Response.json({
      id: 'msg_check',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: toolSupport
        ? [{ type: 'tool_use', id: 'check', name: 'connection_check', input: { ok: true } }]
        : [{ type: 'text', text: 'Hello' }],
      stop_reason: toolSupport ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 5 },
    }),
  );
  expect(await manager.test(setup)).toEqual({ ok: true });
  toolSupport = false;
  await expect(manager.test(setup)).rejects.toThrow('tool-calling check');
  expect(manager.list()).toEqual([]);
});

test('a short completion uses the configured connection and returns only text', async () => {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const { manager } = await fixture(async (url, init) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return String(url).endsWith('/responses')
      ? Response.json({
          id: 'resp_title',
          created_at: 1,
          model: 'gpt-test',
          output: [
            {
              type: 'message',
              id: 'msg_title',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'OpenAI title', annotations: [] }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 2 },
        })
      : Response.json({
          id: 'msg_title',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Ruta por Durotar' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 4 },
        });
  });
  const { id } = await manager.save(setup);
  const signal = new AbortController().signal;
  expect(
    await manager.complete(connectionModelSlug(id, 'claude-test'), 'Name it', 'Hola', signal),
  ).toBe('Ruta por Durotar');
  expect(requests[0]!.headers.get('x-api-key')).toBe(setup.apiKey);
  expect(JSON.stringify(requests[0]!.body)).toContain('Name it');
  expect(JSON.stringify(requests[0]!.body)).not.toContain('"tools"');

  const openai = await manager.save({
    provider: 'openai',
    name: 'OpenAI',
    apiKey: 'openai-key',
    models: [{ id: 'gpt-test', contextWindow: 128000 }],
  });
  expect(
    await manager.complete(connectionModelSlug(openai.id, 'gpt-test'), 'Name it', 'Hola', signal),
  ).toBe('OpenAI title');
  // Titles must not be stored server-side, like every other Responses request.
  expect(requests.at(-1)!.body.store).toBe(false);
});

test('a short ChatGPT completion uses the lowest supported effort and is never stored', async () => {
  const { manager, chatgpt } = await fixture();
  const sent: Record<string, unknown>[] = [];
  chatgpt.models.mockResolvedValue([
    { slug: 'gpt-test', displayName: 'GPT', efforts: ['low', 'medium', 'high'] },
  ] as never);
  const authorized = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const completed = {
      type: 'response.completed',
      response: {
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: 'Talentos de mago' }] },
        ],
      },
    };
    return new Response('data: ' + JSON.stringify(completed) + '\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  Object.assign(chatgpt, { authorized });
  const signal = new AbortController().signal;
  expect(await manager.complete('gpt-test', 'Name it', 'Talentos', signal)).toBe(
    'Talentos de mago',
  );
  expect(sent[0]).toMatchObject({
    model: 'gpt-test',
    reasoning: { effort: 'low' },
    store: false,
    instructions: 'Name it',
  });
  expect(sent[0]).not.toHaveProperty('tools');
  await expect(manager.complete('unknown-model', 'Name it', 'Hola', signal)).rejects.toThrow(
    'not available',
  );
});

test.each(providerDefinitions)(
  '$name native adapter reaches its permitted route with bridge-owned credentials',
  async (definition) => {
    let upstream: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      upstream = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json(
        {
          object: 'error',
          type: 'error',
          param: '',
          code: 'bad_request',
          message: 'fixture stop',
          error: {
            code: definition.id === 'google' ? 400 : 'bad_request',
            status: 'INVALID_ARGUMENT',
            type: 'invalid_request_error',
            message: 'fixture stop',
          },
        },
        { status: 400 },
      );
    };
    const { manager } = await fixture(fetcher);
    const { id } = await manager.save({
      provider: definition.id,
      name: definition.name,
      apiKey: 'real-vault-key',
      baseURL: definition.id === 'compatible' ? 'http://localhost:1234/v1' : undefined,
      models: [{ id: definition.example, contextWindow: 32768 }],
    });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.origin).toBe('http://127.0.0.1:43187');
      expect(headers.get('authorization')).toBe('Bearer loopback-token');
      expect(headers.has('x-api-key')).toBe(false);
      expect(headers.has('x-goog-api-key')).toBe(false);
      const suffix = url.pathname.slice(('/model/connections/' + id).length) + url.search;
      return manager.forward(id, suffix, String(init?.body), headers, new AbortController().signal);
    });
    const model = connectionModel(
      {
        model: connectionModelSlug(id, definition.example),
        effort: 'provider-default',
        provider: definition.id,
        connectionId: id,
        modelId: definition.example,
        webSearchAvailable: true,
      },
      'http://127.0.0.1:43187',
      'loopback-token',
      async () => true,
    );
    await expect(
      model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Call check.' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'calltest1', toolName: 'check', input: '{}' },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'calltest1',
                toolName: 'check',
                output: { type: 'json', value: { marker: 'roundtrip-marker' } },
              },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'Check again.' }] },
        ],
        tools: [
          { type: 'function', name: 'check', inputSchema: { type: 'object', properties: {} } },
          {
            type: 'function',
            name: 'web__web_search',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolChoice: { type: 'auto' },
      }),
    ).rejects.toThrow('fixture stop');
    expect(upstream).toBeDefined();
    expect(JSON.stringify(upstream!.body)).toContain('roundtrip-marker');
    expect(JSON.stringify(upstream!.body)).toContain('web__web_search');
    const keyHeader = ['anthropic', 'minimax'].includes(definition.id)
      ? 'x-api-key'
      : definition.id === 'google'
        ? 'x-goog-api-key'
        : 'authorization';
    expect(upstream!.headers.get(keyHeader)).toBe(
      keyHeader === 'authorization' ? 'Bearer real-vault-key' : 'real-vault-key',
    );
    expect(upstream!.headers.get('authorization')).not.toBe('Bearer loopback-token');
    expect(upstream!.url).toContain(definition.baseURL || 'http://localhost:1234/v1');
    if (definition.id === 'gateway') {
      expect(upstream!.headers.get('ai-language-model-id')).toBe(definition.example);
      expect(upstream!.headers.has('ai-gateway-protocol-version')).toBe(true);
    }
    if (['openai', 'xai'].includes(definition.id)) {
      expect(upstream!.body.store).toBe(false);
      expect(upstream!.body.include).toContain('reasoning.encrypted_content');
    }
  },
);

test('proxy rejects unconfigured models and non-model routes, strips arbitrary credentials, and redacts errors', async () => {
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ error: { message: 'Invalid private-test-key' } }, { status: 401 }),
  );
  const { manager } = await fixture(upstream);
  const { id } = await manager.save(setup);
  const headers = new Headers({ authorization: 'Bearer loopback', cookie: 'private-cookie' });
  const signal = new AbortController().signal;
  await expect(
    manager.forward(id, '/messages', '{"model":"other"}', headers, signal),
  ).rejects.toThrow('configured model');
  await expect(
    manager.forward(id, '/models', '{"model":"claude-test"}', headers, signal),
  ).rejects.toThrow('Unsupported');
  await expect(
    manager.forward(id, '/messages?key=oops', '{"model":"claude-test"}', headers, signal),
  ).rejects.toThrow('Unsupported');
  expect(upstream).not.toHaveBeenCalled();
  const response = await manager.forward(
    id,
    '/messages',
    '{"model":"claude-test"}',
    headers,
    signal,
  );
  expect(await response.text()).toContain('Invalid [redacted]');
  const forwarded = new Headers(upstream.mock.calls[0]?.[1]?.headers);
  expect(forwarded.has('cookie')).toBe(false);
});

test('discovery reads provider metadata and filters Google models without generation support', async () => {
  const { manager } = await fixture(async () =>
    Response.json({
      models: [
        {
          name: 'models/gemini-test',
          displayName: 'Gemini',
          inputTokenLimit: 1000000,
          supportedGenerationMethods: ['generateContent'],
        },
        { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
  );
  expect(await manager.discover({ provider: 'google', name: 'Gemini', apiKey: 'key' })).toEqual({
    models: [{ id: 'gemini-test', name: 'Gemini', contextWindow: 1000000, reasoningEfforts: [] }],
  });
});

test.each(['anthropic', 'google', 'compatible', 'gateway'] as const)(
  '%s streams native tool calls and accepts their results on the next request',
  async (provider) => {
    const events: unknown[] =
      provider === 'anthropic'
        ? [
            {
              type: 'message_start',
              message: {
                id: 'msg_test',
                type: 'message',
                role: 'assistant',
                model: 'native-test',
                content: [],
                stop_reason: null,
                usage: { input_tokens: 2, output_tokens: 0 },
              },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'call_test', name: 'check', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"ok":true}' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: 5 },
            },
            { type: 'message_stop' },
          ]
        : provider === 'google'
          ? [
              {
                candidates: [
                  {
                    index: 0,
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: { name: 'check', args: { ok: true }, id: 'call_test' },
                          thoughtSignature: 'signature-test',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 5 },
              },
            ]
          : provider === 'gateway'
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call_test',
                  toolName: 'check',
                  input: '{"ok":true}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
                  usage: { inputTokens: { total: 2 }, outputTokens: { total: 5 } },
                },
              ]
            : [
                {
                  id: 'chat_test',
                  model: 'native-test',
                  created: 1,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_test',
                            type: 'function',
                            function: { name: 'check', arguments: '{"ok":true}' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: 'chat_test',
                  model: 'native-test',
                  created: 1,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                },
              ];
    let requestBody = '';
    let requests = 0;
    const { manager } = await fixture(async (_url, init) => {
      requestBody = String(init?.body);
      requests++;
      if (requests > 1) {
        return Response.json(
          {
            type: 'error',
            message: 'done',
            error: {
              type: 'invalid_request_error',
              message: 'done',
              code: provider === 'google' ? 400 : 'bad_request',
              status: 'INVALID_ARGUMENT',
            },
          },
          { status: 400 },
        );
      }
      return new Response(
        events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const { id } = await manager.save({
      provider,
      name: 'Native',
      apiKey: 'key',
      baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
      models: [{ id: 'native-test', contextWindow: 32000 }],
    });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      return manager.forward(
        id,
        url.pathname.slice(('/model/connections/' + id).length) + url.search,
        String(init?.body),
        new Headers(init?.headers),
        new AbortController().signal,
      );
    });
    const model = connectionModel(
      {
        model: connectionModelSlug(id, 'native-test'),
        effort: 'provider-default',
        connectionId: id,
        provider,
        modelId: 'native-test',
      },
      'http://127.0.0.1:43187',
      'loopback',
      async () => true,
    );
    const prompt = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Check.' }] },
    ];
    const { stream } = await model.doStream({ prompt });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    const call = chunks.find((chunk) => chunk.type === 'tool-call');
    expect(call).toMatchObject({ toolName: 'check', input: '{"ok":true}' });
    if (!call || call.type !== 'tool-call') {
      throw Error('Missing tool call');
    }
    expect(
      chunks.some(
        (chunk) => chunk.type === 'finish' && chunk.finishReason.unified === 'tool-calls',
      ),
    ).toBe(true);
    await expect(
      model.doGenerate({
        prompt: [
          ...prompt,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
                providerOptions: call.providerMetadata,
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: 'json', value: { verified: true } },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('done');
    expect(requestBody).toContain('verified');
    if (provider === 'google') {
      expect(requestBody).toContain('signature-test');
    }
  },
);
