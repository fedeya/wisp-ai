import { toolDescriptions } from '@wisp/protocol/capabilities';
import { defineDynamic } from 'eve';
import { capabilityEnabled } from './capabilities.ts';
/**
 * Offers a tool while its capability is on. A tool in `toolFeatures` is also
 * off while its feature flag is, because the bridge publishes it as disabled.
 */
export function enabledTool<T>(name: string, definition: T) {
  if (!Object.hasOwn(toolDescriptions, name)) {
    throw new Error('Unregistered tool: ' + name);
  }
  return defineDynamic(async () => ((await capabilityEnabled('tool:' + name)) ? definition : null));
}
