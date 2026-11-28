import { Effect, Option, Schema, SchemaGetter } from 'effect';
import { featureOverrides } from '@wisp/protocol/features';
import { readJson, writeJson } from './json-file.ts';

const filled = Schema.String.check(Schema.isMinLength(1));
export const bridgeConfigSchema = Schema.Struct({
  wow: Schema.optional(filled),
  // Earlier installers saved an empty string before model selection.
  model: Schema.optional(Schema.String).pipe(
    Schema.decodeTo(Schema.optional(filled), {
      decode: SchemaGetter.transformOptional(Option.filter((model) => model !== '')),
      encode: SchemaGetter.passthrough(),
    }),
  ),
  mcpConfig: Schema.optional(filled),
  // A bad entry drops the saved feature choices instead of the whole file.
  features: Schema.optional(featureOverrides).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
});
export type BridgeConfigValues = typeof bridgeConfigSchema.Type;

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
  let config = await readJson(file, bridgeConfigSchema, () => ({}));
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
