import { Layer } from 'effect';
import { HttpClientLive } from './integrations/http-client.ts';
import { Exa } from './integrations/search/exa.ts';
import { TheWoWDB } from './integrations/thewowdb.ts';
import { LoggerLive } from './logger.ts';
import { ProcessLayer } from './process.ts';

/**
 * The services every part of the bridge can use. `main.ts` provides it once
 * to the bridge program; `startBridge` builds it into the bridge's own scope.
 */
export const AppLayer = Layer.mergeAll(
  LoggerLive,
  ProcessLayer,
  Layer.mergeAll(TheWoWDB.layer, Exa.layer).pipe(Layer.provide(HttpClientLive)),
);

/** The services AppLayer provides. */
export type AppServices = Layer.Success<typeof AppLayer>;
