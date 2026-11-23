import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvalConfig } from 'eve/evals';
import { startModelBridge } from './model-bridge.ts';
import { itemSourcesFixture } from './fixtures/fedrath.ts';
import { gameItemReadings } from './fixtures/dungeon-loot.ts';

export default defineEvalConfig({
  timeoutMs: 300_000,
  maxConcurrency: 2,
  async setup() {
    // The eval bridge answers wow__item_sources for the requested IDs only,
    // like the real bridge, instead of a stub that returns every item.
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'wisp-evals-')), 'item-sources.json');
    await writeFile(file, JSON.stringify(itemSourcesFixture()));
    process.env.WISP_EVAL_ITEM_SOURCES = file;
    // The game's item reading for wow__dungeon_loot, which the eval bridge
    // joins with the shipped AtlasLoot data.
    const items = path.join(path.dirname(file), 'game-items.json');
    await writeFile(items, JSON.stringify(gameItemReadings()));
    process.env.WISP_EVAL_GAME_ITEMS = items;
    return { bridge: await startModelBridge() };
  },
  async teardown(context) {
    await context?.bridge.close();
  },
});
