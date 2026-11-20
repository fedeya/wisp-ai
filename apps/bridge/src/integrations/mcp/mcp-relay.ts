import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { McpManager } from './mcp-manager.ts';
export class McpRelay {
  manager: McpManager;
  allowed: (server: string, tool?: string) => boolean;
  sessions = new Map<
    string,
    { name: string; server: Server; transport: StreamableHTTPServerTransport }
  >();
  readOnlyMode: () => boolean = () => false;
  constructor(manager: McpManager, allowed: McpRelay['allowed']) {
    this.manager = manager;
    this.allowed = allowed;
  }
  async handle(req: IncomingMessage, res: ServerResponse, name: string) {
    if (!this.allowed(name) || !this.manager.servers[name]?.enabled) {
      res.writeHead(403).end('MCP disabled');
      return;
    }
    const id = String(req.headers['mcp-session-id'] || '');
    let entry = id ? this.sessions.get(id) : undefined;
    if (id && (!entry || entry.name !== name)) {
      res.writeHead(404).end('Unknown MCP session');
      return;
    }
    if (!entry) {
      if (req.method !== 'POST' || this.sessions.size >= 50) {
        res.writeHead(400).end('Initialize the MCP connection first');
        return;
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
      const transport = new StreamableHTTPServerTransport({
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
    await entry.transport.handleRequest(req, res);
  }
  async close() {
    await Promise.all([...this.sessions.values()].map((s) => s.server.close()));
    this.sessions.clear();
  }
}
