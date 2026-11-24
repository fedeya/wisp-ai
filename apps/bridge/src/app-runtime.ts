import { Layer, ManagedRuntime } from 'effect';
import { HttpClientLive } from './integrations/http-client.ts';
import { Exa } from './integrations/search/exa.ts';
import { TheWoWDB } from './integrations/thewowdb.ts';
import { LoggerLive } from './logger.ts';

/**
 * Everything Effect code in the bridge runs with. The bridge is not one Effect
 * program yet, so its composition root builds this layer into a
 * ManagedRuntime once and runs Effect code through it; services join the layer
 * as their modules move to Effect.
 */
export const AppLayer = Layer.mergeAll(
  LoggerLive,
  Layer.mergeAll(TheWoWDB.layer, Exa.layer).pipe(Layer.provide(HttpClientLive)),
);

/** The services AppLayer provides. */
export type AppServices = Layer.Success<typeof AppLayer>;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

export function makeAppRuntime(): AppRuntime {
  return ManagedRuntime.make(AppLayer);
}
