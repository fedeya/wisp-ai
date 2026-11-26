// The answer-quality grader: binary LLM judges (binary-judges.ts), each
// deciding one failure mode against the scenario's facts and the tool results
// the agent read. They run when WISP_EVAL_GRADE=1.
//
// Calibration (2026-11-23): 50 verdicts on the 26 English eval runs, labeled
// by Claude with the player deciding the ambiguous patterns. Agreement on
// Pass / Fail labels: unsupported-claim 20/22 and 4/4, the other judges 24/24
// Pass (no Fail examples yet). The set is small: read the critiques, and
// relabel after changing a judge, its examples or the model.
import { generateText, Output, wrapLanguageModel } from 'ai';
import { inject } from 'vitest';
import { createHarness, createJudge } from 'vitest-evals';
import type { JudgeHarnessInput, ToolCall } from 'vitest-evals';
import { z } from 'zod';
import { connectionModel } from '../../src/models/connection-model.ts';
import type { WispInput } from '../runtime/harness.ts';
import { judges, type Judge, type JudgeName } from './binary-judges.ts';
import { scenarios } from './quality-rubric.ts';

const INSTRUCTIONS = `You are an evaluator for Wisp, an in-game World of Warcraft: Forever assistant.
Judge only against the FACTS, the TOOL RESULTS the agent read and the QUESTION, not your own game knowledge. A detail is supported when the facts or a tool result state it.
Item names may appear as [[ref:key]] placeholders; the PRESENTED references map those keys to items.
Stat keys use the game's own names: ITEM_MOD_INTELLECT_SHORT is Intellect, ITEM_MOD_SPELL_POWER_SHORT spell power, RESISTANCE0_NAME armor, and so on.
Answer the single criterion below with Pass or Fail. Write a detailed critique that cites the answer before giving the result.`;

// Tool results the judge reads, trimmed so a long run fits its context.
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

/** The system prompt for one judge: its criterion, definitions and examples. */
export function judgeInstructions(judge: Judge) {
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

export function qualityPrompt(name: string, question: string, reply: string, calls: ToolCall[]) {
  const scenario = scenarios[name];
  if (!scenario) {
    throw new Error('No quality facts for scenario ' + name);
  }
  return JSON.stringify({
    FACTS: scenario.facts,
    QUESTION: question,
    TOOL_RESULTS: toolResults(calls),
    PRESENTED: calls
      .filter((call) => call.name === 'wisp__present_ui')
      .map((call) => call.arguments),
    ANSWER: reply,
  });
}

/** Asks one judge, given its instructions, about one answer. */
export async function judgeAnswer(
  model: ReturnType<typeof judgeModel>,
  system: string,
  prompt: string,
  signal?: AbortSignal,
) {
  return generateText({
    model,
    abortSignal: signal,
    instructions: system,
    prompt,
    output: Output.object({ schema: verdict }),
    // The model proxy sometimes answers 5xx for one request.
    maxRetries: 2,
  });
}

const judgeHarness = createHarness<JudgeHarnessInput, z.infer<typeof verdict>>({
  name: 'wisp-answer-judge-model',
  async run({ input: { system = INSTRUCTIONS, prompt }, signal }) {
    const { origin, token, model } = inject('evalBridge');
    const { output, usage } = await judgeAnswer(
      judgeModel(origin, token, process.env.WISP_GRADE_MODEL || model),
      system,
      prompt,
      signal,
    );
    return {
      events: [
        { type: 'message', role: 'system', content: system },
        { type: 'message', role: 'user', content: prompt },
        { type: 'message', role: 'assistant', content: output },
      ],
      output,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    };
  },
});

/** One judge per failure mode the scenario lists in quality-rubric.ts. */
export function qualityJudges(name: string) {
  if (process.env.WISP_EVAL_GRADE !== '1') {
    return [];
  }
  const scenario = scenarios[name];
  if (!scenario) {
    throw new Error('No quality facts for scenario ' + name);
  }
  return scenario.judges.map((judge: JudgeName) =>
    createJudge<WispInput, { reply: string }>({
      name: judge,
      judgeHarness,
      async assess({ input, output, toolCalls, runJudge }) {
        if (!runJudge) {
          throw new Error('Missing answer judge harness');
        }
        const { critique, result } = verdict.parse(
          await runJudge({
            system: judgeInstructions(judges[judge]),
            prompt: qualityPrompt(name, input.question, output.reply, toolCalls),
          }),
        );
        return {
          score: Number(result === 'Pass'),
          metadata: { rationale: critique, output: { result } },
        };
      },
    }),
  );
}
