import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { Effect } from 'effect';
import type { McpManager } from './mcp-manager.ts';

export function makeMcpRelayTools(
  manager: Pick<McpManager, 'connect'>,
  allowed: (server: string, tool: string) => boolean,
  readOnlyMode: () => boolean,
) {
  const allowedInCurrentMode = (tool: Tool) =>
    !readOnlyMode() || tool.annotations?.readOnlyHint === true;

  const list = Effect.fn('McpRelay.listTools')(function* (name: string) {
    const { tools } = yield* manager.connect(name);
    return {
      tools: tools.filter((tool) => allowed(name, tool.name) && allowedInCurrentMode(tool)),
    };
  });

  const call = Effect.fn('McpRelay.callTool')(function* (
    name: string,
    params: CallToolRequest['params'],
    signal: AbortSignal,
  ) {
    if (!allowed(name, params.name)) {
      return yield* Effect.fail(Error('MCP tool disabled'));
    }
    const { client, tools } = yield* manager.connect(name);
    const tool = tools.find((tool) => tool.name === params.name);
    if (!tool) {
      return yield* Effect.fail(Error('Unknown MCP tool'));
    }
    if (!allowedInCurrentMode(tool)) {
      return yield* Effect.fail(
        Error('Only explicitly read-only MCP tools are available during automatic advice'),
      );
    }
    return yield* Effect.tryPromise({
      try: () =>
        client.callTool({ name: params.name, arguments: params.arguments }, undefined, {
          signal,
          timeout: 60_000,
        }),
      catch: (error) => error,
    });
  });

  return { list, call };
}
