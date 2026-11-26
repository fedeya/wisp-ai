import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { McpManager } from './mcp-manager.ts';
export class McpRelay {
  manager: McpManager;
  allowed: (server: string, tool?: string) => boolean;
  sessions = new Map<
    string,
    { name: string; server: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  readOnlyMode: () => boolean = () => false;
  constructor(manager: McpManager, allowed: McpRelay['allowed']) {
    this.manager = manager;
    this.allowed = allowed;
  }
  async handle(request: Request, name: string): Promise<Response> {
    if (!this.allowed(name) || !this.manager.servers[name]?.enabled) {
      return new Response('MCP disabled', { status: 403 });
    }
    const id = request.headers.get('mcp-session-id');
    let entry = id ? this.sessions.get(id) : undefined;
    if (id && (!entry || entry.name !== name)) {
      return new Response('Unknown MCP session', { status: 404 });
    }
    if (!entry) {
      if (request.method !== 'POST' || this.sessions.size >= 50) {
        return new Response('Initialize the MCP connection first', { status: 400 });
      }
      const server = new Server(
        { name: 'Wisp-' + name, version: '0.2.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const c = await this.manager.connect(name);
        return {
          tools: c.tools.filter(
            (t) =>
              this.allowed(name, t.name) &&
              (!this.readOnlyMode() || t.annotations?.readOnlyHint === true),
          ),
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (!this.allowed(name, request.params.name)) {
          throw Error('MCP tool disabled');
        }
        const c = await this.manager.connect(name);
        const tool = c.tools.find((t) => t.name === request.params.name);
        if (!tool) {
          throw Error('Unknown MCP tool');
        }
        if (this.readOnlyMode() && tool.annotations?.readOnlyHint !== true) {
          throw Error('Only explicitly read-only MCP tools are available during automatic advice');
        }
        return await c.client.callTool(
          { name: request.params.name, arguments: request.params.arguments },
          undefined,
          { signal: extra.signal, timeout: 60000 },
        );
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { name, server, transport });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          this.sessions.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
      entry = { name, server, transport };
    }
    return entry.transport.handleRequest(request);
  }
  async close() {
    await Promise.all([...this.sessions.values()].map((s) => s.server.close()));
    this.sessions.clear();
  }
}
