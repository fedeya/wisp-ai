import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';

export interface Sent {
  readonly url: URL;
  readonly request: HttpClientRequest.HttpClientRequest;
}

/** An HttpClient that answers each request with `respond`; `sent` records the requests. */
export function cannedHttp(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      sent.push({ url, request });
      return HttpClientResponse.fromWeb(request, respond({ url, request }));
    }),
  );
  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
}
