import type { FeatureFlag } from '@wisp/protocol/features';
import { readFile } from 'node:fs/promises';
export async function readCapabilityFlags(file?: string): Promise<Record<string, boolean>> {
  if (!file) {
    return {};
  }
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (
      !data ||
      typeof data.enabled !== 'object' ||
      Array.isArray(data.enabled) ||
      data.enabled === null ||
      Object.values(data.enabled).some((value) => typeof value !== 'boolean')
    ) {
      throw new Error('Invalid capability settings; the file was preserved');
    }
    return data.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}
export async function capabilityEnabled(id: string, defaultEnabled = true): Promise<boolean> {
  const flags = await readCapabilityFlags(process.env.WOW_CAPABILITIES_FILE);
  return flags[id] ?? defaultEnabled;
}
export async function connectionTools(name: string, tools: readonly string[]): Promise<string[]> {
  const flags = await readCapabilityFlags(process.env.WOW_CAPABILITIES_FILE);
  return tools.filter((tool) => flags['mcp_tool:' + name + ':' + tool] !== false);
}
/**
 * Whether the bridge turned a feature flag on. The bridge resolves flags and
 * publishes them next to the capability switches; unknown flags are off.
 */
export async function featureEnabled(name: FeatureFlag): Promise<boolean> {
  return (await readFeatureFlags(process.env.WOW_CAPABILITIES_FILE))[name] === true;
}
async function readFeatureFlags(file?: string): Promise<Record<string, boolean>> {
  if (!file) {
    return {};
  }
  try {
    const { features } = JSON.parse(await readFile(file, 'utf8'));
    return features && typeof features === 'object' && !Array.isArray(features) ? features : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}
