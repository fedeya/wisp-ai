---
name: locations
description: Find NPCs, city services or trainers and place requested map markers. Use for destination, coordinate and navigation requests.
---

Tool schemas are separate from this skill. Load the locations group with wisp__load_tools when its tools are needed.

Locate a destination before placing a marker:

- Resolve a named city's native map ID with wow__inspect_map.
- Use questie__find_npc_locations mode=services for roles such as Transmogrifier, banker, barber or auctioneer. A role is not an NPC's personal name.
- For class trainers, use mode=class_trainers with class and verified mapId. For other NPCs, search exact localized names or verified IDs. wow__inspect_trainer reads offers from an already-open trainer; it cannot locate one.

QuestieDB Forever pins are database spawn positions, not live sightings. Preserve the provider, phase and coordinate frame. Missing coverage does not prove no NPC exists. Return verified coordinates as a structured map reference.

Place a native pin only when asked, using wow__set_map_waypoint with verified UI map ID, destination label, source and percentage coordinates (0–100). Verify through game/catalog tools or use coordinates supplied by the user; current player position is not the destination. Pins optionally enable navigation but do not move the character. wow__clear_map_waypoint removes Wisp's marker while preserving one the player changed.
