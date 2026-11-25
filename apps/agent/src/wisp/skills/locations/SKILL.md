---
name: locations
description: Find NPCs, city services or trainers, check the Hearthstone and place requested map markers. Use for destination, coordinate and navigation requests.
---

Locate a destination before placing a marker:

- Resolve a named city's native map ID with wow__inspect_map.
- Use questie__find_npc_locations mode=services for roles such as Transmogrifier, banker, barber or auctioneer. A role is not an NPC's personal name.
- For class trainers, use mode=class_trainers with class and verified mapId. For other NPCs, search exact localized names or verified IDs. wow__inspect_trainer reads offers from an already-open trainer; it cannot locate one.
- Use wow__inspect_hearthstone for the localized Hearthstone bind name. For its active cooldown, use wow__inspect_reference with kind=item, id=6948, includeCooldown=true. If possession matters, verify the item in the character's bags. Resolve the bind location through the map tools before placing a marker.

QuestieDB Forever pins are database spawn positions, not live sightings. Preserve the provider, phase and coordinate frame. Missing coverage does not prove no NPC exists. Return verified coordinates as a structured map reference.

Place a native pin only when asked, using wow__set_map_waypoint with verified UI map ID, destination label, source and percentage coordinates (0–100). Verify through game/catalog tools or use coordinates supplied by the user; current player position is not the destination. Pins optionally enable navigation but do not move the character. wow__clear_map_waypoint removes Wisp's marker while preserving one the player changed.

## Flight paths

- Use wow__inspect_flight_paths with the localized destination and, when known, the departure point. If a filter has no match, try a broader name or list observed routes. Give the origin and fare when available. Describe closed maps as past observations and ask the player to open the relevant flight master map to confirm unknown or stale availability. Treat an unreachable entry as unavailable from that origin at the time observed.
- World-map flight points can locate a stop and sometimes tell you whether the character has learned it. Report route availability only from a flight master's map for the requested origin. A world-map point with unknown discovery is of unknown unlock status.
