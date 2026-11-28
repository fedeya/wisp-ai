import {
  characterSections,
  gearSearchInspectionSchema,
  inspectionParseOptions,
  inspectionSchema,
  itemSourcesInput,
} from '@wisp/agent/contract/game-inspection';
import { Effect, Schema } from 'effect';
import {
  inspectionResults,
  gameReading,
  itemSourcesResult,
  type GameInspection,
} from '@wisp/agent/game-access';
import * as Game from '@wisp/agent/game-access';
import { actionSchema, actionTools } from '@wisp/agent/contract/game-actions';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
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
  // Direct candidate reads are the live portion of the agent's dungeon loot tool.
  gear_candidates: 'dungeon_loot',
  auctions: 'inspect_auctions',
  macros: 'inspect_macros',
  map: 'inspect_map',
  hearthstone: 'inspect_hearthstone',
} satisfies Record<GameInspection['kind'], string>;

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
const decodeInspection = Schema.decodeUnknownEffect(inspectionSchema);
const decodeGearSearch = Schema.decodeUnknownEffect(gearSearchInspectionSchema);
const decodeSections = Schema.decodeUnknownEffect(characterSections);
const decodeItemSources = Schema.decodeUnknownEffect(itemSourcesInput);

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

  type InspectionKind = GameInspection['kind'];
  type InspectionArgs<K extends InspectionKind> = Extract<GameInspection, { kind: K }>['args'];

  const inspectionMethod = <K extends InspectionKind, A>(kind: K, schema: Schema.Decoder<A>) => {
    const decode = Schema.decodeUnknownEffect(schema);
    return Effect.fn(`GameAccess.inspect.${kind}`)(function* (
      session: string,
      args: InspectionArgs<K>,
    ) {
      const inspection = yield* decodeInspection({ kind, args }, inspectionParseOptions(kind));
      const { request } = yield* authorize(session, inspectionTools[kind]);
      const read = request({ kind: 'inspect', inspection });
      if (!retriesItemLoading(inspection)) return yield* read.pipe(Effect.flatMap(decode));

      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      return yield* Effect.tryPromise({
        try: (signal) => readLoadedItems(() => run(read, { signal }), signal),
        catch: asError,
      }).pipe(Effect.flatMap(decode));
    });
  };

  const gearSearchMethod = <K extends 'search_armor' | 'search_weapons'>(kind: K) =>
    Effect.fn(`GameAccess.inspect.${kind}`)(function* (session: string, args: InspectionArgs<K>) {
      const inspection = yield* decodeGearSearch({ kind, args }, rejectUnknownKeys);
      const { request } = yield* authorize(session, inspectionTools[kind]);
      if (!everlootAllowed('item_categories')) {
        return yield* Effect.fail(
          new Error(
            'Gear search needs the Everloot integration and its item categories tool, which are off in Settings',
          ),
        );
      }
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      return yield* Effect.tryPromise({
        try: (signal) =>
          searchGear(
            inspection,
            async (candidateRead) => {
              const read = request({ kind: 'inspect', inspection: candidateRead });
              const result = await readLoadedItems(() => run(read, { signal }), signal);
              return run(Schema.decodeUnknownEffect(inspectionResults.gear_candidates)(result), {
                signal,
              });
            },
            (tool, args) =>
              run(
                Everloot.read(deps.mcpManager, tool, args, () => everlootAllowed(tool)),
                {
                  signal,
                },
              ),
          ),
        catch: asError,
      }).pipe(Effect.tap(Schema.decodeUnknownEffect(inspectionResults[kind])));
    });

  return Game.Service.of({
    readCharacter: Effect.fn('GameAccess.readCharacter')(function* (session, input, refresh) {
      const sections = yield* decodeSections(input);
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
    itemSources: Effect.fn('GameAccess.itemSources')(function* (session, input) {
      const { itemIds } = yield* decodeItemSources(input, rejectUnknownKeys);
      const { request } = yield* authorize(session, 'item_sources');
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      return yield* Effect.tryPromise({
        try: (signal) =>
          itemSources(
            itemIds,
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
      }).pipe(Effect.tap(Schema.decodeUnknownEffect(itemSourcesResult)));
    }),
    readSettings: inspectionMethod('settings', inspectionResults.settings),
    findNpcLocations: inspectionMethod('npc_locations', inspectionResults.npc_locations),
    readQuestieQuest: inspectionMethod('questie_quest', inspectionResults.questie_quest),
    readQuestieChain: inspectionMethod('questie_chain', inspectionResults.questie_chain),
    findObjectLocations: inspectionMethod('object_locations', inspectionResults.object_locations),
    findStoredItem: inspectionMethod('stored_item', inspectionResults.stored_item),
    readItemPrices: inspectionMethod('item_prices', inspectionResults.item_prices),
    readPolestarGuide: inspectionMethod('polestar_guide', inspectionResults.polestar_guide),
    readReference: inspectionMethod('reference', inspectionResults.reference),
    readProgression: inspectionMethod('progression', inspectionResults.progression),
    readTarget: inspectionMethod('target', inspectionResults.target),
    readTrainer: inspectionMethod('trainer', inspectionResults.trainer),
    readFlightPaths: inspectionMethod('flight_paths', inspectionResults.flight_paths),
    readDungeons: inspectionMethod('dungeons', inspectionResults.dungeons),
    readTraining: inspectionMethod('training', inspectionResults.training),
    readChat: inspectionMethod('chat', inspectionResults.chat),
    readCombat: inspectionMethod('combat', inspectionResults.combat),
    readResources: inspectionMethod('resources', inspectionResults.resources),
    compareItems: inspectionMethod('compare_items', inspectionResults.compare_items),
    searchArmor: gearSearchMethod('search_armor'),
    searchWeapons: gearSearchMethod('search_weapons'),
    readGearCandidates: inspectionMethod('gear_candidates', inspectionResults.gear_candidates),
    readAuctions: inspectionMethod('auctions', inspectionResults.auctions),
    readMacros: inspectionMethod('macros', inspectionResults.macros),
    readMap: inspectionMethod('map', inspectionResults.map),
    readHearthstone: inspectionMethod('hearthstone', inspectionResults.hearthstone),
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
