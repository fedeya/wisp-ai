import { defaultCapabilities, type Capability } from '@wisp/protocol/capabilities';
import { Effect, Result } from 'effect';
import type { CapabilitySettings } from '../capabilities.ts';
import type * as McpManager from '@wisp/agent/mcp-manager';
import type { SavedServer } from '@wisp/agent/mcp-storage';

/**
 * The built-in capabilities plus one entry per MCP server and its tools.
 * Server URLs are shown without credentials, query or fragment.
 */
export function mcpCapabilityCatalog(
  servers: readonly SavedServer[],
  bundled: McpManager.Interface['bundled'] = [],
): Capability[] {
  const catalog = [
    ...defaultCapabilities(),
    ...bundled.flatMap(({ capabilities }) => capabilities),
  ];
  for (const server of servers) {
    const url = server.url ? new URL(server.url) : undefined;
    if (url) {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
    }
    catalog.push({
      id: 'mcp:' + server.name,
      kind: 'mcp',
      name: server.name,
      group: 'integrations',
      defaultEnabled: server.enabled,
      description:
        (server.description || server.name) + ' - ' + (url?.toString() || 'Local stdio server'),
    });
    for (const tool of server.tools || []) {
      catalog.push({
        id: 'mcp_tool:' + server.name + ':' + tool.name,
        name: tool.name,
        group: 'integrations',
        parent: 'mcp:' + server.name,
        description: (tool.description || tool.name).slice(0, 500),
      });
    }
  }
  return catalog;
}

/** Keeps capability settings and the MCP servers they switch on and off in step. */
export function createMcpCapabilities(
  mcpManager: Pick<McpManager.Interface, 'list' | 'setEnabled' | 'disconnect' | 'bundled'>,
  capabilitySettings: CapabilitySettings,
) {
  return {
    /** Rebuild the capability catalog after the MCP server list changed. */
    refreshCatalog: Effect.fn('McpCapabilities.refreshCatalog')(function* () {
      capabilitySettings.catalog = mcpCapabilityCatalog(
        yield* mcpManager.list(),
        mcpManager.bundled,
      );
    }),
    /** Start or stop each MCP server as its saved capability setting says. */
    applySavedSettings: Effect.fn('McpCapabilities.applySavedSettings')(function* () {
      for (const server of yield* mcpManager.list()) {
        yield* mcpManager.setEnabled(
          server.name,
          capabilitySettings.configured('mcp:' + server.name),
        );
      }
    }),
    /** Save a capability; for an MCP server, switch it first and undo that if saving fails. */
    setCapability: Effect.fn('McpCapabilities.setCapability')(function* (
      id: string,
      enabled: boolean,
    ) {
      const server = id.startsWith('mcp:')
        ? (yield* mcpManager.list()).find((server) => id === 'mcp:' + server.name)
        : undefined;
      if (server) {
        yield* mcpManager.setEnabled(server.name, enabled);
      }
      const result = yield* Effect.result(
        Effect.tryPromise({
          try: () => capabilitySettings.set(id, enabled),
          catch: (error) => error,
        }),
      );
      if (Result.isFailure(result)) {
        if (server) {
          yield* mcpManager.setEnabled(server.name, server.enabled);
        }
        return yield* Effect.fail(result.failure);
      }
      const bundled = mcpManager.bundled.find(({ definition }) => id === 'mcp:' + definition.name);
      if (bundled && !enabled) {
        yield* mcpManager.disconnect(bundled.definition.name);
      }
    }),
  };
}
