// The answer-quality grader: an LLM judge scores each rubric criterion against
// the scenario's facts and the tool results the agent read.
import { generateText, Output, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { connectionModel } from '../src/models/connection-model.ts';
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

/** Grades one saved answer; quality is the share of rubric points it earned. */
export function qualityScorer(model: ReturnType<typeof judgeModel>) {
  return async (run: Run) => {
    const scenario = scenarios[run.name];
    if (!scenario) {
      throw new Error('No quality facts for scenario ' + run.name);
    }
    const { output } = await generateText({
      model,
      instructions: GRADER,
      prompt: JSON.stringify({
        FACTS: scenario.facts,
        GOOD_ANSWER: scenario.goodAnswer,
        CRITERIA: criteria,
        QUESTION: run.prompt,
        TOOL_RESULTS: toolResults(run),
        PRESENTED: run.presented,
        ANSWER: run.reply,
      }),
      output: Output.object({ schema: grades }),
    });
    return {
      ...output,
      quality: keys.reduce((sum, key) => sum + output[key], 0) / (keys.length * 2),
    };
  };
}

export function grade(scorer: ReturnType<typeof qualityScorer>, run: Run) {
  return scorer(run);
}
