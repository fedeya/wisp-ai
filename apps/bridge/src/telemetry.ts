import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { publicToolName, toolDescriptions } from '@wisp/protocol/capabilities';
import { PRESENT_UI_TOOL, SKIP_TIP_TOOL } from '@wisp/protocol/reply-presentation';

const token = 'phc_se29yi8DLMmFxhRcqQrzrSs9vGLzAiEGmsaMvjotDdTE';
const endpoint = 'https://us.i.posthog.com/i/v0/e/';
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
type Outcome = 'completed' | 'failed' | 'cancelled' | 'needs_input';
type Properties = Record<string, string | number | boolean>;

// All outbound fields are constructed here. No prompts, tool inputs/outputs, labels,
// model/connection IDs, character data or free-form errors are accepted.
export class UsageTelemetry {
  private pending = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private activeDay = '';
  private addonDay = '';
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
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        body: JSON.stringify({
          api_key: token,
          distinct_id: preferences.installationId,
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
              process.arch === 'x64'
                ? 'x86_64'
                : process.arch === 'arm64'
                  ? 'aarch64'
                  : process.arch,
            $process_person_profile: false,
            $geoip_disable: true,
            ...properties,
          },
        }),
      });
    } finally {
      this.controllers.delete(controller);
    }
  }

  private active() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.activeDay !== day) {
      this.activeDay = day;
      this.record('app_active');
    }
  }

  chat(mode: 'chat' | 'hover' | 'routine' | 'tip', outcome: Outcome, duration: number) {
    this.active();
    this.record('chat_completed', {
      mode,
      outcome,
      duration_ms: Math.max(0, Math.round(duration)),
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

  close() {
    this.closed = true;
    this.controllers.forEach((controller) => controller.abort());
  }
}
