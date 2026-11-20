import { errorMessage } from './errors.ts';
import type { ModelConnections } from './model-connections.ts';
import type { SessionState } from './session-state.ts';

/**
 * Returns a function that reloads the account model catalog into `state`.
 * Calls made while a reload is running share it. Never rejects: a failure
 * empties the catalog and records the error for the addon.
 */
export function createModelCatalogRefresh({
  state,
  connections,
  changed,
}: {
  state: Pick<SessionState, 'modelCatalog' | 'modelCatalogError'>;
  connections: Pick<ModelConnections, 'models'>;
  changed: () => void;
}): () => Promise<void> {
  let load: Promise<void> | undefined;
  return () =>
    (load ??= (async () => {
      try {
        state.modelCatalog = await connections.models();
        state.modelCatalogError = undefined;
      } catch (error) {
        state.modelCatalog = [];
        state.modelCatalogError = errorMessage(error);
      } finally {
        load = undefined;
        changed();
      }
    })());
}
