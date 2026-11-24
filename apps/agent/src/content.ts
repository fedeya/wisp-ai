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
  return fileURLToPath(new URL('./wisp/', import.meta.url));
}

export interface AuthoredSkill {
  name: string;
  description: string;
  instructions: string;
}

export async function readInstructions(root = agentContentRoot()) {
  return readFile(path.join(root, 'instructions.md'), 'utf8');
}

/** Reads every `skills/<name>/SKILL.md`; the frontmatter name must match its folder. */
export async function readSkills(root = agentContentRoot()): Promise<AuthoredSkill[]> {
  const directory = path.join(root, 'skills');
  const entries = await readdir(directory, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const text = (await readFile(path.join(directory, entry.name, 'SKILL.md'), 'utf8')).replace(
          /\r\n/g,
          '\n',
        );
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
      }),
  );
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
