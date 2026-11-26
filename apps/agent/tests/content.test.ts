import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSkills } from '../src/wisp/content.ts';

test('skills are the folders with a SKILL.md; other entries are skipped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-skills-'));
  try {
    await mkdir(path.join(root, 'skills/combat'), { recursive: true });
    await writeFile(
      path.join(root, 'skills/combat/SKILL.md'),
      '---\r\nname: combat\r\ndescription: Read the combat log.\r\n---\r\nUse wow__read_combat.\r\n',
    );
    await mkdir(path.join(root, 'skills/empty'));
    await writeFile(path.join(root, 'skills/README.md'), 'Not a skill.');
    expect(await readSkills(root)).toEqual([
      {
        name: 'combat',
        description: 'Read the combat log.',
        instructions: 'Use wow__read_combat.',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wisp's own skills all load", async () => {
  expect((await readSkills()).length).toBeGreaterThan(0);
});
