import { expectedCharacter } from '@wisp/protocol/character-key';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as NodeHttpServerRequest from '@effect/platform-node/NodeHttpServerRequest';
import { ByteSize, Effect } from 'effect';
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { z } from 'zod';
import { rpcRequests, rpcResponses } from '@wisp/protocol/agent-rpc';
import { actionTools } from '@wisp/protocol/game-actions';
import { routineInput, routineEvents } from '@wisp/protocol/routines';
import { panelInput } from '@wisp/protocol/panels';
import { simulationInput, simulationNeedsLiveState } from '@wisp/protocol/simulation';
import { databaseRequest } from '@wisp/protocol/database';
import { wowheadQuery } from '@wisp/protocol/search';
import type { Chat } from '../chat/events.ts';
import type { ReplyPresentation } from '@wisp/protocol/reply-presentation';
import type { ChatGPTAuth } from '../auth/chatgpt-auth.ts';
import type { McpRelay } from '../integrations/mcp/mcp-relay.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { RoutineStore } from '../routines/routine-store.ts';
import type { PanelStore } from '../addon/panels.ts';
import type { MemoryStore } from './memory-store.ts';
import type { GameRequests } from '../addon/game-requests.ts';
import type { DatabaseResult } from '../integrations/thewowdb.ts';
import type { Simulator } from '../integrations/simulation/simulator.ts';
import type { ModelConnections } from '../models/model-connections.ts';
import type { ModelFailures } from '../models/model-failures.ts';
import { proxyConnectionModel } from '../models/model-proxy.ts';
import { proxyModel } from '../models/model-proxy.ts';
import type { Logger } from '../logger.ts';
import type { WowheadSearch } from '../integrations/search/web-search.ts';
import type { UsageTelemetry } from '../telemetry.ts';
import { chooseChatModel } from '../chat/chat-model.ts';
import { readLoadedItems, retriesItemLoading } from '../addon/item-loading.ts';
import { searchGear } from '../integrations/gear-search.ts';
import { dungeonLoot } from '../integrations/dungeon-loot.ts';
import { itemSources } from '../integrations/item-sources.ts';
import { characterIdentity, conversationTitle, queryCharacterSections } from '../chat/context.ts';
export interface MemoryView {
  entries?: unknown[];
  status: string;
  error?: string;
  requestId?: string;
}
export interface AgentDependencies {
  logger?: Pick<Logger, 'info'>;
  telemetry?: Pick<UsageTelemetry, 'webSearch'>;
  token: string;
  auth: ChatGPTAuth;
  connections: ModelConnections;
  /** Records why model requests failed, for chat telemetry. */
  modelFailures?: ModelFailures;
  webSearch: WowheadSearch;
  mcpRelay: McpRelay;
  capabilitySettings: CapabilitySettings;
  routineStore: RoutineStore;
  panelStore: PanelStore;
  memoryStore: MemoryStore;
  pending: GameRequests;
  /** TheWoWDB catalog requests, run on the bridge's services. */
  database: {
    query(input: z.input<typeof databaseRequest>, signal?: AbortSignal): Promise<DatabaseResult>;
  };
  simulator: Simulator;
  getChats: () => Chat[];
  currentTransport: () => string;
  defaultModel: () => string;
  readSimulationCharacter: (chat?: string) => Promise<unknown>;
  memorySnapshot: (identity: string | undefined) => Promise<MemoryView>;
  setMemoryView: (view: MemoryView) => void;
  changed: () => void;
  presentReply: (
    chat: Chat,
    callId: string,
    presentation: ReplyPresentation,
    signal: AbortSignal,
  ) => Promise<ReplyPresentation>;
}
// The agent shows these messages to the model, so they are passed through unsanitized.
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failed = (error: unknown) => HttpServerResponse.text(failure(error), { status: 503 });

/**
 * Runs Promise work for a request. Its signal aborts when the agent hangs up
 * before the reply is written, which interrupts the request fiber.
 */
const work = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

/** Streams a reply on the raw Node request and response, as model proxies and the MCP relay do. */
const raw = (
  forward: (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void>,
  onFailure: (error: unknown, outgoing: ServerResponse) => void,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incoming = NodeHttpServerRequest.toIncomingMessage(request) as IncomingMessage;
    const outgoing = NodeHttpServerRequest.toServerResponse(request) as ServerResponse;
    yield* Effect.promise(() =>
      forward(incoming, outgoing).catch((error) => onFailure(error, outgoing)),
    );
    // The reply is already written; the server sends nothing more.
    return HttpServerResponse.empty();
  });

const tooLarge = (error: unknown) =>
  error instanceof HttpServerError.HttpServerError &&
  error.reason._tag === 'RequestParseError' &&
  error.reason.reason === 'BodyTooLarge';

const inspectionTools = {
  settings: 'get_settings',
  npc_locations: 'find_npc_locations',
  questie_quest: 'get_quest',
  questie_chain: 'get_quest_chain',
  object_locations: 'find_object_locations',
  stored_item: 'find_item',
  item_prices: 'get_item_prices',
  polestar_guide: 'get_guide_step',
  reference: 'inspect_reference',
  progression: 'query_progression',
  target: 'inspect_target',
  trainer: 'inspect_trainer',
  flight_paths: 'inspect_flight_paths',
  dungeons: 'query_dungeons',
  training: 'query_training',
  chat: 'read_chat',
  combat: 'read_combat',
  resources: 'query_resources',
  compare_items: 'compare_items',
  search_armor: 'search_armor',
  search_weapons: 'search_weapons',
  item_sources: 'item_sources',
  dungeon_loot: 'dungeon_loot',
  auctions: 'inspect_auctions',
  macros: 'inspect_macros',
  map: 'inspect_map',
  hearthstone: 'inspect_hearthstone',
} as const;

/**
 * The loopback server the agent's tools call. Every request carries the
 * bridge's token; tool routes name the agent session of a working chat on the
 * live game connection.
 */
export const makeAgentApp = Effect.fn('AgentServer.make')(function* (deps: AgentDependencies) {
  const {
    token,
    auth,
    connections,
    webSearch,
    mcpRelay,
    capabilitySettings,
    routineStore,
    panelStore,
    memoryStore,
    pending,
    database,
    simulator,
    getChats,
    currentTransport,
    defaultModel,
    readSimulationCharacter,
    memorySnapshot,
    setMemoryView,
    changed,
  } = deps;
  const expected = Buffer.from('Bearer ' + token);
  const router = yield* HttpRouter.make;

  // Model proxies and the MCP relay stream on the raw Node request and response.
  const modelFailed = (error: unknown, outgoing: ServerResponse) => {
    if (outgoing.headersSent) {
      outgoing.destroy();
    } else {
      outgoing
        .writeHead(503, { 'content-type': 'application/json', 'x-wisp-model-error': 'true' })
        .end(
          JSON.stringify({
            error: { message: error instanceof Error ? error.message : 'Model request failed' },
          }),
        );
    }
  };
  yield* router.add(
    'POST',
    '/model/responses',
    raw(
      (incoming, outgoing) => proxyModel(incoming, outgoing, auth, deps.logger, deps.modelFailures),
      modelFailed,
    ),
  );
  yield* router.add(
    'POST',
    '/model/connections/*',
    raw(
      (incoming, outgoing) =>
        proxyConnectionModel(incoming, outgoing, connections, deps.modelFailures),
      modelFailed,
    ),
  );
  yield* router.add(
    '*',
    '/mcp/*',
    raw(
      (incoming, outgoing) => mcpRelay.handle(incoming, outgoing, (incoming.url || '').slice(5)),
      (_, outgoing) => void outgoing.writeHead(503).end('MCP connection failed'),
    ),
  );

  yield* router.add(
    'GET',
    '/session-model',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const id = new URL(request.url, 'http://bridge.invalid').searchParams.get('session');
      const selection = yield* work(async () => {
        const chat = getChats().find(
          (chat) => chat.agentSession === id && chat.status === 'working',
        );
        if (!chat?.modelSettings) {
          throw Error('No model selected for this turn.');
        }
        const models = await connections.models();
        const selected = chooseChatModel(
          models,
          chat.modelSettings.model,
          chat.modelSettings.effort,
        );
        return {
          ...selected,
          ...(await connections.selection(selected.model)),
          webSearchAvailable:
            capabilitySettings.enabled('tool:web_search') && webSearch.available(selected.model),
          contextWindow: models.find((m) => m.slug === selected.model)?.contextWindow,
        };
      });
      return HttpServerResponse.jsonUnsafe(selection);
    }).pipe(Effect.catch((error) => Effect.succeed(failed(error)))),
  );

  // Tool calls from the agent: each names the agent session of a working chat on the live connection.
  interface ToolCall {
    raw: unknown;
    chat: Chat;
    /** Aborts when the agent hangs up before the reply is written. */
    signal: AbortSignal;
  }
  const operationShape = z.object({
    operation: z.string().optional(),
    input: z.object({ operation: z.string().optional() }).optional(),
  });
  const tool = (
    route: `/${string}`,
    handle: (call: ToolCall) => Promise<unknown>,
    maxSize = 32768,
  ) =>
    router.add(
      'POST',
      route,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.text.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxSize)),
          Effect.mapError((error) => (tooLarge(error) ? Error('Request is too large') : error)),
        );
        const result = yield* work(async (signal) => {
          const raw: unknown = JSON.parse(body);
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
            (route === '/action' ||
              (route === '/routines' &&
                !['catalog', 'list', 'get'].includes(operation.input?.operation || '')) ||
              (route === '/memory' && operation.operation !== 'list') ||
              (route === '/panels' &&
                ['save', 'remove'].includes(operation.input?.operation || '')))
          ) {
            throw Error(
              'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
            );
          }
          return handle({ raw, chat, signal });
        });
        return HttpServerResponse.jsonUnsafe(result);
      }).pipe(Effect.catch((error) => Effect.succeed(failed(error)))),
    );

  yield* tool('/present', async ({ raw, chat, signal }) => {
    const data = rpcRequests.present.parse(raw);
    return deps.presentReply(chat, data.callId, data.presentation, signal);
  });

  yield* tool(
    '/simulate',
    async ({ raw, chat, signal }) => {
      const data = rpcRequests.simulate.parse(raw);
      if (chat.proactive || !capabilitySettings.enabled('tool:simulate_dps')) {
        throw Error('DPS simulation is disabled or not allowed for automatic suggestions.');
      }
      const { agentSession: _session, ...args } = data;
      const input = simulationInput.parse(args);
      const needsLiveState = simulationNeedsLiveState(input);
      const snapshot = needsLiveState ? await readSimulationCharacter(chat.id) : undefined;
      if (
        needsLiveState &&
        (chat.owner !== currentTransport() ||
          (chat.characterKey && characterIdentity(snapshot) !== chat.characterKey))
      ) {
        throw Error('The character changed. Request a new simulation.');
      }
      return simulator.run(snapshot, input, signal);
    },
    1024 * 1024,
  );

  const knowledge = (route: '/database' | '/wowhead') =>
    tool(route, async ({ raw, chat, signal }) => {
      const data = z.object({ operation: z.string().optional() }).passthrough().parse(raw);
      const name =
        route === '/wowhead'
          ? 'web_search'
          : data.operation === 'search'
            ? 'search_database'
            : 'get_database_entity';
      if (!capabilitySettings.enabled('tool:' + name)) {
        throw new Error('This knowledge source is disabled in Settings');
      }
      const { agentSession: _session, ...args } = data;
      return route === '/database'
        ? database.query(databaseRequest.parse(args), signal)
        : measuredWebSearch(
            wowheadQuery.parse(args),
            chat.modelSettings?.model || defaultModel(),
            signal,
          );
    });
  // Web search is the slowest tool, so record its budget and outcome to tune depth defaults.
  async function measuredWebSearch(
    query: z.output<typeof wowheadQuery>,
    model: string,
    abort: AbortSignal,
  ) {
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
  yield* knowledge('/database');
  yield* knowledge('/wowhead');

  yield* tool('/routines', async ({ raw, chat }) => {
    const data = rpcRequests.routines.parse(raw);
    if (!capabilitySettings.enabled('tool:manage_routine')) {
      throw Error('Routines are disabled');
    }
    if (!chat.characterKey) {
      throw Error('A fresh character identity is required');
    }
    const input = routineInput.parse(data.input);
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

  yield* tool('/panels', async ({ raw, chat }) => {
    const data = rpcRequests.panels.parse(raw);
    if (!capabilitySettings.enabled('tool:manage_panel')) {
      throw Error('Persistent panels are disabled');
    }
    if (!chat.characterKey) {
      throw Error('A fresh character identity is required');
    }
    const input = panelInput.parse(data.input);
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

  yield* tool('/identity', async ({ chat }) => ({ characterKey: chat.characterKey || null }));

  yield* tool('/memory', async ({ raw, chat }) => {
    const data = rpcRequests.memory.parse(raw);
    if (data.slot !== 'preferences' && data.slot !== 'character') {
      throw new Error('Invalid memory scope');
    }
    if (!capabilitySettings.enabled('memory:' + data.slot)) {
      throw new Error('This memory capability is disabled in Settings');
    }
    const owner = data.slot === 'preferences' ? 'local-player' : chat.characterKey;
    if (!owner) {
      throw new Error('No fresh character identity for this memory');
    }
    let entries;
    if (data.operation === 'list') {
      entries = await memoryStore.read(data.slot, owner);
    } else if (data.operation === 'save' || data.operation === 'remove') {
      if (
        typeof data.key !== 'string' ||
        (data.operation === 'save' && typeof data.text !== 'string')
      ) {
        throw new Error('Invalid memory entry');
      }
      entries = await memoryStore.update(
        data.slot,
        owner,
        data.key,
        data.operation === 'save' ? data.text : undefined,
      );
      const snapshot = await memorySnapshot(chat.characterKey);
      if (chat.owner === currentTransport()) {
        setMemoryView(snapshot);
      }
      changed();
    } else {
      throw new Error('Invalid memory operation');
    }
    return { entries };
  });

  yield* tool('/title', async ({ raw, chat }) => {
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

  // Game reads and actions go to the addon through the pending-request mailbox.
  const game = (route: '/state' | '/inspect' | '/action') =>
    tool(route, async ({ raw, chat, signal: abort }) => {
      const inspection =
        route === '/inspect' ? rpcRequests.inspect.parse(raw).inspection : undefined;
      const action = route === '/action' ? rpcRequests.action.parse(raw).action : undefined;
      const name = action
        ? actionTools[action.kind]
        : inspection
          ? inspectionTools[inspection.kind]
          : 'query_character';
      if (!capabilitySettings.enabled('tool:' + name)) {
        throw new Error('This tool is disabled in Settings');
      }
      // A character switch reloads the addon and replaces its transport, which
      // `tool` already rejects. The expected character is a second check that
      // is sent only when the turn knew who was playing.
      const stateRequest = !inspection && !action ? rpcRequests.state.parse(raw) : undefined;
      if (stateRequest) {
        return queryCharacterSections(
          chat,
          stateRequest.sections,
          async (sections) =>
            rpcResponses.state.parse(
              await pending.request(
                { chat: chat.id, session: currentTransport(), sections, agent: true },
                abort,
              ),
            ),
          stateRequest.refresh,
        );
      }
      const request = (gameInspection = inspection as unknown) =>
        pending.request(
          {
            chat: chat.id,
            session: currentTransport(),
            agent: true,
            ...(action
              ? {
                  action: { ...action, expectedCharacter: expectedCharacter(chat.characterKey) },
                }
              : gameInspection
                ? { inspection: gameInspection }
                : {}),
          },
          abort,
        );
      if (inspection?.kind === 'search_armor' || inspection?.kind === 'search_weapons') {
        if (
          !capabilitySettings.enabled('mcp:everloot') ||
          !capabilitySettings.enabled('mcp_tool:everloot:item_categories')
        ) {
          throw new Error(
            'Gear search needs the Everloot integration and its item categories tool, which are off in Settings',
          );
        }
        return searchGear(
          inspection,
          (candidates) => readLoadedItems(() => request(candidates), abort),
          { signal: abort },
        );
      }
      if (inspection?.kind === 'dungeon_loot') {
        return dungeonLoot(inspection.args, (candidates) =>
          readLoadedItems(() => request(candidates), abort),
        );
      }
      if (inspection?.kind === 'item_sources') {
        return itemSources(inspection.args.itemIds, (names) => request(names), {
          everloot:
            capabilitySettings.enabled('mcp:everloot') &&
            capabilitySettings.enabled('mcp_tool:everloot:entity_relations'),
          questie: capabilitySettings.enabled('integration:questie'),
          auctionator:
            capabilitySettings.enabled('integration:auctionator') &&
            capabilitySettings.enabled('tool:get_item_prices'),
          signal: abort,
        });
      }
      return inspection && retriesItemLoading(inspection)
        ? readLoadedItems(() => request(), abort)
        : request();
    });
  yield* game('/state');
  yield* game('/inspect');
  yield* game('/action');

  const routes = router.asHttpEffect();
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const supplied = Buffer.from(request.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return HttpServerResponse.text('Forbidden', { status: 403 });
    }
    return yield* routes;
  });
});
