---
name: inventory
description: Compare equipment, find stored items and interpret auction prices. Use for gear upgrades, inventory and market questions.
---

For equipment comparisons, read gear (and bags when relevant) in one wow__query_character call. Gear readings already include each equipped item's name, item level, required level, equip location and stats; do not inspect equipped items again. Compare candidates with wow__compare_items, which reads up to 5 items and their equipped counterparts with stat deltas in one call; use wow__inspect_reference only for tooltip effects a comparison does not show. Item reads wait for the client cache; a "loading" item after that stays unknown rather than retried. Compare stats, effects, class/proficiency and equip requirements before recommending an upgrade. gear.items is sparse and its slot IDs identify equipment slots; a shirt is not chest armor. Names and IDs alone do not establish wearability or upgrade value. Hypothetical simulation inputs do not require ownership or equip eligibility.

To find upgrades, never guess item names from memory: Forever has items your training data does not know. Search real candidates with wow__search_armor (slot, plus the character's armor type for body slots) and wow__search_weapons (weapon type, shields or held-in-off-hand items). They list every catalog item for that slot that the character can equip by level, with stats and raw differences against current gear, so they need no separate comparison or catalog lookup. Work in three steps:

1. In one step, read gear with wow__query_character and call wow__search_armor and wow__search_weapons for every empty or weak slot you might upgrade (including the weapon types the class uses).
2. Choose a few picks yourself from the results using the character's class, role, level, money and goals; the result order is only item level gain. Then read where all your picks come from and their last auction price with one wow__item_sources call. Catalog entries are unconfirmed game-file data: drop picks with no known source.
3. Answer. Do not re-check picks with wow__compare_items, wow__inspect_reference, TheWoWDB, Everloot or Auctionator unless a needed fact is missing. Offer to research more slots instead of verifying every item.

For where any item comes from or what it costs, use wow__item_sources for all the items at once. For items on other characters or in bank/mail, use syndicator__find_item; Baganator uses Syndicator data. Cache absence does not establish absence. auctionator__get_item_prices gives last-seen unit prices with age.

Use the current realm and faction where relevant. Everloot market_value is a realm estimate from uploaded scans; auction_history is historical. wow__inspect_auctions reads only partial results already loaded at an open auction house, without launching searches or scans. Distinguish observed time, unit/stack prices, bid/buyout/vendor value and copper/silver/gold. Cached prices are not live listings. These tools cannot buy, sell, bid, post, cancel or transfer items.
