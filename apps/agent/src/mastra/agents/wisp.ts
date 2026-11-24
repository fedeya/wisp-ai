import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { createSkill } from '@mastra/core/skills';
import { readInstructions, readSkills } from '../../content.ts';
import { authoredTools } from '../../tools.ts';
import { assembleTools, authored } from '../../turn-tools.ts';

/** The RequestContext key that carries a turn's model and tools. */
export const WISP_TURN = 'wisp.turn';
export interface WispTurn {
  model: unknown;
  tools: Record<string, unknown>;
}

let content:
  | Promise<{ instructions: string; skills: ReturnType<typeof createSkill>[] }>
  | undefined;
/** instructions.md and skills/, read once. */
export function wispContent() {
  content ??= Promise.all([readInstructions(), readSkills()]).then(([instructions, skills]) => ({
    instructions,
    skills: skills.map((skill) => createSkill(skill)),
  }));
  content.catch(() => (content = undefined));
  return content;
}

const turnOf = (requestContext: RequestContext | undefined) =>
  requestContext?.get(WISP_TURN) as WispTurn | undefined;

// Mastra Studio has no Wisp turn: it offers every authored tool without
// capability checks, and a model from WISP_STUDIO_MODEL (with its API key).
// Tool calls still need a running bridge and game. Mastra may also ask for the
// model without a turn to inspect it, as runEvals does before each run.
const STUDIO_MODEL = 'openai/gpt-6.1-sol';
function studioModel() {
  return process.env.WISP_STUDIO_MODEL || STUDIO_MODEL;
}
function studioTools() {
  const entries = Object.entries(authoredTools);
  return assembleTools({
    session: 'studio',
    signal: new AbortController().signal,
    direct: Object.fromEntries(entries.filter(([, tool]) => !tool.deferred)),
    deferred: entries
      .filter(([, tool]) => tool.deferred)
      .map(([name, tool]) => authored(name, tool)),
  }).tools;
}

/**
 * Wisp, the in-game assistant. The bridge runs it in process: each turn puts
 * the conversation's model and its allowed tools in the request context.
 */
export const wisp = new Agent({
  id: 'wisp',
  name: 'Wisp',
  description: 'In-game assistant for World of Warcraft: Forever.',
  instructions: async () => (await wispContent()).instructions,
  model: ({ requestContext }) => (turnOf(requestContext)?.model ?? studioModel()) as never,
  tools: ({ requestContext }) => (turnOf(requestContext)?.tools ?? studioTools()) as never,
  skills: async () => (await wispContent()).skills,
});
