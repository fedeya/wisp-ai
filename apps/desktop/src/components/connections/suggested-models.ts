import { Schema } from 'effect';
import {
  connectionModel,
  type ConnectionModel,
  type DiscoveredConnectionModel,
} from '@wisp/protocol/providers';

const snapshotSuffix = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * The discovered models Wisp can use, without dated snapshots whose alias is
 * also listed (gpt-4o-2024-08-06 next to gpt-4o). Snapshots without an alias,
 * like most Anthropic IDs, stay.
 */
const decodeModel = Schema.decodeUnknownSync(connectionModel);
export function suggestedModels(
  models: ReadonlyArray<DiscoveredConnectionModel>,
): ConnectionModel[] {
  const usable = models.filter(({ supportsTools }) => supportsTools === true);
  const ids = new Set(usable.map(({ id }) => id));
  return usable
    .filter(({ id }) => {
      const alias = id.replace(snapshotSuffix, '');
      return alias === id || !ids.has(alias);
    })
    .map((model) => decodeModel(model));
}
