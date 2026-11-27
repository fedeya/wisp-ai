// @effect-migrated
import { Layer } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

// Requests go through Node's built-in fetch, as before, and carry no trace
// headers: wago.tools and CurseForge's CDN have no use for them.
export const layer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false)),
);
