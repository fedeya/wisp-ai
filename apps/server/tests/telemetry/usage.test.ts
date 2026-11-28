import { assert, describe, expect, it } from '@effect/vitest';
import * as NodePath from '@effect/platform-node/NodePath';
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
} from 'effect';
import * as PlatformError from 'effect/PlatformError';
import { TestClock } from 'effect/testing';
import * as AppConfig from '#/platform/config';
import { AppVersion } from '#/platform/app-version';
import { Features } from '#/features';
import { PostHogClient, PostHogError } from '../../src/telemetry/posthog.ts';
import type { CaptureMessage, Properties } from '../../src/telemetry/posthog.ts';
import { make, UsageTelemetry } from '../../src/telemetry/usage.ts';

const installationId = '6f1c9a52-3b0e-4d8f-9a17-2c5e8b4d7f30';
/** How events name the machine running the tests. */
const hostOs =
  process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform;
const hostArch =
  process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;

/**
 * What the telemetry below reads and sends: `telemetry.json` comes from
 * `preferences` (none is a missing file), and PostHog records the events
 * instead of sending them.
 */
class Harness extends Context.Service<
  Harness,
  {
    readonly preferences: Ref.Ref<Option.Option<string>>;
    readonly reads: Ref.Ref<number>;
    readonly sent: Ref.Ref<readonly CaptureMessage[]>;
    /** `optOut` and each event PostHog accepted, in order. */
    readonly calls: Ref.Ref<readonly string[]>;
    /** Captures wait for this while it is set, as a slow network would make them. */
    readonly hold: Ref.Ref<Option.Option<Deferred.Deferred<void>>>;
    /** The next capture fails, as an offline network would make it. */
    readonly failNext: Ref.Ref<boolean>;
    readonly optedOut: Deferred.Deferred<void>;
    /** The flags `Features` reports as on. */
    readonly features: Ref.Ref<readonly string[]>;
  }
>()('@wisp/server/tests/telemetry/Harness') {}

const harness = Layer.effectContext(
  Effect.gen(function* () {
    const preferences = yield* Ref.make(Option.none<string>());
    const reads = yield* Ref.make(0);
    const sent = yield* Ref.make<readonly CaptureMessage[]>([]);
    const calls = yield* Ref.make<readonly string[]>([]);
    const hold = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
    const failNext = yield* Ref.make(false);
    const optedOut = yield* Deferred.make<void>();
    const features = yield* Ref.make<readonly string[]>([]);
    const fs = FileSystem.makeNoop({
      readFile: (file) =>
        Effect.gen(function* () {
          yield* Ref.update(reads, (count) => count + 1);
          const text = yield* Ref.get(preferences);
          if (Option.isNone(text)) {
            return yield* PlatformError.systemError({
              _tag: 'NotFound',
              module: 'FileSystem',
              method: 'readFile',
              pathOrDescriptor: file,
            });
          }
          return new TextEncoder().encode(text.value);
        }),
    });
    const client = PostHogClient.of({
      capture: (message) =>
        Effect.gen(function* () {
          const held = yield* Ref.get(hold);
          if (Option.isSome(held)) {
            yield* Deferred.await(held.value);
          }
          if (yield* Ref.getAndSet(failNext, false)) {
            return yield* new PostHogError({ cause: Error('offline') });
          }
          yield* Ref.update(sent, (all) => [...all, message]);
          yield* Ref.update(calls, (all) => [...all, message.event]);
        }),
      optOut: Effect.gen(function* () {
        yield* Ref.update(calls, (all) => [...all, 'optOut']);
        yield* Deferred.succeed(optedOut, undefined);
      }),
    });
    return Context.make(Harness, {
      preferences,
      reads,
      sent,
      calls,
      hold,
      failNext,
      optedOut,
      features,
    }).pipe(Context.add(FileSystem.FileSystem, fs), Context.add(PostHogClient, client));
  }),
);

/** Features with only the flag names the harness says are on. */
const features = Layer.unwrap(
  Effect.gen(function* () {
    const h = yield* Harness;
    return Layer.mock(Features, {
      channel: 'development',
      changes: Stream.empty,
      enabledNames: Ref.get(h.features),
    });
  }),
);

/** The harness, with `version` as the running Wisp and release reporting on unless `release` is false. */
const environment = ({ version = '0.1.0', release = true } = {}) => {
  const app = Layer.merge(
    Layer.succeed(AppVersion, AppVersion.of({ version })),
    AppConfig.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: { WISP_DATA_DIR: '/wisp', ...(release ? { WISP_TELEMETRY_RELEASE: '1' } : {}) },
          }),
        ),
      ),
    ),
  );
  return Layer.mergeAll(NodePath.layer, app, features.pipe(Layer.provideMerge(harness)));
};

const telemetryLayer = Layer.effect(UsageTelemetry, make);

/** Runs `use` with a new telemetry, closed when `use` ends, which waits for the events on their way. */
const withTelemetry = <A, E, R>(
  use: (telemetry: UsageTelemetry['Service']) => Effect.Effect<A, E, R>,
) => Effect.flatMap(UsageTelemetry, use).pipe(Effect.provide(telemetryLayer));

const savePreferences = (enabled: boolean, id = installationId) =>
  Effect.flatMap(Harness, (h) =>
    Ref.set(
      h.preferences,
      Option.some(JSON.stringify({ enabled, installationId: id, firstOpenSent: true })),
    ),
  );

const sent = Effect.flatMap(Harness, (h) => Ref.get(h.sent));
const sentNamed = (event: string) =>
  Effect.map(sent, (all) => all.filter((message) => message.event === event));
const propertiesOf = (event: string) =>
  Effect.map(sentNamed(event), (all) =>
    // Partial, so a test can expect a property to be missing.
    all.map((message): Partial<Properties> => message.properties),
  );

describe('UsageTelemetry', () => {
  it.effect('development runs never read preferences or send', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
          yield* telemetry.gameConnectionStarted;
          yield* telemetry.gameConnectionProgress({ connected: true, hasReadySnapshot: true });
        }),
      );
      assert.strictEqual(yield* Effect.flatMap(Harness, (h) => Ref.get(h.reads)), 0);
      assert.deepStrictEqual(yield* sent, []);
    }).pipe(Effect.provide(environment({ release: false }))),
  );

  it.effect('missing, corrupt and invalid preferences fail closed', () =>
    Effect.gen(function* () {
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
          for (const text of [
            '{broken',
            // Like Node's readFile, a byte order mark is kept, so JSON.parse rejects the file.
            '﻿' + JSON.stringify({ enabled: true, installationId }),
            JSON.stringify({ enabled: true, installationId: 'not-a-uuid' }),
            JSON.stringify({ enabled: 'yes', installationId }),
          ]) {
            yield* Effect.flatMap(Harness, (h) => Ref.set(h.preferences, Option.some(text)));
            yield* telemetry.webSearch({
              depth: 'quick',
              provider: 'Exa',
              outcome: 'available',
              duration: 1,
              resultCount: 1,
            });
          }
        }),
      );
      assert.isAbove(yield* Effect.flatMap(Harness, (h) => Ref.get(h.reads)), 0);
      assert.deepStrictEqual(yield* sent, []);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('the live native opt-out stops new events without restarting the bridge', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({
            mode: 'hover',
            outcome: 'completed',
            duration: 120.8,
            firstTextMs: 0,
          });
          const [event] = yield* sentNamed('chat_completed');
          assert.strictEqual(event?.distinctId, installationId);
          expect(event?.properties).toEqual({
            surface: 'desktop',
            app_version: '0.1.1-nightly.53.1',
            channel: 'nightly',
            os: hostOs,
            arch: hostArch,
            $process_person_profile: false,
            $geoip_disable: true,
            mode: 'hover',
            outcome: 'completed',
            duration_ms: 121,
            first_text_ms: 0,
          });
          yield* savePreferences(false);
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
          assert.strictEqual((yield* sent).length, 2);
          yield* savePreferences(true);
          yield* telemetry.chat({ mode: 'routine', outcome: 'completed', duration: 10 });
        }),
      );
      // The opt-out also forgot today's app_active, so turning it back on sends it again.
      assert.deepStrictEqual(
        (yield* sent).map((message) => message.event),
        ['app_active', 'chat_completed', 'app_active', 'chat_completed'],
      );
      const properties = (yield* propertiesOf('chat_completed')).at(-1);
      assert.strictEqual(properties?.['mode'], 'routine');
      assert.notProperty(properties, 'first_text_ms');
    }).pipe(Effect.provide(environment({ version: '0.1.1-nightly.53.1' }))),
  );

  it.effect('app_active is sent once a day', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
          yield* TestClock.adjust('1 day');
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
        }),
      );
      assert.strictEqual((yield* sentNamed('app_active')).length, 2);
      assert.strictEqual((yield* sentNamed('chat_completed')).length, 3);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('the flags that are on go with every event', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
          yield* Effect.flatMap(Harness, (h) => Ref.set(h.features, ['new_panel', 'tips']));
          yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 20 });
        }),
      );
      const features = (yield* propertiesOf('chat_completed')).map(
        (properties) => properties['features'],
      );
      assert.deepStrictEqual(features, [undefined, 'new_panel,tips']);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('chat telemetry sums model token usage for the turn and ignores other events', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          const turn = yield* telemetry.usageObserver;
          yield* turn.observe({
            type: 'usage.recorded',
            data: {
              kind: 'model',
              usage: { inputTokens: 12_000, outputTokens: 300, cacheReadTokens: 9000 },
            },
          });
          yield* turn.observe({
            type: 'usage.recorded',
            data: { kind: 'model', usage: { inputTokens: 15_000, outputTokens: 450 } },
          });
          yield* turn.observe({
            type: 'usage.recorded',
            data: { kind: 'tool', usage: { inputTokens: 5 } },
          });
          yield* turn.observe({
            type: 'usage.recorded',
            data: { kind: 'model', usage: { inputTokens: -1, outputTokens: 'PRIVATE' } },
          });
          yield* turn.observe({ type: 'call.settled', data: { callId: 'a' } });
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'completed',
            duration: 10,
            usage: yield* turn.usage,
          });
          const empty = yield* telemetry.usageObserver;
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'failed',
            duration: 5,
            errorCode: 'engine_not_ready',
            usage: yield* empty.usage,
          });
        }),
      );
      const chats = yield* propertiesOf('chat_completed');
      const used = chats.find((properties) => properties['outcome'] === 'completed');
      const failed = chats.find((properties) => properties['outcome'] === 'failed');
      expect(used).toMatchObject({
        model_calls: 2,
        input_tokens: 27_000,
        output_tokens: 750,
        cache_read_tokens: 9000,
      });
      assert.notProperty(failed, 'model_calls');
      assert.notProperty(failed, 'input_tokens');
    }).pipe(Effect.provide(environment())),
  );

  it.effect('tool telemetry counts public categories and drops private call data', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          const tools = yield* telemetry.toolObserver(() => false);
          const calls = [
            { kind: 'tool', name: 'wow__query_character' },
            { kind: 'tool', name: 'my-private-server__Alice-email' },
            { kind: 'skill', name: 'PRIVATE-SKILL' },
            { kind: 'tool', name: 'character__save_memory' },
            { kind: 'tool', name: 'preferences__remove_memory' },
            { kind: 'tool', name: 'everloot__item_page' },
            { kind: 'tool', name: 'everloot-search__search_knowledge' },
            { kind: 'tool', name: 'everloot-changes__recent_changes' },
            { kind: 'tool', name: 'everloot-private__PRIVATE-TOOL' },
            { kind: 'control', name: 'PRIVATE-CONTROL' },
          ];
          for (const [index, capability] of calls.entries()) {
            const callId = String(index);
            yield* tools.observe({
              type: 'call.requested',
              data: {
                callId,
                capability: { ...capability, label: 'PRIVATE LABEL' },
                input: 'PRIVATE PROMPT',
              },
            });
            yield* TestClock.adjust(index * 10);
            yield* tools.observe({
              type: 'call.settled',
              data: { callId, outcome: 'completed', output: 'PRIVATE OUTPUT' },
            });
            yield* tools.observe({ type: 'call.settled', data: { callId, outcome: 'completed' } });
          }
        }),
      );
      const events = yield* sentNamed('tool_executed');
      assert.deepStrictEqual(
        events.map((event) => String(event.properties['tool'])).sort((a, b) => a.localeCompare(b)),
        [
          'everloot',
          'everloot',
          'everloot',
          'external_tool',
          'external_tool',
          'memory',
          'memory',
          'query_character',
          'skill',
        ],
      );
      assert.deepStrictEqual(
        events.map((event) => event.properties['duration_ms']),
        [0, 10, 20, 30, 40, 50, 60, 70, 80],
      );
      expect(JSON.stringify(yield* sent)).not.toMatch(/PRIVATE|Alice|my-private|callId/);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('custom MCP connections keep their tools generic when public names overlap', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          const tools = yield* telemetry.toolObserver((connection) => connection === 'character');
          yield* tools.observe({
            type: 'call.requested',
            data: { callId: 'call', capability: { kind: 'tool', name: 'character__save_memory' } },
          });
          yield* tools.observe({
            type: 'call.settled',
            data: { callId: 'call', outcome: 'cancelled' },
          });
        }),
      );
      expect(yield* propertiesOf('tool_executed')).toEqual([
        expect.objectContaining({ tool: 'external_tool', outcome: 'cancelled' }),
      ]);
      expect(JSON.stringify(yield* sent)).not.toContain('save_memory');
    }).pipe(Effect.provide(environment())),
  );

  it.effect('chat telemetry only sends allowlisted failure codes', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'failed',
            duration: 10,
            errorCode: 'model_auth_failed',
          });
          // A failure without a code is reported as unknown.
          yield* telemetry.chat({ mode: 'hover', outcome: 'failed', duration: 20 });
          yield* telemetry.chat({ mode: 'routine', outcome: 'timeout', duration: 30 });
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'completed',
            duration: 40,
            errorCode: 'turn_stream_failed',
          });
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'cancelled',
            duration: 50,
            errorCode: 'turn_stream_failed',
          });
          yield* telemetry.chat({ mode: 'chat', outcome: 'needs_input', duration: 60 });
        }),
      );
      const chats = yield* propertiesOf('chat_completed');
      assert.deepStrictEqual(
        chats.map((properties) => properties['error_code']),
        ['model_auth_failed', 'unknown', 'timeout', undefined, undefined, undefined],
      );
    }).pipe(Effect.provide(environment())),
  );

  it.effect('web search telemetry sends only its budget, provider, outcome and counts', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.webSearch({
            depth: 'quick',
            provider: 'ChatGPT',
            outcome: 'available',
            duration: 20_924.4,
            resultCount: 3,
          });
          yield* telemetry.webSearch({
            depth: 'PRIVATE DEPTH',
            provider: 'PRIVATE PROVIDER',
            outcome: 'PRIVATE OUTCOME',
            duration: -5,
            resultCount: 500,
          });
          yield* telemetry.webSearch({
            depth: 'deep',
            provider: undefined,
            outcome: 'failed',
            duration: 7,
            resultCount: Number.NaN,
          });
        }),
      );
      const searches = (yield* propertiesOf('web_search_finished')).map(
        ({ depth, provider, outcome, duration_ms, result_count }) => ({
          depth,
          provider,
          outcome,
          duration_ms,
          result_count,
        }),
      );
      assert.deepStrictEqual(searches, [
        {
          depth: 'quick',
          provider: 'chatgpt',
          outcome: 'available',
          duration_ms: 20_924,
          result_count: 3,
        },
        {
          depth: 'standard',
          provider: 'none',
          outcome: 'unavailable',
          duration_ms: 0,
          result_count: 50,
        },
        { depth: 'deep', provider: 'none', outcome: 'failed', duration_ms: 7, result_count: 0 },
      ]);
      // A web search alone does not count as the app being active.
      assert.deepStrictEqual(yield* sentNamed('app_active'), []);
      expect(JSON.stringify(yield* sent)).not.toContain('PRIVATE');
    }).pipe(Effect.provide(environment())),
  );

  it.effect('addon polls are deduplicated and only valid versions are sent', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.game('0.1.0');
          yield* telemetry.game('0.1.0');
          yield* telemetry.game('a character name');
          yield* TestClock.adjust('1 day');
          yield* telemetry.game('0.1.0');
        }),
      );
      assert.deepStrictEqual(
        (yield* propertiesOf('game_connected')).map((properties) => properties['addon_version']),
        ['0.1.0', 'unknown', '0.1.0'],
      );
    }).pipe(Effect.provide(environment())),
  );

  it.effect('game handshakes record one stable outcome per observed session', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          const progress = (connected: boolean, hasReadySnapshot: boolean) =>
            telemetry.gameConnectionProgress({ connected, hasReadySnapshot });
          yield* progress(false, false);
          yield* telemetry.gameConnectionStarted;
          yield* TestClock.adjust(2000);
          yield* progress(true, true);
          yield* progress(true, true);

          yield* telemetry.gameConnectionStarted;
          yield* TestClock.adjust(29_999);
          yield* progress(false, false);
          yield* TestClock.adjust(1);
          yield* progress(false, false);
          yield* progress(true, true);

          yield* telemetry.gameConnectionStarted;
          yield* TestClock.adjust(30_000);
          yield* progress(false, true);

          yield* telemetry.gameConnectionStarted;
          yield* TestClock.adjust(1000);
          yield* telemetry.gameConnectionStarted;
        }),
      );
      const attempts = yield* propertiesOf('game_connection_finished');
      expect(attempts).toEqual([
        expect.objectContaining({
          channel: 'stable',
          app_version: '0.1.0',
          outcome: 'connected',
          duration_ms: 2000,
        }),
        expect.objectContaining({
          outcome: 'timeout',
          error_code: 'engine_not_ready',
          duration_ms: 30_000,
        }),
        expect.objectContaining({
          outcome: 'timeout',
          error_code: 'addon_ack_missing',
          duration_ms: 30_000,
        }),
        expect.objectContaining({
          outcome: 'failed',
          error_code: 'session_replaced',
          duration_ms: 1000,
        }),
      ]);
      assert.notProperty(attempts[0], 'error_code');
    }).pipe(Effect.provide(environment())),
  );

  it.effect('chat telemetry sends only listed providers and failure kinds', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'failed',
            duration: 10,
            errorCode: 'turn_result_failed',
            provider: 'google',
            failureKind: 'not_found',
          });
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'failed',
            duration: 20,
            errorCode: 'turn_result_failed',
            provider: 'connection:private-endpoint:private-model',
            failureKind: 'PRIVATE PROVIDER ERROR',
          });
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'completed',
            duration: 30,
            provider: 'chatgpt',
            failureKind: 'rate_limited',
          });
          yield* telemetry.chat({
            mode: 'chat',
            outcome: 'timeout',
            duration: 40,
            provider: 'compatible',
            failureKind: 'timeout',
          });
        }),
      );
      const chats = yield* propertiesOf('chat_completed');
      assert.deepStrictEqual(
        chats.map((properties) => [properties['model_provider'], properties['failure_kind']]),
        [
          ['google', 'not_found'],
          [undefined, undefined],
          ['chatgpt', undefined],
          ['compatible', 'timeout'],
        ],
      );
      expect(JSON.stringify(chats)).not.toMatch(/private|PRIVATE/);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('at most 32 events are on their way at once; more are dropped', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      const release = yield* Deferred.make<void>();
      yield* Effect.flatMap(Harness, (h) => Ref.set(h.hold, Option.some(release)));
      // The events still on their way when the telemetry closes are sent before it does.
      const started = yield* withTelemetry((telemetry) =>
        Effect.gen(function* () {
          for (let search = 0; search < 40; search++) {
            yield* telemetry.webSearch({
              depth: 'quick',
              provider: 'Exa',
              outcome: 'available',
              duration: search,
              resultCount: 1,
            });
          }
          const reads = yield* Effect.flatMap(Harness, (h) => Ref.get(h.reads));
          yield* Deferred.succeed(release, undefined);
          return reads;
        }),
      );
      assert.strictEqual(started, 32);
      assert.strictEqual((yield* sent).length, 32);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('network failures never reach the caller', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      yield* Effect.flatMap(Harness, (h) => Ref.set(h.failNext, true));
      yield* withTelemetry((telemetry) =>
        telemetry.webSearch({
          depth: 'quick',
          provider: 'Exa',
          outcome: 'available',
          duration: 1,
          resultCount: 1,
        }),
      );
      assert.deepStrictEqual(yield* sent, []);
    }).pipe(Effect.provide(environment())),
  );

  it.effect('shutdown opts out, waits for the events on their way, then records nothing', () =>
    Effect.gen(function* () {
      yield* savePreferences(true);
      const h = yield* Harness;
      const release = yield* Deferred.make<void>();
      yield* Ref.set(h.hold, Option.some(release));
      const scope = yield* Scope.make();
      const telemetry = yield* Layer.buildWithScope(telemetryLayer, scope).pipe(
        Effect.map(Context.get(UsageTelemetry)),
      );
      yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Deferred.await(h.optedOut);
      assert.deepStrictEqual(yield* Ref.get(h.calls), ['optOut']);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      assert.deepStrictEqual(yield* Ref.get(h.calls), ['optOut', 'app_active', 'chat_completed']);
      yield* Ref.set(h.hold, Option.none());
      yield* telemetry.chat({ mode: 'chat', outcome: 'completed', duration: 10 });
      yield* telemetry.gameConnectionStarted;
      assert.strictEqual((yield* sent).length, 2);
    }).pipe(Effect.provide(environment())),
  );
});
