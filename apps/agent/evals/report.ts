import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface ReportedTurn {
  reply?: string;
  toolCalls: ReadonlyArray<{ name?: string; toolName?: string; input?: unknown; status?: string }>;
}
// Saves what the agent said and did, so a person can read the answers.
export async function saveTurn(name: string, prompt: string, turn: ReportedTurn, ms: number) {
  const dir = path.resolve(process.env.WISP_EVAL_OUT || '.eve/eval-replies');
  await mkdir(dir, { recursive: true });
  const calls = turn.toolCalls.map((call) => ({
    tool: call.toolName ?? call.name,
    status: call.status,
    input: call.input,
  }));
  await writeFile(
    path.join(dir, name + '.md'),
    [
      '# ' + name,
      '',
      '**Prompt:** ' + prompt,
      '',
      `**Time:** ${(ms / 1000).toFixed(1)} s · **tool calls:** ${calls.length}`,
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
}
