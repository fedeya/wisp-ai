# Current turn-in rewards

With the quest **turn-in reward dialog open**, ask which displayed choice helps
your stated goal (for example solo leveling). Wisp can discover the native
`wow__inspect_quest_rewards` read-only tool and show a native table with all
observed item choices and guaranteed items, quantities, exact variant links and
cached raw stats alongside matching equipped slots. Only choices are ranked;
guaranteed items are not selectable alternatives.

This is one on-demand observation, not a quest planner or an automatic action.
Wisp never opens the dialog, selects, claims, completes or accepts a quest. It
does not poll or request item loads. A closed/changed dialog requires a new
player-requested read; quest identity, visibility and event generation are
revalidated before returning any offer. Observations are not retained by the
reader; historical replies are not evidence of the current offer.

## Coverage and interpretation

- At most ten guaranteed items and ten alternatives are read. Each section
  reports count/coverage and capture time. Missing counts are unknown, not zero.
- Raw stats are capped at 32 entries per item and 128 entries across the read;
  exceeding either budget leaves that item's stats unknown rather than partial.
  `statsTruncated` and `statsReason` identify the specific budget omission.
- `nameTruncated`, `equipLocationTruncated` and `titleTruncated` identify clipped
  text fields. `truncated` propagates from an equipped comparison to its reward,
  section and observation; `optionsTruncated` separately identifies omitted
  options. Availability is independent: an available section with only three
  choices can still contain truncated text or unknown budget-limited stats.
- Currency/non-item choices are explicit unsupported entries, never dropped or
  valued as items. Other non-item guaranteed rewards are outside this observation.
- Uncached items and unavailable/restricted stats remain unknown per option.
  Only a successful empty item-info return is `loading` (`reason: uncached`).
  Missing APIs, exceptions, secret names and malformed responses remain `unknown`
  with bounded reason tokens, never raw exception text or stack paths. Ordinary
  unavailable/restricted data is not labeled budget-truncated.
  Exact reward and equipped links are passed directly to cached item APIs;
  sibling variants are not deduplicated by item ID. Oversized links are unknown,
  not truncated into a different link. Text uses the shared UTF-8 byte limiter.
- A recommendation is conditional on observed stats, character context and the
  stated goal. Unknown choices can prevent a confident winner. No DPS, weights,
  proc/set valuation or combined two-hand/off-hand replacement is inferred.
  Existing `compare_items` and `inspect_reference` are ID-based, not exact-variant
  replacements for this read.

## Forever API evidence

Verified against the explicit `forever` branch of
[`Gethe/wow-ui-source`](https://github.com/Gethe/wow-ui-source/tree/4cd0ab752a77164f654ccbca9d0c1fe8dafceebe),
pinned to `4cd0ab752a77164f654ccbca9d0c1fe8dafceebe`:

- `Blizzard_UIPanels_Game/Mainline/QuestInfo.lua:518–546, 645–647, 777–801,
  956–964`: current `GetQuestItemInfo(type, index)` returns name, texture,
  quantity, quality, usability and item ID; `GetQuestItemLink(type, index)` is
  the native exact-link caller. Separate reward/choice counts and choice loot
  types (`0` item, `1` currency) use the original dialog index.
- `Blizzard_UIPanels_Game/Mainline/QuestFrame.lua:9–15, 24–28, 66–84,
  126–132`: dialog lifecycle, reward panel visibility and item refresh events.
- `Blizzard_APIDocumentationGenerated/ItemDocumentation.lua:626–653,
  1004–1017`: `C_Item.GetItemInfo(itemInfo)` and
  `C_Item.GetItemStats(itemLink)` accept the observed link. APIs are
  feature-detected, secret values are rejected before use, failures remain
  unknown/unavailable; no Retail fallback is selected.
- `Blizzard_FrameXMLUtil/ItemUtil.lua:297`: the native item-display helper passes
  `itemLink` directly to `C_Item.GetItemInfo`, retaining variant context.

## Acceptance

Offline native Lua and Eve/RPC fixtures cover three alternatives plus one
guaranteed item, exact sibling variants, equipped slots, unknown stats, lifecycle
invalidation, authentication and session gates. The local model fixture scripts
the recommendation and presentation; it does **not** prove model judgment.

Manual Forever acceptance remains: open a real turn-in, ask which reward helps
solo leveling, verify all quantities/variants and guaranteed separation, then
close/change the dialog and verify old offers are not treated as current. Check
that no selection/claim or UI navigation occurs. Linux fixtures do not validate
Windows/Forever UX, API availability in a running client, or native latency.
