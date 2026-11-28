// @effect-migrated
import type { ToolName } from '@wisp/protocol/capabilities';
import type { ToolDefinition } from './tool.ts';
import type { CapabilitySnapshot } from '../host/capabilities.ts';
/**
 * Offers a tool while its capability is on. A tool in `toolFeatures` is also
 * off while its feature flag is, because the bridge publishes it as disabled.
 * Only a tool `toolDescriptions` registers has a capability, so `name` is one
 * of its names.
 */
export function enabledTool<I, O>(name: ToolName, definition: ToolDefinition<I, O>) {
  return { ...definition, capability: 'tool:' + name };
}

/** Whether the model may see a tool now: its capability, if any, is on. */
export function toolOffered(
  tool: Pick<ToolDefinition, 'capability'>,
  capabilities: CapabilitySnapshot,
) {
  return !tool.capability || capabilities.enabled(tool.capability);
}
