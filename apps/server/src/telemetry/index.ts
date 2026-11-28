// @effect-migrated
import { Layer } from 'effect';
import * as PostHog from './posthog.ts';
import { make, UsageTelemetry } from './usage.ts';

export { UsageTelemetry } from './usage.ts';
export type {
  ChatErrorCode,
  ChatMode,
  ChatOutcome,
  TurnUsage,
  WebSearchTelemetry,
} from './usage.ts';

/**
 * Usage telemetry reporting to Wisp's PostHog project. Closing the layer stops
 * new events, waits for the ones on their way and shuts the client down.
 */
export const layer = Layer.effect(UsageTelemetry, make).pipe(Layer.provide(PostHog.layer));
