# Game data

Some facts Wisp needs are in the game's own tables but not in any API the
addon can call in game, for example where each dungeon entrance is. Wisp
generates them into files it ships, so it does not depend on another addon for
them. `@wisp/game-data` (`packages/game-data`) does the generation.

- `build.json` pins the World of Warcraft: Forever build every dataset is read
  from.
- `src/datasets/` holds one module per generated file: which tables it reads
  and what it writes. Addon data goes to `addon/WispAI/Data/` as `ns.Data.<Name>`
  and must be listed in `WispAI.toc`.
- `curated/` holds the few facts the tables lack, each with its source.
- Tables come from [wago.tools](https://wago.tools) and are cached in
  `packages/game-data/.cache/<build>/` (not committed), so a regeneration can be
  repeated offline.

## After a Forever patch

1. Set the new build in `packages/game-data/build.json`.
2. Run `pnpm data:generate` (add `--refresh` to download cached tables again).
3. Review the diff of the generated files and commit them with the build change.

`pnpm --filter @wisp/game-data test` checks the CSV reader, the Lua writer, the
coordinate conversion and that every generated file names the pinned build.

## Adding a dataset

Prefer a live game API when one exists: it is always current. Add a dataset for
facts only the client tables hold, and keep server-side facts (loot, drop
rates, trainers) out: those are not in the client tables. Write the module in
`src/datasets/`, add it to `datasets()` in `src/index.ts`, and test it with
`memoryTables` fixtures copied from real rows.
