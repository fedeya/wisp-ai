import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Logger } from 'pino';
import type { ChatGPTAuth } from '../auth/chatgpt-auth.ts';
import type { McpRelay } from '../integrations/mcp/mcp-relay.ts';
import type { ModelConnections } from '../models/model-connections.ts';
import type { ModelFailures } from '../models/model-failures.ts';
import { proxyConnectionModel, proxyModel } from '../models/model-proxy.ts';

interface AgentServerDependencies {
  logger?: Pick<Logger, 'info'>;
  token: string;
  auth: ChatGPTAuth;
  connections: ModelConnections;
  /** Records why model requests failed, for chat telemetry. */
  modelFailures?: ModelFailures;
  mcpRelay: McpRelay;
}
type AgentContext = Context<{ Bindings: HttpBindings }>;

/**
 * The loopback server for what must stay HTTP: the AI SDK reaches models
 * through a URL (the ChatGPT and connection proxies), and MCP clients reach
 * the player's relayed servers the same way. The agent's own calls to the
 * bridge are plain function calls (agent-calls.ts).
 */
export function createAgentApp(deps: AgentServerDependencies) {
  const { token, auth, connections, mcpRelay } = deps;
  const expected = Buffer.from('Bearer ' + token);
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.notFound((c) => c.body(null, 404));
  app.use(async (c, next) => {
    const supplied = Buffer.from(c.req.header('authorization') || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.text('Forbidden', 403);
    }
    await next();
  });

  // Model proxies and the MCP relay stream on the raw Node request and response.
  const proxy =
    (forward: (c: AgentContext) => Promise<void>) =>
    async (c: AgentContext): Promise<Response> => {
      const { outgoing } = c.env;
      try {
        await forward(c);
      } catch (e) {
        if (outgoing.headersSent) {
          outgoing.destroy();
        } else {
          outgoing
            .writeHead(503, { 'content-type': 'application/json', 'x-wisp-model-error': 'true' })
            .end(
              JSON.stringify({
                error: { message: e instanceof Error ? e.message : 'Model request failed' },
              }),
            );
        }
      }
      return RESPONSE_ALREADY_SENT;
    };
  app.post(
    '/model/responses',
    proxy((c) => proxyModel(c.env.incoming, c.env.outgoing, auth, deps.logger, deps.modelFailures)),
  );
  app.post(
    '/model/connections/*',
    proxy((c) =>
      proxyConnectionModel(c.env.incoming, c.env.outgoing, connections, deps.modelFailures),
    ),
  );
  app.all('/mcp/*', async (c) => {
    const { incoming, outgoing } = c.env;
    try {
      await mcpRelay.handle(incoming, outgoing, (incoming.url || '').slice(5));
    } catch {
      outgoing.writeHead(503).end('MCP connection failed');
    }
    return RESPONSE_ALREADY_SENT;
  });
  return app;
}

// Node listener for the loopback agent server.
export function createAgentHandler(deps: AgentServerDependencies) {
  return getRequestListener(createAgentApp(deps).fetch);
}
