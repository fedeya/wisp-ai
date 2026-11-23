import { toolDescriptions } from '@wisp/protocol/capabilities';
import type { FeatureFlag } from '@wisp/protocol/features';
import { defineDynamic } from 'eve';
import { capabilityEnabled, featureEnabled } from './capabilities.ts';
/**
 * Offers a tool while its capability is on. With `feature`, the tool also
 * stays hidden until that feature flag is on.
 */
export function enabledTool<T>(
  name: string,
  definition: T,
  options: { feature?: FeatureFlag } = {},
) {
  if (!Object.hasOwn(toolDescriptions, name)) {
    throw new Error('Unregistered tool: ' + name);
  }
  return defineDynamic(async () => {
    if (options.feature && !(await featureEnabled(options.feature))) {
      return null;
    }
    return (await capabilityEnabled('tool:' + name)) ? definition : null;
  });
}
