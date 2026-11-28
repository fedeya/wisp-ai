import { Context, Effect, Layer } from 'effect';
import { localMemory, memorySlots } from '../wisp/agent-memory.ts';
import { toolOffered } from './enabled-tool.ts';
import { EngineConfig } from '../host/engine-config.ts';
import * as Capabilities from '../host/capabilities.ts';
import * as Game from '../host/game-access.ts';
import * as Memory from '../host/memory.ts';
import type { HostError } from '../execution/engine-errors.ts';
import { Mcp } from '../integrations/mcp-tools.ts';
import * as WebFetch from '../integrations/web/web-fetch.ts';
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
      const { stub } = yield* EngineConfig;
      const settings = yield* Capabilities.Service;
      const mcp = yield* Mcp;
      const gameAccess = yield* Game.Service;
      const memoryAccess = yield* Memory.Service;
      const webFetch = yield* WebFetch.Service;

      const tools = Effect.fn('TurnToolbox.tools')(function* (session: string) {
        const capabilities = yield* settings.read;
        const direct: Record<string, ToolDefinition> = {};
        const deferred: DeferredTool[] = [];
        const memory: string[] = [];
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        for (const [name, tool] of Object.entries(authoredTools)) {
          if (!toolOffered(tool, capabilities)) continue;
          const bound: ToolDefinition = {
            ...tool,
            execute: (input, ctx) =>
              tool.execute(input, { ...ctx, gameAccess, webFetch, runEffect: runPromise }),
          };
          if (tool.deferred) deferred.push(authored(name, bound, stub));
          else direct[name] = bound;
        }
        for (const slot of memorySlots) {
          const slotMemory = localMemory(slot, memoryAccess, runPromise);
          if (!(yield* slotMemory.scope(session, capabilities))) continue;
          Object.assign(direct, slotMemory.tools());
          const recalled = yield* slotMemory.recall(session);
          if (recalled) memory.push(recalled);
        }
        for (const tool of yield* mcp.tools(session, capabilities)) {
          deferred.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            run: (input, ctx) => {
              const fixture = stub?.(tool.name, input);
              return fixture
                ? Promise.resolve().then(() => stubbed(fixture))
                : runPromise(
                    tool
                      .call(
                        input && typeof input === 'object'
                          ? (input as Record<string, unknown>)
                          : {},
                      )
                      .pipe(Effect.mapError((error) => error.cause)),
                    { signal: ctx.signal },
                  );
            },
          });
        }
        return { direct, deferred, memory: memory.join('\n\n') };
      });

      return TurnToolbox.of({ tools });
    }),
  );
}
