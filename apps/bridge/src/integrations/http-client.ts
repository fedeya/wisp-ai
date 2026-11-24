import { Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

/**
 * The HttpClient integrations call third-party services with: fetch, no
 * redirects, and no trace headers, which would tell those services our request
 * IDs. Both settings are read per request, so the client applies them to every
 * request it runs. Tests replace fetch by providing `FetchHttpClient.Fetch`.
 */
export const HttpClientLive = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(
      HttpClient.transform((response) =>
        response.pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        ),
      ),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
