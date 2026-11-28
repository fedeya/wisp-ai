// @effect-migrated
import { Context, Duration, Effect, Exit, FileSystem, Layer } from 'effect';
import type { HostError } from '../execution/engine-errors.ts';
import { readContent, type AuthoredSkill } from './content.ts';
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

/** Wisp's instructions and skills, cached after the first successful load. */
export class WispAgent extends Context.Service<
  WispAgent,
  { readonly content: Effect.Effect<WispContent, HostError> }
>()('@wisp/agent/WispAgent') {}

export const layer = Layer.effect(
  WispAgent,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const load = readContent().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map(({ instructions, skills }) => ({
        system: systemPrompt(instructions, skills),
        skills,
      })),
    );
    const content = yield* Effect.cachedWithTTL(load, (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    );
    return WispAgent.of({ content });
  }),
);
