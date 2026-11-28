// @effect-migrated
import {
  Context,
  Effect,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from 'effect';
import type { FileSystem, Scope } from 'effect';
import { SecureRandom } from 'effect/crypto';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { Headers, HttpClientError } from 'effect/http';
import {
  connectionConfig,
  connectionModelSlug,
  parseConnectionModel,
} from '@wisp/protocol/providers';
import type {
  ConnectionConfig,
  ConnectionSetup,
  ConnectionView,
  DiscoveredConnectionModel,
  ProviderId,
} from '@wisp/protocol/providers';
import { modelReasoningEfforts } from '@wisp/agent/reasoning';
import { modelContextWindow } from '@wisp/agent/context-windows';
import { safeErrorMessage } from '@wisp/agent/contract/model-errors';
import { ChatGPTAuth } from '#/auth';
import type { ChatGPTAuthError, ChatGPTRequestError } from '#/auth';
import { AppConfig } from '#/platform/config';
import * as JsonFile from '#/platform/json-file';
import type { JsonFileError } from '#/platform/json-file';
import { SecretVault } from '#/platform/secret-vault';
import type { SecretVaultError } from '#/platform/secret-vault';
import type { AccountModel } from '../chat/chat-model.ts';
import { discoveredModels } from './discovery.ts';
import { ModelConnectionError, connectionsFileError } from './errors.ts';
import type { ConnectionsFileError, ModelRequestError } from './errors.ts';
import { generate } from './provider-model.ts';
import {
  defaultBaseURL,
  isOk,
  providerBaseURL,
  providerHeaders,
  providerRefusal,
  providerShortName,
  redactSecret,
  requestFailed,
  withDeadline,
} from './provider-http.ts';
import { ResponseStreamError, completedResponse } from './response-stream.ts';

/** `connections.json`: the connections without their keys, which the vault keeps. */
const SavedConnections = Schema.Array(connectionConfig);

const RESPONSES = 'https://api.openai.com/v1/responses';
const GATEWAY_MODELS = 'https://ai-gateway.vercel.sh/v1/models';
const DISCOVERY_TIMEOUT = '20 seconds';

/** Headers the agent's provider SDKs send that the provider must see too. */
const FORWARDED_HEADERS = [
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'ai-language-model-specification-version',
  'ai-language-model-id',
  'ai-language-model-streaming',
  'ai-gateway-auth-method',
  'ai-gateway-protocol-version',
] as const;

/** Which provider model the player chose, for a connection's model. */
export interface ConnectionSelection {
  readonly connectionId: string;
  readonly provider: ProviderId;
  readonly modelId: string;
}

/** A model request from the agent, to send on to a connection's provider. */
export interface ForwardRequest {
  /** The connection's id, from the agent's route. */
  readonly connection: string;
  /** The rest of the route: the provider's path and query. */
  readonly path: string;
  readonly body: string;
  /** The agent's request headers; only the ones the provider needs are sent. */
  readonly headers: Headers.Headers;
}

/** Whatever answers a model: a connection's provider, or the ChatGPT subscription. */
export type ModelProvider = ProviderId | 'chatgpt';

/**
 * The player's API connections to model providers and the models they offer,
 * beside the ChatGPT subscription. Each connection's key stays in the vault;
 * `connections.json` keeps the rest.
 */
export class ModelConnections extends Context.Service<
  ModelConnections,
  {
    /** Every connection, with whether the vault holds a key for it. */
    readonly list: Effect.Effect<ConnectionView[]>;
    /**
     * False only when nothing could answer a chat: no ChatGPT account was ever signed in
     * and no API connection has a key (or is a keyless compatible endpoint) with models.
     * Expired or limited accounts still count, so their own errors explain the fix.
     */
    readonly hasProvider: Effect.Effect<boolean>;
    /** Whether `model` can be used now: its connection has a key, or ChatGPT is connected. */
    readonly connected: (model: string) => Effect.Effect<boolean>;
    /** Who answers `model`, or `undefined` for a connection that no longer exists. */
    readonly provider: (model: string) => Effect.Effect<ModelProvider | undefined>;
    /** The connection and provider model a connection's `model` names; none for ChatGPT's. */
    readonly selection: (
      model: string,
    ) => Effect.Effect<Option.Option<ConnectionSelection>, ModelConnectionError>;
    /**
     * Saves a new connection, or changes one, with its key. The key is
     * written first and restored when the file cannot be written.
     */
    readonly save: (
      input: ConnectionSetup,
    ) => Effect.Effect<
      { readonly id: string },
      ModelConnectionError | ConnectionsFileError | SecretVaultError
    >;
    /** Forgets a connection and its key. */
    readonly remove: (
      id: string,
    ) => Effect.Effect<void, ModelConnectionError | ConnectionsFileError | SecretVaultError>;
    /**
     * The models the player can choose: the ChatGPT account's, then each
     * usable connection's. A name two of them share is prefixed with its
     * connection. A ChatGPT failure only fails when no connection has models.
     */
    readonly models: Effect.Effect<
      AccountModel[],
      ChatGPTAuthError | ChatGPTRequestError | SecretVaultError
    >;
    /** Checks that `model` can answer: its connection has a key, or ChatGPT has a token. */
    readonly prepare: (
      model: string,
    ) => Effect.Effect<void, ModelConnectionError | ChatGPTAuthError | SecretVaultError>;
    /**
     * A single short completion outside the agent, e.g. a conversation title. It uses
     * the player's selected model and connection, with the cheapest supported effort.
     */
    readonly complete: (
      model: string,
      instructions: string,
      text: string,
    ) => Effect.Effect<
      string,
      | ModelConnectionError
      | ModelRequestError
      | ResponseStreamError
      | ChatGPTAuthError
      | ChatGPTRequestError
      | SecretVaultError
    >;
    /** Checks that the setup's first model answers with a native tool call. */
    readonly test: (
      input: ConnectionSetup,
    ) => Effect.Effect<void, ModelConnectionError | ModelRequestError | SecretVaultError>;
    /** The models the provider lists for the setup, with what Wisp knows about each. */
    readonly discover: (
      input: Omit<ConnectionSetup, 'models'>,
    ) => Effect.Effect<
      { readonly models: DiscoveredConnectionModel[] },
      ModelConnectionError | ModelRequestError | SecretVaultError
    >;
    /**
     * Sends the agent's model request to the connection's provider with the
     * connection's key, when it names a configured model on its provider's
     * model route. A failed status keeps the provider's error shape with the
     * key removed. The response body stays open until the scope closes.
     */
    readonly forward: (
      request: ForwardRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      ModelConnectionError | ModelRequestError | SecretVaultError,
      Scope.Scope
    >;
  }
>()('@wisp/server/models/ModelConnections') {}

/** What the consumers that are not migrated call; `runtime.ts` adapts `ModelConnections` to it. */
export interface PromiseModelConnections {
  models(): Promise<AccountModel[]>;
  prepare(model: string): Promise<void>;
  complete(model: string, instructions: string, text: string, signal: AbortSignal): Promise<string>;
  selection(model: string): Promise<Partial<ConnectionSelection>>;
  forward(
    id: string,
    suffix: string,
    body: string,
    headers: globalThis.Headers,
    signal: AbortSignal,
  ): Promise<Response>;
}

interface State {
  readonly connections: readonly ConnectionConfig[];
  /** The connections the vault holds a key for. */
  readonly keys: ReadonlySet<string>;
}

const vaultKey = (id: string) => 'ai-connection:' + id;

/** The provider's short name, numbered when another connection already uses it. */
const defaultName = (connections: readonly ConnectionConfig[], provider: ProviderId) => {
  const base = providerShortName(provider);
  const taken = new Set(connections.map((c) => c.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    name = `${base} ${n}`;
  }
  return name;
};

/** Model names compare without case or surrounding spaces. */
const key = (name: string) => name.trim().toLowerCase();
const fail = (message: string) => new ModelConnectionError({ message });

/** A connection whose models can answer without a key: a local or keyless compatible server. */
const usable = (state: State, connection: ConnectionConfig) =>
  state.keys.has(connection.id) || connection.provider === 'compatible';

/** The route a provider's native SDK sends chat requests to, relative to its base URL. */
const modelRoute = (provider: ProviderId, pathname: string, google: boolean) =>
  provider === 'google'
    ? google
    : provider === 'gateway'
      ? pathname === '/language-model'
      : provider === 'anthropic' || provider === 'minimax'
        ? pathname === '/messages'
        : provider === 'cohere'
          ? pathname === '/chat'
          : provider === 'deepinfra'
            ? pathname === '/openai/chat/completions'
            : provider === 'openai' || provider === 'xai'
              ? pathname === '/responses'
              : pathname === '/chat/completions';

/** Replaces the key in every string of a provider's error body, keeping its shape. */
const redactBody = (value: unknown, secret: Redacted.Redacted<string>): unknown => {
  if (Predicate.isString(value)) {
    return safeErrorMessage(redactSecret(value, secret));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactBody(entry, secret));
  }
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactBody(entry, secret)]),
    );
  }
  return value;
};
/** A model id from a Google route; a malformed escape fails as `decodeURIComponent` reported it. */
const decodeModelId = (encoded: string) =>
  Effect.try({
    try: () => decodeURIComponent(encoded),
    catch: (error) => fail(Predicate.isError(error) ? error.message : 'URI malformed'),
  });
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeForwardBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The parts of a completed Responses answer a short completion reads. */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));
const CompletedText = Schema.Struct({
  output: lenient(
    Schema.Array(
      Schema.Struct({
        type: lenient(Schema.String),
        content: lenient(
          Schema.Array(
            Schema.Struct({ type: lenient(Schema.String), text: lenient(Schema.String) }),
          ),
        ),
      }),
    ),
  ),
});
const decodeCompletedText = Schema.decodeUnknownOption(CompletedText);
/** ChatGPT's reason for refusing a request: `{ error: { message } }` or a subscription's `{ detail }`. */
const ChatGPTRefusal = Schema.Struct({
  error: lenient(Schema.Struct({ message: Schema.optional(Schema.Unknown) })),
  detail: Schema.optional(Schema.Unknown),
});
const decodeChatGPTRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(ChatGPTRefusal));

/** Fails as reading a ChatGPT stream failed before: no body, or what the transport failed with. */
const streamFailed = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === 'EmptyBodyError'
    ? new ResponseStreamError({ message: 'ChatGPT returned no response.' })
    : requestFailed(error);

/** What the service needs besides the vault and ChatGPT. */
export type ConnectionServices =
  | FileSystem.FileSystem
  | Path.Path
  | SecureRandom.SecureRandom
  | HttpClient.HttpClient
  | SecretVault
  | ChatGPTAuth;

/**
 * Loads the connections saved in `file` and which of them the vault holds a
 * key for. A file that does not decode fails with a `JsonFileError` and stays
 * as it was.
 */
const make = Effect.fnUntraced(function* (
  file: string,
): Effect.fn.Return<
  ModelConnections['Service'],
  JsonFileError | ConnectionsFileError | SecretVaultError,
  ConnectionServices
> {
  const vault = yield* SecretVault;
  const chatgpt = yield* ChatGPTAuth;
  const random = yield* SecureRandom.SecureRandom;
  // Captured for the file writes, which run inside the service's methods.
  const files = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  // As with the fetch calls before, a redirect fails the request.
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
    ),
  );
  const scopedClient = HttpClient.withScope(client);

  const saved = yield* JsonFile.read(file, SavedConnections, () => []).pipe(
    Effect.catchTag('PlatformError', (error) => Effect.fail(connectionsFileError(error))),
  );
  const keys = new Set<string>();
  for (const connection of saved) {
    if (Redacted.value(yield* vault.read(vaultKey(connection.id)))) {
      keys.add(connection.id);
    }
  }
  const state = yield* Ref.make<State>({ connections: saved, keys });
  // Saves and removals change the vault and the file in step, one at a time.
  const writes = yield* Semaphore.make(1);

  const find = (id: string) =>
    Effect.map(Ref.get(state), ({ connections }) =>
      connections.find((connection) => connection.id === id),
    );
  const get = Effect.fnUntraced(function* (id: string) {
    const connection = yield* find(id);
    if (connection === undefined) {
      return yield* fail('AI connection not found.');
    }
    return connection;
  });

  /** The key a request sends: the one given, else the saved connection's; only a local server may have none. */
  const credential = Effect.fnUntraced(function* (input: {
    readonly id?: string | undefined;
    readonly apiKey?: string | undefined;
    readonly provider: ProviderId;
  }) {
    const key = input.apiKey
      ? Redacted.make(input.apiKey)
      : input.id
        ? yield* vault.read(vaultKey((yield* get(input.id)).id))
        : Redacted.make('');
    if (!Redacted.value(key) && input.provider !== 'compatible') {
      return yield* fail('Enter an API key.');
    }
    return key;
  });

  /** Writes the connections, restoring the previous key of `id` when the file cannot be written. */
  const persist = Effect.fnUntraced(function* (
    id: string,
    secret: Redacted.Redacted<string>,
    next: readonly ConnectionConfig[],
  ) {
    const previous = yield* vault.read(vaultKey(id));
    yield* vault.write(vaultKey(id), secret);
    yield* JsonFile.write(file, SavedConnections, next).pipe(
      Effect.mapError(connectionsFileError),
      Effect.provideContext(files),
      Effect.tapError(() => vault.write(vaultKey(id), previous)),
    );
    yield* Ref.update(state, (current) => {
      const keys = new Set(current.keys);
      if (Redacted.value(secret)) {
        keys.add(id);
      } else {
        keys.delete(id);
      }
      return { connections: next, keys };
    });
  });

  const list = Effect.map(Ref.get(state), ({ connections, keys }) =>
    connections.map((connection) => ({ ...connection, hasKey: keys.has(connection.id) })),
  );

  const hasProvider = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    return (
      (yield* chatgpt.state).status !== 'signed_out' ||
      current.connections.some(
        (connection) => usable(current, connection) && connection.models.length > 0,
      )
    );
  });

  const connected = Effect.fn('ModelConnections.connected')(function* (model: string) {
    const selected = parseConnectionModel(model);
    if (!selected) {
      return (yield* chatgpt.state).status === 'connected';
    }
    const current = yield* Ref.get(state);
    return current.connections.some(
      (connection) =>
        connection.id === selected.connection &&
        usable(current, connection) &&
        connection.models.some((m) => m.id === selected.model),
    );
  });

  const provider = Effect.fn('ModelConnections.provider')(function* (model: string) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      return 'chatgpt' as const;
    }
    return (yield* find(parsed.connection))?.provider;
  });

  const selection = Effect.fn('ModelConnections.selection')(function* (model: string) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      return Option.none<ConnectionSelection>();
    }
    const connection = yield* get(parsed.connection);
    return Option.some<ConnectionSelection>({
      connectionId: connection.id,
      provider: connection.provider,
      modelId: parsed.model,
    });
  });

  const save = Effect.fn('ModelConnections.save')(function* (input: ConnectionSetup) {
    const existing = input.id === undefined ? Option.none() : Option.some(yield* get(input.id));
    if (Option.isSome(existing) && existing.value.provider !== input.provider) {
      return yield* fail('Create a new connection to change provider.');
    }
    yield* providerBaseURL(input);
    if (new Set(input.models.map((m) => m.id)).size !== input.models.length) {
      return yield* fail('Model IDs must be unique.');
    }
    const secret = yield* credential(input);
    const id = input.id || (yield* random.uuidV4());
    const { connections } = yield* Ref.get(state);
    const config = yield* Schema.decodeEffect(connectionConfig)({
      id,
      provider: input.provider,
      name:
        input.name ??
        Option.match(existing, {
          onNone: () => defaultName(connections, input.provider),
          onSome: (connection) => connection.name,
        }),
      ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
      models: input.models.map((m) => ({
        ...m,
        contextWindow: m.contextWindow ?? modelContextWindow(input.provider, m.id),
        reasoningEfforts: m.reasoningEfforts ?? modelReasoningEfforts(input.provider, m.id),
      })),
    }).pipe(Effect.mapError((error) => fail(error.message)));
    yield* persist(id, secret, [...connections.filter((c) => c.id !== id), config]).pipe(
      // Once started, a save runs to its end, so the key and the file stay in step.
      Effect.uninterruptible,
    );
    return { id };
  }, writes.withPermits(1));

  const remove = Effect.fn('ModelConnections.remove')(function* (id: string) {
    yield* get(id);
    const { connections } = yield* Ref.get(state);
    yield* persist(
      id,
      Redacted.make(''),
      connections.filter((c) => c.id !== id),
    ).pipe(Effect.uninterruptible);
  }, writes.withPermits(1));

  const models = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const configured = current.connections
      .filter((c) => usable(current, c))
      .flatMap((c) =>
        c.models.map((m) => {
          const supported =
            c.provider === 'gateway' && m.reasoningEfforts
              ? m.reasoningEfforts
              : modelReasoningEfforts(c.provider, m.id);
          const model: AccountModel = {
            slug: connectionModelSlug(c.id, m.id),
            displayName: m.name || m.id,
            efforts: supported.length ? ['provider-default', ...supported] : [],
            ...(supported.length ? { defaultEffort: 'provider-default' } : {}),
            contextWindow: m.contextWindow,
          };
          return { connection: c.name, model };
        }),
      );
    const account =
      (yield* chatgpt.state).status === 'connected'
        ? yield* chatgpt.models.pipe(
            Effect.catch((error) => (configured.length ? Effect.succeed([]) : Effect.fail(error))),
          )
        : [];
    // Model names already say what they are ("Claude Opus 5.5"), so the
    // connection only prefixes a name that two sources share.
    const counts = new Map<string, number>();
    for (const { displayName } of [...account, ...configured.map(({ model }) => model)]) {
      counts.set(key(displayName), (counts.get(key(displayName)) ?? 0) + 1);
    }
    return [
      ...account,
      ...configured.map(({ connection, model }) =>
        (counts.get(key(model.displayName)) ?? 0) > 1
          ? { ...model, displayName: `${connection} / ${model.displayName}` }
          : model,
      ),
    ];
  }).pipe(Effect.withSpan('ModelConnections.models'));

  /** The connection that serves `model`, when it is still configured. */
  const configuredConnection = Effect.fnUntraced(function* (connection: string, model: string) {
    const found = yield* get(connection);
    if (!found.models.some((m) => m.id === model)) {
      return yield* fail('Model is no longer configured.');
    }
    return found;
  });

  const prepare = Effect.fn('ModelConnections.prepare')(function* (model: string) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      if ((yield* chatgpt.state).status === 'authorizing') {
        return yield* fail('Finish ChatGPT sign-in first.');
      }
      yield* chatgpt.accessToken;
      return;
    }
    yield* credential(yield* configuredConnection(parsed.connection, parsed.model));
  });

  const chatgptComplete = Effect.fnUntraced(function* (
    model: string,
    instructions: string,
    text: string,
  ) {
    const entry = (yield* chatgpt.models).find((m) => m.slug === model);
    if (!entry) {
      return yield* fail('This model is not available.');
    }
    const effort = ['none', 'minimal', 'low'].find((e) => entry.efforts.includes(e));
    const request = HttpClientRequest.post(RESPONSES).pipe(
      HttpClientRequest.bodyText(
        JSON.stringify({
          model,
          ...(effort ? { reasoning: { effort } } : {}),
          store: false,
          stream: true,
          instructions,
          input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
        }),
        'application/json',
      ),
    );
    const response = yield* chatgpt.authorized(request);
    if (!isOk(response)) {
      const refusal = Option.getOrUndefined(
        Option.flatMap(yield* Effect.option(response.text), decodeChatGPTRefusal),
      );
      const reason = refusal?.error?.message ?? refusal?.detail;
      return yield* fail(
        safeErrorMessage(Predicate.isString(reason) ? reason : 'The model is unavailable.'),
      );
    }
    const completed = yield* completedResponse(response.stream.pipe(Stream.mapError(streamFailed)));
    const output = Option.match(decodeCompletedText(completed), {
      onNone: () => [],
      onSome: (answer) => answer.output ?? [],
    });
    return output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((part) => (part.type === 'output_text' ? (part.text ?? '') : ''))
      .join('');
  }, Effect.scoped);

  const complete = Effect.fn('ModelConnections.complete')(function* (
    model: string,
    instructions: string,
    text: string,
  ) {
    const parsed = parseConnectionModel(model);
    if (!parsed) {
      return yield* chatgptComplete(model, instructions, text);
    }
    const connection = yield* configuredConnection(parsed.connection, parsed.model);
    const secret = yield* credential(connection);
    const result = yield* generate(
      client,
      {
        provider: connection.provider,
        modelId: parsed.model,
        baseURL: yield* providerBaseURL(connection),
        secret,
      },
      {
        prompt: [
          { role: 'system', content: instructions },
          { role: 'user', content: [{ type: 'text', text }] },
        ],
      },
    );
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  });

  const test = Effect.fn('ModelConnections.test')(function* (input: ConnectionSetup) {
    const secret = yield* credential(input);
    const [first] = input.models;
    if (first === undefined) {
      return yield* fail('Enter a model ID.');
    }
    const result = yield* generate(
      client,
      {
        provider: input.provider,
        modelId: first.id,
        baseURL: yield* providerBaseURL(input),
        secret,
      },
      {
        prompt: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Call connection_check with ok=true.' }],
          },
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
      },
    );
    if (
      !result.content.some(
        (part) => part.type === 'tool-call' && part.toolName === 'connection_check',
      )
    ) {
      return yield* fail(
        'The model replied, but did not pass the tool-calling check. Choose a model with tool support.',
      );
    }
  });

  const discover = Effect.fn('ModelConnections.discover')(function* (
    input: Omit<ConnectionSetup, 'models'>,
  ) {
    const secret = yield* credential(input);
    const baseURL = yield* providerBaseURL(input);
    const officialEndpoint = baseURL === defaultBaseURL(input.provider);
    const url =
      input.provider === 'gateway'
        ? input.baseURL
          ? baseURL + '/config'
          : GATEWAY_MODELS
        : baseURL + (input.provider === 'deepinfra' ? '/openai/models' : '/models');
    const body = yield* Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders(providerHeaders(input.provider, secret)),
          ),
        )
        .pipe(Effect.mapError(requestFailed));
      if (!isOk(response)) {
        return yield* yield* providerRefusal(response, secret);
      }
      return yield* response.json.pipe(Effect.mapError(requestFailed));
    }).pipe(withDeadline(DISCOVERY_TIMEOUT));
    const found = discoveredModels(input.provider, body, officialEndpoint);
    if (!found.length) {
      return yield* fail('This provider did not return a model list. Enter model IDs manually.');
    }
    return { models: found };
  });

  const forward = Effect.fn('ModelConnections.forward')(function* (request: ForwardRequest) {
    const connection = yield* get(request.connection);
    const secret = yield* credential(connection);
    const url = URL.parse('https://loopback.invalid' + request.path);
    if (url === null) {
      return yield* fail('Unsupported model route.');
    }
    const data = yield* decodeForwardBody(request.body).pipe(
      Effect.mapError((error) => fail(error.message)),
    );
    const google = /^\/models\/(.+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
    const model =
      connection.provider === 'google'
        ? google?.[1] && (yield* decodeModelId(google[1]))
        : connection.provider === 'gateway'
          ? request.headers['ai-language-model-id']
          : data.model;
    if (!Predicate.isString(model) || !connection.models.some((m) => m.id === model)) {
      return yield* fail('Choose a configured model.');
    }
    if (
      !modelRoute(connection.provider, url.pathname, google !== null) ||
      [...url.searchParams.keys()].some((key) => key !== 'alt') ||
      (url.search && !(connection.provider === 'google' && url.search === '?alt=sse'))
    ) {
      return yield* fail('Unsupported model route.');
    }
    const forwarded = Object.fromEntries(
      FORWARDED_HEADERS.flatMap((name) => {
        const value = request.headers[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    // Never persist Responses history server-side, for API keys or subscriptions.
    const body = url.pathname === '/responses' ? { ...data, store: false } : data;
    const response = yield* scopedClient
      .execute(
        HttpClientRequest.post(
          (yield* providerBaseURL(connection)) + url.pathname + url.search,
        ).pipe(
          HttpClientRequest.setHeaders({
            ...providerHeaders(connection.provider, secret),
            ...forwarded,
          }),
          HttpClientRequest.bodyText(JSON.stringify(body), 'application/json'),
        ),
      )
      .pipe(Effect.mapError(requestFailed));
    if (isOk(response)) {
      return response;
    }
    // Native SDKs validate different error schemas. Preserve the shape while
    // removing secrets, rather than converting every error to OpenAI JSON.
    const error = Option.getOrElse(
      Option.flatMap(yield* Effect.option(response.text), decodeJson),
      () => ({ error: { message: `Provider returned HTTP ${response.status}.` } }),
    );
    const retryAfter = response.headers['retry-after'];
    return HttpClientResponse.fromWeb(
      response.request,
      Response.json(redactBody(error, secret), {
        status: response.status,
        headers: retryAfter === undefined ? undefined : { 'retry-after': retryAfter },
      }),
    );
  });

  return ModelConnections.of({
    list,
    hasProvider,
    connected,
    provider,
    selection,
    save,
    remove,
    models,
    prepare,
    complete,
    test,
    discover,
    forward,
  });
});

/** The player's model connections, saved in `connections.json` in the runtime folder from `AppConfig`. */
export const layer = Layer.effect(
  ModelConnections,
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(paths.runtime, 'connections.json'));
  }),
);

/** The player's model connections, saved in `file`. */
export const layerAt = (file: string) => Layer.effect(ModelConnections, make(file));
