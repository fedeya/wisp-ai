// @effect-migrated allow=effectPromises: adapter around posthog-node, whose calls return Promises
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { PostHog } from 'posthog-node';
import type { EventMessage } from 'posthog-node';

const token = 'phc_se29yi8DLMmFxhRcqQrzrSs9vGLzAiEGmsaMvjotDdTE';
const host = 'https://us.i.posthog.com';
/** How long shutdown waits for events still on their way. */
const shutdownTimeoutMs = 3000;
/** The only properties an event may carry; the SDK's context and enrichment add no others. */
const propertyKeys = new Set([
  'surface',
  'app_version',
  'channel',
  'os',
  'arch',
  'mode',
  'outcome',
  'duration_ms',
  'first_text_ms',
  'model_calls',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'error_code',
  'model_provider',
  'failure_kind',
  'addon_version',
  'tool',
  'depth',
  'provider',
  'result_count',
  'features',
  '$process_person_profile',
  '$geoip_disable',
  '$lib',
  '$lib_version',
]);

export type Properties = Readonly<Record<string, string | number | boolean>>;

/** One event for the installation `distinctId`. */
export interface CaptureMessage {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Properties;
}

/** posthog-node rejected a call; the event was not sent. */
export class PostHogError extends Schema.TaggedError<PostHogError>()('PostHogError', {
  cause: Schema.Defect(),
}) {}

/** The PostHog project Wisp reports usage to. */
export class PostHogClient extends Context.Service<
  PostHogClient,
  {
    /** Sends one event now. The SDK client is created for the first event. */
    readonly capture: (message: CaptureMessage) => Effect.Effect<void, PostHogError>;
    /** Stops the client: events still on their way to it are dropped. */
    readonly optOut: Effect.Effect<void, PostHogError>;
  }
>()('@wisp/server/telemetry/PostHogClient') {}

/** Runs one call of the SDK. */
const sdk = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new PostHogError({ cause }) });

/**
 * posthog-node, created on the first event so a run that sends nothing never
 * starts it. It sends each event right away, without retries or GeoIP, and
 * closing the layer shuts it down, waiting up to 3 seconds for events still on
 * their way. Requests go through `FetchHttpClient.Fetch`.
 */
export const layer = Layer.effect(
  PostHogClient,
  Effect.gen(function* () {
    const fetch = yield* FetchHttpClient.Fetch;
    const created = yield* Ref.make(Option.none<PostHog>());
    const client = yield* Effect.cached(
      Effect.sync(() => {
        const posthog: PostHog = new PostHog(token, {
          host,
          fetch,
          requestTimeout: 3000,
          fetchRetryCount: 0,
          flushInterval: 0,
          disableGeoip: true,
          isServer: false,
          enableLocalEvaluation: false,
          enableExceptionAutocapture: false,
          privacyMode: true,
          // Runs for every event the SDK sends, ours or its own.
          before_send: (message: EventMessage | null) =>
            message === null || posthog.optedOut
              ? null
              : {
                  ...message,
                  properties: Object.fromEntries(
                    Object.entries(message.properties ?? {}).filter(([key]) =>
                      propertyKeys.has(key),
                    ),
                  ),
                },
        });
        return posthog;
      }).pipe(Effect.tap((posthog) => Ref.set(created, Option.some(posthog)))),
    );

    /** Runs `use` with the SDK client, if the first event created it. */
    const ifCreated = (use: (posthog: PostHog) => Effect.Effect<void, PostHogError>) =>
      Ref.get(created).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: use })),
      );

    yield* Effect.addFinalizer(() =>
      ifCreated((posthog) => sdk(() => posthog.shutdown(shutdownTimeoutMs))).pipe(
        // A failed shutdown is a bug in the SDK: report it with the rest of the cleanup.
        Effect.orDie,
      ),
    );

    const capture = Effect.fn('PostHogClient.capture')(function* (message: CaptureMessage) {
      const posthog = yield* client;
      yield* sdk(() => posthog.captureImmediate(message));
    });

    const optOut = ifCreated((posthog) => sdk(() => posthog.optOut())).pipe(
      Effect.withSpan('PostHogClient.optOut'),
    );

    return PostHogClient.of({ capture, optOut });
  }),
);
