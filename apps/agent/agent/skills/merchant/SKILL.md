---
name: merchant
description: Use when advising what to buy from the merchant currently open, including supplies, equipment and budget/bundle calculations.
---

Discover wow__inspect_merchant with eve__search. Only inspect the merchant the user opened; do not navigate, search vendors automatically or purchase. Catalog vendor_page data is reference stock, not this character's observed offers.

Read fresh wow__query_resources for money and bags; use inspect_reference and compare_items for relevant item details/raw equipment comparisons. Ask for an explicit budget or reserve before proposing spending. Each reading has its own provenance/capture time: do not treat old resources or old merchant offers as current. Re-read after merchant close/change/update or before revising a purchase suggestion. Missing/unavailable is not empty, false or zero.

Cost is copper per purchase bundle, not per item. Let M be fresh known money, B the explicit budget, and R the reserve (all non-negative copper). If only a budget is given, R = 0; if only a reserve is given, B = M. If neither is given, ask before proposing spending. Missing/unknown money blocks exact affordability; zero money is known, not missing. Compute spendable = `max(0, min(B, M - R))`. For a positive bundle cost, affordable purchases = floor(spendable / bundle cost); units = purchases * bundleSize. For example M=500, B=300, R=600, cost=120, bundleSize=5 yields zero purchases and zero units, never negative quantities. For limited stock, cap purchases at floor(availableCount / bundleSize); zero stock excludes the offer, unlimited is not zero. Handle zero-cost bundles separately (no division); never assume unlimited free quantities. Exclude unsupported/unknown/extended costs from exact totals; say the complete total is unknown. Preserve false usability/purchasability; requirements tooltip text is partial, not complete eligibility. Never claim an exact affordable quantity when bundle size, stock or cost is unknown.

Give a prioritized suggestion with bundle counts, resulting item units, known copper subtotal and remaining money. Scope it to the bounded filtered rows actually read (offset/limit); partial coverage never proves missing stock. The user makes every purchase; Wisp cannot shop automatically.
