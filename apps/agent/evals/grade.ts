// Grades saved eval answers (.eve/eval-replies/runs.jsonl) for quality with the
// eval model bridge, against each scenario's facts and a fixed rubric.
//
//   node apps/agent/evals/grade.ts [label ...]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startModelBridge } from './model-bridge.ts';
import { criteria, scenarios } from './quality.ts';

interface Run {
  label: string;
  name: string;
  prompt: string;
  seconds: number;
  steps: number;
  reply: string;
  presented: unknown[];
}
type Scores = Record<keyof typeof criteria, number>;

const GRADER = `You grade answers from Wisp, an in-game World of Warcraft assistant.
Judge only against the FACTS and the GOOD ANSWER description provided, not your own game knowledge: anything the facts do not support counts as unsupported.
Item names may appear as [[ref:key]] placeholders; the PRESENTED references map those keys to items.
Score each criterion 0, 1 or 2 using its definition. Be strict and consistent. In notes, give the one or two most important reasons for lost points, in English, under 50 words.`;

const keys = Object.keys(criteria) as Array<keyof typeof criteria>;
const schema = {
  type: 'object',
  additionalProperties: false,
  required: [...keys, 'notes'],
  properties: {
    ...Object.fromEntries(keys.map((key) => [key, { type: 'integer', enum: [0, 1, 2] }])),
    notes: { type: 'string' },
  },
};

async function grade(run: Run, model: string): Promise<Scores & { notes: string }> {
  const scenario = scenarios[run.name];
  if (!scenario) {
    throw new Error('No quality facts for scenario ' + run.name);
  }
  const response = await fetch(process.env.WOW_BRIDGE_URL + '/model/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.WOW_BRIDGE_TOKEN,
    },
    body: JSON.stringify({
      model,
      instructions: GRADER,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                FACTS: scenario.facts,
                GOOD_ANSWER: scenario.goodAnswer,
                CRITERIA: criteria,
                QUESTION: run.prompt,
                PRESENTED: run.presented,
                ANSWER: run.reply,
              }),
            },
          ],
        },
      ],
      text: { format: { type: 'json_schema', name: 'grade', strict: true, schema } },
      reasoning: { effort: process.env.WISP_GRADE_EFFORT || 'medium' },
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error('Grader request failed: ' + response.status + ' ' + (await response.text()));
  }
  const body = (await response.json()) as {
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  const text = body.output
    ?.find((item) => item.type === 'message')
    ?.content?.find((part) => part.type === 'output_text')?.text;
  if (!text) {
    throw new Error('Grader returned no answer');
  }
  return JSON.parse(text);
}

async function main() {
  const dir = path.resolve(process.env.WISP_EVAL_OUT || 'apps/agent/.eve/eval-replies');
  const labels = process.argv.slice(2);
  const runs = (await readFile(path.join(dir, 'runs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Run)
    .filter((run) => !labels.length || labels.includes(run.label));
  const bridge = await startModelBridge();
  const graded: Array<Run & Scores & { notes: string; quality: number }> = [];
  try {
    const queue = [...runs];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let run = queue.shift(); run; run = queue.shift()) {
          const scores = await grade(run, process.env.WISP_GRADE_MODEL || bridge.model);
          const quality = keys.reduce((sum, key) => sum + scores[key], 0) / (keys.length * 2);
          graded.push({ ...run, ...scores, quality });
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
