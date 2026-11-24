import { Effect, Schema } from 'effect';
import { Tool, Toolkit } from 'effect/ai';
import { z } from 'zod';
import type { AuthoredSkill } from './content.ts';
import type { ToolDefinition, ToolModelOutput } from './tool.ts';

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

/** A zod schema as the JSON Schema a provider receives. */
export function jsonSchema(schema: z.ZodType) {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  return rest;
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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? 'The tool failed.');
}

type Run = (input: unknown, signal: AbortSignal, callId: string) => unknown;

/** The Effect AI toolkit of one turn and what the engine reports about its calls. */
export interface TurnToolkit {
  toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>;
  /** Activity labels of direct tools; deferred ones carry their own. */
  labels: Map<string, ToolDefinition['label']>;
  deferred: Map<string, DeferredTool>;
  /** What the model sees of a tool's result, when the tool shapes it. */
  modelOutput: Map<string, (output: unknown) => ToolModelOutput>;
  /** Tools that finish the turn without another model step. */
  endsTurn: Set<string>;
}

/**
 * The tools of one turn as an Effect AI toolkit: direct tools, the skill
 * loader, and tool_search with tool_call for the deferred ones. A failed tool
 * returns its message to the model instead of failing the turn.
 */
export function assembleTools(options: {
  session: string;
  signal: AbortSignal;
  direct: Record<string, ToolDefinition>;
  deferred: DeferredTool[];
  skills: AuthoredSkill[];
  stub?: ToolStub;
}): Effect.Effect<TurnToolkit> {
  const { session, signal, direct, skills, stub } = options;
  const tools: Tool.Any[] = [];
  const handlers: Record<string, (params: unknown, context: { toolCallId?: string }) => unknown> =
    {};
  const add = (name: string, description: string, parameters: object, run: Run) => {
    tools.push(
      Tool.dynamic(name, {
        description,
        parameters: parameters as never,
        failure: Schema.String,
        failureMode: 'return',
      }) as unknown as Tool.Any,
    );
    handlers[name] = (params, context) =>
      Effect.tryPromise({
        try: async (interrupted) =>
          run(params, AbortSignal.any([signal, interrupted]), context.toolCallId ?? ''),
        catch: errorText,
      });
  };

  const labels = new Map<string, ToolDefinition['label']>();
  const modelOutput = new Map<string, (output: unknown) => ToolModelOutput>();
  const endsTurn = new Set<string>();
  const deferred = new Map(options.deferred.map((tool) => [tool.name, tool]));
  // tool_call also reaches direct tools, for a model that routes every call through it.
  const callable = new Map([
    ...deferred,
    ...Object.entries(direct).map(([name, tool]) => [name, authored(name, tool, stub)] as const),
  ]);

  for (const [name, tool] of Object.entries(direct)) {
    labels.set(name, tool.label);
    if (tool.toModelOutput) {
      modelOutput.set(name, tool.toModelOutput);
    }
    if (tool.endsTurn) {
      endsTurn.add(name);
    }
    const call = callable.get(name)!;
    add(name, tool.description, jsonSchema(tool.inputSchema), (input, abortSignal, callId) =>
      call.run(input, { session, signal: abortSignal, callId }),
    );
  }
  if (skills.length) {
    const input = z.object({ name: z.string().min(1) });
    modelOutput.set(SKILL, (output) =>
      typeof output === 'string'
        ? { type: 'text', value: output }
        : { type: 'json', value: output },
    );
    add(
      SKILL,
      "Load one of Wisp's authored skills by name and follow its instructions.",
      jsonSchema(input),
      (params) => {
        const { name } = input.parse(params);
        const skill = skills.find((entry) => entry.name === name);
        if (!skill) {
          // An answer, not a failure: the model picks another skill from the list.
          return (
            'Skill "' +
            name +
            '" not found. Available skills: ' +
            skills.map((entry) => entry.name).join(', ')
          );
        }
        return { name: skill.name, instructions: skill.instructions };
      },
    );
  }
  if (deferred.size) {
    const search = z.object({ query: z.string().min(1) });
    add(
      TOOL_SEARCH,
      'Find deferred tools (local game, catalog and integration tools, and external MCP connections) by keywords. Returns names, descriptions and input schemas. Discovery performs no game action.',
      jsonSchema(search),
      (params) => {
        const { query } = search.parse(params);
        const results = searchTools(options.deferred, query);
        return results.length
          ? { results }
          : { results, available: options.deferred.map((tool) => tool.name) };
      },
    );
    const proxy = z.object({
      name: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
    });
    add(
      TOOL_CALL,
      'Run a deferred tool found with tool_search. Pass its exact name and an input object matching its schema.',
      jsonSchema(proxy),
      (params, abortSignal, callId) => {
        const { name, input } = proxy.parse(params);
        const tool = callable.get(name);
        if (!tool) {
          throw Error('Unknown or disabled tool: ' + name + '. Use tool_search to find tools.');
        }
        return tool.run(input, { session, signal: abortSignal, callId });
      },
    );
  }

  const toolkit = Toolkit.make(...tools);
  return Effect.map(toolkit.toHandlers(handlers as never), (context) => context).pipe(
    Effect.flatMap((context) => Effect.provideContext(toolkit, context)),
    Effect.map((withHandler) => ({
      toolkit: withHandler as unknown as TurnToolkit['toolkit'],
      labels,
      deferred,
      modelOutput,
      endsTurn,
    })),
  );
}

/** The reasoning effort a turn asks the provider for. */
export function providerOptions(selected: { provider?: string; effort: string }) {
  return selected.provider || selected.effort === 'provider-default'
    ? undefined
    : { openai: { reasoningEffort: selected.effort } };
}
