import { parseCharacterKey } from '@wisp/protocol/character-key';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { rpcRequests, rpcResponses } from '@wisp/protocol/agent-rpc';
import { actionTools } from '@wisp/protocol/game-actions';
import { routineInput, routineEvents } from '@wisp/protocol/routines';
import { panelInput } from '@wisp/protocol/panels';
import { simulationInput, simulationNeedsLiveState } from '@wisp/protocol/simulation';
import { databaseRequest } from '@wisp/protocol/database';
import { wowheadQuery } from '@wisp/protocol/search';
import type { Chat } from './events.ts';
import type { ReplyPresentation } from '@wisp/protocol/reply-presentation';
import type { ChatGPTAuth } from './chatgpt-auth.ts';
import type { McpRelay } from './mcp-relay.ts';
import type { CapabilitySettings } from './capabilities.ts';
import type { RoutineStore } from './routines.ts';
import type { PanelStore } from './panels.ts';
import type { MemoryStore } from './memory-store.ts';
import type { GameRequests } from './game-requests.ts';
import type { TheWoWDB } from './thewowdb.ts';
import type { Simulator } from './simulation.ts';
import type { ModelConnections } from './model-connections.ts';
import { proxyConnectionModel } from './model-proxy.ts';
import { proxyModel } from './model-proxy.ts';
import type { WowheadSearch } from './web-search.ts';
import { chooseChatModel } from './chat-model.ts';
import { characterIdentity, conversationTitle, queryCharacterSections } from './context.ts';
export interface MemoryView {
  entries?: unknown[];
  status: string;
  error?: string;
  requestId?: string;
}
interface AgentDependencies {
  log?: (message: string) => void;
  token: string;
  auth: ChatGPTAuth;
  connections: ModelConnections;
  webSearch: WowheadSearch;
  mcpRelay: McpRelay;
  capabilitySettings: CapabilitySettings;
  routineStore: RoutineStore;
  panelStore: PanelStore;
  memoryStore: MemoryStore;
  pending: GameRequests;
  database: TheWoWDB;
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
export function createAgentHandler(deps: AgentDependencies) {
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
  return async (req: IncomingMessage, res: ServerResponse) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (
      req.method === 'POST' &&
      (req.url === '/model/responses' || req.url?.startsWith('/model/connections/'))
    ) {
      try {
        if (req.url === '/model/responses') {
          await proxyModel(req, res, auth, deps.log);
        } else {
          await proxyConnectionModel(req, res, connections);
        }
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
        } else {
          res
            .writeHead(503, { 'content-type': 'application/json', 'x-wisp-model-error': 'true' })
            .end(
              JSON.stringify({
                error: { message: e instanceof Error ? e.message : 'Model request failed' },
              }),
            );
        }
      }
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/session-model?')) {
      try {
        const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('session');
        const chat = getChats().find((chat) => chat.eveId === id && chat.status === 'working');
        if (!chat?.modelSettings) {
          throw Error('No model selected for this turn.');
        }
        const models = await connections.models();
        const selected = chooseChatModel(
          models,
          chat.modelSettings.model,
          chat.modelSettings.effort,
        );
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ...selected,
            ...(await connections.selection(selected.model)),
            webSearchAvailable:
              capabilitySettings.enabled('tool:web_search') && webSearch.available(selected.model),
            contextWindow: models.find((m) => m.slug === selected.model)?.contextWindow,
          }),
        );
      } catch (error) {
        res.writeHead(503).end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if ((req.url || '').startsWith('/mcp/')) {
      try {
        await mcpRelay.handle(req, res, (req.url || '').slice(5));
      } catch {
        res.writeHead(503).end('MCP connection failed');
      }
      return;
    }
    if (
      req.method !== 'POST' ||
      ![
        '/state',
        '/title',
        '/present',
        '/identity',
        '/memory',
        '/inspect',
        '/action',
        '/panels',
        '/routines',
        '/database',
        '/wowhead',
        '/simulate',
      ].includes(req.url || '')
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      req.setEncoding('utf8');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > (req.url === '/simulate' ? 1024 * 1024 : 32768)) {
          throw new Error('Request is too large');
        }
      }
      const raw: unknown = JSON.parse(body);
      const { eveSession } = z.object({ eveSession: z.string().min(1) }).parse(raw);
      const operation = z
        .object({
          operation: z.string().optional(),
          input: z.object({ operation: z.string().optional() }).optional(),
        })
        .parse(raw);
      const chat = getChats().find((c) => c.eveId === eveSession && c.status === 'working');
      let detachedSimulation = false;
      if (req.url === '/simulate') {
        const { eveSession: _session, ...args } = rpcRequests.simulate.parse(raw);
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
        (req.url === '/action' ||
          (req.url === '/routines' &&
            !['catalog', 'list', 'get'].includes(operation.input?.operation || '')) ||
          (req.url === '/memory' && operation.operation !== 'list') ||
          (req.url === '/panels' && ['save', 'remove'].includes(operation.input?.operation || '')))
      ) {
        throw Error(
          'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
        );
      }
      if (req.url === '/present') {
        const data = rpcRequests.present.parse(raw);
        const abort = new AbortController();
        res.once('close', () => {
          if (!res.writableEnded) {
            abort.abort();
          }
        });
        const result = await deps.presentReply(chat, data.callId, data.presentation, abort.signal);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (req.url === '/simulate') {
        const data = rpcRequests.simulate.parse(raw);
        if (chat.proactive || !capabilitySettings.enabled('tool:simulate_dps')) {
          throw Error('DPS simulation is disabled or not allowed for automatic suggestions.');
        }
        const { eveSession: _session, ...args } = data;
        const input = simulationInput.parse(args);
        const abort = new AbortController();
        res.once('close', () => {
          if (!res.writableEnded) {
            abort.abort();
          }
        });
        const needsLiveState = simulationNeedsLiveState(input);
        const snapshot = needsLiveState ? await readSimulationCharacter(chat.id) : undefined;
        if (
          needsLiveState &&
          (chat.owner !== currentTransport() ||
            (chat.characterKey && characterIdentity(snapshot) !== chat.characterKey))
        ) {
          throw Error('The character changed. Request a new simulation.');
        }
        const result = await simulator.run(snapshot, input, abort.signal);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (req.url === '/database' || req.url === '/wowhead') {
        const data = z.object({ operation: z.string().optional() }).passthrough().parse(raw);
        const tool =
          req.url === '/wowhead'
            ? 'web_search'
            : data.operation === 'search'
              ? 'search_database'
              : 'get_database_entity';
        if (!capabilitySettings.enabled('tool:' + tool)) {
          throw new Error('This knowledge source is disabled in Settings');
        }
        const abort = new AbortController();
        res.once('close', () => {
          if (!res.writableEnded) {
            abort.abort();
          }
        });
        const { eveSession: _session, ...args } = data;
        const result =
          req.url === '/database'
            ? await database.query(databaseRequest.parse(args), abort.signal)
            : await webSearch.search(
                wowheadQuery.parse(args),
                chat.modelSettings?.model || defaultModel(),
                abort.signal,
              );
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (req.url === '/routines') {
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            input.operation === 'catalog'
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
                : { routines },
          ),
        );
        return;
      }
      if (req.url === '/panels') {
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            input.operation === 'get'
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
                : { panels },
          ),
        );
        return;
      }
      if (req.url === '/identity') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ characterKey: chat.characterKey || null }));
        return;
      }
      if (req.url === '/memory') {
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entries }));
        return;
      }
      if (req.url === '/title') {
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ title }));
        return;
      }
      const inspection =
        req.url === '/inspect' ? rpcRequests.inspect.parse(raw).inspection : undefined;
      const action = req.url === '/action' ? rpcRequests.action.parse(raw).action : undefined;
      const tool = action
        ? actionTools[action.kind]
        : inspection
          ? (
              {
                settings: 'get_settings',
                npc_locations: 'find_npc_locations',
                questie_quest: 'get_quest',
                questie_chain: 'get_quest_chain',
                object_locations: 'find_object_locations',
                stored_item: 'find_item',
                item_prices: 'get_item_prices',
                reference: 'inspect_reference',
                progression: 'query_progression',
                target: 'inspect_target',
                trainer: 'inspect_trainer',
                merchant: 'inspect_merchant',
                training: 'query_training',
                chat: 'read_chat',
                resources: 'query_resources',
                compare_items: 'compare_items',
                quest_rewards: 'inspect_quest_rewards',
                auctions: 'inspect_auctions',
                macros: 'inspect_macros',
                map: 'inspect_map',
              } as const
            )[inspection.kind]
          : 'query_character';
      if (!capabilitySettings.enabled('tool:' + tool)) {
        throw new Error('This tool is disabled in Settings');
      }
      if (action && !chat.characterKey) {
        throw new Error('A fresh character identity is required before applying an action');
      }
      const stateRequest = !inspection && !action ? rpcRequests.state.parse(raw) : undefined;
      const identity = action ? parseCharacterKey(chat.characterKey!) : undefined;
      const abort = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) {
          abort.abort();
        }
      });
      if (stateRequest) {
        const result = await queryCharacterSections(
          chat,
          stateRequest.sections,
          async (sections) =>
            rpcResponses.state.parse(
              await pending.request(
                { chat: chat.id, session: currentTransport(), sections },
                abort.signal,
              ),
            ),
          stateRequest.refresh,
        );
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      const result = await pending.request(
        {
          chat: chat.id,
          session: currentTransport(),
          ...(action
            ? {
                action: {
                  ...action,
                  expectedCharacter: { realm: identity!.realm, name: identity!.name },
                },
              }
            : inspection
              ? { inspection }
              : {}),
        },
        abort.signal,
      );
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(503).end(error instanceof Error ? error.message : String(error));
    }
  };
}
