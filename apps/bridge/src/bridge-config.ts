import { z } from 'zod';
import { readJson, writeJson } from './json-file.ts';

export const bridgeConfigSchema = z.object({
  wow: z.string().min(1).optional(),
  // Earlier installers saved an empty string before model selection.
  model: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional()),
  mcpConfig: z.string().min(1).optional(),
});
export type BridgeConfigValues = z.infer<typeof bridgeConfigSchema>;

export interface BridgeConfig {
  /** The last successfully written configuration. */
  get(): BridgeConfigValues;
  /**
   * Merge `patch` into the saved configuration. Writes run one at a time in
   * call order; `get()` only reflects a patch once its write has succeeded.
   */
  update(patch: Partial<BridgeConfigValues>): Promise<void>;
}

export async function loadBridgeConfig(file: string): Promise<BridgeConfig> {
  let config = await readJson<BridgeConfigValues>(file, bridgeConfigSchema, () => ({}));
  let configWrite = Promise.resolve();
  return {
    get: () => config,
    update(patch) {
      const write = configWrite
        .catch(() => {})
        .then(async () => {
          const next = { ...config, ...patch };
          await writeJson(file, next);
          config = next;
        });
      configWrite = write;
      return write;
    },
  };
}
