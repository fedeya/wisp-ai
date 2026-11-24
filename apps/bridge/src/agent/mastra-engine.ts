import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { selectedModel } from '@wisp/protocol/agent-rpc';
import { connectionModel } from '@wisp/agent/connection-model';
import { capabilityEnabled } from '@wisp/agent/capabilities';
import type { Logger } from 'pino';

/**
 * Spike: answers turns with an in-process Mastra agent behind the
 * `mastra_engine` flag. It reuses the authored Eve tool modules, skills and
 * instructions, and emits the same stream events as Eve so the turn runner,
 * reply projection and telemetry run unchanged.
 */
export const MASTRA_SESSION_PREFIX = 'mastra-';

/** The stream events the bridge reads from Eve (`chat/events.ts`). */
export interface EngineEvent {
  type: string;
  data: Record<string, unknown>;
}
export interface EngineResult {
  status: 'completed' | 'failed' | 'cancelled';
  error?: { message?: string };
  sessionEnded?: boolean;
}

interface EveToolDefinition {
  description: string;
  inputSchema: unknown;
  deferred?: boolean;
  label?: {
    start?: (input: unknown) => string;
    complete?: (input: unknown, output: unknown) => string;
  };
  execute: (input: unknown, ctx: unknown) => unknown;
  toModelOutput?: (...args: unknown[]) => unknown;
}
type ToolModule = { name: string; entry: unknown };

const DYNAMIC = Symbol.for('eve.dynamic');
// Meta tools from Mastra; like Eve's own control tools they are not player-facing activity.
const CONTROL_TOOLS = new Set(['skill', 'skill_read', 'skill_search', 'search_tools', 'load_tool']);

const HOST_NOTES = `

## Runtime notes

Deferred tools are not listed until you find them: call search_tools with a few keywords (it replaces eve__search), then load_tool with the returned name. Skills load with the skill tool; skill_read reads a skill's files.`;

export interface MastraEngineOptions {
  /** The `@wisp/agent` package root that holds `agent/`. */
  agentRoot: string;
  runtimeDir: string;
  origin: () => string;
  token: string;
  logger: Pick<Logger, 'info' | 'warn'>;
}

export function createMastraEngine(options: MastraEngineOptions) {
  const { agentRoot, runtimeDir, origin, token, logger } = options;
  const memory = new Memory({
    storage: new LibSQLStore({
      id: 'wisp-mastra',
      url: pathToFileURL(path.join(runtimeDir, 'mastra.sqlite')).href,
    }),
    options: { lastMessages: 40 },
  });
  let loaded: Promise<{ tools: ToolModule[]; skills: string[]; instructions: string }> | undefined;
  function load() {
    loaded ??= (async () => {
      const agentDir = path.join(agentRoot, 'agent');
      const files = (await readdir(path.join(agentDir, 'tools'))).filter((f) => f.endsWith('.ts'));
      const tools = await Promise.all(
        files.map(async (file) => ({
          name: file.slice(0, -3),
          entry: (await import(pathToFileURL(path.join(agentDir, 'tools', file)).href)).default,
        })),
      );
      const skills = (await readdir(path.join(agentDir, 'skills'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => path.join(agentDir, 'skills', d.name));
      const instructions =
        (await readFile(path.join(agentDir, 'instructions.md'), 'utf8')) + HOST_NOTES;
      return { tools, skills, instructions };
    })();
    loaded.catch(() => (loaded = undefined));
    return loaded;
  }

  // Evaluates `enabledTool` wrappers: a disabled capability resolves to null.
  async function resolveTool(entry: unknown, sessionId: string) {
    if (entry && typeof entry === 'object' && DYNAMIC in entry) {
      const evaluate = (entry as Record<symbol, (ctx: unknown) => Promise<unknown>>)[DYNAMIC];
      return (await evaluate({ session: { id: sessionId } })) as EveToolDefinition | null;
    }
    return entry as EveToolDefinition;
  }

  async function modelSettings(sessionId: string, signal: AbortSignal) {
    const response = await fetch(
      origin() + '/session-model?session=' + encodeURIComponent(sessionId),
      {
        headers: { authorization: 'Bearer ' + token },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      },
    );
    if (!response.ok) {
      throw Error('Could not load model settings for this conversation.');
    }
    return selectedModel.parse(await response.json());
  }

  async function* run(
    sessionId: string,
    input: string,
    signal: AbortSignal,
    settle: (result: EngineResult) => void,
  ): AsyncGenerator<EngineEvent> {
    const { tools, skills, instructions } = await load();
    const selected = await modelSettings(sessionId, signal);
    const labels = new Map<string, EveToolDefinition['label']>();
    const direct: Record<string, any> = {};
    const deferred: Record<string, any> = {};
    for (const { name, entry } of tools) {
      const definition = await resolveTool(entry, sessionId);
      if (!definition) {
        continue;
      }
      labels.set(name, definition.label);
      const tool = createTool({
        id: name,
        description: definition.description,
        inputSchema: definition.inputSchema as never,
        execute: (data, context) =>
          definition.execute(data, {
            session: { id: sessionId },
            abortSignal: context?.abortSignal ?? signal,
            callId: context?.agent?.toolCallId,
          }) as Promise<unknown>,
        ...(definition.toModelOutput ? { toModelOutput: definition.toModelOutput as never } : {}),
      });
      (definition.deferred ? deferred : direct)[name] = tool;
    }
    const openai: Record<string, string> =
      selected.provider || selected.effort === 'provider-default'
        ? {}
        : { reasoningEffort: selected.effort };
    const agent = new Agent({
      id: 'wisp',
      name: 'Wisp',
      instructions,
      model: connectionModel(
        selected,
        origin(),
        token,
        () => capabilityEnabled('tool:web_search'),
        // A stable per-conversation key keeps the tool loop on one prompt cache.
        'wisp-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32),
        sessionId,
        // The pinned @ai-sdk/provider types differ in patch version from Mastra's copy.
      ) as never,
      tools: direct,
      skills,
      memory,
      // One processor per run: reused instances can carry stale tool closures.
      inputProcessors: [
        new ToolSearchProcessor({ tools: deferred, storage: 'context', search: { topK: 5 } }),
      ],
    });

    yield { type: 'turn.started', data: {} };
    const inputs = new Map<string, unknown>();
    const texts = new Map<string, string>();
    let failure: unknown;
    try {
      const output = await agent.stream(input, {
        memory: { thread: sessionId, resource: 'wisp' },
        abortSignal: signal,
        maxSteps: 40,
        providerOptions: { openai },
      });
      for await (const chunk of output.fullStream as AsyncIterable<{
        type: string;
        payload?: Record<string, any>;
      }>) {
        const p = chunk.payload ?? {};
        switch (chunk.type) {
          case 'text-start':
            texts.set(p.id, '');
            break;
          case 'text-delta':
            texts.set(p.id, (texts.get(p.id) ?? '') + p.text);
            yield { type: 'content.delta', data: { partId: p.id, kind: 'text', delta: p.text } };
            break;
          case 'text-end':
            yield {
              type: 'content.completed',
              data: { partId: p.id, kind: 'text', value: texts.get(p.id) ?? '' },
            };
            break;
          case 'tool-call-delta':
            yield {
              type: 'call.input',
              data: { callId: p.toolCallId, delta: p.argsTextDelta, name: p.toolName },
            };
            break;
          case 'tool-call': {
            inputs.set(p.toolCallId, p.args);
            const label = safeLabel(() => labels.get(p.toolName)?.start?.(p.args));
            yield {
              type: 'call.requested',
              data: {
                callId: p.toolCallId,
                input: p.args,
                capability: {
                  name: p.toolName,
                  label,
                  kind: CONTROL_TOOLS.has(p.toolName) ? 'control' : 'tool',
                },
              },
            };
            break;
          }
          case 'tool-result': {
            const label = safeLabel(() =>
              labels.get(p.toolName)?.complete?.(inputs.get(p.toolCallId), p.result),
            );
            yield {
              type: 'call.settled',
              data: {
                callId: p.toolCallId,
                outcome: p.isError ? 'failed' : 'completed',
                output: p.result,
                ...(label ? { label } : {}),
              },
            };
            break;
          }
          case 'tool-error':
            yield {
              type: 'call.settled',
              data: {
                callId: p.toolCallId,
                outcome: 'failed',
                error: { message: errorText(p.error) },
              },
            };
            break;
          case 'step-finish': {
            const usage = stepUsage(p.output?.usage);
            if (usage) {
              yield { type: 'usage.recorded', data: { kind: 'model', usage } };
            }
            break;
          }
          case 'error':
            failure = p.error;
            break;
        }
      }
    } catch (error) {
      failure = error;
    }
    if (signal.aborted) {
      settle({ status: 'cancelled' });
    } else if (failure !== undefined) {
      logger.warn({ event: 'mastra.turn_failed', error: errorText(failure) }, 'Mastra turn failed');
      settle({ status: 'failed', error: { message: errorText(failure) } });
    } else {
      settle({ status: 'completed' });
    }
  }

  return {
    newSessionId: () => MASTRA_SESSION_PREFIX + randomUUID(),
    /** Starts a turn; events stream once, the result settles when the stream ends. */
    send(sessionId: string, input: string, signal: AbortSignal) {
      let settle!: (result: EngineResult) => void;
      const result = new Promise<EngineResult>((resolve) => (settle = resolve));
      const events = run(sessionId, input, signal, settle);
      return { events, result };
    },
    async end(sessionId: string) {
      await memory.deleteThread(sessionId).catch(() => {});
    },
  };
}

function safeLabel(label: () => string | undefined) {
  try {
    return label();
  } catch {
    return undefined;
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? 'The response failed.');
}

// AI SDK 7 reports token counts either as numbers or as { total, cacheRead } objects.
function stepUsage(raw: unknown) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const usage = raw as Record<string, any>;
  const count = (value: unknown) =>
    typeof value === 'number'
      ? value
      : value && typeof value === 'object' && typeof (value as any).total === 'number'
        ? (value as any).total
        : undefined;
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const cacheReadTokens =
    typeof usage.cachedInputTokens === 'number'
      ? usage.cachedInputTokens
      : typeof usage.inputTokens?.cacheRead === 'number'
        ? usage.inputTokens.cacheRead
        : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}
