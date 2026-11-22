---
name: inventory
description: Compare equipment, find stored items and interpret auction prices. Use for gear upgrades, inventory and market questions.
---

For equipment comparisons, read gear (and bags when relevant) in one wow__query_character call. Gear readings already include each equipped item's name, item level, required level, equip location and stats; do not inspect equipped items again. Compare candidates with wow__compare_items, which reads up to 5 items and their equipped counterparts with stat deltas in one call; use wow__inspect_reference only for tooltip effects a comparison does not show. Item reads wait for the client cache; a "loading" item after that stays unknown rather than retried. Compare stats, effects, class/proficiency and equip requirements before recommending an upgrade. gear.items is sparse and its slot IDs identify equipment slots; a shirt is not chest armor. Names and IDs alone do not establish wearability or upgrade value. Hypothetical simulation inputs do not require ownership or equip eligibility.

Keep upgrade research proportional: shortlist the few weakest slots and a handful of realistic candidates, then look up only the source or price that changes the recommendation. Discover the deferred tools you need (wow__compare_items, auctionator__get_item_prices, thewowdb__search_database) in a single eve__search, and issue independent lookups together in one step. Answer once the best options are clear; offer to research more slots instead of verifying every item.

For items on other characters or in bank/mail, use syndicator__find_item; Baganator uses Syndicator data. Cache absence does not establish absence. auctionator__get_item_prices gives last-seen unit prices with age.

Use the current realm and faction where relevant. Everloot market_value is a realm estimate from uploaded scans; auction_history is historical. wow__inspect_auctions reads only partial results already loaded at an open auction house, without launching searches or scans. Distinguish observed time, unit/stack prices, bid/buyout/vendor value and copper/silver/gold. Cached prices are not live listings. These tools cannot buy, sell, bid, post, cancel or transfer items.
