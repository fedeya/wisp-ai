import { Context, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { ChatGPTAuth } from '#/auth';
import type { ChatGPTAuthError, ChatGPTAuthState, ChatGPTRequestError } from '#/auth';

/** The text body a request carries, or `''`. */
export const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : '';

/** The JSON body a request carries. */
export const bodyJson = (request: HttpClientRequest.HttpClientRequest): unknown =>
  JSON.parse(bodyText(request));

/** A streamed Responses API answer that completes with `response`. */
export const completed = (response: unknown) =>
  new Response('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');

const signedIn = (status: ChatGPTAuthState['status']): ChatGPTAuthState => ({
  status,
  revision: 0,
  activeId: null,
  account: null,
  message: '',
  profiles: [],
});

/**
 * A ChatGPT account whose API requests `respond` answers. `sent` records
 * them; `connect` signs the account in.
 */
export function chatgpt(
  respond: (
    request: HttpClientRequest.HttpClientRequest,
    count: number,
  ) => Response | Effect.Effect<Response, ChatGPTAuthError | ChatGPTRequestError> = () =>
    new Response(null, { status: 503 }),
) {
  const sent: HttpClientRequest.HttpClientRequest[] = [];
  let status: ChatGPTAuthState['status'] = 'signed_out';
  const layer = Layer.mock(ChatGPTAuth, {
    state: Effect.sync(() => signedIn(status)),
    authorized: (request) =>
      Effect.suspend(() => {
        sent.push(request);
        const response = respond(request, sent.length);
        return Effect.isEffect(response) ? response : Effect.succeed(response);
      }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  });
  return {
    sent,
    layer,
    connect: () => {
      status = 'connected';
    },
  };
}

interface Sent {
  readonly url: URL;
  readonly request: HttpClientRequest.HttpClientRequest;
  /** What `fetch` would have been given, such as `redirect`. */
  readonly init: RequestInit | undefined;
  /** Aborted when the request is interrupted. */
  readonly signal: AbortSignal;
}

/** A request that did not reach its server, failing with `cause` as `fetch` would. */
export const unreachable = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause }),
    }),
  );

/** An `HttpClient` that answers each request with `respond`; `sent` records them. */
export function httpClient(
  respond: (
    sent: Sent,
    count: number,
  ) => Response | Effect.Effect<Response, HttpClientError.HttpClientError>,
) {
  const sent: Sent[] = [];
  const client = HttpClient.make((request, url, signal, fiber) =>
    Effect.suspend(() => {
      const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
      const entry = { url, request, init, signal };
      sent.push(entry);
      const response = respond(entry, sent.length);
      return Effect.isEffect(response) ? response : Effect.succeed(response);
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  );
  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
}
