// @effect-migrated
import { Layer } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

/**
 * Node's fetch without trace headers, so a script's requests carry the
 * headers it sets and nothing else, as they did with plain fetch.
 */
export const fetchHttpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);
