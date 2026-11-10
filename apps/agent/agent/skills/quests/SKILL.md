---
name: quests
description: Choose the next quest or investigate quest objectives, prerequisites and follow-ups using the current log and verified locations.
---

Tool schemas are separate from this skill. Load the quests group with wisp__load_tools when its tools are needed.

Recommend one suitable active quest or turn-in from the fresh log, level and location. Explain the choice with verified facts and account for travel. A completed quest in another town is not automatically the fastest option; a quest name does not establish proximity.

Fetch questie__get_quest details only to resolve necessary objectives or entity IDs. Use bounded questie__get_quest_chain reads for prerequisites or follow-ups. Static requirements do not establish current eligibility. Look up locations when needed to distinguish candidates; avoid catalog/search chains for optional details. If an optional lookup fails, answer from the verified log.
