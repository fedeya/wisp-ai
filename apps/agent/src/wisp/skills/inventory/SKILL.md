---
name: inventory
description: Find stored items on other characters, in the bank or mail, compare specific items, and interpret auction and market prices. Gear upgrade searches are covered by the instructions and need no skill.
---

To compare specific items the user names, use wow__compare_items, which reads up to 5 items and their equipped counterparts with stat deltas in one call; use wow__inspect_reference only for tooltip effects a comparison does not show. Item reads wait for the client cache; a "loading" item after that stays unknown rather than retried. Compare stats, effects, class/proficiency and equip requirements. gear.items is sparse and its slot IDs identify equipment slots. Hypothetical simulation inputs do not require ownership or equip eligibility.

For where any item comes from or what it costs, use wow__item_sources for all the items at once. For items on other characters or in bank/mail, use syndicator__find_item; Baganator uses Syndicator data. Cache absence does not establish absence. auctionator__get_item_prices gives last-seen unit prices with age.

Use the current realm and faction where relevant. Everloot market_value is a realm estimate from uploaded scans; auction_history is historical. wow__inspect_auctions reads only partial results already loaded at an open auction house, without launching searches or scans. Distinguish observed time, unit/stack prices, bid/buyout/vendor value and copper/silver/gold. Cached prices are not live listings. These tools cannot buy, sell, bid, post, cancel or transfer items.
