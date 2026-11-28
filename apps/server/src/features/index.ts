// @effect-migrated
import { Layer } from 'effect';
import { featureFlags } from '@wisp/protocol/features';
import { Features, make } from './flags.ts';

export { Features } from './flags.ts';
export type { FeatureValues } from './flags.ts';

/** Wisp's feature flags, with the overrides the player saved in `Settings`. */
export const layer = Layer.effect(Features, make(featureFlags));
