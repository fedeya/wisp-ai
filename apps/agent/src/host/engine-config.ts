import { Context } from 'effect';
import type { ToolStub } from '../tools/turn-tools.ts';
import type { McpManager } from '../integrations/mcp-manager.ts';

/** What the engine needs from its host. */
export interface EngineHost {
  /** The bridge's loopback agent endpoint and its token. */
  readonly origin: () => string;
  readonly token: string;
  /** The bridge's published capability and feature settings. */
  readonly capabilitiesFile?: () => string | undefined;
  /** The shared MCP service and the host's live policy for each turn. */
  readonly mcp?: {
    readonly manager: McpManager;
    readonly allowed: (server: string, tool?: string) => boolean;
    readonly readOnly: (session: string) => boolean;
  };
  /** Evals answer tools from fixtures: a stub result replaces the tool's own. */
  readonly stub?: ToolStub;
}

export class EngineConfig extends Context.Service<EngineConfig, EngineHost>()(
  '@wisp/agent/EngineConfig',
) {}
