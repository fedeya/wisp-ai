import { z } from 'zod';
import { expectedCharacter } from '@wisp/protocol/character-key';
import { routineEvents } from '@wisp/protocol/routines';
import type { wowheadQuery } from '@wisp/protocol/search';
import { actionTools } from '@wisp/agent/contract/game-actions';
import { simulationNeedsLiveState } from '@wisp/agent/contract/simulation';
import type {
  AgentHostCalls,
  HostCall,
  HostRequests,
  HostResponses,
} from '@wisp/agent/contract/host-calls';
import type { ReplyPresentation } from '@wisp/agent/contract/reply-presentation';
import type { Chat } from '../chat/events.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { RoutineStore } from '../routines/routine-store.ts';
import type { PanelStore } from '../addon/panels.ts';
import type { MemoryStore } from './memory-store.ts';
import type { GameRequests } from '../addon/game-requests.ts';
import type { TheWoWDB } from '../integrations/thewowdb.ts';
import type { Simulator } from '../integrations/simulation/simulator.ts';
import type { ModelConnections } from '../models/model-connections.ts';
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

export interface AgentCallDependencies {
  telemetry?: Pick<UsageTelemetry, 'webSearch'>;
  connections: ModelConnections;
  webSearch: WowheadSearch;
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

/** A character reading the addon returned, as the agent reads it. */
const reading = z.record(z.string(), z.unknown());

type Handlers = {
  [K in HostCall]: (
    input: HostRequests[K],
    chat: Chat,
    signal: AbortSignal,
  ) => Promise<HostResponses[K]>;
};

/** Whether an automatic suggestion's call would change something the player owns. */
function changesPlayerData<K extends HostCall>(call: K, input: HostRequests[K]) {
  const request = input as HostRequests[HostCall];
  switch (call) {
    case 'action':
      return true;
    case 'routines':
      return !['catalog', 'list', 'get'].includes(
        (request as HostRequests['routines']).input.operation,
      );
    case 'memory':
      return (request as HostRequests['memory']).operation !== 'list';
    case 'panels':
      return ['save', 'remove'].includes((request as HostRequests['panels']).input.operation);
    default:
      return false;
  }
}

/**
 * What the agent asks of the bridge. The agent runs in this process, so its
 * tools call these directly: each call names the agent session of a working
 * chat on the live game connection. The tools validated their own input.
 */
export function createAgentCalls(deps: AgentCallDependencies): AgentHostCalls {
  const {
    connections,
    webSearch,
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

  // Game reads and actions go to the addon through the pending-request mailbox.
  async function game(
    chat: Chat,
    signal: AbortSignal,
    request:
      | { kind: 'state'; input: HostRequests['state'] }
      | { kind: 'inspect'; input: HostRequests['inspect'] }
      | { kind: 'action'; input: HostRequests['action'] },
  ) {
    const inspection = request.kind === 'inspect' ? request.input.inspection : undefined;
    const action = request.kind === 'action' ? request.input.action : undefined;
    const name = action
      ? actionTools[action.kind]
      : inspection
        ? inspectionTools[inspection.kind]
        : 'query_character';
    if (!capabilitySettings.enabled('tool:' + name)) {
      throw new Error('This tool is disabled in Settings');
    }
    // A character switch reloads the addon and replaces its transport, which
    // `call` already rejects. The expected character is a second check that
    // is sent only when the turn knew who was playing.
    if (request.kind === 'state') {
      return queryCharacterSections(
        chat,
        request.input.sections,
        async (sections) =>
          reading.parse(
            await pending.request(
              { chat: chat.id, session: currentTransport(), sections, agent: true },
              signal,
            ),
          ),
        request.input.refresh,
      );
    }
    const send = (gameInspection = inspection as unknown) =>
      pending.request(
        {
          chat: chat.id,
          session: currentTransport(),
          agent: true,
          ...(action
            ? { action: { ...action, expectedCharacter: expectedCharacter(chat.characterKey) } }
            : gameInspection
              ? { inspection: gameInspection }
              : {}),
        },
        signal,
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
        (candidates) => readLoadedItems(() => send(candidates), signal),
        {
          signal,
        },
      );
    }
    if (inspection?.kind === 'dungeon_loot') {
      return dungeonLoot(inspection.args, (candidates) =>
        readLoadedItems(() => send(candidates), signal),
      );
    }
    if (inspection?.kind === 'item_sources') {
      return itemSources(inspection.args.itemIds, (names) => send(names), {
        everloot:
          capabilitySettings.enabled('mcp:everloot') &&
          capabilitySettings.enabled('mcp_tool:everloot:entity_relations'),
        questie: capabilitySettings.enabled('integration:questie'),
        auctionator:
          capabilitySettings.enabled('integration:auctionator') &&
          capabilitySettings.enabled('tool:get_item_prices'),
        signal,
      });
    }
    return inspection && retriesItemLoading(inspection)
      ? readLoadedItems(() => send(), signal)
      : send();
  }

  const handlers: Handlers = {
    state: (input, chat, signal) => game(chat, signal, { kind: 'state', input }),
    inspect: (input, chat, signal) => game(chat, signal, { kind: 'inspect', input }),
    action: (input, chat, signal) => game(chat, signal, { kind: 'action', input }),

    present: (input, chat, signal) =>
      deps.presentReply(chat, input.callId, input.presentation, signal),

    simulate: async (input, chat, signal) => {
      if (chat.proactive || !capabilitySettings.enabled('tool:simulate_dps')) {
        throw Error('DPS simulation is disabled or not allowed for automatic suggestions.');
      }
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

    database: async (input, _chat, signal) => {
      const name = input.operation === 'search' ? 'search_database' : 'get_database_entity';
      if (!capabilitySettings.enabled('tool:' + name)) {
        throw new Error('This knowledge source is disabled in Settings');
      }
      return database.query(input, signal);
    },

    wowhead: async (input, chat, signal) => {
      if (!capabilitySettings.enabled('tool:web_search')) {
        throw new Error('This knowledge source is disabled in Settings');
      }
      return measuredWebSearch(input, chat.modelSettings?.model || defaultModel(), signal);
    },

    routines: async ({ input }, chat) => {
      if (!capabilitySettings.enabled('tool:manage_routine')) {
        throw Error('Routines are disabled');
      }
      if (!chat.characterKey) {
        throw Error('A fresh character identity is required');
      }
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
    },

    panels: async ({ input }, chat) => {
      if (!capabilitySettings.enabled('tool:manage_panel')) {
        throw Error('Persistent panels are disabled');
      }
      if (!chat.characterKey) {
        throw Error('A fresh character identity is required');
      }
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
    },

    identity: async (_input, chat) => ({ characterKey: chat.characterKey || null }),

    memory: async (input, chat) => {
      if (!capabilitySettings.enabled('memory:' + input.slot)) {
        throw new Error('This memory capability is disabled in Settings');
      }
      const owner = input.slot === 'preferences' ? 'local-player' : chat.characterKey;
      if (!owner) {
        throw new Error('No fresh character identity for this memory');
      }
      if (input.operation === 'list') {
        return { entries: await memoryStore.read(input.slot, owner) };
      }
      const entries = await memoryStore.update(
        input.slot,
        owner,
        input.key,
        input.operation === 'save' ? input.text : undefined,
      );
      const snapshot = await memorySnapshot(chat.characterKey);
      if (chat.owner === currentTransport()) {
        setMemoryView(snapshot);
      }
      changed();
      return { entries };
    },

    title: async (input, chat) => {
      if (!capabilitySettings.enabled('tool:set_conversation_title')) {
        throw new Error('Conversation titles are disabled in Settings');
      }
      const title = conversationTitle(input.title);
      if (!title) {
        throw new Error('A conversation title is required');
      }
      chat.title = title;
      chat.titleGenerated = true;
      changed();
      return { title };
    },
  };

  return {
    async call(session, call, input, signal) {
      const chat = getChats().find((c) => c.agentSession === session && c.status === 'working');
      // A simulation of a hypothetical character needs no live game connection.
      const detached =
        call === 'simulate' && !simulationNeedsLiveState(input as HostRequests['simulate']);
      if (!chat || (!detached && (!currentTransport() || chat.owner !== currentTransport()))) {
        throw new Error('No active connection for this character');
      }
      if (chat.proactive && changesPlayerData(call, input)) {
        throw Error(
          'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
        );
      }
      return handlers[call](input, chat, signal);
    },

    async selectedModel(session) {
      const chat = getChats().find((c) => c.agentSession === session && c.status === 'working');
      if (!chat?.modelSettings) {
        throw Error('No model selected for this turn.');
      }
      const models = await connections.models();
      const selected = chooseChatModel(models, chat.modelSettings.model, chat.modelSettings.effort);
      return {
        ...selected,
        ...(await connections.selection(selected.model)),
        webSearchAvailable:
          capabilitySettings.enabled('tool:web_search') && webSearch.available(selected.model),
        contextWindow: models.find((m) => m.slug === selected.model)?.contextWindow,
      };
    },
  };
}
