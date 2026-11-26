import { hasToolCall, isStepCount, tool, type StopCondition, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AuthoredSkill } from './content.ts';
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
/** Loads one of Wisp's authored skills. */
export const SKILL = 'skill';
/** Agent tools that are not player-facing activity. */
export const CONTROL_TOOLS = new Set([TOOL_SEARCH, SKILL]);
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

/**
 * The AI SDK tools of one turn: direct tools, the skill loader, and tool_search
 * with tool_call for the deferred ones. Labels and the deferred catalog
 * describe calls to the bridge as the tools they run. A tool that throws
 * answers the model with its error; the turn goes on.
 */
export function assembleTools(options: {
  session: string;
  signal: AbortSignal;
  direct: Record<string, ToolDefinition>;
  deferred: DeferredTool[];
  skills: AuthoredSkill[];
  stub?: ToolStub;
}) {
  const { session, signal, direct, skills, stub } = options;
  const labels = new Map<string, ToolDefinition['label']>();
  const deferred = new Map(options.deferred.map((entry) => [entry.name, entry]));
  // tool_call also reaches direct tools, for a model that routes every call through it.
  const callable = new Map([
    ...deferred,
    ...Object.entries(direct).map(([name, entry]) => [name, authored(name, entry, stub)] as const),
  ]);
  const tools: ToolSet = {};
  for (const [name, definition] of Object.entries(direct)) {
    labels.set(name, definition.label);
    const toModelOutput = definition.toModelOutput;
    tools[name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input: unknown, context) => {
        const fixture = stub?.(name, input);
        if (fixture) {
          return stubbed(fixture);
        }
        return definition.execute(input, {
          session: { id: session },
          abortSignal: context.abortSignal ?? signal,
          callId: context.toolCallId,
        });
      },
      ...(toModelOutput ? { toModelOutput: ({ output }) => toModelOutput(output) as never } : {}),
    });
  }
  if (skills.length) {
    tools[SKILL] = tool({
      description: "Load one of Wisp's authored skills by name and follow its instructions.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const skill = skills.find((entry) => entry.name === name);
        // An answer, not a failure: the model picks another skill from the list.
        return skill
          ? { name: skill.name, instructions: skill.instructions }
          : 'Skill "' +
              name +
              '" not found. Available skills: ' +
              skills.map((entry) => entry.name).join(', ');
      },
      toModelOutput: ({ output }) =>
        typeof output === 'string'
          ? { type: 'text', value: output }
          : { type: 'json', value: output },
    });
  }
  if (deferred.size) {
    tools[TOOL_SEARCH] = tool({
      description:
        'Find deferred tools (local game, catalog and integration tools, and external MCP connections) by keywords. Returns names, descriptions and input schemas. Discovery performs no game action.',
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const results = searchTools(options.deferred, query);
        return results.length
          ? { results }
          : { results, available: options.deferred.map((entry) => entry.name) };
      },
    });
    tools[TOOL_CALL] = tool({
      description:
        'Run a deferred tool found with tool_search. Pass its exact name and an input object matching its schema.',
      inputSchema: z.object({
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async ({ name, input }, context) => {
        const target = callable.get(name);
        if (!target) {
          throw Error('Unknown or disabled tool: ' + name + '. Use tool_search to find tools.');
        }
        return target.run(input, {
          session,
          signal: context.abortSignal ?? signal,
          callId: context.toolCallId,
        });
      },
    });
  }
  return { tools, labels, deferred };
}

/** Stops when the last step ran one of `names` through tool_call, which direct tools also accept. */
export function ranThroughCall(names: ReadonlySet<string>): StopCondition<ToolSet> {
  return ({ steps }) =>
    steps.at(-1)?.toolResults.some((result) => {
      if (result.toolName !== TOOL_CALL) return false;
      const target = (result.input as { name?: unknown } | undefined)?.name;
      return typeof target === 'string' && names.has(target);
    }) ?? false;
}

/** Run options of a turn: the step budget, endsTurn tools and reasoning effort. */
export function turnOptions(
  direct: Record<string, ToolDefinition>,
  selected: { provider?: string; effort: string },
) {
  const endsTurn = Object.entries(direct)
    .filter(([, definition]) => definition.endsTurn)
    .map(([name]) => name);
  return {
    stopWhen: [
      isStepCount(MAX_STEPS),
      ...(endsTurn.length ? [hasToolCall(...endsTurn), ranThroughCall(new Set(endsTurn))] : []),
    ],
    ...(selected.provider || selected.effort === 'provider-default'
      ? {}
      : { providerOptions: { openai: { reasoningEffort: selected.effort } } }),
  };
}
