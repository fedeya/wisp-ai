import { Effect, Schema } from 'effect';
import { GameAccess, gameReading, inspectWith } from '@wisp/agent/game-access';
import { actionSchema, actionTools } from '@wisp/agent/contract/game-actions';
import { expectedCharacter } from '@wisp/protocol/character-key';
import type { McpManager } from '@wisp/agent/mcp-manager';
import * as Everloot from '@wisp/agent/everloot';
import type { Connection, GameCall } from '@wisp/wow-bridge';
import type { Chat } from '../chat/events.ts';
import { queryCharacterSections } from '../chat/context.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import { searchGear } from '../integrations/gear-search.ts';
import { itemSources } from '../integrations/item-sources.ts';
import { readLoadedItems, retriesItemLoading } from './item-loading.ts';
import { errorMessage } from '../errors.ts';

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
  // Direct candidate reads are the live portion of the agent's dungeon loot tool.
  gear_candidates: 'dungeon_loot',
  auctions: 'inspect_auctions',
  macros: 'inspect_macros',
  map: 'inspect_map',
  hearthstone: 'inspect_hearthstone',
} as const;

interface Dependencies {
  getChats: () => readonly Chat[];
  currentTransport: () => string;
  requestGame: Connection['request'];
  capabilitySettings: Pick<CapabilitySettings, 'enabled'>;
  mcpManager: Pick<McpManager, 'call'>;
}

const asError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(errorMessage(cause));
const parseReading = Schema.decodeUnknownEffect(gameReading);

export function make(deps: Dependencies) {
  const { capabilitySettings } = deps;
  const authorize = Effect.fnUntraced(function* (session: string, tool: string, mutates = false) {
    const owner = deps.currentTransport();
    const chat = deps
      .getChats()
      .find((chat) => chat.agentSession === session && chat.status === 'working');
    if (!owner || !chat || chat.owner !== owner) {
      return yield* Effect.fail(new Error('No active connection for this character'));
    }
    if (mutates && chat.proactive) {
      return yield* Effect.fail(
        new Error(
          'Automatic suggestions cannot change settings, memory, panels, macros or map markers',
        ),
      );
    }
    if (!capabilitySettings.enabled('tool:' + tool)) {
      return yield* Effect.fail(new Error('This tool is disabled in Settings'));
    }
    const character = chat.characterKey;
    const request = (operation: GameCall['operation']) =>
      Effect.suspend(() => {
        if (
          deps.currentTransport() !== owner ||
          chat.owner !== owner ||
          chat.characterKey !== character ||
          chat.agentSession !== session ||
          chat.status !== 'working' ||
          !deps.getChats().includes(chat)
        ) {
          return Effect.fail(new Error('No active connection for this character'));
        }
        return deps.requestGame({ chat: chat.id, session: owner, agent: true, operation });
      });
    return { chat, character, request };
  });

  const everlootAllowed = (tool: Everloot.LookupTool) =>
    capabilitySettings.enabled('mcp:' + Everloot.name) &&
    capabilitySettings.enabled('mcp_tool:' + Everloot.name + ':' + tool);

  return GameAccess.of({
    readCharacter: Effect.fn('GameAccess.readCharacter')(function* (session, sections, refresh) {
      const { chat, request } = yield* authorize(session, 'query_character');
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      return yield* Effect.tryPromise({
        try: (signal) =>
          queryCharacterSections(
            chat,
            sections,
            (sections) =>
              run(request({ kind: 'read', sections }).pipe(Effect.flatMap(parseReading)), {
                signal,
              }),
            refresh,
          ),
        catch: asError,
      });
    }),
    inspectGame: inspectWith(
      {
        item_sources: Effect.fn('GameAccess.itemSources')(function* (session, inspection) {
          const { request } = yield* authorize(session, inspectionTools[inspection.kind]);
          const run = Effect.runPromiseWith(yield* Effect.context<never>());
          return yield* Effect.tryPromise({
            try: (signal) =>
              itemSources(
                inspection.args.itemIds,
                (input) => run(request({ kind: 'inspect', inspection: input }), { signal }),
                {
                  everloot: everlootAllowed('entity_relations'),
                  questie: capabilitySettings.enabled('integration:questie'),
                  auctionator:
                    capabilitySettings.enabled('integration:auctionator') &&
                    capabilitySettings.enabled('tool:get_item_prices'),
                  readEverloot: (tool, args) =>
                    run(
                      Everloot.read(deps.mcpManager, tool, args, () => everlootAllowed(tool)),
                      { signal },
                    ),
                },
              ),
            catch: asError,
          });
        }),
      },
      Effect.fn('GameAccess.inspectGame')(function* (session, inspection) {
        const { request } = yield* authorize(session, inspectionTools[inspection.kind]);
        const inspect = (inspection: unknown) => request({ kind: 'inspect', inspection });
        if (
          inspection.kind !== 'search_armor' &&
          inspection.kind !== 'search_weapons' &&
          !retriesItemLoading(inspection)
        ) {
          return yield* inspect(inspection);
        }
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const read = (input: unknown) => run(inspect(input), { signal });
            const readItems = (input: unknown) => readLoadedItems(() => read(input), signal);
            const readEverloot: Everloot.Lookup = (tool, args) =>
              run(
                Everloot.read(deps.mcpManager, tool, args, () => everlootAllowed(tool)),
                { signal },
              );
            switch (inspection.kind) {
              case 'search_armor':
              case 'search_weapons':
                if (!everlootAllowed('item_categories')) {
                  throw new Error(
                    'Gear search needs the Everloot integration and its item categories tool, which are off in Settings',
                  );
                }
                return searchGear(inspection, readItems, readEverloot);
              default:
                return readItems(inspection);
            }
          },
          catch: asError,
        });
      }),
    ),
    runGameAction: Effect.fn('GameAccess.runGameAction')(function* (session, input) {
      const action = yield* Effect.try({ try: () => actionSchema.parse(input), catch: asError });
      const { character, request } = yield* authorize(session, actionTools[action.kind], true);
      return yield* request({
        kind: 'act',
        action: { ...action, expectedCharacter: expectedCharacter(character) },
      }).pipe(Effect.flatMap(parseReading));
    }),
  });
}
