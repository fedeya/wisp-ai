import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import type { McpManager } from './mcp-manager.ts';
import { makeMcpRelayTools } from './mcp-relay-tools.ts';

const make = Effect.fnUntraced(function* (
  manager: McpManager,
  allowed: (server: string, tool?: string) => boolean,
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const sessions = new Map<
    string,
    { name: string; server: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  const relay = {
    readOnlyMode: () => false,
    handle,
    async close() {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      sessions.clear();
    },
  };
  const tools = makeMcpRelayTools(manager, allowed, () => relay.readOnlyMode());

  async function handle(request: Request, name: string): Promise<Response> {
    if (!allowed(name) || !manager.servers[name]?.enabled) {
      return new Response('MCP disabled', { status: 403 });
    }
    const id = request.headers.get('mcp-session-id');
    const entry = id ? sessions.get(id) : undefined;
    if (id && (!entry || entry.name !== name)) {
      return new Response('Unknown MCP session', { status: 404 });
    }
    if (!entry && (request.method !== 'POST' || sessions.size >= 50)) {
      return new Response('Initialize the MCP connection first', { status: 400 });
    }
    const transport = entry?.transport ?? (await createSession(name));
    return transport.handleRequest(request);
  }

  async function createSession(name: string) {
    // The low-level SDK API forwards upstream JSON Schemas as-is and filters tools per request.
    const server = new Server(
      { name: 'Wisp-' + name, version: '0.2.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => runPromise(tools.list(name)));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      runPromise(tools.call(name, request.params, extra.signal)),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { name, server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    return transport;
  }

  return relay;
});

export type McpRelay = Effect.Success<ReturnType<typeof make>>;
export const McpRelay = { make };
