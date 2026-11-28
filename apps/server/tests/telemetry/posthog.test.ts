import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Queue, Schema, Scope } from 'effect';
import { FetchHttpClient } from 'effect/http';
import * as PostHog from '../../src/telemetry/posthog.ts';

/** What one request to PostHog carried. */
const Batch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(
      Schema.Struct({
        event: Schema.String,
        distinct_id: Schema.String,
        properties: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

/** The text of a request body, gunzipped when the SDK compressed it. */
const bodyText = (body: BodyInit | null | undefined) =>
  Effect.tryPromise(async () => {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const stream = new Response(bytes).body;
    return gzipped && stream
      ? new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(bytes);
  });

/** Answers every request PostHog makes and keeps its body, so nothing reaches the network. */
const recordRequests = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<BodyInit | null | undefined>();
  const fetch: typeof globalThis.fetch = (_input, init) => {
    Queue.offerUnsafe(requests, init?.body);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  return { requests, fetch };
});

/** The client on a scope the test closes, with requests answered by `fetch`. */
const openClient = (fetch: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(PostHog.layer, scope).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    return { client: Context.get(context, PostHog.PostHogClient), scope };
  });

const message: PostHog.CaptureMessage = {
  distinctId: '6f1c9a52-3b0e-4d8f-9a17-2c5e8b4d7f30',
  event: 'chat_completed',
  properties: { surface: 'desktop', mode: 'chat', duration_ms: 12, private_label: 'PRIVATE' },
};

describe('PostHogClient', () => {
  it.effect('sends each event at once with only the listed properties', () =>
    Effect.gen(function* () {
      const { requests, fetch } = yield* recordRequests;
      const { client, scope } = yield* openClient(fetch);
      yield* client.capture(message);
      const [event, ...rest] = (yield* Schema.decodeEffect(Batch)(
        yield* bodyText(yield* Queue.take(requests)),
      )).batch;
      assert.deepStrictEqual(rest, []);
      assert.strictEqual(event?.event, 'chat_completed');
      assert.strictEqual(event?.distinct_id, message.distinctId);
      assert.deepStrictEqual(Object.keys(event?.properties ?? {}).sort(), [
        '$geoip_disable',
        '$lib',
        '$lib_version',
        'duration_ms',
        'mode',
        'surface',
      ]);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(yield* Queue.size(requests), 0);
    }),
  );

  it.effect('sends nothing once it opted out', () =>
    Effect.gen(function* () {
      const { requests, fetch } = yield* recordRequests;
      const { client, scope } = yield* openClient(fetch);
      yield* client.capture(message);
      yield* Queue.take(requests);
      yield* client.optOut;
      yield* client.capture(message);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(yield* Queue.size(requests), 0);
    }),
  );

  it.effect('a run that sends nothing never starts the SDK', () =>
    Effect.gen(function* () {
      const { requests, fetch } = yield* recordRequests;
      const { client, scope } = yield* openClient(fetch);
      yield* client.optOut;
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(yield* Queue.size(requests), 0);
    }),
  );
});
