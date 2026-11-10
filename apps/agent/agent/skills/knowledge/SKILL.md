---
name: knowledge
description: Research Forever game facts with catalogs, Everloot and web sources. Use when live readings or the training catalog do not answer the question.
---

Tool schemas are separate from this skill. Load the knowledge group with wisp__load_tools when its tools are needed.

Use these sources in order, complementing only missing coverage:

1. TheWoWDB is the primary Forever catalog. Use thewowdb__get_database_entity for a verified ID, or thewowdb__search_database to resolve a name. Preserve localized labels even when the index is English. Cite links.html or the attribution URL and check the build; old beta records may differ from live behavior. Database zone/area IDs are not native UiMap IDs.
2. Everloot supplies player-observed drops, vendors, locations, quest relations, talent trees/share codes, professions, recent changes and realm market history. Discover its connections with eve__search and call through eve__tool. Wisp fixes these connections to Forever and omits mixed-version generic tools. Preserve URLs, build, dataAsOf, uncertainty and attribution/licence. Starter builds are not observed consensus.
3. web__web_search discovers documentation, addon repositories, patch notes and guides. Use available results and exact source URLs. Verify Forever applicability; label other-version comparisons. Try localized and English names or verified IDs when coverage is missing.

For acquisition questions, use wow__query_training first for class abilities. Follow the actual acquisition chain: ability -> trainer, talent, quest or teaching item -> obtainable source -> requirements. Internal spell level, item level and required character level are different. A taught-by relation alone does not establish availability. Investigate removal/unavailability or alternate acquisition when the premise is uncertain; a catalog miss does not establish absence.

Search with quick for narrow facts, standard for ordinary research and deep for unresolved availability or conflicting comparisons. Use focused query variants and increase depth when the previous search was inconclusive. Set maxResults, maxQueries, timeoutSeconds and excerptCharacters only as needed. Exa executes explicit variants; ChatGPT query count is guidance for its search model. Stop when the evidence answers the question.

Generated summaries and research dossiers are leads. Inspect findings, sourceType/scope and unresolvedQuestions; follow useful suggestedQueries. For an unconfirmed result, read a promising independent source or change the query before repeating the uncertainty. Reopening one page is not corroboration. Give established facts, identify the specific remaining gap and offer a sourced alternative when useful.

Use web_fetch for public HTTPS pages, including supplied links. Read promising pages before relying on their summaries. For truncated content, continue the same URL with nextCursor until the needed section is read; a fragment is not the complete guide. Cursors expire after 10 minutes or engine restart; refetch if needed. Cite the requested URL. Login walls, anti-bot pages, HTTP errors and empty client-rendered pages do not verify facts. Distinguish incomplete access from missing game content.
