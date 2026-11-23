import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  connectionConfig,
  connectionSetup,
  connectionDiscovery,
  discoveredConnectionModel,
  connectionModelSlug,
  parseConnectionModel,
  providerDefinitions,
  reasoningEffort,
  type ReasoningEffort,
  type ConnectionConfig,
  type DiscoveredConnectionModel,
  type ProviderId,
} from '@wisp/protocol/providers';
import { createProviderModel } from '@wisp/agent/providers';
import { modelReasoningEfforts } from '@wisp/agent/reasoning';
import { modelToolSupport } from '@wisp/agent/tool-support';
import { modelContextWindow } from '@wisp/agent/context-windows';
import { normalizeModelError, safeErrorMessage } from '@wisp/protocol/model-errors';
import type { ChatGPTAuth } from '../auth/chatgpt-auth.ts';
import { readCompletedResponse } from './response-stream.ts';
import type { AccountModel } from '../chat/chat-model.ts';
import type { SecretVault } from '../auth/secret-vault.ts';
import { readJson, writeJson } from '../json-file.ts';

/**
 * Whether a discovered model accepts function tools: true or false when the
 * provider's model list, the pinned SDK catalog or what the provider serves
 * says so, otherwise undefined. Discovery only offers models marked true, so
 * every provider needs an answer here or its catalog shows nothing.
 */
function discoveredToolSupport(
  provider: ProviderId,
  id: string,
  m: Record<string, unknown>,
  officialEndpoint: boolean,
): boolean | undefined {
  // OpenRouter and other OpenAI-style aggregators.
  if (Array.isArray(m.supported_parameters)) {
    return m.supported_parameters.includes('tools');
  }
  if (provider === 'gateway' && Array.isArray(m.tags) && m.tags.includes('tool-use')) {
    return true;
  }
  // Mistral.
  const capabilities = m.capabilities as Record<string, unknown> | null | undefined;
  if (typeof capabilities?.function_calling === 'boolean') {
    return capabilities.function_calling;
  }
  // Cohere.
  if (Array.isArray(m.features)) {
    return m.features.includes('tools');
  }
  // Fireworks.
  for (const value of [m.supports_tools, m.supportsTools]) {
    if (typeof value === 'boolean') {
      return value;
    }
  }
  // These official endpoints list only chat models, and all of them call tools.
  if (officialEndpoint && (provider === 'anthropic' || provider === 'deepseek')) {
    return true;
  }
  // Together tags each model with what it does; only chat models take tools.
  if (provider === 'togetherai' && officialEndpoint && typeof m.type === 'string') {
    return m.type === 'chat';
  }
  // These lists say nothing about tools. Their chat models all call tools, so
  // only the speech, image, embedding and safety models listed beside them are
  // left out. A local server is the player's own choice of models.
  if ((officialEndpoint && toolCallingChatProviders.has(provider)) || provider === 'compatible') {
    return !nonChatModel.test(id);
  }
  return modelToolSupport(provider, id);
}
const toolCallingChatProviders = new Set<ProviderId>([
  'xai',
  'groq',
  'cerebras',
  'togetherai',
  'deepinfra',
  'alibaba',
  'moonshotai',
  'minimax',
  'baseten',
  'zai',
]);
const nonChatModel =
  /embed|bge-|whisper|tts|speech|transcri|audio|orpheus|image|imagine|video|dall-e|flux|stable-diffusion|sdxl|guard|moderation|rerank|paraformer|cogview|cogvideo|wan\d|ocr|compound/i;

export interface ModelCatalog {
  models(): Promise<AccountModel[]>;
  prepare(model: string): Promise<void>;
  complete(model: string, instructions: string, text: string, signal: AbortSignal): Promise<string>;
}

export class ModelConnections implements ModelCatalog {
  private connections: ConnectionConfig[] = [];
  private keys = new Set<string>();
  private file: string;
  private vault: SecretVault;
  private chatgpt: ChatGPTAuth;
  private fetcher: typeof fetch;
  constructor(
    file: string,
    vault: SecretVault,
    chatgpt: ChatGPTAuth,
    fetcher: typeof fetch = fetch,
  ) {
    this.file = file;
    this.vault = vault;
    this.chatgpt = chatgpt;
    this.fetcher = fetcher;
  }
  async load() {
    this.connections = await readJson(this.file, z.array(connectionConfig), () => []);
    for (const connection of this.connections) {
      if (await this.vault.read(this.key(connection.id))) {
        this.keys.add(connection.id);
      }
    }
  }
  private key(id: string) {
    return 'ai-connection:' + id;
  }
  list() {
    return this.connections.map((c) => ({ ...c, hasKey: this.keys.has(c.id) }));
  }
  /**
   * False only when nothing could answer a chat: no ChatGPT account was ever signed in
   * and no API connection has a key (or is a keyless compatible endpoint) with models.
   * Expired or limited accounts still count, so their own errors explain the fix.
   */
  hasProvider() {
    return (
      this.chatgpt.state().status !== 'signed_out' ||
      this.connections.some(
        (connection) =>
          (this.keys.has(connection.id) || connection.provider === 'compatible') &&
          connection.models.length > 0,
      )
    );
  }
  connected(model: string) {
    const selected = parseConnectionModel(model);
    if (!selected) {
      return this.chatgpt.state().status === 'connected';
    }
    return this.connections.some(
      (connection) =>
        connection.id === selected.connection &&
        (this.keys.has(connection.id) || connection.provider === 'compatible') &&
        connection.models.some((m) => m.id === selected.model),
    );
  }
  get(id: string) {
    const connection = this.connections.find((c) => c.id === id);
    if (!connection) {
      throw Error('AI connection not found.');
    }
    return connection;
  }
  baseURL(connection: Pick<ConnectionConfig, 'baseURL' | 'provider'>) {
    const value =
      connection.baseURL || providerDefinitions.find((p) => p.id === connection.provider)!.baseURL;
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) {
      throw Error('Use HTTPS, or HTTP for a local server, without credentials or URL parameters.');
    }
    return url.toString().replace(/\/$/, '');
  }
  private async credential(input: { id?: string; apiKey?: string; provider: string }) {
    const key =
      input.apiKey || (input.id ? await this.vault.read(this.key(this.get(input.id).id)) : '');
    if (!key && input.provider !== 'compatible') {
      throw Error('Enter an API key.');
    }
    return key;
  }
  async save(raw: unknown) {
    const input = connectionSetup.parse(raw);
    if (input.id && this.get(input.id).provider !== input.provider) {
      throw Error('Create a new connection to change provider.');
    }
    this.baseURL(input);
    if (new Set(input.models.map((m) => m.id)).size !== input.models.length) {
      throw Error('Model IDs must be unique.');
    }
    const secret = await this.credential(input);
    const id = input.id || randomUUID();
    const config = connectionConfig.parse({
      ...input,
      id,
      name: input.name ?? (input.id ? this.get(input.id).name : this.defaultName(input.provider)),
      models: input.models.map((m) => ({
        ...m,
        contextWindow: m.contextWindow ?? modelContextWindow(input.provider, m.id),
        reasoningEfforts: m.reasoningEfforts ?? modelReasoningEfforts(input.provider, m.id),
      })),
    });
    const previous = await this.vault.read(this.key(id));
    await this.vault.write(this.key(id), secret);
    const next = [...this.connections.filter((c) => c.id !== id), config];
    try {
      await writeJson(this.file, next);
    } catch (error) {
      await this.vault.write(this.key(id), previous);
      throw error;
    }
    this.connections = next;
    if (secret) {
      this.keys.add(id);
    } else {
      this.keys.delete(id);
    }
    return { id };
  }
  /**
   * The provider's short name ("Anthropic / Claude" → "Claude"), numbered when
   * another connection already uses it.
   */
  private defaultName(provider: ProviderId) {
    const base =
      provider === 'openai'
        ? 'OpenAI'
        : providerDefinitions
            .find((p) => p.id === provider)!
            .name.split(' / ')
            .at(-1)!;
    const taken = new Set(this.connections.map((c) => c.name));
    let name: string = base;
    for (let n = 2; taken.has(name); n++) {
      name = `${base} ${n}`;
    }
    return name;
  }
  async remove(id: string) {
    this.get(id);
    const previous = await this.vault.read(this.key(id));
    await this.vault.write(this.key(id), '');
    const next = this.connections.filter((c) => c.id !== id);
    try {
      await writeJson(this.file, next);
    } catch (error) {
      await this.vault.write(this.key(id), previous);
      throw error;
    }
    this.connections = next;
    this.keys.delete(id);
  }
  async models(): Promise<AccountModel[]> {
    const configured = this.connections
      .filter((c) => this.keys.has(c.id) || c.provider === 'compatible')
      .flatMap((c) =>
        c.models.map((m) => {
          const supported =
            c.provider === 'gateway' && m.reasoningEfforts
              ? m.reasoningEfforts
              : modelReasoningEfforts(c.provider, m.id);
          return {
            connection: c.name,
            model: {
              slug: connectionModelSlug(c.id, m.id),
              displayName: m.name || m.id,
              efforts: supported.length ? ['provider-default', ...supported] : [],
              ...(supported.length ? { defaultEffort: 'provider-default' } : {}),
              contextWindow: m.contextWindow,
            } satisfies AccountModel,
          };
        }),
      );
    const account: AccountModel[] = [];
    if (this.chatgpt.state().status === 'connected') {
      try {
        account.push(...(await this.chatgpt.models()));
      } catch (error) {
        if (!configured.length) {
          throw error;
        }
      }
    }
    // Model names already say what they are ("Claude Opus 5.5"), so the
    // connection only prefixes a name that two sources share.
    const key = (name: string) => name.trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const { displayName } of [...account, ...configured.map(({ model }) => model)]) {
      counts.set(key(displayName), (counts.get(key(displayName)) ?? 0) + 1);
    }
    return [
      ...account,
      ...configured.map(({ connection, model }) =>
        counts.get(key(model.displayName))! > 1
          ? { ...model, displayName: `${connection} / ${model.displayName}` }
          : model,
      ),
    ];
  }
  async prepare(model: string) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      if (this.chatgpt.pending) {
        throw Error('Finish ChatGPT sign-in first.');
      }
      await this.chatgpt.accessToken();
      return;
    }
    const connection = this.get(parsed.connection);
    if (!connection.models.some((m) => m.id === parsed.model)) {
      throw Error('Model is no longer configured.');
    }
    await this.credential(connection);
  }
  async selection(model: string) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      return {};
    }
    const connection = this.get(parsed.connection);
    return { connectionId: connection.id, provider: connection.provider, modelId: parsed.model };
  }
  /** Who answers a model: a connection's provider, or the ChatGPT subscription. */
  provider(model: string): ProviderId | 'chatgpt' | undefined {
    const parsed = parseConnectionModel(model);
    if (!parsed) return 'chatgpt';
    return this.connections.find((c) => c.id === parsed.connection)?.provider;
  }
  private headers(provider: string, secret: string): Record<string, string> {
    return provider === 'anthropic' || provider === 'minimax'
      ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
      : provider === 'google'
        ? { 'x-goog-api-key': secret }
        : secret
          ? { authorization: 'Bearer ' + secret }
          : {};
  }
  private async upstreamError(response: Response, secret: string): Promise<never> {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    let message =
      body?.error?.message || body?.message || `Provider returned HTTP ${response.status}.`;
    if (secret) {
      message = message.split(secret).join('[redacted]');
    }
    throw Error(safeErrorMessage(message));
  }
  async discover(raw: unknown): Promise<{ models: DiscoveredConnectionModel[] }> {
    const input = connectionDiscovery.parse(raw);
    const secret = await this.credential(input);
    const baseURL = this.baseURL(input);
    const officialEndpoint =
      baseURL === providerDefinitions.find((p) => p.id === input.provider)!.baseURL;
    const url =
      input.provider === 'gateway'
        ? input.baseURL
          ? baseURL + '/config'
          : 'https://ai-gateway.vercel.sh/v1/models'
        : baseURL + (input.provider === 'deepinfra' ? '/openai/models' : '/models');
    const response = await this.fetcher(url, {
      headers: this.headers(input.provider, secret),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await this.upstreamError(response, secret);
    }
    const body = (await response.json()) as {
      data?: Record<string, unknown>[];
      models?: Record<string, unknown>[];
    };
    const models = new Map<string, DiscoveredConnectionModel>();
    // Together answers with a bare array instead of `{ data }`.
    const rows = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.models)
          ? body.models
          : [];
    for (const m of rows) {
      if (!m || typeof m !== 'object') continue;
      if (input.provider === 'gateway' && typeof m.type === 'string' && m.type !== 'language') {
        continue;
      }
      const id =
        typeof m.id === 'string'
          ? m.id
          : typeof m.name === 'string'
            ? m.name.replace(/^models\//, '')
            : undefined;
      if (!id) {
        continue;
      }
      if (
        input.provider === 'google' &&
        Array.isArray(m.supportedGenerationMethods) &&
        !m.supportedGenerationMethods.includes('generateContent')
      ) {
        continue;
      }
      const context =
        m.context_window ??
        m.context_length ??
        m.inputTokenLimit ??
        m.max_input_tokens ??
        m.max_context_length ??
        m.contextWindow;
      const metadataEfforts =
        input.provider === 'gateway' && Array.isArray(m.reasoning_options)
          ? m.reasoning_options
              .flatMap((option: { type?: string; values?: unknown[] }) =>
                option.type === 'effort' && Array.isArray(option.values) ? option.values : [],
              )
              .filter((value): value is ReasoningEffort => reasoningEffort.safeParse(value).success)
          : undefined;
      const supportsTools = discoveredToolSupport(input.provider, id, m, officialEndpoint);
      const model = discoveredConnectionModel.safeParse({
        id,
        name:
          [m.display_name, m.displayName, m.name].find(
            (name): name is string =>
              typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 200,
          ) ?? id,
        contextWindow:
          discoveredConnectionModel.shape.contextWindow.safeParse(context).data ??
          modelContextWindow(input.provider, id),
        reasoningEfforts: metadataEfforts?.length
          ? metadataEfforts
          : modelReasoningEfforts(input.provider, id),
        supportsTools,
      });
      if (model.success) models.set(model.data.id, model.data);
    }
    if (!models.size) {
      throw Error('This provider did not return a model list. Enter model IDs manually.');
    }
    return { models: [...models.values()] };
  }
  private providerModel(
    connection: Pick<ConnectionConfig, 'provider' | 'baseURL'>,
    modelId: string,
    secret: string,
  ) {
    return createProviderModel(connection.provider, modelId, {
      apiKey: secret || 'local',
      baseURL: this.baseURL(connection),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('authorization');
        headers.delete('x-api-key');
        headers.delete('x-goog-api-key');
        for (const [key, value] of Object.entries(this.headers(connection.provider, secret))) {
          headers.set(key, value);
        }
        let body = init?.body;
        // Never persist Responses history server-side, as in forward().
        const target = url instanceof Request ? url.url : String(url);
        if (typeof body === 'string' && new URL(target).pathname.endsWith('/responses')) {
          body = JSON.stringify({ ...JSON.parse(body), store: false });
        }
        const response = await this.fetcher(url, {
          ...init,
          body,
          headers,
          redirect: 'error',
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(25000)])
            : AbortSignal.timeout(25000),
        });
        if (!response.ok) {
          await this.upstreamError(response, secret);
        }
        return response;
      },
    });
  }
  // A single short completion outside the agent, e.g. a conversation title. It uses
  // the user's selected model and connection, with the cheapest supported effort.
  async complete(model: string, instructions: string, text: string, signal: AbortSignal) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      return this.chatgptComplete(model, instructions, text, signal);
    }
    const connection = this.get(parsed.connection);
    if (!connection.models.some((m) => m.id === parsed.model)) {
      throw Error('Model is no longer configured.');
    }
    const secret = await this.credential(connection);
    const result = await this.providerModel(connection, parsed.model, secret).doGenerate({
      prompt: [
        { role: 'system', content: instructions },
        { role: 'user', content: [{ type: 'text', text }] },
      ],
      abortSignal: signal,
    });
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  }
  private async chatgptComplete(
    model: string,
    instructions: string,
    text: string,
    signal: AbortSignal,
  ) {
    const entry = (await this.chatgpt.models()).find((m) => m.slug === model);
    if (!entry) {
      throw Error('This model is not available.');
    }
    const effort = ['none', 'minimal', 'low'].find((e) => entry.efforts.includes(e));
    const response = await this.chatgpt.authorized('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(effort ? { reasoning: { effort } } : {}),
        store: false,
        stream: true,
        instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
      }),
      signal,
    });
    if (!response.ok) {
      const error = await normalizeModelError(response);
      const body = (await error.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw Error(safeErrorMessage(body?.error?.message ?? 'The model is unavailable.'));
    }
    const completed = (await readCompletedResponse(response)) as {
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };
    return (completed.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((part) => (part.type === 'output_text' ? (part.text ?? '') : ''))
      .join('');
  }
  async test(raw: unknown) {
    const input = connectionSetup.parse(raw);
    const secret = await this.credential(input);
    const model = this.providerModel(input, input.models[0]!.id, secret);
    const result = await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Call connection_check with ok=true.' }] },
      ],
      tools: [
        {
          type: 'function',
          name: 'connection_check',
          description: 'Check tool calling support.',
          inputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { type: 'tool', toolName: 'connection_check' },
    });
    if (
      !result.content.some(
        (part) => part.type === 'tool-call' && part.toolName === 'connection_check',
      )
    ) {
      throw Error(
        'The model replied, but did not pass the tool-calling check. Choose a model with tool support.',
      );
    }
    return { ok: true };
  }
  async forward(id: string, suffix: string, body: string, incoming: Headers, signal: AbortSignal) {
    const connection = this.get(id);
    const secret = await this.credential(connection);
    const url = new URL('https://loopback.invalid' + suffix);
    const data = JSON.parse(body) as Record<string, unknown>;
    const google = /^\/models\/(.+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
    const model =
      connection.provider === 'google'
        ? google && decodeURIComponent(google[1]!)
        : connection.provider === 'gateway'
          ? incoming.get('ai-language-model-id')
          : data.model;
    if (typeof model !== 'string' || !connection.models.some((m) => m.id === model)) {
      throw Error('Choose a configured model.');
    }
    const route =
      connection.provider === 'google'
        ? !!google
        : connection.provider === 'gateway'
          ? url.pathname === '/language-model'
          : ['anthropic', 'minimax'].includes(connection.provider)
            ? url.pathname === '/messages'
            : connection.provider === 'cohere'
              ? url.pathname === '/chat'
              : connection.provider === 'deepinfra'
                ? url.pathname === '/openai/chat/completions'
                : ['openai', 'xai'].includes(connection.provider)
                  ? url.pathname === '/responses'
                  : url.pathname === '/chat/completions';
    if (
      !route ||
      [...url.searchParams.keys()].some((key) => key !== 'alt') ||
      (url.search && !(connection.provider === 'google' && url.search === '?alt=sse'))
    ) {
      throw Error('Unsupported model route.');
    }
    const headers = new Headers({
      'content-type': 'application/json',
      ...this.headers(connection.provider, secret),
    });
    for (const name of [
      'accept',
      'anthropic-version',
      'anthropic-beta',
      'ai-language-model-specification-version',
      'ai-language-model-id',
      'ai-language-model-streaming',
      'ai-gateway-auth-method',
      'ai-gateway-protocol-version',
    ]) {
      if (incoming.has(name)) {
        headers.set(name, incoming.get(name)!);
      }
    }
    // Never persist Responses history server-side, for API keys or subscriptions.
    if (url.pathname === '/responses') {
      data.store = false;
    }
    const response = await this.fetcher(this.baseURL(connection) + url.pathname + url.search, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      // Native SDKs validate different error schemas. Preserve the shape while
      // removing secrets, rather than converting every error to OpenAI JSON.
      const redact = (value: unknown): unknown => {
        if (typeof value === 'string') {
          return safeErrorMessage(secret ? value.split(secret).join('[redacted]') : value);
        }
        if (Array.isArray(value)) {
          return value.map(redact);
        }
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, redact(entry)]),
          );
        }
        return value;
      };
      const body = await response
        .json()
        .catch(() => ({ error: { message: `Provider returned HTTP ${response.status}.` } }));
      return Response.json(redact(body), {
        status: response.status,
        headers: response.headers.has('retry-after')
          ? { 'retry-after': response.headers.get('retry-after')! }
          : undefined,
      });
    }
    return response;
  }
}
