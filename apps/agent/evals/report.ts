import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ReportedTurn {
  reply?: string;
  events: ReadonlyArray<{ type?: string }>;
  toolCalls: ReadonlyArray<{
    name?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    status?: string;
  }>;
}
// Saves what the agent said and did, so a person can read the answers, and
// appends one summary line per run so configurations can be compared.
export async function saveTurn(name: string, prompt: string, turn: ReportedTurn, ms: number) {
  const dir = path.resolve(
    process.env.WISP_EVAL_OUT || fileURLToPath(new URL('../eval-replies/', import.meta.url)),
  );
  await mkdir(dir, { recursive: true });
  const calls = turn.toolCalls.map((call) => ({
    tool: call.toolName ?? call.name,
    status: call.status,
    input: call.input,
    // Characters of the result the model read; about 4 per token.
    outputChars: call.output === undefined ? undefined : JSON.stringify(call.output).length,
  }));
  const steps = turn.events.filter((event) => event.type === 'usage.recorded').length;
  const label = process.env.WISP_EVAL_LABEL || 'run';
  await writeFile(
    path.join(dir, `${name}.${label}.md`),
    [
      '# ' + name + ' (' + label + ')',
      '',
      '**Prompt:** ' + prompt,
      '',
      `**Time:** ${(ms / 1000).toFixed(1)} s · **model steps:** ${steps} · **tool calls:** ${calls.length}`,
      '',
      '## Tool calls',
      '',
      ...calls.map(
        (call) =>
          `- \`${call.tool}\` ${JSON.stringify(call.input)} (${call.status}` +
          (call.outputChars === undefined ? ')' : `, ${call.outputChars} chars)`),
      ),
      '',
      '## Reply',
      '',
      turn.reply ?? '(no reply)',
      '',
    ].join('\n'),
  );
  // Full runs for apps/agent/evals/grade.ts, which grades answers afterwards.
  const presented = turn.toolCalls
    .filter((call) => (call.toolName ?? call.name) === 'wisp__present_ui')
    .map((call) => call.input);
  await appendFile(
    path.join(dir, 'runs.jsonl'),
    JSON.stringify({
      label,
      name,
      prompt,
      seconds: Math.round(ms / 100) / 10,
      steps,
      tools: calls.map((call) => call.tool),
      outputChars: calls.map((call) => call.outputChars ?? null),
      presented,
      // What the agent read, so the grader judges against the same data.
      results: turn.toolCalls
        .filter((call) => (call.toolName ?? call.name) !== 'wisp__present_ui')
        .map((call) => ({
          tool: call.toolName ?? call.name,
          input: call.input,
          output: call.output,
        })),
      reply: turn.reply ?? '',
    }) + '\n',
  );
  await appendFile(
    path.join(dir, 'summary.jsonl'),
    JSON.stringify({
      label,
      name,
      seconds: Math.round(ms / 100) / 10,
      steps,
      calls: calls.length,
      searches: calls.filter((call) => call.tool === 'tool_search').length,
      skills: calls.filter((call) => call.tool === 'skill').length,
    }) + '\n',
  );
}
