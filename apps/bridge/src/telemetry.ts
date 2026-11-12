import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { PostHog } from 'posthog-node';
import path from 'node:path';
import { z } from 'zod';
import { publicToolName, toolDescriptions } from '@wisp/protocol/capabilities';
import { PRESENT_UI_TOOL, SKIP_TIP_TOOL } from '@wisp/protocol/reply-presentation';

const token = 'phc_se29yi8DLMmFxhRcqQrzrSs9vGLzAiEGmsaMvjotDdTE';
const host = 'https://us.i.posthog.com';
const propertyKeys = new Set([
  'surface',
  'app_version',
  'channel',
  'os',
  'arch',
  'mode',
  'outcome',
  'duration_ms',
  'error_code',
  'addon_version',
  'tool',
  '$process_person_profile',
  '$geoip_disable',
  '$lib',
  '$lib_version',
]);
const builtinTools = new Map(
  Object.keys(toolDescriptions).map((name) => [publicToolName(name), name]),
);
builtinTools.set(PRESENT_UI_TOOL, 'present_ui');
builtinTools.set(SKIP_TIP_TOOL, 'skip_tip');
const preferencesSchema = z.object({ enabled: z.boolean(), installationId: z.uuid() });
const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-nightly\.\d+\.\d+)?$/)
  .max(80);
export type ChatOutcome = 'completed' | 'failed' | 'cancelled' | 'needs_input' | 'timeout';
const chatErrorCodeSchema = z.enum([
  'capability_sync_failed',
  'engine_not_ready',
  'account_busy',
  'model_preparation_failed',
  'model_auth_failed',
  'model_catalog_failed',
  'turn_start_failed',
  'turn_stream_failed',
  'turn_result_failed',
  'timeout',
  'unknown',
]);
export type ChatErrorCode = z.infer<typeof chatErrorCodeSchema>;
type GameConnectionError = 'session_replaced' | 'engine_not_ready' | 'addon_ack_missing';
const gameConnectionTimeoutMs = 30_000;
type Properties = Record<string, string | number | boolean>;

// All outbound fields are constructed here. No prompts, tool inputs/outputs, labels,
// model/connection IDs, character data or free-form errors are accepted.
export class UsageTelemetry {
  private pending = new Set<Promise<void>>();
  private client?: PostHog;
  private activeDay = '';
  private addonDay = '';
  private gameConnectionStartedAt?: number;
  private closed = false;
  private dataRoot: string;
  private version: string;
  private release: boolean;
  constructor(
    dataRoot: string,
    version: string,
    release = process.env.WISP_TELEMETRY_RELEASE === '1',
  ) {
    this.dataRoot = dataRoot;
    this.version = version;
    this.release = release;
  }

  private record(event: string, properties: Properties = {}) {
    if (!this.release || this.closed || this.pending.size >= 32) {
      return;
    }
    const work = this.send(event, properties).catch(() => {});
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private async send(event: string, properties: Properties) {
    const preferences = preferencesSchema.parse(
      JSON.parse(await readFile(path.join(this.dataRoot, 'telemetry.json'), 'utf8')),
    );
    // Read at send time so the native Settings switch applies to the running bridge.
    if (!preferences.enabled || this.closed) {
      this.activeDay = '';
      this.addonDay = '';
      return;
    }
    this.client ??= new PostHog(token, {
      host,
      requestTimeout: 3000,
      fetchRetryCount: 0,
      flushInterval: 0,
      disableGeoip: true,
      isServer: false,
      enableLocalEvaluation: false,
      enableExceptionAutocapture: false,
      privacyMode: true,
      before_send: (message) => {
        try {
          const saved = preferencesSchema.parse(
            JSON.parse(readFileSync(path.join(this.dataRoot, 'telemetry.json'), 'utf8')),
          );
          if (this.closed || !saved.enabled) return null;
          // SDK context/enrichment must not add arbitrary properties to our events.
          message.properties = Object.fromEntries(
            Object.entries(message.properties ?? {}).filter(([key]) => propertyKeys.has(key)),
          );
          return message;
        } catch {
          return null;
        }
      },
    });
    await this.client.captureImmediate({
      distinctId: preferences.installationId,
      event,
      properties: {
        surface: 'desktop',
        app_version: versionSchema.safeParse(this.version).success ? this.version : 'unknown',
        channel: this.version.includes('-nightly.') ? 'nightly' : 'stable',
        os:
          process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : process.platform,
        arch:
          process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch,
        $process_person_profile: false,
        $geoip_disable: true,
        ...properties,
      },
    });
  }

  private active() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.activeDay !== day) {
      this.activeDay = day;
      this.record('app_active');
    }
  }

  chat(
    mode: 'chat' | 'hover' | 'routine' | 'tip',
    outcome: ChatOutcome,
    duration: number,
    errorCode?: ChatErrorCode,
  ) {
    this.active();
    const failureCode =
      outcome === 'timeout'
        ? 'timeout'
        : outcome === 'failed'
          ? (chatErrorCodeSchema.safeParse(errorCode).data ?? 'unknown')
          : undefined;
    this.record('chat_completed', {
      mode,
      outcome,
      duration_ms: Math.max(0, Math.round(duration)),
      ...(failureCode ? { error_code: failureCode } : {}),
    });
  }

  game(version: string) {
    const parsed = versionSchema.safeParse(version);
    const day =
      new Date().toISOString().slice(0, 10) + ':' + (parsed.success ? parsed.data : 'unknown');
    if (this.addonDay === day) {
      return;
    }
    this.addonDay = day;
    this.active();
    this.record('game_connected', { addon_version: parsed.success ? parsed.data : 'unknown' });
  }

  gameConnectionStarted() {
    if (!this.release || this.closed) return;
    const now = performance.now();
    this.finishGameConnection(now, 'session_replaced');
    this.gameConnectionStartedAt = now;
  }

  gameConnectionProgress(connected: boolean, hasReadySnapshot: boolean) {
    const started = this.gameConnectionStartedAt;
    if (started === undefined) return;
    const now = performance.now();
    if (connected) {
      this.finishGameConnection(now);
    } else if (now - started >= gameConnectionTimeoutMs) {
      this.finishGameConnection(now, hasReadySnapshot ? 'addon_ack_missing' : 'engine_not_ready');
    }
  }

  private finishGameConnection(now: number, error?: GameConnectionError) {
    const started = this.gameConnectionStartedAt;
    if (started === undefined) return;
    this.gameConnectionStartedAt = undefined;
    this.record('game_connection_finished', {
      outcome: error === 'session_replaced' ? 'failed' : error ? 'timeout' : 'connected',
      duration_ms: Math.round(now - started),
      ...(error ? { error_code: error } : {}),
    });
  }

  toolObserver() {
    const calls = new Map<string, { name: string; started: number }>();
    return (raw: unknown) => {
      const event = z
        .object({ type: z.string(), data: z.record(z.string(), z.unknown()) })
        .safeParse(raw);
      if (!event.success) {
        return;
      }
      const { type, data } = event.data;
      if (typeof data.callId !== 'string') {
        return;
      }
      if (type === 'call.requested') {
        const capability = z
          .object({ name: z.string(), kind: z.string().optional() })
          .safeParse(data.capability);
        if (!capability.success || capability.data.kind === 'control') {
          return;
        }
        const name = capability.data.name;
        // Custom MCP names can contain personal information. Only report their category.
        const safeName = builtinTools.get(name) ?? 'external_tool';
        if (calls.size < 256 && !calls.has(data.callId)) {
          calls.set(data.callId, { name: safeName, started: performance.now() });
        }
      } else if (type === 'call.settled') {
        const call = calls.get(data.callId);
        if (!call) {
          return;
        }
        calls.delete(data.callId);
        const outcome =
          data.outcome === 'completed'
            ? 'completed'
            : data.outcome === 'cancelled'
              ? 'cancelled'
              : 'failed';
        this.record('tool_executed', {
          tool: call.name,
          outcome,
          duration_ms: Math.round(performance.now() - call.started),
        });
      }
    };
  }

  async drain() {
    await Promise.allSettled(this.pending);
  }

  async close() {
    this.closed = true;
    await this.client?.optOut();
    await this.drain();
    await this.client?.shutdown(3000);
  }
}
