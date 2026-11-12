# Current merchant offers

Wisp's read-only `wow__inspect_merchant` is discovered through Eve search. Open a merchant's offers tab yourself, then ask for supplies or equipment advice within an explicit copper budget. The merchant skill composes current offers with fresh resources, item references and raw equipment comparisons; there is no purchasing action.

Each result includes merchant identity, capture time, session revision, bounded item links/IDs, bundle size, copper price per purchase, limited stock (including zero) versus unlimited stock, exposed usability/purchasability, and optional bounded raw requirement tooltip text. Missing values remain unknown. Extended costs are unsupported, never free. Each read is fresh; close/change/world transition invalidates the local merchant session. Historical tool results cannot establish a merchant is still open: re-read before advice changes.

The default reads 20 filtered offers; offset 0–500 and limit 1–40 permit bounded slices without navigating the UI. Serialized offers share a 48,000-byte JSON budget (including escaping), leaving room for observation/wire metadata and compression overhead. When space runs out, tooltip detail is omitted first (`tooltipTruncated=true`, `requirementsStatus=unavailable`); any omitted offer rows are reflected by `truncated` and the returned indexes/count versus `totalVisibleOffers`. Individual tooltip columns are UTF-8 byte-bounded and also report clipping. Coverage is always partial: filters may hide stock, and requirements may be missing or truncated. No offers are cached, no search/polling is started and no game mutations occur.

For example, with 500 copper, a 300-copper budget and a five-item bundle costing 120 copper, two purchases yield ten items, cost 240 copper and leave 260 copper. Zero stock is excluded; an extended-cost offer has no known copper total. Limited stock is item count, so only whole available bundles may be suggested.

Spendable copper is `max(0, min(budget, money - reserve))`: a budget alone defaults reserve to zero; a reserve alone defaults budget to fresh known money. Ask if neither is specified. Unknown money cannot establish exact affordability; known zero money can. A reserve of 600 with only 500 copper leaves zero spendable, not negative purchases. Zero-cost bundles require separate handling without division or assumed unlimited free quantities; unknown bundle size, stock or cost prevents an exact affordable quantity.

## Forever API verification

Read-only source verification: Gethe/wow-ui-source explicit `forever` branch at `4cd0ab752a77164f654ccbca9d0c1fe8dafceebe`. `Interface/AddOns/Blizzard_UIPanels_Game/Vanilla/MerchantFrame.lua` lines 185–209 uses `UnitName("NPC")`, `GetMerchantNumItems()`, `GetMerchantItemInfo(index)` returning name, texture, price, stackCount, numAvailable, isPurchasable, isUsable, extendedCost, currencyID. Lines 212–255 distinguish extended versus copper costs; lines 258–275 use item links and zero stock. `Blizzard_APIDocumentationGenerated/TooltipInfoDocumentation.lua` documents `C_TooltipInfo.GetMerchantItem(slot)` returning optional TooltipData. Optional APIs are feature-detected; failures/restrictions are not bypassed. No Retail fallback.

Linux synthetic fixtures do not validate Windows/Forever interaction, API availability or native UX; those remain manual validation gates.
