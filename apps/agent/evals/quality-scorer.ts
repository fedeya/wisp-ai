// The answer-quality grader: an LLM judge scores each rubric criterion against
// the scenario's facts and the tool results the agent read.
import { Effect, Schema } from 'effect';
import { LanguageModel } from 'effect/ai';
import { connectionModel } from '../src/connection-model.ts';
import { aiSdkLanguageModel, providerCause } from '../src/effect-model.ts';
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
const score = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }));
const Grades = Schema.Struct({
  ...(Object.fromEntries(keys.map((key) => [key, score])) as Record<
    keyof typeof criteria,
    typeof score
  >),
  notes: Schema.String,
});

/** The judge: the eval model through the eval bridge, at the grading effort. */
export function judgeModel(origin: string, token: string, model: string) {
  const effort = process.env.WISP_GRADE_EFFORT || 'medium';
  return aiSdkLanguageModel(
    connectionModel({ model, effort }, origin, token, async () => false),
    { openai: { reasoningEffort: effort } },
  );
}

/** Grades one saved answer; quality is the share of rubric points it earned. */
export function qualityScorer(model: ReturnType<typeof judgeModel>) {
  return (run: Run) =>
    Effect.gen(function* () {
      const scenario = scenarios[run.name];
      if (!scenario) {
        return yield* Effect.fail(Error('No quality facts for scenario ' + run.name));
      }
      const response = yield* LanguageModel.generateObject({
        objectName: 'grades',
        schema: Grades,
        prompt: [
          { role: 'system', content: GRADER },
          {
            role: 'user',
            content: JSON.stringify({
              FACTS: scenario.facts,
              GOOD_ANSWER: scenario.goodAnswer,
              CRITERIA: criteria,
              QUESTION: run.prompt,
              TOOL_RESULTS: toolResults(run),
              PRESENTED: run.presented,
              ANSWER: run.reply,
            }),
          },
        ],
      }).pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, model));
      const scores = response.value;
      return {
        ...scores,
        quality: keys.reduce((sum, key) => sum + scores[key], 0) / (keys.length * 2),
      };
    });
}

export function grade(scorer: ReturnType<typeof qualityScorer>, run: Run) {
  return Effect.runPromise(
    scorer(run).pipe(Effect.mapError((error) => providerCause(error))),
  ) as Promise<Scores & { notes: string; quality: number }>;
}
