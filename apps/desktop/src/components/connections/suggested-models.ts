import {
  connectionModel,
  type ConnectionModel,
  type DiscoveredConnectionModel,
} from '@wisp/protocol/providers';

/**
 * Above this many usable models (aggregators such as OpenRouter list hundreds)
 * adding them all would bury the model picker, so the player chooses instead.
 */
export const autoAddLimit = 40;

const snapshotSuffix = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * The discovered models Wisp can use, without dated snapshots whose alias is
 * also listed (gpt-4o-2024-08-06 next to gpt-4o). Snapshots without an alias,
 * like most Anthropic IDs, stay.
 */
export function suggestedModels(models: DiscoveredConnectionModel[]): ConnectionModel[] {
  const usable = models.filter(({ supportsTools }) => supportsTools === true);
  const ids = new Set(usable.map(({ id }) => id));
  return usable
    .filter(({ id }) => {
      const alias = id.replace(snapshotSuffix, '');
      return alias === id || !ids.has(alias);
    })
    .map((model) => connectionModel.parse(model));
}
