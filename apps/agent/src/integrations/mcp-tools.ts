import { Context, Effect, Layer } from 'effect';
import { everlootTools } from '@wisp/protocol/capabilities';
import { HostError } from '../execution/engine-errors.ts';
import { AgentCapabilities, type CapabilitySnapshot } from '../host/capabilities.ts';
import { EngineConfig } from '../host/engine-config.ts';
import { McpManager, type MCPDefinition } from './mcp-manager.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  call: (input: Record<string, unknown>) => Effect.Effect<unknown, HostError>;
}

interface ToolSource {
  namespace: string;
  description: string;
  allow?: readonly string[];
  provided?: Record<string, unknown>;
}

const everlootSources: readonly ToolSource[] = [
  {
    namespace: 'everloot',
    description:
      'Complementary Forever-only observations and reference pages: drops, vendors, quest relations, world locations, talents, professions and realm scan history. Use TheWoWDB for the primary catalog. Missing coverage is unknown. Preserve build, date, source and licence; prices are scans, not live listings.',
    allow: everlootTools.filter((name) => !['search_knowledge', 'recent_changes'].includes(name)),
  },
  {
    namespace: 'everloot-search',
    description:
      'Complementary Everloot search with version fixed to Forever by the application. Cannot search Retail, Classic or archived wiki lore. Use TheWoWDB first for catalog facts.',
    allow: ['search_knowledge'],
    provided: { version: 'forever' },
  },
  {
    namespace: 'everloot-changes',
    description:
      'Official Forever changes only: blue posts, hotfixes and builds. The game filter is supplied by Wisp; Classic changes cannot be selected.',
    allow: ['recent_changes'],
    provided: { game: 'forever' },
  },
];

function toolSources(servers: readonly MCPDefinition[]): Map<string, readonly ToolSource[]> {
  // Configured servers can only be opened when the manager has enabled them.
  const sources = new Map<string, readonly ToolSource[]>([['everloot', everlootSources]]);
  for (const server of servers) {
    if (server.enabled) {
      sources.set(server.name, [
        {
          namespace: server.name.replace(/_/g, '-'),
          description: server.description || server.name,
        },
      ]);
    }
  }
  return sources;
}

function allowedBy(capabilities: CapabilitySnapshot) {
  return (server: string, tool?: string) =>
    capabilities.enabled('mcp:' + server) &&
    (tool === undefined || !capabilities.disabledMcpTools(server).includes(tool));
}

function withoutProvided(schema: unknown, provided?: Record<string, unknown>) {
  if (!provided || !schema || typeof schema !== 'object') return schema;
  const value = schema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...value,
    properties: Object.fromEntries(
      Object.entries(value.properties || {}).filter(([key]) => !(key in provided)),
    ),
    required: (value.required || []).filter((key) => !(key in provided)),
  };
}

/** Projects manager tools into the model catalog; the manager owns all connections. */
export class Mcp extends Context.Service<
  Mcp,
  {
    readonly tools: (
      session: string,
      capabilities: CapabilitySnapshot,
    ) => Effect.Effect<readonly McpTool[], HostError>;
  }
>()('@wisp/agent/Mcp') {}

export const layer = Layer.effect(
  Mcp,
  Effect.gen(function* () {
    const { mcp } = yield* EngineConfig;
    const settings = yield* AgentCapabilities;
    const manager =
      mcp?.manager ??
      (yield* Effect.acquireRelease(
        Effect.sync(() => McpManager.make()),
        (manager) => manager.close(),
      ));

    const tools = Effect.fn('Mcp.tools')(function* (
      session: string,
      capabilities: CapabilitySnapshot,
    ) {
      const allowed = mcp?.allowed ?? allowedBy(capabilities);
      const result: McpTool[] = [];
      for (const [server, sources] of toolSources(manager.list())) {
        const enabledSources = sources.filter(
          ({ allow }) => !allow || allow.some((name) => allowed(server, name)),
        );
        if (!allowed(server) || !enabledSources.length) continue;
        const listed = yield* manager.discover(server).pipe(
          Effect.catch((error) =>
            Effect.logWarning('MCP connection unavailable').pipe(
              Effect.annotateLogs({
                event: 'agent.mcp_unavailable',
                connection: server,
                error: error.message,
              }),
              Effect.as(undefined),
            ),
          ),
        );
        if (!listed) continue;
        const readOnly = server !== 'everloot' && mcp?.readOnly(session);
        for (const { namespace, description, allow, provided } of enabledSources) {
          for (const tool of listed) {
            if (
              (allow && !allow.includes(tool.name)) ||
              !allowed(server, tool.name) ||
              (readOnly && tool.annotations?.readOnlyHint !== true)
            ) {
              continue;
            }
            result.push({
              name: namespace + '__' + tool.name,
              description: [description, tool.description].filter(Boolean).join('\n'),
              inputSchema: withoutProvided(tool.inputSchema, provided),
              call: Effect.fnUntraced(function* (input: Record<string, unknown>) {
                const mayCall = mcp?.allowed ?? allowedBy(yield* settings.read);
                if (!mayCall(server, tool.name)) {
                  return yield* new HostError({ cause: Error('MCP tool disabled') });
                }
                return yield* manager
                  .call(
                    server,
                    tool.name,
                    { ...input, ...provided },
                    (current) => {
                      if (!mayCall(server, tool.name)) throw Error('MCP tool disabled');
                      if (
                        server !== 'everloot' &&
                        mcp?.readOnly(session) &&
                        current.annotations?.readOnlyHint !== true
                      ) {
                        throw Error(
                          'Only explicitly read-only MCP tools are available during automatic advice',
                        );
                      }
                    },
                    server === 'everloot' ? 120_000 : 60_000,
                  )
                  .pipe(Effect.mapError((cause) => new HostError({ cause })));
              }),
            });
          }
        }
      }
      return result;
    });
    return Mcp.of({ tools });
  }),
);
