import { Context, Effect, Schema } from 'effect';
import type { z } from 'zod';
import type { actionSchema } from '../contract/game-actions.ts';
import type { characterSections, itemSourcesInput } from '../contract/game-inspection.ts';
import type { GameInspection, InspectionResult } from '../contract/game-inspection-results.ts';
export { inspectionResults } from '../contract/game-inspection-results.ts';
export type { GameInspection, InspectionResult } from '../contract/game-inspection-results.ts';
import type { ItemSourcesResult } from '../contract/item-sources-result.ts';
export type { ItemSourcesResult } from '../contract/item-sources-result.ts';
export { itemSourcesResult } from '../contract/item-sources-result.ts';

export const gameReading = Schema.Record(Schema.String, Schema.Unknown);
export type GameReading = typeof gameReading.Type;
export type GameAction = z.input<typeof actionSchema>;
export type CharacterSections = z.infer<typeof characterSections>;
export type ItemSourcesInput = z.input<typeof itemSourcesInput>;

type InspectionOperation<K extends GameInspection['kind']> = (
  session: string,
  args: Extract<GameInspection, { kind: K }>['args'],
) => Effect.Effect<InspectionResult<K>, Error>;

export class GameAccess extends Context.Service<
  GameAccess,
  {
    readCharacter: (
      session: string,
      sections: CharacterSections,
      refresh?: boolean,
    ) => Effect.Effect<GameReading, Error>;
    readonly readSettings: InspectionOperation<'settings'>;
    readonly findNpcLocations: InspectionOperation<'npc_locations'>;
    readonly readQuestieQuest: InspectionOperation<'questie_quest'>;
    readonly readQuestieChain: InspectionOperation<'questie_chain'>;
    readonly findObjectLocations: InspectionOperation<'object_locations'>;
    readonly findStoredItem: InspectionOperation<'stored_item'>;
    readonly readItemPrices: InspectionOperation<'item_prices'>;
    readonly readPolestarGuide: InspectionOperation<'polestar_guide'>;
    readonly readReference: InspectionOperation<'reference'>;
    readonly readProgression: InspectionOperation<'progression'>;
    readonly readTarget: InspectionOperation<'target'>;
    readonly readTrainer: InspectionOperation<'trainer'>;
    readonly readFlightPaths: InspectionOperation<'flight_paths'>;
    readonly readDungeons: InspectionOperation<'dungeons'>;
    readonly readTraining: InspectionOperation<'training'>;
    readonly readChat: InspectionOperation<'chat'>;
    readonly readCombat: InspectionOperation<'combat'>;
    readonly readResources: InspectionOperation<'resources'>;
    readonly compareItems: InspectionOperation<'compare_items'>;
    readonly searchArmor: InspectionOperation<'search_armor'>;
    readonly searchWeapons: InspectionOperation<'search_weapons'>;
    readonly readGearCandidates: InspectionOperation<'gear_candidates'>;
    readonly readAuctions: InspectionOperation<'auctions'>;
    readonly readMacros: InspectionOperation<'macros'>;
    readonly readMap: InspectionOperation<'map'>;
    readonly readHearthstone: InspectionOperation<'hearthstone'>;
    itemSources: (
      session: string,
      input: ItemSourcesInput,
    ) => Effect.Effect<ItemSourcesResult, Error>;
    runGameAction: (session: string, action: GameAction) => Effect.Effect<GameReading, Error>;
  }
>()('@wisp/agent/GameAccess') {}

const unavailable = () => Effect.fail(new Error('No active connection for this character'));
export const unavailableGameAccess = GameAccess.of({
  readCharacter: unavailable,
  readSettings: unavailable,
  findNpcLocations: unavailable,
  readQuestieQuest: unavailable,
  readQuestieChain: unavailable,
  findObjectLocations: unavailable,
  findStoredItem: unavailable,
  readItemPrices: unavailable,
  readPolestarGuide: unavailable,
  readReference: unavailable,
  readProgression: unavailable,
  readTarget: unavailable,
  readTrainer: unavailable,
  readFlightPaths: unavailable,
  readDungeons: unavailable,
  readTraining: unavailable,
  readChat: unavailable,
  readCombat: unavailable,
  readResources: unavailable,
  compareItems: unavailable,
  searchArmor: unavailable,
  searchWeapons: unavailable,
  readGearCandidates: unavailable,
  readAuctions: unavailable,
  readMacros: unavailable,
  readMap: unavailable,
  readHearthstone: unavailable,
  itemSources: unavailable,
  runGameAction: unavailable,
});
