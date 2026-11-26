import { Effect, FileSystem, Predicate } from 'effect';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostError } from '../execution/engine-errors.ts';

/**
 * The authored instructions and skills. The packaged engine ships them as
 * assets next to its entry point and names that folder in WISP_AGENT_CONTENT.
 */
export function agentContentRoot() {
  if (process.env.WISP_AGENT_CONTENT) {
    return process.env.WISP_AGENT_CONTENT;
  }
  return fileURLToPath(new URL('./', import.meta.url));
}

export interface AuthoredSkill {
  name: string;
  description: string;
  instructions: string;
}

const readInstructions = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path.join(root, 'instructions.md'));
});

/**
 * Reads every `skills/<name>/SKILL.md`; the frontmatter name must match its folder.
 * Entries are listed by name only: the packaged engine reads these files from
 * pkg's snapshot, whose readdir ignores `withFileTypes`.
 */
export const readSkills = Effect.fnUntraced(function* (root = agentContentRoot()) {
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(root, 'skills');
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError((cause) => new HostError({ cause })));
  const skills = yield* Effect.forEach(
    names,
    Effect.fnUntraced(function* (name) {
      const file = yield* fs.readFileString(path.join(directory, name, 'SKILL.md')).pipe(
        Effect.catch((error) => {
          // A file, or a folder without SKILL.md, is not a skill.
          const { reason } = error;
          if (
            reason._tag === 'NotFound' ||
            (reason._tag === 'BadResource' &&
              Predicate.hasProperty(reason.cause, 'code') &&
              reason.cause.code === 'ENOTDIR')
          ) {
            return Effect.succeed(undefined);
          }
          return Effect.fail(new HostError({ cause: error }));
        }),
      );
      if (file === undefined) return undefined;
      return yield* Effect.try({
        try: () => parseSkill(name, file),
        catch: (cause) => new HostError({ cause }),
      });
    }),
    { concurrency: 'unbounded' },
  );
  return skills.filter((skill) => skill !== undefined).sort((a, b) => a.name.localeCompare(b.name));
});

function parseSkill(folder: string, file: string): AuthoredSkill {
  const text = file.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) {
    throw Error('Skill without frontmatter: ' + folder);
  }
  const field = (key: string) =>
    new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(match[1]!)?.[1]?.trim();
  const name = field('name');
  const description = field('description');
  if (name !== folder || !description) {
    throw Error('Skill frontmatter must name its folder and describe it: ' + folder);
  }
  return { name, description, instructions: match[2]!.trim() };
}

export const readContent = Effect.fn('WispAgent.readContent')(function* (
  root = agentContentRoot(),
) {
  const [instructions, skills] = yield* Effect.all(
    [
      readInstructions(root).pipe(Effect.mapError((cause) => new HostError({ cause }))),
      readSkills(root),
    ],
    { concurrency: 2 },
  );
  return { instructions, skills };
});
