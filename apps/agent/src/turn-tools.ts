import { createTool } from '@mastra/core/tools';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import type { ToolDefinition } from './tool.ts';

export type ToolStubOutcome = { response: unknown } | { throw: { message: string } };
/** Evals answer tools from fixtures: a stub result replaces the tool's own. */
export type ToolStub = (tool: string, input: unknown) => ToolStubOutcome | undefined;

export function stubbed(outcome: ToolStubOutcome) {
  if ('throw' in outcome) {
    throw Error(outcome.throw.message);
  }
  return outcome.response;
}

/** The two fixed tools that reach every deferred tool, so the tool list never changes. */
export const TOOL_SEARCH = 'tool_search';
export const TOOL_CALL = 'tool_call';
/** Agent tools that are not player-facing activity. */
export const CONTROL_TOOLS = new Set([TOOL_SEARCH, 'skill', 'skill_read', 'skill_search']);
export const MAX_STEPS = 40;

/** A tool reached through tool_call: an authored deferred tool or an MCP tool. */
export interface DeferredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  label?: ToolDefinition['label'];
  run: (
    input: unknown,
    ctx: { session: string; signal: AbortSignal; callId: string },
  ) => Promise<unknown>;
}

function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

/** Ranks deferred tools by query words found in their names, then descriptions. */
export function searchTools(tools: DeferredTool[], query: string, limit = 8) {
  const wanted = new Set(words(query));
  return tools
    .map((tool) => {
      const name = words(tool.name);
      const description = words(tool.description);
      let score = 0;
      for (const word of wanted) {
        score += name.includes(word) ? 3 : 0;
        score += description.includes(word) ? 1 : 0;
      }
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}

function jsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
}

/** An authored tool as tool_call runs it: input validated against its schema, then executed. */
export function authored(name: string, tool: ToolDefinition, stub?: ToolStub): DeferredTool {
  return {
    name,
    description: tool.description,
    inputSchema: jsonSchema(tool.inputSchema),
    label: tool.label,
    run: async (input, ctx) => {
      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        throw Error('Invalid input for ' + name + ': ' + z.prettifyError(parsed.error));
      }
      const fixture = stub?.(name, parsed.data);
      if (fixture) {
        return stubbed(fixture);
      }
      return tool.execute(parsed.data, {
        session: { id: ctx.session },
        abortSignal: ctx.signal,
        callId: ctx.callId,
      });
    },
  };
}

const callId = (context: unknown) =>
  String((context as { agent?: { toolCallId?: string } } | undefined)?.agent?.toolCallId ?? '');

/**
 * The Mastra tools of one turn: direct tools, plus tool_search and tool_call
 * for the deferred ones. Labels and the deferred catalog describe calls to the
 * bridge as the tools they run.
 */
export function assembleTools(options: {
  session: string;
  signal: AbortSignal;
  direct: Record<string, ToolDefinition>;
  deferred: DeferredTool[];
  stub?: ToolStub;
}) {
  const { session, signal, direct, stub } = options;
  const labels = new Map<string, ToolDefinition['label']>();
  const deferred = new Map(options.deferred.map((tool) => [tool.name, tool]));
  // tool_call also reaches direct tools, for a model that routes every call through it.
  const callable = new Map([
    ...deferred,
    ...Object.entries(direct).map(([name, tool]) => [name, authored(name, tool, stub)] as const),
  ]);
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const [name, tool] of Object.entries(direct)) {
    labels.set(name, tool.label);
    tools[name] = createTool({
      id: name,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      execute: async (data, context) => {
        const fixture = stub?.(name, data);
        if (fixture) {
          return stubbed(fixture);
        }
        return tool.execute(data, {
          session: { id: session },
          abortSignal: context?.abortSignal ?? signal,
          callId: callId(context),
        });
      },
      ...(tool.toModelOutput ? { toModelOutput: tool.toModelOutput as never } : {}),
    }) as never;
  }
  if (deferred.size) {
    tools[TOOL_SEARCH] = createTool({
      id: TOOL_SEARCH,
      description:
        'Find deferred tools (local game, catalog and integration tools, and external MCP connections) by keywords. Returns names, descriptions and input schemas. Discovery performs no game action.',
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const results = searchTools(options.deferred, query);
        return results.length
          ? { results }
          : { results, available: options.deferred.map((tool) => tool.name) };
      },
    }) as never;
    tools[TOOL_CALL] = createTool({
      id: TOOL_CALL,
      description:
        'Run a deferred tool found with tool_search. Pass its exact name and an input object matching its schema.',
      inputSchema: z.object({
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async ({ name, input }, context) => {
        const tool = callable.get(name);
        if (!tool) {
          throw Error('Unknown or disabled tool: ' + name + '. Use tool_search to find tools.');
        }
        return tool.run(input, {
          session,
          signal: context?.abortSignal ?? signal,
          callId: callId(context),
        });
      },
    }) as never;
  }
  return { tools, labels, deferred };
}

/** Run options of a turn: the step budget, endsTurn tools and reasoning effort. */
export function turnOptions(
  direct: Record<string, ToolDefinition>,
  selected: { provider?: string; effort: string },
) {
  const openai: Record<string, string> =
    selected.provider || selected.effort === 'provider-default'
      ? {}
      : { reasoningEffort: selected.effort };
  const endsTurn = new Set(
    Object.entries(direct)
      .filter(([, tool]) => tool.endsTurn)
      .map(([name]) => name),
  );
  return {
    maxSteps: MAX_STEPS,
    stopWhen: [
      stepCountIs(MAX_STEPS),
      ({
        steps,
      }: {
        steps: { toolCalls?: { toolName?: string; payload?: { toolName?: string } }[] }[];
      }) =>
        (steps.at(-1)?.toolCalls ?? []).some((call) =>
          endsTurn.has(call.toolName ?? call.payload?.toolName ?? ''),
        ),
    ] as never,
    providerOptions: { openai },
  };
}
