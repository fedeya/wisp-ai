// The answer-quality grader: binary LLM judges (judges.ts), each deciding one
// failure mode against the scenario's facts and the tool results the agent read.
import { generateText, Output, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { connectionModel } from '../src/models/connection-model.ts';
import { judges, type Judge, type JudgeName } from './judges.ts';
import { scenarios } from './quality.ts';

export interface Run {
  label: string;
  name: string;
  prompt: string;
  seconds: number;
  steps: number;
  reply: string;
  presented: unknown[];
  results?: unknown[];
}
export interface Verdict {
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

function instructions(judge: Judge) {
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

// The critique comes first so the judge reasons before it decides.
const verdict = z.object({ critique: z.string(), result: z.enum(['Pass', 'Fail']) });

/** The judge: the eval model through the eval bridge, at the grading effort. */
export function judgeModel(origin: string, token: string, model: string) {
  const effort = process.env.WISP_GRADE_EFFORT || 'medium';
  return wrapLanguageModel({
    model: connectionModel({ model, effort }, origin, token, async () => false),
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: { ...params.providerOptions?.openai, reasoningEffort: effort },
        },
      }),
    },
  });
}

/** Asks one judge about one saved answer. */
export async function judgeRun(
  model: ReturnType<typeof judgeModel>,
  run: Run,
  index: number,
  name: JudgeName,
): Promise<Verdict> {
  const scenario = scenarios[run.name];
  if (!scenario) {
    throw new Error('No quality facts for scenario ' + run.name);
  }
  const { output } = await generateText({
    model,
    instructions: instructions(judges[name]),
    prompt: JSON.stringify({
      FACTS: scenario.facts,
      QUESTION: run.prompt,
      TOOL_RESULTS: toolResults(run),
      PRESENTED: run.presented,
      ANSWER: run.reply,
    }),
    output: Output.object({ schema: verdict }),
    // The model proxy sometimes answers 5xx for one request.
    maxRetries: 2,
  });
  return { run: index, label: run.label, name: run.name, judge: name, ...output };
}
