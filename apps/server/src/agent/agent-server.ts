import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { rpcRequests } from '@wisp/agent/contract/agent-rpc';
import { Effect, Schema } from 'effect';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { routineEvents } from '@wisp/protocol/routines';
import { simulationNeedsLiveState } from '@wisp/agent/contract/simulation';
import { databaseRequest } from '@wisp/agent/contract/database';
import { KeyedRecord } from '@wisp/agent/contract/tool-inputs';
import { wowheadQuery, type WebSearchQuery } from '@wisp/protocol/search';
import type { Chat } from '../chat/events.ts';
import type { ReplyPresentation } from '@wisp/agent/contract/reply-presentation';
import type { PromiseChatGPTAuth } from '../auth/index.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { RoutineStore } from '../routines/routine-store.ts';
import type { PanelStore } from '../panels/panel-store.ts';
import type { TheWoWDB } from '../integrations/thewowdb/index.ts';
import type { Simulator } from '../integrations/simulation/simulator.ts';
import type { ModelConnections } from '../models/model-connections.ts';
import type { ModelFailures } from '../models/model-failures.ts';
import { proxyConnectionModel } from '../models/model-proxy.ts';
import { createModelProxy } from '../models/model-proxy.ts';
import type { WowheadSearch } from '../integrations/search/web-search.ts';
import type { UsageTelemetry } from '../telemetry.ts';
import { chooseChatModel } from '../chat/chat-model.ts';
import { characterIdentity, conversationTitle } from '../chat/context.ts';
interface AgentDependencies {
  telemetry?: Pick<UsageTelemetry, 'webSearch'>;
  token: string;
  auth: PromiseChatGPTAuth;
  connections: ModelConnections;
  /** Records why model requests failed, for chat telemetry. */
  modelFailures?: ModelFailures;
  webSearch: WowheadSearch;
  capabilitySettings: CapabilitySettings;
  routineStore: RoutineStore;
  panelStore: PanelStore;
  database: TheWoWDB['Service'];
  simulator: Simulator['Service'];
  getChats: () => Chat[];
  currentTransport: () => string;
  defaultModel: () => string;
  readSimulationCharacter: (chat?: string) => Promise<unknown>;
  changed: () => void;
  presentReply: (
    chat: Chat,
    callId: string,
    presentation: ReplyPresentation,
    signal: AbortSignal,
  ) => Promise<ReplyPresentation>;
}
type AgentContext = Context<{ Bindings: HttpBindings }>;
// Web search requests are strict, like the protocol schema they use.
const decodeWebSearch = Schema.decodeUnknownSync(wowheadQuery, rejectUnknownKeys);
// Database requests are strict, like their contract.
const decodeDatabase = Schema.decodeUnknownSync(databaseRequest, rejectUnknownKeys);
// A knowledge request: its operation, if any, and every other key as sent but an
// own `__proto__`, which zod's `passthrough` dropped.
const decodeKnowledge = Schema.decodeUnknownSync(
  Schema.StructWithRest(Schema.Struct({ operation: Schema.optionalKey(Schema.String) }), [
    KeyedRecord(Schema.String, Schema.Unknown),
  ]),
);
// The agent shows these messages to the model, so they are passed through unsanitized.
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Aborts the game, simulator or search work when the agent hangs up before the reply is written.
function abortOnHangUp(c: AgentContext) {
  const abort = new AbortController();
  const { outgoing } = c.env;
  outgoing.once('close', () => {
    if (!outgoing.writableEnded) {
      abort.abort();
    }
  });
  return abort.signal;
}
export const createAgentApp = Effect.fnUntraced(function* (deps: AgentDependencies) {
  // Runs migrated services from the Hono handlers; a hang-up interrupts the run.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const proxyChatGPT = yield* createModelProxy(deps.auth, deps.modelFailures);
  const {
    token,
    connections,
    webSearch,
    capabilitySettings,
    routineStore,
    panelStore,
    database,
    simulator,
    getChats,
    currentTransport,
    defaultModel,
    readSimulationCharacter,
    changed,
  } = deps;
  const expected = Buffer.from('Bearer ' + token);
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.notFound((c) => c.body(null, 404));
  app.use(async (c, next) => {
    const supplied = Buffer.from(c.req.header('authorization') || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.text('Forbidden', 403);
    }
    await next();
    return undefined;
  });

  // Model proxies stream on the raw Node request and response.
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
    proxy((c) => proxyChatGPT(c.env.incoming, c.env.outgoing)),
  );
  app.post(
    '/model/connections/*',
    proxy((c) =>
      proxyConnectionModel(c.env.incoming, c.env.outgoing, connections, deps.modelFailures),
    ),
  );

  app.get('/session-model', async (c) => {
    try {
      const id = c.req.query('session');
      const chat = getChats().find((chat) => chat.agentSession === id && chat.status === 'working');
      if (!chat?.modelSettings) {
        throw Error('No model selected for this turn.');
      }
      const models = await connections.models();
      const selected = chooseChatModel(models, chat.modelSettings.model, chat.modelSettings.effort);
      return c.json({
        ...selected,
        ...(await connections.selection(selected.model)),
        webSearchAvailable:
          capabilitySettings.enabled('tool:web_search') && webSearch.available(selected.model),
        contextWindow: models.find((m) => m.slug === selected.model)?.contextWindow,
      });
    } catch (error) {
      return c.text(failure(error), 503);
    }
  });

  // Tool calls from the agent: each names the agent session of a working chat on the live connection.
  interface ToolCall {
    raw: unknown;
    chat: Chat;
    signal: () => AbortSignal;
  }
  const operationShape = z.object({
    input: z.object({ operation: z.string().optional() }).optional(),
  });
  function tool(
    route: string,
    handle: (call: ToolCall, c: AgentContext) => Promise<unknown>,
    maxSize = 32768,
  ) {
    app.post(
      route,
      bodyLimit({ maxSize, onError: (c) => c.text('Request is too large', 503) }),
      async (c) => {
        try {
          const raw: unknown = JSON.parse(await c.req.text());
          const { agentSession } = z.object({ agentSession: z.string().min(1) }).parse(raw);
          const operation = operationShape.parse(raw);
          const chat = getChats().find(
            (c) => c.agentSession === agentSession && c.status === 'working',
          );
          let detachedSimulation = false;
          if (route === '/simulate') {
            const { agentSession: _session, ...args } = rpcRequests.simulate.parse(raw);
            detachedSimulation = !simulationNeedsLiveState(args);
          }
          if (
            !chat ||
            (!detachedSimulation && (!currentTransport() || chat.owner !== currentTransport()))
          ) {
            throw new Error('No active connection for this character');
          }
          if (
            chat.proactive &&
            ((route === '/routines' &&
              !['catalog', 'list', 'get'].includes(operation.input?.operation || '')) ||
              (route === '/panels' &&
                ['save', 'remove'].includes(operation.input?.operation || '')))
          ) {
            throw Error(
              'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
            );
          }
          let signal: AbortSignal | undefined;
          const result = await handle(
            { raw, chat, signal: () => (signal ??= abortOnHangUp(c)) },
            c,
          );
          return c.json(result as object);
        } catch (error) {
          return c.text(failure(error), 503);
        }
      },
    );
  }

  tool('/present', async ({ raw, chat, signal }) => {
    const data = rpcRequests.present.parse(raw);
    return deps.presentReply(chat, data.callId, data.presentation, signal());
  });

  tool(
    '/simulate',
    async ({ raw, chat, signal }) => {
      const data = rpcRequests.simulate.parse(raw);
      if (chat.proactive || !capabilitySettings.enabled('tool:simulate_dps')) {
        throw Error('DPS simulation is disabled or not allowed for automatic suggestions.');
      }
      // The request decodes the simulation's own schema, defaults included.
      const { agentSession: _session, ...input } = data;
      const abort = signal();
      const needsLiveState = simulationNeedsLiveState(input);
      const snapshot = needsLiveState ? await readSimulationCharacter(chat.id) : undefined;
      if (
        needsLiveState &&
        (chat.owner !== currentTransport() ||
          (chat.characterKey && characterIdentity(snapshot) !== chat.characterKey))
      ) {
        throw Error('The character changed. Request a new simulation.');
      }
      return runPromise(simulator.run(snapshot, input), { signal: abort });
    },
    1024 * 1024,
  );

  const knowledge = (route: '/database' | '/wowhead') =>
    tool(route, async ({ raw, chat, signal }) => {
      const data = decodeKnowledge(raw);
      const name =
        route === '/wowhead'
          ? 'web_search'
          : data.operation === 'search'
            ? 'search_database'
            : 'get_database_entity';
      if (!capabilitySettings.enabled('tool:' + name)) {
        throw new Error('This knowledge source is disabled in Settings');
      }
      const abort = signal();
      const { agentSession: _session, ...args } = data;
      return route === '/database'
        ? // Hanging up interrupts the lookup, which cancels its request.
          runPromise(database.query(decodeDatabase(args)), { signal: abort })
        : measuredWebSearch(
            decodeWebSearch(args),
            chat.modelSettings?.model || defaultModel(),
            abort,
          );
    });
  // Web search is the slowest tool, so record its budget and outcome to tune depth defaults.
  async function measuredWebSearch(query: WebSearchQuery, model: string, abort: AbortSignal) {
    const started = performance.now();
    try {
      const result = await webSearch.search(query, model, abort);
      deps.telemetry?.webSearch({
        depth: query.depth,
        provider: result.provider,
        outcome: result.status,
        duration: performance.now() - started,
        resultCount: result.sources.length,
      });
      return result;
    } catch (error) {
      deps.telemetry?.webSearch({
        depth: query.depth,
        provider: undefined,
        outcome: 'failed',
        duration: performance.now() - started,
        resultCount: 0,
      });
      throw error;
    }
  }
  knowledge('/database');
  knowledge('/wowhead');

  tool('/routines', async ({ raw, chat }) => {
    const data = rpcRequests.routines.parse(raw);
    if (!capabilitySettings.enabled('tool:manage_routine')) {
      throw Error('Routines are disabled');
    }
    if (!chat.characterKey) {
      throw Error('A fresh character identity is required');
    }
    const { input } = data;
    const routines = ['save', 'pause', 'resume', 'remove'].includes(input.operation)
      ? await routineStore.mutate(chat.characterKey, input, chat.id)
      : routineStore.list(chat.characterKey);
    changed();
    return input.operation === 'catalog'
      ? {
          events: routineEvents,
          interval: { minimumSeconds: 60, onlineOnly: true },
          filters: ['eq', 'ne', 'gte', 'lte', 'contains', 'multiple_of'],
          semantics:
            'Triggers OR; filters AND; events coalesce during combat/busy/cooldown. No arbitrary code.',
        }
      : input.operation === 'get'
        ? {
            routine: routines.find((r) => r.id === input.id) || null,
            runs: routineStore.history({
              characterKey: chat.characterKey,
              routineId: input.id,
              limit: 20,
            }),
          }
        : { routines };
  });

  tool('/panels', async ({ raw, chat }) => {
    const data = rpcRequests.panels.parse(raw);
    if (!capabilitySettings.enabled('tool:manage_panel')) {
      throw Error('Persistent panels are disabled');
    }
    if (!chat.characterKey) {
      throw Error('A fresh character identity is required');
    }
    // The request decodes the panel input's own schema.
    const { input } = data;
    const panels =
      input.operation === 'save' || input.operation === 'remove'
        ? await panelStore.mutate(chat.characterKey, input)
        : panelStore.list(chat.characterKey);
    changed();
    return input.operation === 'get'
      ? { panel: panels.find((p) => p.id === input.id) || null }
      : input.operation === 'list'
        ? {
            panels: panels.map((p) => ({
              id: p.id,
              title: p.title,
              bindings: p.bindings,
              updatedAt: p.updatedAt,
            })),
          }
        : { panels };
  });

  tool('/title', async ({ raw, chat }) => {
    const data = rpcRequests.title.parse(raw);
    if (!capabilitySettings.enabled('tool:set_conversation_title')) {
      throw new Error('Conversation titles are disabled in Settings');
    }
    const title = conversationTitle(data.title);
    if (!title) {
      throw new Error('A conversation title is required');
    }
    chat.title = title;
    chat.titleGenerated = true;
    changed();
    return { title };
  });

  return app;
});
// Node listener for the loopback agent server.
export function createAgentHandler(deps: AgentDependencies) {
  return createAgentApp(deps).pipe(Effect.map((app) => getRequestListener(app.fetch)));
}
