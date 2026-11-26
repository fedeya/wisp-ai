// Every authored tool, imported statically so the packaged bridge bundles them.
// apps/agent/tests/tool-registry.test.ts checks this list against ./tools/.
import type { ToolDefinition } from '../tools/tool.ts';
import auctionator__get_item_prices from './tools/auctionator__get_item_prices.ts';
import polestar__create_guide from './tools/polestar__create_guide.ts';
import polestar__get_guide_step from './tools/polestar__get_guide_step.ts';
import questie__find_npc_locations from './tools/questie__find_npc_locations.ts';
import questie__find_object_locations from './tools/questie__find_object_locations.ts';
import questie__get_quest from './tools/questie__get_quest.ts';
import questie__get_quest_chain from './tools/questie__get_quest_chain.ts';
import syndicator__find_item from './tools/syndicator__find_item.ts';
import thewowdb__get_database_entity from './tools/thewowdb__get_database_entity.ts';
import thewowdb__search_database from './tools/thewowdb__search_database.ts';
import web__web_search from './tools/web__web_search.ts';
import web_fetch from './tools/web_fetch.ts';
import wisp__manage_panel from './tools/wisp__manage_panel.ts';
import wisp__manage_routine from './tools/wisp__manage_routine.ts';
import wisp__present_ui from './tools/wisp__present_ui.ts';
import wisp__set_conversation_title from './tools/wisp__set_conversation_title.ts';
import wisp__skip_tip from './tools/wisp__skip_tip.ts';
import wow__clear_map_waypoint from './tools/wow__clear_map_waypoint.ts';
import wow__compare_items from './tools/wow__compare_items.ts';
import wow__create_macro from './tools/wow__create_macro.ts';
import wow__dungeon_loot from './tools/wow__dungeon_loot.ts';
import wow__get_settings from './tools/wow__get_settings.ts';
import wow__inspect_auctions from './tools/wow__inspect_auctions.ts';
import wow__inspect_flight_paths from './tools/wow__inspect_flight_paths.ts';
import wow__inspect_hearthstone from './tools/wow__inspect_hearthstone.ts';
import wow__inspect_macros from './tools/wow__inspect_macros.ts';
import wow__inspect_map from './tools/wow__inspect_map.ts';
import wow__inspect_reference from './tools/wow__inspect_reference.ts';
import wow__inspect_target from './tools/wow__inspect_target.ts';
import wow__inspect_trainer from './tools/wow__inspect_trainer.ts';
import wow__item_sources from './tools/wow__item_sources.ts';
import wow__query_character from './tools/wow__query_character.ts';
import wow__query_dungeons from './tools/wow__query_dungeons.ts';
import wow__query_progression from './tools/wow__query_progression.ts';
import wow__query_resources from './tools/wow__query_resources.ts';
import wow__query_training from './tools/wow__query_training.ts';
import wow__read_chat from './tools/wow__read_chat.ts';
import wow__read_combat from './tools/wow__read_combat.ts';
import wow__search_armor from './tools/wow__search_armor.ts';
import wow__search_weapons from './tools/wow__search_weapons.ts';
import wow__set_map_waypoint from './tools/wow__set_map_waypoint.ts';
import wow__undo_settings from './tools/wow__undo_settings.ts';
import wow__update_settings from './tools/wow__update_settings.ts';
import wowsims__simulate_dps from './tools/wowsims__simulate_dps.ts';

export const authoredTools: Record<string, ToolDefinition> = {
  auctionator__get_item_prices,
  polestar__create_guide,
  polestar__get_guide_step,
  questie__find_npc_locations,
  questie__find_object_locations,
  questie__get_quest,
  questie__get_quest_chain,
  syndicator__find_item,
  thewowdb__get_database_entity,
  thewowdb__search_database,
  web__web_search,
  web_fetch,
  wisp__manage_panel,
  wisp__manage_routine,
  wisp__present_ui,
  wisp__set_conversation_title,
  wisp__skip_tip,
  wow__clear_map_waypoint,
  wow__compare_items,
  wow__create_macro,
  wow__dungeon_loot,
  wow__get_settings,
  wow__inspect_auctions,
  wow__inspect_flight_paths,
  wow__inspect_hearthstone,
  wow__inspect_macros,
  wow__inspect_map,
  wow__inspect_reference,
  wow__inspect_target,
  wow__inspect_trainer,
  wow__item_sources,
  wow__query_character,
  wow__query_dungeons,
  wow__query_progression,
  wow__query_resources,
  wow__query_training,
  wow__read_chat,
  wow__read_combat,
  wow__search_armor,
  wow__search_weapons,
  wow__set_map_waypoint,
  wow__undo_settings,
  wow__update_settings,
  wowsims__simulate_dps,
};
