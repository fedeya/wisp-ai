# Forever ability catalog

Wisp vendors the nine class `spellsByLevel` tables and `QuestSpells.lua` from
[fusionpit/WhatsTraining](https://github.com/fusionpit/WhatsTraining/tree/bf57434eafabf507beae49521cb5debb9ff69d01/Classes/Camelot),
revision `bf57434eafabf507beae49521cb5debb9ff69d01` (retrieved 2026-11-09).
Upstream calls the Forever data directory `Camelot`. These are not Classic/Era tables.
The MIT license is preserved in `addon/WispAI/TrainingData.LICENSE`.

`TrainingData.lua` wraps the original tables in a private namespace. `Training.lua`
queries those tables and resolves localized names through the client's C_Spell API.
No additional addon is required. Querying another class retains race/faction
requirements; current-class results filter those restrictions and report learned
flags. Prices are base copper amounts without reputation discounts. Requirements
are returned as data, not a claim that the character can currently train.

Coverage is class trainer ranks and quest spells. This is not an exhaustive list
of talent unlocks, profession recipes, weapon skills, hunter pet training or
warlock pet tomes. Missing names trigger client spell-data requests and are
reported explicitly. Retry or use a verified spell ID rather than treating an
empty name search as proof that an ability does not exist.

To update: review upstream changes, copy the nine class tables and QuestSpells
from Classes/Camelot into the existing private wrappers, update the revision in
Training.lua and this document, preserve the license, and run addon catalog tests.

## Live smoke check — 2026-11-09

Sent `¿Cuándo aprendo invisibilidad con el mago?` through a fresh in-game Wisp
conversation, using the running desktop engine and live addon.
The completed activity log recorded this sequence:

1. `wisp__load_tools` → `wow__query_training`.
2. Knowledge loading, TheWoWDB spell search and Everloot search.
3. `web__web_search` → `web_fetch` on the returned Wowhead Forever spell page.

That recorded run predates native tool discovery. Current runs find deferred tools
with `eve__search` and call them through `eve__tool`.

All listed calls completed and the turn finished normally. The answer reported
that it could not confirm a normal learning level, rather than converting the
page's level-99 item-effect metadata or a tome reference into a verified trainer
unlock. This checks real catalog-to-web investigation; it does not establish the
ability's current acquisition method or level. Automatic tests separately check
name resolution, level/price requirements, pagination and unrestricted provider
requests.

## Research workflow regression

When a catalog lookup misses, the agent checks availability as well as the
requested learning level. It follows teaching items/quests to their sources,
distinguishes internal effect levels from actual requirements, and checks
current guides or attributed firsthand reports. Explicit negative evidence can
support an unavailable answer; an empty catalog alone cannot.

ChatGPT search returns a generated source dossier with findings, source type,
scope, unresolved questions and suggested follow-up queries. Every finding URL
must match a public URL returned by the search provider (tracking parameters and
Wowhead's encoded equals separator are normalized). Unrelated unsafe search hits
are discarded without suppressing valid findings. Generated dossiers remain
leads for reading and corroboration, not independent confirmation.

The headless smoke scenario exercises the production agent, model proxy,
database lookup, global web search and page fetching without a WoW session.
Only the catalog-miss boundary is synthetic; no live character data is supplied
or modified, and game tools other than the fixture catalog are unavailable.
It sends the original question without supplying the expected answer. The
report records tool order, search queries, returned dossiers and the final answer
for semantic review; passing tool-order assertions alone does not prove an answer
correct. Existing signed-in ChatGPT credentials are read through the native vault;
the harness refuses tokens close to expiry to avoid concurrent renewal.

From the repository root in PowerShell:

```powershell
$env:WISP_SMOKE_RESEARCH = '1'
$env:WISP_DATA_DIR = Join-Path $env:APPDATA 'com.wisp.ai'
$env:WISP_SMOKE_DIR = Join-Path (Get-Location) 'runtime/research-smoke'
$env:WISP_DESKTOP_EXE = Join-Path (Get-Location) 'dist/preview-latest/wisp.exe'
node scripts/smoke-agent.mjs
```

The report is written to `$env:WISP_SMOKE_DIR/report.json`. This is an opt-in
live-model/network smoke check, separate from deterministic unit tests.

### Verified headless run — 2026-11-09

The final run sent `¿Cuándo aprendo invisibilidad con el mago?` without hints about
the expected answer. It consulted the synthetic empty catalog, the live database,
two global web searches and three page reads. Both web searches returned available
source dossiers with three findings each. The agent answered that the Mage does
not learn Invisibility as a class ability in Forever, linked the current community
guide it read, and explicitly distinguished that guide from an official statement.

Semantic review checks the supported conclusion and attribution, not just tool
calls. Earlier runs exposed search timeouts and rejection of otherwise valid
sources because of unrelated unsafe search hits. The final implementation bounds
each search to a focused dossier, uses low reasoning on supported GPT-5/6 search
models, and allows 85 seconds within the calling tool's 100-second deadline.

To evaluate another run, inspect the answer and the per-search findings/scope in
`report.json`. A generic refusal despite accessible explicit evidence is a failed
semantic result even if every tool completed. Unavailable providers should remain
an explicit test limitation, not be interpreted as missing gameplay content.

## Adaptive search budgets

The model selects `depth: quick | standard | deep` and can override individual
budgets through the same search tool input. It starts with an appropriate depth
for the question and escalates when evidence is conflicting or acquisition is
unresolved; the bridge does not guess depth from keywords.

| Depth    | Findings/sources | Query budget | Search deadline | Exa excerpt/source |
| -------- | ---------------: | -----------: | --------------: | -----------------: |
| quick    |                3 |            1 |      35 seconds |   2,000 characters |
| standard |                5 |            2 |      85 seconds |   4,000 characters |
| deep     |               12 |            4 |     160 seconds |   8,000 characters |

Optional inputs `maxResults`, `maxQueries`, `timeoutSeconds`, and
`excerptCharacters` override the profile defaults. Validation allows 1–12
results, 1–6 queries, 10–180 seconds, and 1,000–12,000 excerpt characters.
Queries can be up to 1,000 characters. `queries` supplies up to five additional
focused variants; the primary query counts toward the budget.

Exa executes explicit variants concurrently within one shared deadline, retains
successful responses if another variant fails, deduplicates sources and caps the
total returned sources/excerpts. Without explicit variants it makes one query.
ChatGPT receives the selected depth/query/findings/time budget; its query count
is guidance to the hosted search model, not an independently enforced internal
query counter. Returned findings/sources and the request deadline are enforced.
Deep search uses medium reasoning on supported models; other profiles use low.
The agent RPC deadline includes a 15-second margin above the search deadline.
Returned results report the selected `budget` for inspection.

Example tool input:

```json
{
  "query": "WoW Forever mage ability acquisition",
  "depth": "deep",
  "maxResults": 8,
  "maxQueries": 3,
  "timeoutSeconds": 120,
  "queries": [
    "WoW Forever mage ability availability",
    "WoW Forever teaching item obtainable source"
  ]
}
```

Legacy callers passing only a query string retain the standard profile.

Headless adaptive check (2026-11-09): with only the empty-catalog boundary
simulated, the agent chose `standard` with `maxQueries: 3` and supplied an
availability query variant, then escalated to `deep` while overriding its result
limit to five sources. Both searches returned available evidence. The real
model/web run completed, inspected source
pages and answered the question with attribution. This checks that the model can
select non-default budgets through the production tool, independently of WoW.
