---
name: inventory
description: Compare equipment, find stored items and interpret auction prices. Use for gear upgrades, inventory and market questions.
---

Tool schemas are separate from this skill. Load the inventory group with wisp__load_tools when its tools are needed.

For equipment comparisons, read current gear and inspect candidate item details. Compare stats, effects, class/proficiency and equip requirements before recommending an upgrade. gear.items is sparse and its slot IDs identify equipment slots; a shirt is not chest armor. Names and IDs alone do not establish wearability or upgrade value. Hypothetical simulation inputs do not require ownership or equip eligibility.

For items on other characters or in bank/mail, use syndicator__find_item; Baganator uses Syndicator data. Cache absence does not establish absence. auctionator__get_item_prices gives last-seen unit prices with age.

Use the current realm and faction where relevant. Everloot market_value is a realm estimate from uploaded scans; auction_history is historical. wow__inspect_auctions reads only partial results already loaded at an open auction house, without launching searches or scans. Distinguish observed time, unit/stack prices, bid/buyout/vendor value and copper/silver/gold. Cached prices are not live listings. These tools cannot buy, sell, bid, post, cancel or transfer items.
