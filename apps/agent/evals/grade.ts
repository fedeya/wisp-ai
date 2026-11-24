// Grades saved eval answers (apps/agent/eval-replies/runs.jsonl) for quality with the
// eval model bridge, against each scenario's facts and a fixed rubric. The grader
// is a Mastra scorer whose judge is the eval model.
//
//   node apps/agent/evals/grade.ts [label ...]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelBridge } from './model-bridge.ts';
import { criteria } from './quality.ts';
import { grade, judgeModel, qualityScorer, type Run, type Scores } from './quality-scorer.ts';

const keys = Object.keys(criteria) as Array<keyof typeof criteria>;

async function main() {
  const dir = path.resolve(
    process.env.WISP_EVAL_OUT || fileURLToPath(new URL('../eval-replies/', import.meta.url)),
  );
  const labels = process.argv.slice(2);
  const runs = (await readFile(path.join(dir, 'runs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Run)
    .filter((run) => !labels.length || labels.includes(run.label));
  const bridge = await startModelBridge();
  const scorer = qualityScorer(
    judgeModel(bridge.url, bridge.token, process.env.WISP_GRADE_MODEL || bridge.model),
  );
  const graded: Array<Run & Scores & { notes: string; quality: number }> = [];
  try {
    const queue = [...runs];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let run = queue.shift(); run; run = queue.shift()) {
          graded.push({ ...run, ...(await grade(scorer, run)) });
        }
      }),
    );
  } finally {
    await bridge.close();
  }
  await writeFile(
    path.join(dir, 'graded.jsonl'),
    graded.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  const average = (list: Array<Record<string, any>>, key: string) =>
    (list.reduce((sum, entry) => sum + entry[key], 0) / list.length).toFixed(2);
  const groups = new Map<string, typeof graded>();
  for (const entry of graded) {
    const key = entry.name + '\t' + entry.label;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  console.log(['scenario', 'label', 'n', 'quality', ...keys, 'steps', 'seconds'].join('\t'));
  for (const [key, list] of [...groups].sort()) {
    console.log(
      [
        key,
        list.length,
        average(list, 'quality'),
        ...keys.map((name) => average(list, name)),
        average(list, 'steps'),
        average(list, 'seconds'),
      ].join('\t'),
    );
  }
  for (const label of new Set(graded.map((entry) => entry.label))) {
    const list = graded.filter((entry) => entry.label === label);
    console.log(['ALL', label, list.length, average(list, 'quality')].join('\t'));
  }
  console.log('\nLowest scores:');
  for (const entry of [...graded].sort((a, b) => a.quality - b.quality).slice(0, 8)) {
    console.log(`${entry.quality.toFixed(2)} ${entry.name} (${entry.label}): ${entry.notes}`);
  }
}

await main();
