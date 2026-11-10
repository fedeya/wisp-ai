import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  connectionConfig,
  connectionSetup,
  connectionDiscovery,
  connectionModelSlug,
  parseConnectionModel,
  providerDefinitions,
  reasoningEffort,
  type ReasoningEffort,
  type ConnectionConfig,
  type ConnectionModel,
} from '@wisp/protocol/providers';
import { createProviderModel } from '@wisp/agent/providers';
import { modelReasoningEfforts } from '@wisp/agent/reasoning';
import { safeErrorMessage } from '@wisp/protocol/model-errors';
import type { ChatGPTAuth } from './chatgpt-auth.ts';
import type { AccountModel } from './chat-model.ts';
import type { SecretVault } from './secret-vault.ts';
import { readJson, writeJson } from './json-file.ts';

export interface ModelCatalog {
  models(): Promise<AccountModel[]>;
  prepare(model: string): Promise<void>;
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
    const connections = await readJson(this.file, z.array(connectionConfig), () => []);
    const keys = new Set<string>();
    for (const connection of connections) {
      if (await this.vault.read(this.key(connection.id))) {
        keys.add(connection.id);
      }
    }
    this.connections = connections;
    this.keys = keys;
  }
  private key(id: string) {
    return 'ai-connection:' + id;
  }
  list() {
    return this.connections.map((c) => ({ ...c, hasKey: this.keys.has(c.id) }));
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
    if (!this.vault.exclusive) {
      return this.saveCurrent(raw);
    }
    return this.vault.exclusive('models', async () => {
      await this.load();
      return this.saveCurrent(raw);
    });
  }
  private async saveCurrent(raw: unknown) {
    const input = connectionSetup.parse(raw);
    if (input.id && this.get(input.id).provider !== input.provider) {
      throw Error('Create a new connection to change provider.');
    }
    this.baseURL(input);
    if (input.models.some((m) => !m.contextWindow)) {
      throw Error(
        'Set the context window in tokens for each model so Wisp can compact conversations correctly.',
      );
    }
    if (new Set(input.models.map((m) => m.id)).size !== input.models.length) {
      throw Error('Model IDs must be unique.');
    }
    const secret = await this.credential(input);
    const id = input.id || randomUUID();
    const config = connectionConfig.parse({
      ...input,
      id,
      models: input.models.map((m) => ({
        ...m,
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
  async remove(id: string) {
    if (!this.vault.exclusive) {
      return this.removeCurrent(id);
    }
    return this.vault.exclusive('models', async () => {
      await this.load();
      return this.removeCurrent(id);
    });
  }
  private async removeCurrent(id: string) {
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
    const configured: AccountModel[] = this.connections
      .filter((c) => this.keys.has(c.id) || c.provider === 'compatible')
      .flatMap((c) =>
        c.models.map((m) => {
          const supported =
            c.provider === 'gateway' && m.reasoningEfforts
              ? m.reasoningEfforts
              : modelReasoningEfforts(c.provider, m.id);
          return {
            slug: connectionModelSlug(c.id, m.id),
            displayName: `${c.name} / ${m.name || m.id}`,
            efforts: supported.length ? ['provider-default', ...supported] : [],
            ...(supported.length ? { defaultEffort: 'provider-default' } : {}),
            contextWindow: m.contextWindow,
          };
        }),
      );
    if (this.chatgpt.state().status === 'connected') {
      try {
        configured.unshift(...(await this.chatgpt.models()));
      } catch (error) {
        if (!configured.length) {
          throw error;
        }
      }
    }
    return configured;
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
  async discover(raw: unknown): Promise<{ models: ConnectionModel[] }> {
    const input = connectionDiscovery.parse(raw);
    const secret = await this.credential(input);
    const baseURL = this.baseURL(input);
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
    const models = (body.data || body.models || []).flatMap((m): ConnectionModel[] => {
      if (input.provider === 'gateway' && typeof m.type === 'string' && m.type !== 'language') {
        return [];
      }
      const id =
        typeof m.id === 'string'
          ? m.id
          : typeof m.name === 'string'
            ? m.name.replace(/^models\//, '')
            : undefined;
      if (!id) {
        return [];
      }
      if (
        input.provider === 'google' &&
        Array.isArray(m.supportedGenerationMethods) &&
        !m.supportedGenerationMethods.includes('generateContent')
      ) {
        return [];
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
      return [
        {
          id,
          name:
            typeof m.display_name === 'string'
              ? m.display_name
              : typeof m.displayName === 'string'
                ? m.displayName
                : id,
          contextWindow: typeof context === 'number' && context > 0 ? context : undefined,
          reasoningEfforts: metadataEfforts?.length
            ? metadataEfforts
            : modelReasoningEfforts(input.provider, id),
        },
      ];
    });
    if (!models.length) {
      throw Error('This provider did not return a model list. Enter model IDs manually.');
    }
    return { models };
  }
  async test(raw: unknown) {
    const input = connectionSetup.parse(raw);
    const secret = await this.credential(input);
    const model = createProviderModel(input.provider, input.models[0]!.id, {
      apiKey: secret || 'local',
      baseURL: this.baseURL(input),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('authorization');
        headers.delete('x-api-key');
        headers.delete('x-goog-api-key');
        for (const [key, value] of Object.entries(this.headers(input.provider, secret))) {
          headers.set(key, value);
        }
        const response = await this.fetcher(url, {
          ...init,
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
