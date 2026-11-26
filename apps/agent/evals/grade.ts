// Grades saved eval answers (apps/agent/eval-replies/runs.jsonl) with binary
// LLM judges (judges.ts), one verdict per judge each scenario lists, against
// the scenario's facts and the tool results the agent read.
//
//   node apps/agent/evals/grade.ts [label ...]
//
// Calibration (2026-11-23): 50 verdicts on the 26 English eval runs, labeled
// by Claude with the player deciding the ambiguous patterns. Agreement on
// Pass / Fail labels: unsupported-claim 20/22 and 4/4, the other judges 24/24
// Pass (no Fail examples yet). The set is small: read the critiques, and
// relabel after changing a judge, its examples or the model.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelBridge } from './model-bridge.ts';
import { judges, type JudgeName } from './judges.ts';
import { scenarios } from './quality.ts';
import { judgeModel, judgeRun, type Run, type Verdict } from './quality-scorer.ts';

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
  for (const run of runs) {
    if (!scenarios[run.name]) throw new Error('No facts for scenario ' + run.name);
  }
  const bridge = await startModelBridge();
  const modelName = process.env.WISP_GRADE_MODEL || bridge.model;
  const model = judgeModel(bridge.url, bridge.token, modelName);
  const queue = runs.flatMap((run, index) =>
    scenarios[run.name]!.judges.map((name) => ({ run, index, name })),
  );
  const verdicts: Verdict[] = [];
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          verdicts.push(await judgeRun(model, job.run, job.index, job.name));
        }
      }),
    );
  } finally {
    await bridge.close();
  }
  await writeFile(
    path.join(dir, 'verdicts.jsonl'),
    verdicts.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  console.log(`Judge model: ${modelName}\n`);
  console.log(['scenario', 'label', 'judge', 'passed'].join('\t'));
  const groups = new Map<string, Verdict[]>();
  for (const verdict of verdicts) {
    const key = [verdict.name, verdict.label, verdict.judge].join('\t');
    groups.set(key, [...(groups.get(key) ?? []), verdict]);
  }
  for (const [key, list] of [...groups].sort()) {
    console.log(`${key}\t${list.filter((v) => v.result === 'Pass').length}/${list.length}`);
  }
  for (const name of Object.keys(judges) as JudgeName[]) {
    const list = verdicts.filter((v) => v.judge === name);
    if (list.length) {
      console.log(
        `ALL\t\t${name}\t${list.filter((v) => v.result === 'Pass').length}/${list.length}`,
      );
    }
  }
  console.log('\nFailures:');
  for (const verdict of verdicts.filter((v) => v.result === 'Fail')) {
    console.log(
      `- run ${verdict.run} ${verdict.name} (${verdict.label}) ${verdict.judge}: ${verdict.critique}`,
    );
  }
}

await main();
