// Runs the agent evals against the real model through the eval bridge.
//
//   node apps/bridge/src/evals/eval-bridge.ts sign-in   (once)
//   pnpm --filter @wisp/agent eval [name-or-tag ...]
//
// Each eval is one real engine turn. A failed gate fails the run; a missed
// scorer is reported as a warning.
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setAgentHost } from '../src/host/agent-host.ts';
import { runEval, type EvalDefinition } from './harness.ts';
import { saveTurn } from './report.ts';
import { startModelBridge } from './model-bridge.ts';
import { itemSourcesFixture } from './fixtures/fedrath.ts';
import { gameItemReadings } from './fixtures/dungeon-loot.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const filters = process.argv.slice(2);
const files: string[] = [];
for (const entry of await readdir(root, { recursive: true })) {
  if (entry.endsWith('.eval.ts')) {
    files.push(entry.replace(/\\/g, '/'));
  }
}
const evals: { name: string; definition: EvalDefinition }[] = [];
for (const file of files.sort()) {
  const definition = (await import(pathToFileURL(path.join(root, file)).href))
    .default as EvalDefinition;
  const name = path.basename(file, '.eval.ts');
  if (!filters.length || filters.some((f) => f === name || definition.tags?.includes(f))) {
    evals.push({ name, definition });
  }
}

// The eval bridge answers wow__item_sources for the requested IDs only, like
// the real bridge, instead of a stub that returns every item.
const sources = path.join(await mkdtemp(path.join(tmpdir(), 'wisp-evals-')), 'item-sources.json');
await writeFile(sources, JSON.stringify(itemSourcesFixture()));
process.env.WISP_EVAL_ITEM_SOURCES = sources;
// The game's item reading for wow__dungeon_loot, which the eval bridge joins with
// the shipped AtlasLoot data.
const items = path.join(path.dirname(sources), 'game-items.json');
await writeFile(items, JSON.stringify(gameItemReadings()));
process.env.WISP_EVAL_GAME_ITEMS = items;
const bridge = await startModelBridge();
setAgentHost({ origin: bridge.url, token: bridge.token });

let failed = 0;
const queue = [...evals];
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const started = performance.now();
    let lines: string[];
    try {
      const outcome = await runEval(next.definition);
      const ms = performance.now() - started;
      if (outcome.turn) {
        await saveTurn(next.name, next.definition.question, outcome.turn, outcome.steps, ms);
      }
      const ok = outcome.verdict !== 'failed';
      failed += ok ? 0 : 1;
      lines = [
        `${ok ? 'PASS' : 'FAIL'} ${next.name} (${(ms / 1000).toFixed(1)} s): ${next.definition.description}`,
        ...outcome.failed.map((label) => '  ✗ ' + label),
        ...outcome.soft.map((label) => '  ! ' + label + ' (soft)'),
        ...(outcome.error ? ['  ✗ ' + outcome.error] : []),
      ];
    } catch (error) {
      failed++;
      lines = [
        'FAIL ' + next.name + ': ' + (error instanceof Error ? error.message : String(error)),
      ];
    }
    console.log(lines.join('\n'));
  }
}
try {
  await Promise.all([worker(), worker()]);
} finally {
  await bridge.close();
}
console.log(`${evals.length - failed}/${evals.length} evals passed.`);
process.exitCode = failed ? 1 : 0;
