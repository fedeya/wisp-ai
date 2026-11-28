// @effect-migrated
import {
  Clock,
  Context,
  DateTime,
  Effect,
  FiberSet,
  FileSystem,
  Option,
  Path,
  Ref,
  Schema,
} from 'effect';
import { publicToolName, toolDescriptions } from '@wisp/protocol/capabilities';
import { providerId } from '@wisp/protocol/providers';
import * as Everloot from '@wisp/agent/everloot';
import { PRESENT_UI_TOOL, SKIP_TIP_TOOL } from '@wisp/agent/contract/reply-presentation';
import { AppConfig } from '#/platform/config';
import { AppVersion } from '#/platform/app-version';
import { modelFailureKinds } from '../models/model-failures.ts';
import { PostHogClient } from './posthog.ts';
import type { Properties } from './posthog.ts';

/** Public names of the built-in tools; any other tool is reported as `external_tool`. */
const builtinTools = new Map(
  Object.keys(toolDescriptions).map((name) => [publicToolName(name), name]),
);
builtinTools.set(PRESENT_UI_TOOL, 'present_ui');
builtinTools.set(SKIP_TIP_TOOL, 'skip_tip');
for (const slot of ['character', 'preferences']) {
  builtinTools.set(slot + '__save_memory', 'memory');
  builtinTools.set(slot + '__remove_memory', 'memory');
}
for (const { namespace, allow } of Everloot.profile.toolGroups) {
  for (const tool of allow) builtinTools.set(namespace + '__' + tool, Everloot.name);
}

/** `telemetry.json`, which the native Settings switch writes. */
const Preferences = Schema.Struct({
  enabled: Schema.Boolean,
  installationId: Schema.String.check(Schema.isUUID()),
});
const decodePreferences = Schema.decodeEffect(Schema.fromJsonString(Preferences));
/** Like Node's `readFile(file, 'utf8')`: a byte order mark stays, so the file does not parse. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

const isVersion = Schema.is(
  Schema.String.check(
    Schema.isPattern(/^\d+\.\d+\.\d+(?:-nightly\.\d+\.\d+)?$/),
    Schema.isMaxLength(80),
  ),
);

const ChatErrorCode = Schema.Literals([
  'capability_sync_failed',
  'engine_not_ready',
  'account_busy',
  'no_provider',
  'model_preparation_failed',
  'model_auth_failed',
  'model_catalog_failed',
  'turn_start_failed',
  'turn_stream_failed',
  'turn_result_failed',
  'usage_limit',
  'timeout',
  'unknown',
]);
/** Why a turn failed, as a fixed code. */
export type ChatErrorCode = typeof ChatErrorCode.Type;
const isChatErrorCode = Schema.is(ChatErrorCode);
export type ChatOutcome = 'completed' | 'failed' | 'cancelled' | 'needs_input' | 'timeout';
export type ChatMode = 'chat' | 'hover' | 'routine' | 'tip';
// Provider ids are a fixed list; 'chatgpt' is the subscription sign-in. Never model ids or endpoints.
const decodeModelProvider = Schema.decodeUnknownOption(
  Schema.Union([providerId, Schema.Literal('chatgpt')]),
);
const isFailureKind = Schema.is(Schema.Literals(modelFailureKinds));

/** The model usage one turn reported. Counts only. */
export interface TurnUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}
const noUsage: TurnUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

/** A finished turn. Anything outside the fixed codes and providers is dropped or generalized. */
export interface ChatTelemetry {
  readonly mode: ChatMode;
  readonly outcome: ChatOutcome;
  /** How long the turn took, in milliseconds. */
  readonly duration: number;
  /** Why the turn failed; recorded for failed and timed-out turns only. */
  readonly errorCode?: ChatErrorCode | undefined;
  readonly firstTextMs?: number | undefined;
  readonly usage?: TurnUsage | undefined;
  /** Who answered the model, such as `anthropic` or `chatgpt`. */
  readonly provider?: string | undefined;
  /** Why the turn's model requests failed, as a `ModelFailureKind`. */
  readonly failureKind?: string | undefined;
}

const WebSearchDepth = Schema.Literals(['quick', 'standard', 'deep']);
const WebSearchProvider = Schema.Literals(['chatgpt', 'exa', 'none']);
const WebSearchOutcome = Schema.Literals(['available', 'unverified', 'unavailable', 'failed']);
const isWebSearchDepth = Schema.is(WebSearchDepth);
const isWebSearchProvider = Schema.is(WebSearchProvider);
const isWebSearchOutcome = Schema.is(WebSearchOutcome);

/** A finished web search: its budget, provider and outcome, never its query or sources. */
export interface WebSearchTelemetry {
  readonly depth: string;
  readonly provider: string | undefined;
  readonly outcome: string;
  readonly duration: number;
  readonly resultCount: number;
}

const TokenCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100_000_000),
);
const decodeModelUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal('usage.recorded'),
    data: Schema.Struct({
      kind: Schema.Literal('model'),
      usage: Schema.Struct({
        inputTokens: TokenCount,
        outputTokens: TokenCount,
        cacheReadTokens: Schema.optional(TokenCount),
      }),
    }),
  }),
);
const decodeToolEvent = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, data: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeCapability = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, kind: Schema.optional(Schema.String) }),
);

/** Sums the model usage the agent reports during one turn. */
export interface UsageObserver {
  readonly observe: (event: unknown) => Effect.Effect<void>;
  readonly usage: Effect.Effect<TurnUsage>;
}

/** Times the tool calls the agent reports during one turn. */
export interface ToolObserver {
  readonly observe: (event: unknown) => Effect.Effect<void>;
}

type GameConnectionError = 'session_replaced' | 'engine_not_ready' | 'addon_ack_missing';
const gameConnectionTimeoutMs = 30_000;
/** Events sent at once; more are dropped. */
const maxPending = 32;
/** Tool calls one turn times at once; more go untimed. */
const maxToolCalls = 256;

/**
 * Anonymous usage counts sent to PostHog in release builds while the player's
 * `telemetry.json` allows it. Every outbound field is built here: no prompts,
 * tool inputs or outputs, labels, model or connection ids, character data or
 * free-form errors. Recording never fails and never waits for the network.
 */
export class UsageTelemetry extends Context.Service<
  UsageTelemetry,
  {
    readonly chat: (turn: ChatTelemetry) => Effect.Effect<void>;
    readonly webSearch: (search: WebSearchTelemetry) => Effect.Effect<void>;
    /** The addon reported its version: recorded once a day for each version. */
    readonly game: (addonVersion: string) => Effect.Effect<void>;
    /** A game window took over the connection; the attempt before it, if open, failed. */
    readonly gameConnectionStarted: Effect.Effect<void>;
    /**
     * Ends the open connection attempt once the game is connected, or as a
     * timeout 30 seconds after it started.
     */
    readonly gameConnectionProgress: (progress: {
      readonly connected: boolean;
      readonly hasReadySnapshot: boolean;
    }) => Effect.Effect<void>;
    readonly usageObserver: Effect.Effect<UsageObserver>;
    /**
     * Records each tool call that settles, by its built-in name or as
     * `skill` or `external_tool`. Tools of the connections that
     * `isCustomMcpConnection` names stay `external_tool`, since a custom MCP
     * tool can share a name with a built-in one.
     */
    readonly toolObserver: (
      isCustomMcpConnection: (connection: string) => boolean,
    ) => Effect.Effect<ToolObserver>;
    /** The feature flags that are on, attached to every event. */
    readonly setFeatures: (names: readonly string[]) => Effect.Effect<void>;
  }
>()('@wisp/server/telemetry/UsageTelemetry') {}

/** The service on `PostHogClient`; its scope drains the events on their way when it closes. */
export const make = Effect.gen(function* () {
  const config = yield* AppConfig;
  const { version } = yield* AppVersion;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* PostHogClient;
  const release = config.telemetryRelease;
  const preferencesFile = path.join(config.paths.dataRoot, 'telemetry.json');
  const common = {
    surface: 'desktop',
    app_version: isVersion(version) ? version : 'unknown',
    channel: version.includes('-nightly.') ? 'nightly' : 'stable',
    os:
      process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'macos'
          : process.platform,
    arch: process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch,
    $process_person_profile: false,
    $geoip_disable: true,
  };

  const closed = yield* Ref.make(false);
  const activeDay = yield* Ref.make('');
  const addonDay = yield* Ref.make('');
  const gameConnectionStartedAt = yield* Ref.make(Option.none<number>());
  // Flag names come from the built-in registry, never from user input.
  const features = yield* Ref.make<readonly string[]>([]);
  const pending = yield* FiberSet.make<void>();

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true);
      yield* client.optOut.pipe(Effect.orDie);
      yield* FiberSet.awaitEmpty(pending);
    }),
  );

  const today = Effect.map(DateTime.now, DateTime.formatIsoDateUtc);
  const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1e6);

  const readPreferences = fs
    .readFile(preferencesFile)
    .pipe(Effect.flatMap((bytes) => decodePreferences(utf8.decode(bytes))));

  // Missing or unreadable preferences fail closed: the event is dropped.
  const send = Effect.fnUntraced(function* (event: string, properties: Properties) {
    const preferences = yield* readPreferences;
    // Read at send time so the native Settings switch applies to the running bridge.
    if (!preferences.enabled || (yield* Ref.get(closed))) {
      yield* Ref.set(activeDay, '');
      yield* Ref.set(addonDay, '');
      return;
    }
    const enabled = (yield* Ref.get(features)).join(',');
    yield* client.capture({
      distinctId: preferences.installationId,
      event,
      properties: { ...common, ...(enabled ? { features: enabled } : {}), ...properties },
    });
  });

  const record = Effect.fnUntraced(function* (event: string, properties: Properties = {}) {
    if (!release || (yield* Ref.get(closed)) || (yield* FiberSet.size(pending)) >= maxPending) {
      return;
    }
    // Whatever fails, defects included, only drops the event.
    yield* FiberSet.run(pending, send(event, properties).pipe(Effect.ignoreCause));
  });

  const active = Effect.gen(function* () {
    const day = yield* today;
    if (yield* Ref.modify(activeDay, (current) => [current !== day, day])) {
      yield* record('app_active');
    }
  });

  const chat = Effect.fn('UsageTelemetry.chat')(function* (turn: ChatTelemetry) {
    yield* active;
    const failureCode =
      turn.outcome === 'timeout'
        ? 'timeout'
        : turn.outcome === 'failed'
          ? isChatErrorCode(turn.errorCode)
            ? turn.errorCode
            : 'unknown'
          : undefined;
    const provider = Option.getOrUndefined(decodeModelProvider(turn.provider));
    const failureKind =
      failureCode && isFailureKind(turn.failureKind) ? turn.failureKind : undefined;
    const usage = turn.usage;
    yield* record('chat_completed', {
      mode: turn.mode,
      outcome: turn.outcome,
      ...(provider ? { model_provider: provider } : {}),
      ...(failureKind ? { failure_kind: failureKind } : {}),
      duration_ms: Math.max(0, Math.round(turn.duration)),
      ...(turn.firstTextMs === undefined ? {} : { first_text_ms: turn.firstTextMs }),
      ...(failureCode ? { error_code: failureCode } : {}),
      ...(usage?.modelCalls
        ? {
            model_calls: usage.modelCalls,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_tokens: usage.cacheReadTokens,
          }
        : {}),
    });
  });

  // Only fixed enums and counts: never queries, URLs, sources or provider errors.
  const webSearch = Effect.fn('UsageTelemetry.webSearch')(function* (search: WebSearchTelemetry) {
    const provider = search.provider?.toLowerCase();
    yield* record('web_search_finished', {
      depth: isWebSearchDepth(search.depth) ? search.depth : 'standard',
      provider: isWebSearchProvider(provider) ? provider : 'none',
      outcome: isWebSearchOutcome(search.outcome) ? search.outcome : 'unavailable',
      duration_ms: Math.max(0, Math.round(search.duration)),
      result_count: Number.isFinite(search.resultCount)
        ? Math.max(0, Math.min(50, search.resultCount))
        : 0,
    });
  });

  const game = Effect.fn('UsageTelemetry.game')(function* (addonVersion: string) {
    const reported = isVersion(addonVersion) ? addonVersion : 'unknown';
    const day = (yield* today) + ':' + reported;
    if (!(yield* Ref.modify(addonDay, (current) => [current !== day, day]))) {
      return;
    }
    yield* active;
    yield* record('game_connected', { addon_version: reported });
  });

  const finishGameConnection = Effect.fnUntraced(function* (
    now: number,
    error?: GameConnectionError,
  ) {
    const started = yield* Ref.getAndSet(gameConnectionStartedAt, Option.none());
    if (Option.isNone(started)) {
      return;
    }
    yield* record('game_connection_finished', {
      outcome: error === 'session_replaced' ? 'failed' : error ? 'timeout' : 'connected',
      duration_ms: Math.round(now - started.value),
      ...(error ? { error_code: error } : {}),
    });
  });

  const gameConnectionStarted = Effect.gen(function* () {
    if (!release || (yield* Ref.get(closed))) {
      return;
    }
    const now = yield* monotonicMillis;
    yield* finishGameConnection(now, 'session_replaced');
    yield* Ref.set(gameConnectionStartedAt, Option.some(now));
  }).pipe(Effect.withSpan('UsageTelemetry.gameConnectionStarted'));

  const gameConnectionProgress = Effect.fn('UsageTelemetry.gameConnectionProgress')(function* ({
    connected,
    hasReadySnapshot,
  }: {
    readonly connected: boolean;
    readonly hasReadySnapshot: boolean;
  }) {
    const started = yield* Ref.get(gameConnectionStartedAt);
    if (Option.isNone(started)) {
      return;
    }
    const now = yield* monotonicMillis;
    if (connected) {
      yield* finishGameConnection(now);
    } else if (now - started.value >= gameConnectionTimeoutMs) {
      yield* finishGameConnection(now, hasReadySnapshot ? 'addon_ack_missing' : 'engine_not_ready');
    }
  });

  const usageObserver = Effect.gen(function* () {
    const usage = yield* Ref.make(noUsage);
    return {
      observe: (event: unknown) =>
        Option.match(decodeModelUsage(event), {
          onNone: () => Effect.void,
          onSome: ({ data: { usage: reported } }) =>
            Ref.update(usage, (total) => ({
              modelCalls: total.modelCalls + 1,
              inputTokens: total.inputTokens + reported.inputTokens,
              outputTokens: total.outputTokens + reported.outputTokens,
              cacheReadTokens: total.cacheReadTokens + (reported.cacheReadTokens ?? 0),
            })),
        }),
      usage: Ref.get(usage),
    } satisfies UsageObserver;
  }).pipe(Effect.withSpan('UsageTelemetry.usageObserver'));

  const toolObserver = Effect.fn('UsageTelemetry.toolObserver')(function* (
    isCustomMcpConnection: (connection: string) => boolean,
  ) {
    const calls = yield* Ref.make<ReadonlyMap<string, { name: string; started: number }>>(
      new Map(),
    );
    const requested = Effect.fnUntraced(function* (callId: string, raw: unknown) {
      const capability = decodeCapability(raw);
      if (Option.isNone(capability) || capability.value.kind === 'control') {
        return;
      }
      const { name, kind } = capability.value;
      const safeName =
        kind === 'skill'
          ? 'skill'
          : isCustomMcpConnection(name.split('__', 1)[0] ?? '')
            ? 'external_tool'
            : (builtinTools.get(name) ?? 'external_tool');
      const started = yield* monotonicMillis;
      yield* Ref.update(calls, (current) =>
        current.size < maxToolCalls && !current.has(callId)
          ? new Map(current).set(callId, { name: safeName, started })
          : current,
      );
    });
    const settled = Effect.fnUntraced(function* (callId: string, outcome: unknown) {
      const call = yield* Ref.modify(calls, (current) => {
        const found = current.get(callId);
        if (!found) {
          return [undefined, current];
        }
        const rest = new Map(current);
        rest.delete(callId);
        return [found, rest];
      });
      if (!call) {
        return;
      }
      const now = yield* monotonicMillis;
      yield* record('tool_executed', {
        tool: call.name,
        outcome:
          outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed',
        duration_ms: Math.round(now - call.started),
      });
    });
    return {
      observe: (raw: unknown) =>
        Option.match(decodeToolEvent(raw), {
          onNone: () => Effect.void,
          onSome: ({ type, data }) => {
            const callId = data['callId'];
            if (typeof callId !== 'string') {
              return Effect.void;
            }
            if (type === 'call.requested') {
              return requested(callId, data['capability']);
            }
            return type === 'call.settled' ? settled(callId, data['outcome']) : Effect.void;
          },
        }),
    } satisfies ToolObserver;
  });

  const setFeatures = Effect.fn('UsageTelemetry.setFeatures')(function* (names: readonly string[]) {
    yield* Ref.set(features, names);
  });

  return UsageTelemetry.of({
    chat,
    webSearch,
    game,
    gameConnectionStarted,
    gameConnectionProgress,
    usageObserver,
    toolObserver,
    setFeatures,
  });
});
