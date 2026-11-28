import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { afterEach, expect, it, layer, vi } from '@effect/vitest';
import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { FetchHttpClient, Headers as HttpHeaders, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import * as ModelConnections from '@wisp/server/models/connections';
import { SecretVault } from '@wisp/server/secret-vault';
import { ChatGPTAuth, ChatGPTAuthError } from '@wisp/server/auth';
import type { ChatGPTAuthStatus } from '@wisp/server/auth';
import type { AccountModel } from '@wisp/server/chat-model';
import { connectionModel } from '@wisp/agent/connection-model';
import {
  connectionDiscovery,
  connectionModelSlug,
  connectionSetup,
  providerDefinitions,
} from '@wisp/protocol/providers';
import { desktopRoutes } from '@wisp/protocol/desktop-routes';

const decodeDiscovered = Schema.decodeUnknownSync(desktopRoutes['/connections/discover'].output);

type Manager = ModelConnections.ModelConnections['Service'];

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What the ChatGPT account does in a test; the fields can change while it runs. */
interface ChatGPTControl {
  status: ChatGPTAuthStatus;
  models: readonly AccountModel[];
  accessTokenCalls: number;
  authorized: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}

const chatgptLayer = (control: ChatGPTControl) =>
  Layer.succeed(
    ChatGPTAuth,
    ChatGPTAuth.of({
      state: Effect.sync(() => ({
        status: control.status,
        revision: 0,
        activeId: null,
        account: null,
        message: '',
        profiles: [],
      })),
      beginSignIn: () => Effect.die('Unused in these tests'),
      cancel: Effect.void,
      select: () => Effect.die('Unused in these tests'),
      accessToken: Effect.suspend(() => {
        control.accessTokenCalls++;
        return Effect.fail(new ChatGPTAuthError({ message: 'ChatGPT disconnected' }));
      }),
      disconnect: Effect.die('Unused in these tests'),
      models: Effect.sync(() => control.models),
      authorized: (request) => Effect.suspend(() => control.authorized(request)),
    }),
  );

const vaultLayer = (secrets: Map<string, string>) =>
  Layer.succeed(
    SecretVault,
    SecretVault.of({
      read: (key) => Effect.sync(() => Redacted.make(secrets.get(key) || '')),
      write: (key, value) =>
        Effect.sync(() => {
          secrets.set(key, Redacted.value(value));
        }),
    }),
  );

/**
 * A temporary `connections.json` with a vault and a ChatGPT account. `open`
 * loads the connections from the file, as Wisp does when it starts. Run the
 * test with `withFetch` so provider requests reach `fetcher`.
 */
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-connections-' });
  const file = path.join(directory, 'connections.json');
  const secrets = new Map<string, string>();
  const chatgpt: ChatGPTControl = {
    status: 'reauth_required',
    models: [],
    accessTokenCalls: 0,
    authorized: () => Effect.die('Unused in this test'),
  };
  const open = Effect.fnUntraced(function* () {
    const context = yield* Layer.build(
      ModelConnections.layerAt(file).pipe(
        Layer.provide([
          vaultLayer(secrets),
          chatgptLayer(chatgpt),
          FetchHttpClient.layer,
          NodeServices.layer,
          NodeCrypto.layerSecureRandom,
        ]),
      ),
    );
    return Context.get(context, ModelConnections.ModelConnections);
  });
  return { fs, file, secrets, chatgpt, open, manager: yield* open() };
});

/** A transport that cannot reach the provider, as `fetch` reports it. */
const unreachable: typeof globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));

/** Provider requests in `effect` go to `fetcher`. */
const withFetch =
  (fetcher: typeof globalThis.fetch) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, FetchHttpClient.Fetch, fetcher);

/** Like the desktop routes, each input is decoded with its contract first. */
const save = (manager: Manager, raw: unknown) =>
  Schema.decodeUnknownEffect(connectionSetup)(raw).pipe(Effect.flatMap(manager.save));
const check = (manager: Manager, raw: unknown) =>
  Schema.decodeUnknownEffect(connectionSetup)(raw).pipe(Effect.flatMap(manager.test));
const discover = (manager: Manager, raw: unknown) =>
  Schema.decodeUnknownEffect(connectionDiscovery)(raw).pipe(Effect.flatMap(manager.discover));
const find = (manager: Manager, id: string) =>
  Effect.map(manager.list, (connections) => connections.find((c) => c.id === id));

/**
 * Sends the agent SDK's model request through `forward`, as the agent server
 * does. The answer is read in full here, which the SDK cannot tell apart.
 */
const promiseForward =
  (manager: Manager, context: Context.Context<never>) =>
  (id: string, path: string, body: string, headers: Headers) =>
    Effect.runPromiseWith(context)(
      manager.forward({ connection: id, path, body, headers: HttpHeaders.fromInput(headers) }).pipe(
        Effect.flatMap((response) =>
          Effect.map(
            response.arrayBuffer,
            (bytes) =>
              new Response(bytes, {
                status: response.status,
                headers: Object.entries(response.headers),
              }),
          ),
        ),
        Effect.scoped,
      ),
    );

const headersOf = (init: RequestInit | undefined) => new Headers(init?.headers);
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    String(init?.body),
  );

const setup = {
  provider: 'anthropic',
  name: 'Claude',
  apiKey: 'private-test-key',
  models: [{ id: 'claude-test', contextWindow: 200000 }],
};

const testLayer = Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom);

layer(testLayer)('ModelConnections', (it) => {
  it.effect('connections persist metadata separately from secrets and work without ChatGPT', () =>
    Effect.gen(function* () {
      const { manager, fs, file, secrets, chatgpt, open } = yield* fixture();
      const { id } = yield* save(manager, setup);
      expect(yield* fs.readFileString(file)).not.toContain(setup.apiKey);
      expect(JSON.stringify(yield* manager.list)).not.toContain(setup.apiKey);
      expect(secrets.get('ai-connection:' + id)).toBe(setup.apiKey);
      const slug = connectionModelSlug(id, 'claude-test');
      yield* manager.prepare(slug);
      expect(chatgpt.accessTokenCalls).toBe(0);
      expect(yield* manager.models).toEqual([
        { slug, displayName: 'claude-test', efforts: [], contextWindow: 200000 },
      ]);
      const restored = yield* open();
      expect((yield* restored.list)[0]?.hasKey).toBe(true);
      yield* save(restored, { ...setup, id, name: 'Renamed', apiKey: undefined });
      expect(secrets.get('ai-connection:' + id)).toBe(setup.apiKey);
      yield* restored.remove(id);
      expect(secrets.get('ai-connection:' + id)).toBe('');
      const error = yield* Effect.flip(restored.prepare(slug));
      expect(error.message).toContain('not found');
    }),
  );

  it.effect('connections.json keeps the format it had', () =>
    Effect.gen(function* () {
      const { manager, fs, file } = yield* fixture();
      const { id } = yield* save(manager, {
        ...setup,
        baseURL: 'https://proxy.example.com/v1',
        models: [{ id: 'claude-sonnet-4-6', name: 'Sonnet' }],
      });
      expect(yield* fs.readFileString(file)).toBe(
        JSON.stringify(
          [
            {
              id,
              provider: 'anthropic',
              name: 'Claude',
              baseURL: 'https://proxy.example.com/v1',
              models: [
                {
                  id: 'claude-sonnet-4-6',
                  name: 'Sonnet',
                  contextWindow: 1_000_000,
                  reasoningEfforts: ['none', 'low', 'medium', 'high'],
                },
              ],
            },
          ],
          null,
          2,
        ),
      );
    }),
  );

  it.effect('a provider exists once ChatGPT was signed in or an API connection has a key', () =>
    Effect.gen(function* () {
      const { manager, chatgpt } = yield* fixture();
      chatgpt.status = 'signed_out';
      expect(yield* manager.hasProvider).toBe(false);
      // An expired or limited ChatGPT account still counts: its own error explains the fix.
      chatgpt.status = 'reauth_required';
      expect(yield* manager.hasProvider).toBe(true);
      chatgpt.status = 'signed_out';
      const { id } = yield* save(manager, setup);
      expect(yield* manager.hasProvider).toBe(true);
      yield* manager.remove(id);
      expect(yield* manager.hasProvider).toBe(false);
      yield* save(manager, {
        provider: 'compatible',
        name: 'Local',
        baseURL: 'http://127.0.0.1:11434/v1',
        models: [{ id: 'local-test', contextWindow: 32000 }],
      });
      expect(yield* manager.hasProvider).toBe(true);
    }),
  );

  it.effect('a file that does not decode fails the load and stays as it was', () =>
    Effect.gen(function* () {
      const { fs, file, open } = yield* fixture();
      yield* fs.writeFileString(file, '[{"id":"not-a-connection"}]');
      const error = yield* Effect.flip(open());
      expect(error.message).toBe('Cannot load connections.json; the original file was preserved.');
      expect(yield* fs.readFileString(file)).toBe('[{"id":"not-a-connection"}]');
    }),
  );

  it.effect('saved API models expose reasoning choices while keeping the existing default', () =>
    Effect.gen(function* () {
      const { manager, open } = yield* fixture();
      const { id } = yield* save(manager, {
        ...setup,
        models: [{ id: 'claude-sonnet-4-6', contextWindow: 200000 }],
      });
      const restored = yield* open();
      expect((yield* restored.models)[0]).toMatchObject({
        slug: connectionModelSlug(id, 'claude-sonnet-4-6'),
        efforts: ['provider-default', 'none', 'low', 'medium', 'high'],
        defaultEffort: 'provider-default',
      });
    }),
  );

  it.effect(
    'gateway discovery preserves exact advertised effort values and filters unknown levels',
    () =>
      Effect.gen(function* () {
        const { manager } = yield* fixture();
        const { models } = yield* discover(manager, {
          provider: 'gateway',
          name: 'Gateway',
          apiKey: 'key',
        });
        expect(models[0]?.reasoningEfforts).toEqual(['none', 'low', 'high']);
        yield* save(manager, { provider: 'gateway', name: 'Gateway', apiKey: 'key', models });
        expect((yield* manager.models)[0]?.efforts).toEqual([
          'provider-default',
          'none',
          'low',
          'high',
        ]);
      }).pipe(
        withFetch(async () =>
          Response.json({
            data: [
              {
                id: 'custom/reasoner',
                name: 'Reasoner',
                type: 'language',
                context_window: 64000,
                reasoning_options: [
                  { type: 'effort', values: ['none', 'low', 'high', 'invented'] },
                ],
              },
            ],
          }),
        ),
      ),
  );

  it.effect.each(['openrouter', 'gateway', 'compatible'] as const)(
    '%s discovery preserves catalog capability metadata through the desktop response',
    (provider) =>
      Effect.gen(function* () {
        const { manager } = yield* fixture();
        const found = yield* discover(manager, {
          provider,
          name: 'Models',
          apiKey: 'key',
          baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
        });
        const { models } = decodeDiscovered(found);
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
        const { id } = yield* save(manager, {
          provider,
          name: 'Models',
          apiKey: 'key',
          models: [models[0]],
          baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
        });
        expect((yield* find(manager, id))?.models[0]).not.toHaveProperty('supportsTools');
      }).pipe(
        withFetch(async () =>
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
        ),
      ),
  );

  it.effect('anthropic discovery marks native models as supporting tools', () =>
    Effect.gen(function* () {
      const { manager } = yield* fixture();
      const found = yield* discover(manager, {
        provider: 'anthropic',
        name: 'Anthropic / Claude',
        apiKey: 'key',
      });
      const { models } = decodeDiscovered(found);
      expect(models).toEqual([
        expect.objectContaining({
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          contextWindow: 1000000,
          supportsTools: true,
        }),
      ]);
      const custom = yield* discover(manager, {
        provider: 'anthropic',
        name: 'Custom Anthropic Proxy',
        apiKey: 'key',
        baseURL: 'https://proxy.example.com/v1',
      });
      const { models: customModels } = decodeDiscovered(custom);
      expect(customModels[0]?.supportsTools).toBeUndefined();
    }).pipe(
      withFetch(async () =>
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
      ),
    ),
  );

  it.effect.each([
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
      body: {
        data: [{ id: 'grok-4' }, { id: 'grok-code-fast-1' }, { id: 'grok-2-image-1212' }],
      },
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
    ({ provider, body, expected }) =>
      Effect.gen(function* () {
        const { manager } = yield* fixture();
        const found = yield* discover(manager, { provider, name: provider, apiKey: 'key' });
        const { models } = decodeDiscovered(found);
        expect(Object.fromEntries(models.map((m) => [m.id, m.supportsTools]))).toEqual(expected);
      }).pipe(withFetch(async () => Response.json(body))),
  );

  // Discovery offers only models marked as calling tools, so a provider with no
  // answer shows an empty catalog. These read the answer from each model's metadata.
  const metadataProviders = new Set(['gateway', 'openrouter', 'mistral', 'cohere', 'fireworks']);
  it.effect.each(providerDefinitions.filter(({ id }) => !metadataProviders.has(id)))(
    '$name discovery offers its example model',
    ({ id: provider, example }) =>
      Effect.gen(function* () {
        const { manager } = yield* fixture();
        const found = yield* discover(manager, {
          provider,
          name: provider,
          apiKey: 'key',
          baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
        });
        expect(found.models).toEqual([
          expect.objectContaining({ id: example, supportsTools: true }),
        ]);
      }).pipe(withFetch(async () => Response.json({ data: [{ id: example }] }))),
  );

  it.effect('deepseek discovery through a custom endpoint makes no claim about tools', () =>
    Effect.gen(function* () {
      const { manager } = yield* fixture();
      const found = yield* discover(manager, {
        provider: 'deepseek',
        name: 'DeepSeek proxy',
        apiKey: 'key',
        baseURL: 'https://proxy.example.com/v1',
      });
      expect(found.models[0]?.supportsTools).toBeUndefined();
    }).pipe(withFetch(async () => Response.json({ data: [{ id: 'deepseek-chat' }] }))),
  );

  it.effect('discovery sends the key in the provider header and redacts it from refusals', () =>
    Effect.gen(function* () {
      const requests: { url: string; headers: Headers }[] = [];
      const { manager } = yield* fixture();
      const error = yield* Effect.flip(
        discover(manager, { provider: 'anthropic', name: 'Claude', apiKey: 'secret-key' }).pipe(
          withFetch(async (url, init) => {
            requests.push({ url: String(url), headers: headersOf(init) });
            return Response.json(
              { error: { message: 'Key secret-key is invalid' } },
              { status: 401 },
            );
          }),
        ),
      );
      expect(error.message).toBe('Key [redacted] is invalid');
      expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/models');
      expect(requests[0]?.headers.get('x-api-key')).toBe('secret-key');
      expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
      const empty = yield* Effect.flip(
        discover(manager, { provider: 'openai', name: 'OpenAI', apiKey: 'key' }).pipe(
          withFetch(async () => new Response('not json', { status: 500 })),
        ),
      );
      expect(empty.message).toBe('Provider returned HTTP 500.');
      const unlisted = yield* Effect.flip(
        discover(manager, { provider: 'openai', name: 'OpenAI', apiKey: 'key' }).pipe(
          withFetch(async () => Response.json({ data: [] })),
        ),
      );
      expect(unlisted.message).toBe(
        'This provider did not return a model list. Enter model IDs manually.',
      );
      const offline = yield* Effect.flip(
        discover(manager, { provider: 'openai', name: 'OpenAI', apiKey: 'key' }).pipe(
          withFetch(unreachable),
        ),
      );
      expect(offline._tag === 'ModelRequestError' && offline.cause).toEqual(
        new TypeError('fetch failed'),
      );
    }),
  );

  it.effect(
    'new connections are named after their provider and models get a known context window',
    () =>
      Effect.gen(function* () {
        const { manager } = yield* fixture();
        const models = [{ id: 'claude-sonnet-4-5-20250929' }, { id: 'unknown-model' }];
        const first = yield* save(manager, { provider: 'anthropic', apiKey: 'key', models });
        const second = yield* save(manager, { provider: 'anthropic', apiKey: 'key', models });
        expect((yield* find(manager, first.id))?.name).toBe('Claude');
        expect((yield* find(manager, second.id))?.name).toBe('Claude 2');
        expect((yield* find(manager, first.id))?.models.map((m) => m.contextWindow)).toEqual([
          200_000, 128_000,
        ]);
        // The same model in two connections is told apart by the connection name.
        expect((yield* manager.models).map((m) => m.displayName)).toEqual([
          'Claude / claude-sonnet-4-5-20250929',
          'Claude / unknown-model',
          'Claude 2 / claude-sonnet-4-5-20250929',
          'Claude 2 / unknown-model',
        ]);
        yield* manager.remove(second.id);
        expect((yield* manager.models).map((m) => m.displayName)).toEqual([
          'claude-sonnet-4-5-20250929',
          'unknown-model',
        ]);
        yield* save(manager, { id: first.id, provider: 'anthropic', models });
        expect((yield* find(manager, first.id))?.name).toBe('Claude');
        yield* save(manager, { id: first.id, provider: 'anthropic', name: 'Work', models });
        expect((yield* find(manager, first.id))?.name).toBe('Work');
      }),
  );

  it.effect('validates endpoints, credentials, unique model IDs and context capacity', () =>
    Effect.gen(function* () {
      const { manager } = yield* fixture();
      for (const baseURL of [
        'http://remote.example/v1',
        'https://user:secret@example.com/v1',
        'https://example.com/v1?key=secret',
        'file:///tmp/models',
      ]) {
        yield* Effect.flip(save(manager, { ...setup, baseURL }));
      }
      const remote = yield* Effect.flip(
        save(manager, { ...setup, baseURL: 'http://remote.example/v1' }),
      );
      expect(remote.message).toBe(
        'Use HTTPS, or HTTP for a local server, without credentials or URL parameters.',
      );
      const local = yield* Effect.flip(
        save(manager, { ...setup, provider: 'compatible', apiKey: '' }),
      );
      expect(local.message).toBe('Invalid URL');
      expect((yield* Effect.flip(save(manager, { ...setup, apiKey: '' }))).message).toContain(
        'API key',
      );
      expect(
        (yield* Effect.flip(
          save(manager, { ...setup, models: [setup.models[0], setup.models[0]] }),
        )).message,
      ).toContain('unique');
      const { id } = yield* save(manager, {
        ...setup,
        provider: 'compatible',
        apiKey: '',
        baseURL: 'http://127.0.0.1:1234/v1',
      });
      yield* manager.prepare(connectionModelSlug(id, 'claude-test'));
      const changed = yield* Effect.flip(save(manager, { ...setup, id }));
      expect(changed.message).toBe('Create a new connection to change provider.');
    }),
  );

  it.effect('the connection check verifies a native tool request without executing tools', () => {
    let toolSupport = true;
    return Effect.gen(function* () {
      const { manager } = yield* fixture();
      yield* check(manager, setup);
      toolSupport = false;
      const error = yield* Effect.flip(check(manager, setup));
      expect(error.message).toContain('tool-calling check');
      expect(yield* manager.list).toEqual([]);
    }).pipe(
      withFetch(async () =>
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
      ),
    );
  });

  it.effect('the connection check reports what the provider and the network failed with', () =>
    Effect.gen(function* () {
      const { manager } = yield* fixture();
      const refused = yield* Effect.flip(
        check(manager, setup).pipe(
          withFetch(async () =>
            Response.json(
              { type: 'error', error: { message: 'Bad key private-test-key' } },
              { status: 401 },
            ),
          ),
        ),
      );
      expect(refused).toEqual(
        expect.objectContaining({ _tag: 'ModelConnectionError', message: 'Bad key [redacted]' }),
      );
      const offline = yield* Effect.flip(check(manager, setup).pipe(withFetch(unreachable)));
      // The AI SDK passes on what the transport failed with.
      expect(offline._tag).toBe('ModelRequestError');
      expect(offline._tag === 'ModelRequestError' && String(offline.cause)).toContain(
        'fetch failed',
      );
    }),
  );

  it.effect('a short completion uses the configured connection and returns only text', () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    return Effect.gen(function* () {
      const { manager } = yield* fixture();
      const { id } = yield* save(manager, setup);
      expect(
        yield* manager.complete(connectionModelSlug(id, 'claude-test'), 'Name it', 'Hola'),
      ).toBe('Ruta por Durotar');
      expect(requests[0]?.headers.get('x-api-key')).toBe(setup.apiKey);
      expect(JSON.stringify(requests[0]?.body)).toContain('Name it');
      expect(JSON.stringify(requests[0]?.body)).not.toContain('"tools"');

      const openai = yield* save(manager, {
        provider: 'openai',
        name: 'OpenAI',
        apiKey: 'openai-key',
        models: [{ id: 'gpt-test', contextWindow: 128000 }],
      });
      expect(
        yield* manager.complete(connectionModelSlug(openai.id, 'gpt-test'), 'Name it', 'Hola'),
      ).toBe('OpenAI title');
      // Titles must not be stored server-side, like every other Responses request.
      expect(requests.at(-1)?.body.store).toBe(false);
      expect(requests.at(-1)?.headers.get('authorization')).toBe('Bearer openai-key');
    }).pipe(
      withFetch(async (url, init) => {
        requests.push({ url: String(url), headers: headersOf(init), body: bodyOf(init) });
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
      }),
    );
  });

  it.effect('a short ChatGPT completion uses the lowest supported effort and is never stored', () =>
    Effect.gen(function* () {
      const { manager, chatgpt } = yield* fixture();
      const sent: Record<string, unknown>[] = [];
      chatgpt.models = [
        { slug: 'gpt-test', displayName: 'GPT', efforts: ['low', 'medium', 'high'] },
      ];
      chatgpt.authorized = (request) =>
        Effect.sync(() => {
          sent.push(
            bodyOf({
              body:
                request.body._tag === 'Uint8Array'
                  ? new TextDecoder().decode(request.body.body)
                  : '',
            }),
          );
          const completed = {
            type: 'response.completed',
            response: {
              output: [
                { type: 'reasoning', summary: [] },
                { type: 'message', content: [{ type: 'output_text', text: 'Talentos de mago' }] },
              ],
            },
          };
          return HttpClientResponse.fromWeb(
            request,
            new Response('data: ' + JSON.stringify(completed) + '\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            }),
          );
        });
      expect(yield* manager.complete('gpt-test', 'Name it', 'Talentos')).toBe('Talentos de mago');
      expect(sent[0]).toMatchObject({
        model: 'gpt-test',
        reasoning: { effort: 'low' },
        store: false,
        instructions: 'Name it',
      });
      expect(sent[0]).not.toHaveProperty('tools');
      const unknown = yield* Effect.flip(manager.complete('unknown-model', 'Name it', 'Hola'));
      expect(unknown.message).toContain('not available');
      chatgpt.authorized = (request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            Response.json({ detail: 'Plan limit reached' }, { status: 429 }),
          ),
        );
      const limited = yield* Effect.flip(manager.complete('gpt-test', 'Name it', 'Hola'));
      expect(limited.message).toBe('Plan limit reached');
    }),
  );

  it.effect('the catalog keeps ChatGPT failures only when no connection has models', () =>
    Effect.gen(function* () {
      const { manager, chatgpt } = yield* fixture();
      chatgpt.status = 'connected';
      chatgpt.models = [{ slug: 'claude-test', displayName: 'claude-test', efforts: [] }];
      const { id } = yield* save(manager, setup);
      // A name the account and a connection share is prefixed with the connection.
      expect((yield* manager.models).map((m) => m.displayName)).toEqual([
        'claude-test',
        'Claude / claude-test',
      ]);
      expect(yield* manager.connected(connectionModelSlug(id, 'claude-test'))).toBe(true);
      expect(yield* manager.connected('claude-test')).toBe(true);
      expect(yield* manager.provider(connectionModelSlug(id, 'claude-test'))).toBe('anthropic');
      expect(yield* manager.provider('claude-test')).toBe('chatgpt');
      expect(yield* manager.selection('claude-test')).toEqual(
        expect.objectContaining({ _tag: 'None' }),
      );
      expect(yield* manager.selection(connectionModelSlug(id, 'claude-test'))).toEqual(
        expect.objectContaining({
          value: { connectionId: id, provider: 'anthropic', modelId: 'claude-test' },
        }),
      );
    }),
  );

  it.effect.each(providerDefinitions)(
    '$name native adapter reaches its permitted route with bridge-owned credentials',
    (definition) => {
      let upstream: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
      return Effect.gen(function* () {
        const { manager } = yield* fixture();
        const forward = promiseForward(manager, yield* Effect.context<never>());
        const { id } = yield* save(manager, {
          provider: definition.id,
          name: definition.name,
          apiKey: 'real-vault-key',
          baseURL: definition.id === 'compatible' ? 'http://localhost:1234/v1' : undefined,
          models: [{ id: definition.example, contextWindow: 32768 }],
        });
        vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          const headers = headersOf(init);
          expect(url.origin).toBe('http://127.0.0.1:43187');
          expect(headers.get('authorization')).toBe('Bearer loopback-token');
          expect(headers.has('x-api-key')).toBe(false);
          expect(headers.has('x-goog-api-key')).toBe(false);
          const suffix = url.pathname.slice(('/model/connections/' + id).length) + url.search;
          return forward(id, suffix, String(init?.body), headers);
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
        const failure = yield* Effect.flip(
          Effect.tryPromise(() =>
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
                {
                  type: 'function',
                  name: 'check',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  type: 'function',
                  name: 'web__web_search',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
              toolChoice: { type: 'auto' },
            }),
          ),
        );
        expect(String(failure.cause)).toContain('fixture stop');
        expect(upstream).toBeDefined();
        expect(JSON.stringify(upstream?.body)).toContain('roundtrip-marker');
        expect(JSON.stringify(upstream?.body)).toContain('web__web_search');
        const keyHeader = ['anthropic', 'minimax'].includes(definition.id)
          ? 'x-api-key'
          : definition.id === 'google'
            ? 'x-goog-api-key'
            : 'authorization';
        expect(upstream?.headers.get(keyHeader)).toBe(
          keyHeader === 'authorization' ? 'Bearer real-vault-key' : 'real-vault-key',
        );
        expect(upstream?.headers.get('authorization')).not.toBe('Bearer loopback-token');
        expect(upstream?.url).toContain(definition.baseURL || 'http://localhost:1234/v1');
        if (definition.id === 'gateway') {
          expect(upstream?.headers.get('ai-language-model-id')).toBe(definition.example);
          expect(upstream?.headers.has('ai-gateway-protocol-version')).toBe(true);
        }
        if (['openai', 'xai'].includes(definition.id)) {
          expect(upstream?.body.store).toBe(false);
          expect(upstream?.body.include).toContain('reasoning.encrypted_content');
        }
      }).pipe(
        withFetch(async (url, init) => {
          upstream = { url: String(url), headers: headersOf(init), body: bodyOf(init) };
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
        }),
      );
    },
  );

  it.effect(
    'proxy rejects unconfigured models and non-model routes, strips arbitrary credentials, and redacts errors',
    () => {
      const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json(
          { error: { message: 'Invalid private-test-key' } },
          { status: 401, headers: { 'retry-after': '7' } },
        ),
      );
      return Effect.gen(function* () {
        const { manager } = yield* fixture();
        const { id } = yield* save(manager, setup);
        const headers = HttpHeaders.fromInput({
          authorization: 'Bearer loopback',
          cookie: 'private-cookie',
        });
        const forward = (path: string, body: string) =>
          manager.forward({ connection: id, path, body, headers });
        expect((yield* Effect.flip(forward('/messages', '{"model":"other"}'))).message).toContain(
          'configured model',
        );
        expect(
          (yield* Effect.flip(forward('/models', '{"model":"claude-test"}'))).message,
        ).toContain('Unsupported');
        expect(
          (yield* Effect.flip(forward('/messages?key=oops', '{"model":"claude-test"}'))).message,
        ).toContain('Unsupported');
        expect(upstream).not.toHaveBeenCalled();
        const response = yield* forward('/messages', '{"model":"claude-test"}');
        expect(response.status).toBe(401);
        expect(response.headers['retry-after']).toBe('7');
        expect(yield* response.text).toContain('Invalid [redacted]');
        const forwarded = headersOf(upstream.mock.calls[0]?.[1]);
        expect(forwarded.has('cookie')).toBe(false);
        expect(forwarded.get('x-api-key')).toBe(setup.apiKey);
      }).pipe(withFetch(upstream));
    },
  );

  it.effect(
    'discovery reads provider metadata and filters Google models without generation support',
    () =>
      Effect.gen(function* () {
        const { manager } = yield* fixture();
        expect(
          yield* discover(manager, { provider: 'google', name: 'Gemini', apiKey: 'key' }),
        ).toEqual({
          models: [
            { id: 'gemini-test', name: 'Gemini', contextWindow: 1000000, reasoningEfforts: [] },
          ],
        });
      }).pipe(
        withFetch(async () =>
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
        ),
      ),
  );

  it.effect.each(['anthropic', 'google', 'compatible', 'gateway'] as const)(
    '%s streams native tool calls and accepts their results on the next request',
    (provider) => {
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
      return Effect.gen(function* () {
        const { manager } = yield* fixture();
        const forward = promiseForward(manager, yield* Effect.context<never>());
        const { id } = yield* save(manager, {
          provider,
          name: 'Native',
          apiKey: 'key',
          baseURL: provider === 'compatible' ? 'http://localhost:1234/v1' : undefined,
          models: [{ id: 'native-test', contextWindow: 32000 }],
        });
        vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          return forward(
            id,
            url.pathname.slice(('/model/connections/' + id).length) + url.search,
            String(init?.body),
            headersOf(init),
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
        const chunks = yield* Effect.promise(async () => {
          const { stream } = await model.doStream({ prompt });
          const collected = [];
          for await (const chunk of stream) {
            collected.push(chunk);
          }
          return collected;
        });
        expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
        const call = chunks.find((chunk) => chunk.type === 'tool-call');
        expect(call).toMatchObject({ toolName: 'check', input: '{"ok":true}' });
        if (!call || call.type !== 'tool-call') {
          return yield* Effect.die('Missing tool call');
        }
        expect(
          chunks.some(
            (chunk) => chunk.type === 'finish' && chunk.finishReason.unified === 'tool-calls',
          ),
        ).toBe(true);
        const failure = yield* Effect.flip(
          Effect.tryPromise(() =>
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
          ),
        );
        expect(String(failure.cause)).toContain('done');
        expect(requestBody).toContain('verified');
        if (provider === 'google') {
          expect(requestBody).toContain('signature-test');
        }
      }).pipe(
        withFetch(async (_url, init) => {
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
        }),
      );
    },
  );
});

// Windows reports a folder in the file's place as busy, and the rename is
// retried on the real clock before the save fails.
it.live('a failed metadata write rolls back the API key', () =>
  Effect.gen(function* () {
    const { manager, fs, file, secrets } = yield* fixture();
    yield* fs.makeDirectory(file);
    const error = yield* Effect.flip(save(manager, setup));
    expect(error._tag).toBe('ConnectionsFileError');
    expect(yield* manager.list).toEqual([]);
    expect([...secrets.values()].every((value) => !value)).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);
