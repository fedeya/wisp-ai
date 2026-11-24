// The answer-quality grader as a Mastra scorer: an LLM judge scores each rubric
// criterion against the scenario's facts and the tool results the agent read.
import { createScorer } from '@mastra/core/evals';
import { wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { connectionModel } from '../src/connection-model.ts';
import { criteria, scenarios } from './quality.ts';

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
export type Scores = Record<keyof typeof criteria, number>;

const GRADER = `You grade answers from Wisp, an in-game World of Warcraft assistant.
Judge only against the FACTS, the TOOL RESULTS the agent read and the GOOD ANSWER description, not your own game knowledge: a detail is supported when the facts or a tool result state it, and anything else counts as unsupported.
Item names may appear as [[ref:key]] placeholders; the PRESENTED references map those keys to items.
Score each criterion 0, 1 or 2 using its definition. Be strict and consistent. In notes, give the one or two most important reasons for lost points, in English, under 50 words.`;

// Tool results the grader reads, trimmed so a long run fits its context.
const RESULT_CHARS = 60_000;
function toolResults(run: Run) {
  const text = JSON.stringify(run.results ?? []);
  return text.length > RESULT_CHARS ? text.slice(0, RESULT_CHARS) + '…(truncated)' : text;
}

const keys = Object.keys(criteria) as Array<keyof typeof criteria>;
const grades = z.object({
  ...(Object.fromEntries(keys.map((key) => [key, z.number().int().min(0).max(2)])) as Record<
    keyof typeof criteria,
    z.ZodNumber
  >),
  notes: z.string(),
});

// The judge: the eval model through the eval bridge, at the grading effort.
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

export function qualityScorer(model: ReturnType<typeof judgeModel>) {
  return createScorer<Run, Run>({
    id: 'answer-quality',
    description: "Grades a saved answer against its scenario's facts and the rubric.",
    judge: { model: model as never, instructions: GRADER },
  })
    .analyze({
      description: 'Score each criterion 0, 1 or 2 and note the main reasons for lost points.',
      outputSchema: grades,
      createPrompt: ({ run }) => {
        const scenario = scenarios[run.input!.name];
        if (!scenario) {
          throw new Error('No quality facts for scenario ' + run.input!.name);
        }
        return JSON.stringify({
          FACTS: scenario.facts,
          GOOD_ANSWER: scenario.goodAnswer,
          CRITERIA: criteria,
          QUESTION: run.input!.prompt,
          TOOL_RESULTS: toolResults(run.input!),
          PRESENTED: run.input!.presented,
          ANSWER: run.input!.reply,
        });
      },
    })
    .generateScore(({ results }) => {
      const scores = results.analyzeStepResult as z.infer<typeof grades>;
      return keys.reduce((sum, key) => sum + scores[key], 0) / (keys.length * 2);
    });
}

export async function grade(scorer: ReturnType<typeof qualityScorer>, run: Run) {
  const result = await scorer.run({ input: run, output: run });
  return {
    ...(result.analyzeStepResult as z.infer<typeof grades>),
    quality: result.score ?? 0,
  };
}
