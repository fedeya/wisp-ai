import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineEvalConfig } from 'eve/evals';
import { startModelBridge } from './model-bridge.ts';
import { itemSourcesFixture } from './fixtures/fedrath.ts';

export default defineEvalConfig({
  timeoutMs: 300_000,
  maxConcurrency: 2,
  async setup() {
    // The eval bridge answers wow__item_sources for the requested IDs only,
    // like the real bridge, instead of a stub that returns every item.
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'wisp-evals-')), 'item-sources.json');
    await writeFile(file, JSON.stringify(itemSourcesFixture()));
    process.env.WISP_EVAL_ITEM_SOURCES = file;
    return { bridge: await startModelBridge() };
  },
  async teardown(context) {
    await context?.bridge.close();
  },
});
