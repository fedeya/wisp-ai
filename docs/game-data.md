# Game data

Some facts Wisp needs are in the game's own tables but not in any API the
addon can call in game, for example where each dungeon entrance is. Wisp
generates them into files it ships, so it does not depend on another addon for
them. `@wisp/game-data` (`packages/game-data`) does the generation.

- `build.json` pins the World of Warcraft: Forever build every dataset is read
  from (`wowf` is wago.tools' product name for Forever), and the AtlasLoot
  release the loot tables come from.
- `src/datasets/` holds one module per generated file: the tables it reads,
  its output and a `build()` that returns plain data. Output is either Lua for
  the addon (`addon/WispAI/Data/<Name>.lua` as `ns.Data.<Name>`, listed in
  `WispAI.toc`; it loads in game, so keep it small) or JSON for the bridge (for
  data the agent uses directly or that is too large for the game's memory).
  `render()` adds a header naming the dataset, build and tables.
- Read columns with `num()` and `str()` from `src/rows.ts`, which fail on a
  missing or malformed column instead of writing `NaN`.
- `curated/` holds the few facts the tables lack, each with its source.
- Tables come from [wago.tools](https://wago.tools), in English unless a
  dataset asks for a locale (`tables.read('Map', 'esMX')`), and are cached in
  `packages/game-data/.cache/<build>/<locale>/` (not committed), so a
  regeneration can be repeated offline.

## Dungeon loot

The client has no loot tables, so `dungeon-loot` reads boss loot from
[AtlasLoot Classic Forever](https://www.curseforge.com/wow/addons/atlasloot-forever)
(Sliccer, GPL-2.0-or-later): who drops what in every dungeon and raid,
Forever's own instances, the drops Forever added to classic bosses (its
"Forever" column) and per-NPC drop rates. `build.json` pins the CurseForge file
(project, file ID, name, sha256); generation downloads it once into the cache,
checks the hash and runs the Dungeons and Raids module's `data.lua` and
`droprate.lua` in Fengari with stubs for the APIs they call. Only facts are
kept: item and NPC IDs, boss and instance names, levels and rates. Forever's
instances, which AtlasLoot names but does not number, are placed by their
Map.db2 name; `curated/dungeon-loot.json` holds the few that need a hand
(Dire Maul's wings, instances the build does not have yet). The output is
`apps/bridge/src/integrations/dungeon-loot.json`, read by `wow__dungeon_loot`.

To update it, set the newer file's ID, name and sha256 in `build.json` (the
file page on CurseForge lists the name) and run `pnpm data:generate dungeon-loot`.

## After a Forever patch

`pnpm data:check` says whether wago.tools lists a newer Forever build than the
pinned one; the scheduled `Game data build` workflow runs it daily and fails
when the pin is behind.

1. Set the new build in `packages/game-data/build.json`.
2. Run `pnpm data:generate` (add `--refresh` to download cached tables again).
3. Fix anything generation reports: for dungeon entrances, a new instance whose
   entrance falls inside several zones' bounds is listed with its candidate
   zones to choose from in `curated/dungeon-entrances.json`.
4. Review the diff of the generated files and commit them with the build change.

`pnpm --filter @wisp/game-data test` checks the CSV reader, the Lua writer, the
coordinate conversion and that every generated file names the pinned build.

## Adding a dataset

Prefer a live game API when one exists: it is always current. Add a dataset for
facts only the client tables hold. Server-side facts (loot, drop rates,
trainers) are not in the client tables; take them only from a pinned,
licence-compatible source, as `dungeon-loot` does. Write the module in
`src/datasets/`, add it to `datasets()` in `src/index.ts`, and test it with
`memoryTables` fixtures copied from real rows.
