import { Effect } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

/**
 * Provides the HttpClient that integrations call third-party services with:
 * the given fetch (tests inject one), no redirects, and no trace headers,
 * which would tell those services our request IDs.
 */
export function withHttpClient(fetcher: typeof fetch) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    );
}
