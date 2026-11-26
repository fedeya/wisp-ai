import { createJudge, toolCalls } from 'vitest-evals';
import type { HarnessRun } from 'vitest-evals';

/** Wisp can name items by registering references instead of spelling them out. */
export function presentedText(run: HarnessRun<{ reply: string }>) {
  const panels = toolCalls(run)
    .filter((call) => call.name === 'wisp__present_ui')
    .map((call) => call.arguments);
  return run.output.reply + JSON.stringify(panels);
}

export function avoidsTool(name: string) {
  return createJudge(`did not call ${name}`, ({ toolCalls }) => ({
    score: Number(!toolCalls.some((call) => call.name === name)),
  }));
}

export function maxToolCalls(count: number) {
  return createJudge(`at most ${count} tool calls`, ({ toolCalls }) => ({
    score: Number(toolCalls.length <= count),
  }));
}
