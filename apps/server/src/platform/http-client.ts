import { Layer } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

/**
 * The server's outgoing `HttpClient`. It sends requests through Node's built-in
 * `fetch`, the transport Wisp's integrations used before, so proxies, TLS and
 * redirects behave the same. Requests carry no trace headers: Wisp has no
 * tracing backend, and third-party APIs should not receive them.
 */
export const layer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);
