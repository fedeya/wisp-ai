import { toolDescriptions } from '@wisp/protocol/capabilities';
import type { ToolDefinition } from './tool.ts';
import { capabilityEnabled } from '../host/capabilities.ts';
/**
 * Offers a tool while its capability is on. A tool in `toolFeatures` is also
 * off while its feature flag is, because the bridge publishes it as disabled.
 */
export function enabledTool<I, O>(name: string, definition: ToolDefinition<I, O>) {
  if (!Object.hasOwn(toolDescriptions, name)) {
    throw new Error('Unregistered tool: ' + name);
  }
  return { ...definition, capability: 'tool:' + name };
}

/** Whether the model may see a tool now: its capability, if any, is on. */
export async function toolOffered(tool: Pick<ToolDefinition, 'capability'>) {
  return !tool.capability || capabilityEnabled(tool.capability);
}
