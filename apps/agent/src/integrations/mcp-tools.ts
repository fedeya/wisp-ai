// @effect-migrated
import { Context, Effect, Layer, Schema } from 'effect';
import { HostError } from '../execution/engine-errors.ts';
import * as Capabilities from '../host/capabilities.ts';
import type { CapabilitySnapshot } from '../host/capabilities.ts';
import * as McpStorage from '../host/mcp-storage.ts';
import * as McpConnection from './mcp-connection.ts';
import * as McpManager from './mcp-manager.ts';
import type { BundledMcp, McpToolGroup } from './mcp-manager.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  call: (input: Record<string, unknown>) => Effect.Effect<unknown, HostError>;
}

interface ToolSource {
  server: string;
  toolGroups: readonly McpToolGroup[];
  trustedReadOnly?: boolean | undefined;
}

const toolSources = Effect.fnUntraced(function* (manager: McpManager.Interface) {
  const custom = yield* manager.list();
  const sources: ToolSource[] = [
    ...manager.bundled
      .filter(({ definition }) => definition.enabled)
      .map((profile) => ({
        server: profile.definition.name,
        toolGroups: profile.toolGroups,
        trustedReadOnly: profile.trustedReadOnly,
      })),
    ...custom
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
  return sources;
});

function allowedBy(capabilities: CapabilitySnapshot) {
  return (server: string, tool?: string) =>
    capabilities.enabled('mcp:' + server) &&
    (tool === undefined || !capabilities.disabledMcpTools(server).includes(tool));
}

const isProperties = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isRequired = Schema.is(Schema.Array(Schema.String));

/** The tool's input schema without the arguments Wisp fixes. */
function withoutProvided(
  schema: Readonly<Record<string, unknown>>,
  provided?: Readonly<Record<string, unknown>>,
) {
  if (!provided) return schema;
  const properties = isProperties(schema.properties) ? schema.properties : {};
  const required = isRequired(schema.required) ? schema.required : [];
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([key]) => !(key in provided)),
    ),
    required: required.filter((key) => !(key in provided)),
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

/** The host's rules for the current turn. */
export interface McpPolicy {
  readonly allowed: (server: string, tool?: string) => boolean;
  readonly readOnly: (session: string) => boolean;
}

const make = (policy?: McpPolicy) =>
  Layer.effect(
    Mcp,
    Effect.gen(function* () {
      const settings = yield* Capabilities.Service;
      const manager = yield* McpManager.Service;

      const tools = Effect.fn('Mcp.tools')(function* (
        session: string,
        capabilities: CapabilitySnapshot,
      ) {
        const allowed = policy?.allowed ?? allowedBy(capabilities);
        const result: McpTool[] = [];
        for (const { server, toolGroups, trustedReadOnly } of yield* toolSources(manager)) {
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
                      if (!mayCall(server, tool.name)) return 'MCP tool disabled';
                      if (
                        !trustedReadOnly &&
                        policy?.readOnly(session) &&
                        current.annotations?.readOnlyHint !== true
                      ) {
                        return 'Only explicitly read-only MCP tools are available during automatic advice';
                      }
                      return undefined;
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

/**
 * The agent's own MCP servers, switched by its capability settings, with
 * nothing saved: for the agent without a host, such as the evals.
 */
export const layer = (bundled: readonly BundledMcp[] = []) =>
  make().pipe(
    Layer.provide(McpManager.layer({ bundled })),
    Layer.provide([McpConnection.layer, McpStorage.layerNone]),
  );

/** The host's MCP manager, under the host's policy. */
export const layerWithPolicy = (policy: McpPolicy) => make(policy);
