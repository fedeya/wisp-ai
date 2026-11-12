---
name: quests
description: Choose the next quest, compare the current turn-in reward choices, or investigate quest objectives, prerequisites and follow-ups using fresh observations.
---

Recommend one suitable active quest or turn-in from the fresh log, level and location. Explain the choice with verified facts and account for travel. A completed quest in another town is not automatically the fastest option; a quest name does not establish proximity.

Fetch questie__get_quest details only to resolve necessary objectives or entity IDs. Use bounded questie__get_quest_chain reads for prerequisites or follow-ups. Static requirements do not establish current eligibility. Look up locations when needed to distinguish candidates; avoid catalog/search chains for optional details. If an optional lookup fails, answer from the verified log.

For “which reward helps me level solo?”, discover and call wow__inspect_quest_rewards once, with the player's turn-in reward dialog open. Never navigate, select or claim a reward. If unavailable, ask the player to open/keep that dialog visible; do not poll. A closed/changed dialog invalidates earlier offers; never present an earlier result as the current offer.

Show every observed choice and every guaranteed item, with quantity and distinct exact variant identity, in one native table via wisp__present_ui. Keep guaranteed rewards clearly separate and never rank them as selectable. Compare the stated matching equipped slots from the observation; query character level/class/talents only as needed. Explain one conditional recommendation among choices for the user's stated goal using observed raw stats. Keep uncached, secret/restricted, unsupported currency/non-item options and truncated coverage explicit; unknown is not zero, empty, unusable or worse. When evidence is insufficient, explain why no confident winner can be chosen.

Use the reader's exact-link stats, not inspect_reference or compare_items by ID, for variant-specific reasoning: those ID-only tools can lose variants. Do not merge sibling variants by item ID. Native reference IDs are not exact-variant proof; use distinct row labels with the observed link/variant text. Raw stats do not establish DPS, stat weights, proc/set value or a combined two-hand/off-hand replacement. Never invent simulation or auto-call it.
