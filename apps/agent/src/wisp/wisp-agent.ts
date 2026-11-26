import { Context, Effect, Layer } from 'effect';
import { hostCall, type HostError } from '../execution/engine-errors.ts';
import { readInstructions, readSkills, type AuthoredSkill } from './content.ts';
import { SKILL } from '../tools/turn-tools.ts';

export interface WispContent {
  /** instructions.md followed by the list of skills the skill tool loads. */
  system: string;
  skills: AuthoredSkill[];
}

function escape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The system prompt: Wisp's instructions, then each skill's name and description. */
export function systemPrompt(instructions: string, skills: AuthoredSkill[]) {
  if (!skills.length) {
    return instructions.trim();
  }
  const listed = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escape(skill.name)}</name>\n    <description>${escape(skill.description)}</description>\n  </skill>`,
    )
    .join('\n');
  return [
    instructions.trim(),
    `<available_skills>\n${listed}\n</available_skills>`,
    `Skills are not tools: to use one, call the \`${SKILL}\` tool with its name. When the player asks about a topic a skill covers, load it without asking first.`,
  ].join('\n\n');
}

let content: Promise<WispContent> | undefined;
/** Wisp's instructions and skills (src/wisp), read once. */
export function wispContent() {
  content ??= Promise.all([readInstructions(), readSkills()]).then(([instructions, skills]) => ({
    system: systemPrompt(instructions, skills),
    skills,
  }));
  content.catch(() => (content = undefined));
  return content;
}

/** Wisp's instructions and skills, read once per process. */
export class WispAgent extends Context.Service<
  WispAgent,
  { readonly content: Effect.Effect<WispContent, HostError> }
>()('@wisp/agent/WispAgent') {
  static readonly layer = Layer.succeed(
    WispAgent,
    WispAgent.of({ content: hostCall(() => wispContent()) }),
  );
}
