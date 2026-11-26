import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export async function readInstructions(root = agentContentRoot()) {
  return readFile(path.join(root, 'instructions.md'), 'utf8');
}

/**
 * Reads every `skills/<name>/SKILL.md`; the frontmatter name must match its folder.
 * Entries are listed by name only: the packaged engine reads these files from
 * pkg's snapshot, whose readdir ignores `withFileTypes`.
 */
export async function readSkills(root = agentContentRoot()): Promise<AuthoredSkill[]> {
  const directory = path.join(root, 'skills');
  const files = await Promise.all(
    (await readdir(directory)).map(async (name) => {
      try {
        return { name, file: await readFile(path.join(directory, name, 'SKILL.md'), 'utf8') };
      } catch (error) {
        // A file, or a folder without SKILL.md, is not a skill.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw error;
      }
    }),
  );
  const skills = files
    .filter((entry) => entry !== undefined)
    .map((entry) => {
      const text = entry.file.replace(/\r\n/g, '\n');
      const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
      if (!match) {
        throw Error('Skill without frontmatter: ' + entry.name);
      }
      const field = (key: string) =>
        new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(match[1]!)?.[1]?.trim();
      const name = field('name');
      const description = field('description');
      if (name !== entry.name || !description) {
        throw Error('Skill frontmatter must name its folder and describe it: ' + entry.name);
      }
      return { name, description, instructions: match[2]!.trim() };
    });
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
