import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface ReportedTurn {
  reply?: string;
  events: ReadonlyArray<{ type?: string }>;
  toolCalls: ReadonlyArray<{ name?: string; toolName?: string; input?: unknown; status?: string }>;
}
// Saves what the agent said and did, so a person can read the answers, and
// appends one summary line per run so configurations can be compared.
export async function saveTurn(name: string, prompt: string, turn: ReportedTurn, ms: number) {
  const dir = path.resolve(process.env.WISP_EVAL_OUT || '.eve/eval-replies');
  await mkdir(dir, { recursive: true });
  const calls = turn.toolCalls.map((call) => ({
    tool: call.toolName ?? call.name,
    status: call.status,
    input: call.input,
  }));
  const steps = turn.events.filter((event) => event.type === 'model.started').length;
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
      ...calls.map((call) => `- \`${call.tool}\` ${JSON.stringify(call.input)} (${call.status})`),
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
      presented,
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
      searches: calls.filter((call) => call.tool === 'eve__search').length,
      skills: turn.events.filter(
        (event) =>
          event.type === 'call.requested' &&
          (event as { data?: { capability?: { kind?: string } } }).data?.capability?.kind ===
            'skill',
      ).length,
    }) + '\n',
  );
}
