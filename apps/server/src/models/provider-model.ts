// @effect-migrated allow=effectPromises,effectRuns: adapter around the AI SDK's provider models, whose doGenerate returns a Promise and whose fetch callback must return one
import { Effect, Redacted, Schema } from 'effect';
import { HttpClientRequest, HttpMethod } from 'effect/http';
import type { HttpClient } from 'effect/http';
import type { ProviderId } from '@wisp/protocol/providers';
import { createProviderModel } from '@wisp/agent/providers';
import { ModelConnectionError, ModelRequestError } from './errors.ts';
import {
  credentialHeaders,
  isOk,
  providerHeaders,
  providerRefusal,
  requestFailed,
  withDeadline,
} from './provider-http.ts';

type ProviderModel = ReturnType<typeof createProviderModel>;
type GenerateOptions = Omit<Parameters<ProviderModel['doGenerate']>[0], 'abortSignal'>;

/** One model of a connection, with the key Wisp sends for it. */
export interface ProviderModelTarget {
  readonly provider: ProviderId;
  readonly modelId: string;
  /** The connection's validated base URL. */
  readonly baseURL: string;
  readonly secret: Redacted.Redacted<string>;
}

const isRefusal = Schema.is(ModelConnectionError);

/** How long one provider request may take, its body included. */
const REQUEST_TIMEOUT = '25 seconds';

const decodeRequestBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The request body with Responses history kept off the provider's servers, as in `forward`. */
const withoutStoredHistory = (body: string) =>
  decodeRequestBody(body).pipe(
    Effect.map((data) => JSON.stringify({ ...data, store: false })),
    Effect.mapError((error) => new ModelConnectionError({ message: error.message })),
  );

/**
 * Sends one request the AI SDK makes through `client`, with the connection's
 * own credential headers instead of the SDK's. A failed status fails with the
 * provider's reason; the body is read in full within the deadline.
 */
const send = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  target: ProviderModelTarget,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
) {
  const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
  const method = init?.method ?? 'GET';
  if (!HttpMethod.isHttpMethod(method)) {
    return yield* new ModelConnectionError({ message: 'Unsupported model request.' });
  }
  const headers = new Headers(init?.headers);
  for (const name of credentialHeaders) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(providerHeaders(target.provider, target.secret))) {
    headers.set(name, value);
  }
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    return yield* new ModelConnectionError({ message: 'Unsupported model request body.' });
  }
  const base = HttpClientRequest.make(method)(url, { headers });
  const request =
    typeof body === 'string'
      ? HttpClientRequest.bodyText(
          base,
          (URL.parse(url)?.pathname.endsWith('/responses') ?? false)
            ? yield* withoutStoredHistory(body)
            : body,
          headers.get('content-type') ?? undefined,
        )
      : base;
  const response = yield* client.execute(request).pipe(Effect.mapError(requestFailed));
  if (!isOk(response)) {
    return yield* yield* providerRefusal(response, target.secret);
  }
  const bytes = yield* response.arrayBuffer.pipe(Effect.mapError(requestFailed));
  return new Response(bytes, {
    status: response.status,
    headers: Object.entries(response.headers),
  });
});

/**
 * Runs one `doGenerate` call of the connection's provider model. The model's
 * requests go through `client`, which fails on a redirect; a provider's refusal fails with its reason,
 * anything else the SDK or the transport failed with is a `ModelRequestError`.
 */
export const generate = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  target: ProviderModelTarget,
  options: GenerateOptions,
) {
  // The SDK calls `fetch` later, from its own Promise code, in this fiber's context.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const fetch: typeof globalThis.fetch = (input, init) =>
    runPromise(
      send(client, target, input, init).pipe(
        withDeadline(REQUEST_TIMEOUT),
        // The SDK reads what `fetch` rejects with: a network failure or a timeout as is.
        Effect.catchTag('ModelRequestError', (error) => Effect.fail(error.cause)),
      ),
      { signal: init?.signal ?? undefined },
    );
  const model = createProviderModel(target.provider, target.modelId, {
    apiKey: Redacted.value(target.secret) || 'local',
    baseURL: target.baseURL,
    fetch,
  });
  return yield* Effect.tryPromise({
    try: (signal) => model.doGenerate({ ...options, abortSignal: signal }),
    catch: (cause) => (isRefusal(cause) ? cause : new ModelRequestError({ cause })),
  });
});
