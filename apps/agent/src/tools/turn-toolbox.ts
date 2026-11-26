import { Context, Effect, Layer } from 'effect';
import { localMemory, memorySlots } from '../wisp/agent-memory.ts';
import { toolOffered } from './enabled-tool.ts';
import { sessionHost } from '../contract/host-calls.ts';
import { EngineConfig } from '../host/engine-config.ts';
import { hostCall, type HostError } from '../execution/engine-errors.ts';
import { Mcp } from '../integrations/mcp-tools.ts';
import type { ToolDefinition } from './tool.ts';
import { authoredTools } from '../wisp/tool-registry.ts';
import { authored, stubbed } from './turn-tools.ts';
import type { DeferredTool } from './turn-tools.ts';

/** What a turn may use, and the saved memory it recalls. */
export interface TurnTools {
  /** Tools listed to the model. */
  direct: Record<string, ToolDefinition>;
  /** Tools reached through `tool_search` and `tool_call`. */
  deferred: DeferredTool[];
  /** The saved memory of the slots in scope, or empty. */
  memory: string;
}

/**
 * The tools of a session's turn: authored tools whose capability is on,
 * memory slots in scope, and MCP tools.
 */
export class TurnToolbox extends Context.Service<
  TurnToolbox,
  { readonly tools: (session: string) => Effect.Effect<TurnTools, HostError> }
>()('@wisp/agent/TurnToolbox') {
  static readonly layer = Layer.effect(
    TurnToolbox,
    Effect.gen(function* () {
      const { stub, calls } = yield* EngineConfig;
      const mcp = yield* Mcp;

      const own = (session: string) =>
        hostCall(async (signal) => {
          const direct: Record<string, ToolDefinition> = {};
          const deferred: DeferredTool[] = [];
          const memory: string[] = [];
          for (const [name, tool] of Object.entries(authoredTools)) {
            if (!(await toolOffered(tool))) continue;
            if (tool.deferred) deferred.push(authored(name, tool, stub));
            else direct[name] = tool;
          }
          for (const slot of memorySlots) {
            const slotMemory = localMemory(slot);
            const host = sessionHost(calls, session, signal);
            if (!(await slotMemory.scope(host))) continue;
            Object.assign(direct, slotMemory.tools());
            const recalled = await slotMemory.recall(host);
            if (recalled) memory.push(recalled);
          }
          return { direct, deferred, memory: memory.join('\n\n') };
        });

      const tools = Effect.fn('TurnToolbox.tools')(function* (session: string) {
        const turn = yield* own(session);
        for (const tool of yield* mcp.tools) {
          turn.deferred.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            run: (input, ctx) => {
              const fixture = stub?.(tool.name, input);
              return fixture
                ? Promise.resolve().then(() => stubbed(fixture))
                : tool.call(
                    input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
                    ctx.signal,
                  );
            },
          });
        }
        return turn;
      });

      return TurnToolbox.of({ tools });
    }),
  );
}
