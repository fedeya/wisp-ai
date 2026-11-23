import { readFile } from 'node:fs/promises';
import { writeJson } from '../json-file.ts';
import {
  defaultCapabilities,
  toolFeatures,
  type Capability,
  type CapabilityView,
} from '@wisp/protocol/capabilities';
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
export class CapabilitySettings {
  file: string;
  catalog: Capability[];
  flags: Record<string, boolean> = {};
  queue: Promise<unknown> = Promise.resolve();
  /** Feature flag of each flagged tool, by `toolDescriptions` name. */
  toolFlags: Readonly<Record<string, string>>;
  constructor(
    file: string,
    catalog = defaultCapabilities(),
    toolFlags: Readonly<Record<string, string>> = toolFeatures,
  ) {
    this.file = file;
    this.catalog = catalog;
    this.toolFlags = toolFlags;
  }
  /** Whether a feature flag that is off removes this capability everywhere. */
  hidden(id: string): boolean {
    const tool = id.startsWith('tool:') ? id.slice(5) : '';
    return Object.hasOwn(this.toolFlags, tool) && this.features[this.toolFlags[tool]] !== true;
  }
  agentFile = '';
  /** Resolved feature flags, published to the agent next to the capability switches. */
  features: Record<string, boolean> = {};
  availability = new Map<
    string,
    { available: boolean; status: string; reason?: string; version?: string }
  >();
  private agentContent = '';
  configured(id: string) {
    const entry = this.catalog.find((entry) => entry.id === id);
    return entry?.group === 'core' || (this.flags[id] ?? entry?.defaultEnabled ?? true);
  }
  state(id: string): { available: boolean; status: string; reason?: string; version?: string } {
    const entry = this.catalog.find((entry) => entry.id === id);
    return (
      this.availability.get(id) ||
      (entry?.parent
        ? this.state(entry.parent)
        : {
            available: true,
            status: entry?.kind === 'source' || entry?.kind === 'mcp' ? 'configured' : 'ready',
          })
    );
  }
  async publish() {
    if (!this.agentFile) {
      return;
    }
    const enabled = Object.fromEntries(
      this.catalog.map((entry) => [entry.id, this.enabled(entry.id)]),
    );
    const features = this.features;
    const content = JSON.stringify({ enabled, features });
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (content === this.agentContent) {
          return;
        }
        await writeJson(this.agentFile, { enabled, features });
        this.agentContent = content;
      });
    this.queue = operation;
    await operation;
  }
  async load() {
    this.flags = await readCapabilityFlags(this.file);
  }
  enabled(id: string): boolean {
    const entry = this.catalog.find((entry) => entry.id === id);
    return (
      !!entry &&
      !this.hidden(id) &&
      this.configured(id) &&
      this.state(id).available &&
      (!entry.parent || this.enabled(entry.parent))
    );
  }
  snapshot(): CapabilityView[] {
    return this.catalog
      .filter((entry) => !this.hidden(entry.id))
      .map((entry) => ({
        ...entry,
        ...this.state(entry.id),
        enabled: this.configured(entry.id),
        effective: this.enabled(entry.id),
      }));
  }
  async set(id: string, enabled: boolean) {
    const entry = this.catalog.find((entry) => entry.id === id);
    if (!entry || entry.group === 'core' || this.hidden(id) || typeof enabled !== 'boolean') {
      throw new Error('Unknown capability or invalid setting');
    }
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const next = { ...this.flags, [id]: enabled };
        await writeJson(this.file, { enabled: next });
        this.flags = next;
      });
    this.queue = operation;
    await operation;
    await this.publish();
  }
}
