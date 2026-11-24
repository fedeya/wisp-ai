// Grades saved eval answers (.eve/eval-replies/runs.jsonl) with binary LLM
// judges (judges.ts), one verdict per judge each scenario lists, against the
// scenario's facts and the tool results the agent read.
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
import { startModelBridge } from './model-bridge.ts';
import { judges, type Judge, type JudgeName } from './judges.ts';
import { scenarios } from './quality.ts';

interface Run {
  label: string;
  name: string;
  prompt: string;
  seconds: number;
  steps: number;
  reply: string;
  presented: unknown[];
  results?: unknown[];
}
interface Verdict {
  run: number;
  label: string;
  name: string;
  judge: JudgeName;
  critique: string;
  result: 'Pass' | 'Fail';
}

const INSTRUCTIONS = `You are an evaluator for Wisp, an in-game World of Warcraft: Forever assistant.
Judge only against the FACTS, the TOOL RESULTS the agent read and the QUESTION, not your own game knowledge. A detail is supported when the facts or a tool result state it.
Item names may appear as [[ref:key]] placeholders; the PRESENTED references map those keys to items.
Stat keys use the game's own names: ITEM_MOD_INTELLECT_SHORT is Intellect, ITEM_MOD_SPELL_POWER_SHORT spell power, RESISTANCE0_NAME armor, and so on.
Answer the single criterion below with Pass or Fail. Write a detailed critique that cites the answer before giving the result.`;

// Tool results the judge reads, trimmed so a long run fits its context.
const RESULT_CHARS = 60_000;
function toolResults(run: Run) {
  const text = JSON.stringify(run.results ?? []);
  return text.length > RESULT_CHARS ? text.slice(0, RESULT_CHARS) + '…(truncated)' : text;
}

function prompt(judge: Judge) {
  return [
    INSTRUCTIONS,
    `## Criterion\n${judge.task}`,
    `## Definitions\nPASS: ${judge.pass}\nFAIL: ${judge.fail}`,
    '## Examples',
    ...judge.examples.map(
      (example, index) =>
        `### Example ${index + 1}\nAnswer: ${example.answer}\nCritique: ${example.critique}\nResult: ${example.result}`,
    ),
  ].join('\n\n');
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['critique', 'result'],
  properties: { critique: { type: 'string' }, result: { type: 'string', enum: ['Pass', 'Fail'] } },
};

async function judge(run: Run, index: number, name: JudgeName, model: string): Promise<Verdict> {
  const scenario = scenarios[run.name]!;
  // The model proxy sometimes answers 5xx for one request; retry those.
  const request = () =>
    fetch(process.env.WOW_BRIDGE_URL + '/model/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + process.env.WOW_BRIDGE_TOKEN,
      },
      body: JSON.stringify({
        model,
        instructions: prompt(judges[name]),
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  FACTS: scenario.facts,
                  QUESTION: run.prompt,
                  TOOL_RESULTS: toolResults(run),
                  PRESENTED: run.presented,
                  ANSWER: run.reply,
                }),
              },
            ],
          },
        ],
        text: { format: { type: 'json_schema', name: 'verdict', strict: true, schema } },
        reasoning: { effort: process.env.WISP_GRADE_EFFORT || 'medium' },
        stream: false,
      }),
    });
  let response = await request();
  for (let attempt = 1; attempt < 3 && response.status >= 500; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    response = await request();
  }
  if (!response.ok) {
    throw new Error('Judge request failed: ' + response.status + ' ' + (await response.text()));
  }
  const body = (await response.json()) as {
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  const text = body.output
    ?.find((item) => item.type === 'message')
    ?.content?.find((part) => part.type === 'output_text')?.text;
  if (!text) {
    throw new Error('Judge returned no answer');
  }
  return { run: index, label: run.label, name: run.name, judge: name, ...JSON.parse(text) };
}

async function main() {
  const dir = path.resolve(process.env.WISP_EVAL_OUT || 'apps/agent/.eve/eval-replies');
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
  const model = process.env.WISP_GRADE_MODEL || bridge.model;
  const queue = runs.flatMap((run, index) =>
    scenarios[run.name]!.judges.map((name) => ({ run, index, name })),
  );
  const verdicts: Verdict[] = [];
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          verdicts.push(await judge(job.run, job.index, job.name, model));
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
  console.log(`Judge model: ${model}\n`);
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
