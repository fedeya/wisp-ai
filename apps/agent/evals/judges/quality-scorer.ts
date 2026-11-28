// The answer-quality grader: an LLM judge scores each rubric criterion against
// the scenario's facts and the tool results the agent read.
import { generateText, Output, wrapLanguageModel } from 'ai';
import { inject } from 'vitest';
import { createHarness, createJudge } from 'vitest-evals';
import type { JudgeHarnessInput, ToolCall } from 'vitest-evals';
import { Record, Schema } from 'effect';
import { IntBetween } from '../../src/contract/tool-inputs.ts';
import { connectionModel } from '../../src/models/connection-model.ts';
import { effectToolInput } from '../../src/tools/tool.ts';
import type { WispInput } from '../runtime/harness.ts';
import { criteria, scenarios } from './quality-rubric.ts';

const GRADER = `You grade answers from Wisp, an in-game World of Warcraft assistant.
Judge only against the FACTS, the TOOL RESULTS the agent read and the GOOD ANSWER description, not your own game knowledge: a detail is supported when the facts or a tool result state it, and anything else counts as unsupported.
Item names may appear as [[ref:key]] placeholders; the PRESENTED references map those keys to items.
Score each criterion 0, 1 or 2 using its definition. Be strict and consistent. In notes, give the one or two most important reasons for lost points, in English, under 50 words.`;

// Tool results the grader reads, trimmed so a long run fits its context.
const RESULT_CHARS = 60_000;
function toolResults(calls: ToolCall[]) {
  const text = JSON.stringify(
    calls
      .filter((call) => call.name !== 'wisp__present_ui')
      .map((call) => ({
        name: call.name,
        input: call.arguments,
        output: call.status === 'ok' ? call.result : undefined,
      })),
  );
  return text.length > RESULT_CHARS ? text.slice(0, RESULT_CHARS) + '…(truncated)' : text;
}

const keys = Record.keys(criteria);
const score = IntBetween(0, 2);
const grades = Schema.Struct({ ...Record.map(criteria, () => score), notes: Schema.String });
// The judge's structured output, with the JSON Schema zod wrote for it.
const gradesOutput = effectToolInput(grades, { layout: 'zod' });
const decodeGrades = Schema.decodeUnknownSync(grades);

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

export function qualityPrompt(name: string, question: string, reply: string, calls: ToolCall[]) {
  const scenario = scenarios[name];
  if (!scenario) {
    throw new Error('No quality facts for scenario ' + name);
  }
  return JSON.stringify({
    FACTS: scenario.facts,
    GOOD_ANSWER: scenario.goodAnswer,
    CRITERIA: criteria,
    QUESTION: question,
    TOOL_RESULTS: toolResults(calls),
    PRESENTED: calls
      .filter((call) => call.name === 'wisp__present_ui')
      .map((call) => call.arguments),
    ANSWER: reply,
  });
}

export async function gradeAnswer(
  model: ReturnType<typeof judgeModel>,
  prompt: string,
  signal?: AbortSignal,
) {
  return generateText({
    model,
    abortSignal: signal,
    instructions: GRADER,
    prompt,
    output: Output.object({ schema: gradesOutput }),
  });
}

const qualityModel = createHarness<JudgeHarnessInput, typeof grades.Type>({
  name: 'wisp-answer-quality-model',
  async run({ input: { prompt }, signal }) {
    const { origin, token, model } = inject('evalBridge');
    const { output, usage } = await gradeAnswer(
      judgeModel(origin, token, process.env.WISP_GRADE_MODEL || model),
      prompt,
      signal,
    );
    return {
      events: [
        { type: 'message', role: 'system', content: GRADER },
        { type: 'message', role: 'user', content: prompt },
        { type: 'message', role: 'assistant', content: output },
      ],
      output,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    };
  },
});

export function qualityJudges(name: string) {
  if (process.env.WISP_EVAL_GRADE !== '1') {
    return [];
  }
  return [
    createJudge<WispInput, { reply: string }>({
      name: 'Answer quality',
      judgeHarness: qualityModel,
      async assess({ input, output, toolCalls, runJudge }) {
        if (!runJudge) {
          throw new Error('Missing answer-quality judge harness');
        }
        const prompt = qualityPrompt(name, input.question, output.reply, toolCalls);
        const { notes, ...scores } = decodeGrades(await runJudge({ prompt }));
        return {
          score: keys.reduce((sum, key) => sum + scores[key], 0) / (keys.length * 2),
          metadata: { rationale: notes, output: scores },
        };
      },
    }),
  ];
}
