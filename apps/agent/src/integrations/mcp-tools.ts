import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { HostError } from '../execution/engine-errors.ts';
import * as Capabilities from '../host/capabilities.ts';
import type { CapabilitySnapshot } from '../host/capabilities.ts';
import { McpManager, type BundledMcp, type McpToolGroup } from './mcp-manager.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  call: (input: Record<string, unknown>) => Effect.Effect<unknown, HostError>;
}

interface ToolSource {
  server: string;
  toolGroups: readonly McpToolGroup[];
  trustedReadOnly?: boolean;
}

function toolSources(manager: McpManager): ToolSource[] {
  return [
    ...manager.bundled
      .filter(({ definition }) => definition.enabled)
      .map((profile) => ({
        server: profile.definition.name,
        toolGroups: profile.toolGroups,
        trustedReadOnly: profile.trustedReadOnly,
      })),
    ...manager
      .list()
      .filter((server) => server.enabled)
      .map((server) => ({
        server: server.name,
        toolGroups: [
          {
            namespace: server.name.replace(/_/g, '-'),
            description: server.description || server.name,
          },
        ],
      })),
  ];
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

interface McpPolicy {
  readonly allowed: (server: string, tool?: string) => boolean;
  readonly readOnly: (session: string) => boolean;
}

export const layer = (bundled: readonly BundledMcp[] = []) =>
  layerWithManager(
    Effect.acquireRelease(
      Effect.sync(() => McpManager.make('.', undefined, bundled)),
      (manager) => manager.close(),
    ),
  );

export const layerFromManager = (manager: McpManager, policy: McpPolicy) =>
  layerWithManager(Effect.succeed(manager), policy);

const layerWithManager = (
  acquire: Effect.Effect<McpManager, never, Scope.Scope>,
  policy?: McpPolicy,
) =>
  Layer.effect(
    Mcp,
    Effect.gen(function* () {
      const settings = yield* Capabilities.Service;
      const manager = yield* acquire;

      const tools = Effect.fn('Mcp.tools')(function* (
        session: string,
        capabilities: CapabilitySnapshot,
      ) {
        const allowed = policy?.allowed ?? allowedBy(capabilities);
        const result: McpTool[] = [];
        for (const { server, toolGroups, trustedReadOnly } of toolSources(manager)) {
          const enabledSources = toolGroups.filter(
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
          const readOnly = !trustedReadOnly && policy?.readOnly(session);
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
                  const mayCall = policy?.allowed ?? allowedBy(yield* settings.read);
                  if (!mayCall(server, tool.name)) {
                    return yield* new HostError({ cause: Error('MCP tool disabled') });
                  }
                  return yield* manager
                    .call(server, tool.name, { ...input, ...provided }, (current) => {
                      if (!mayCall(server, tool.name)) throw Error('MCP tool disabled');
                      if (
                        !trustedReadOnly &&
                        policy?.readOnly(session) &&
                        current.annotations?.readOnlyHint !== true
                      ) {
                        throw Error(
                          'Only explicitly read-only MCP tools are available during automatic advice',
                        );
                      }
                    })
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
