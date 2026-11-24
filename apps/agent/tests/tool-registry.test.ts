import { expect, test } from 'vitest';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { authoredTools } from '../src/tools.ts';

test('the static tool registry lists every authored tool', async () => {
  const files = await readdir(fileURLToPath(new URL('../agent/tools/', import.meta.url)));
  const names = files
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -3))
    .sort();
  expect(Object.keys(authoredTools).sort()).toEqual(names);
  for (const [name, tool] of Object.entries(authoredTools)) {
    expect(tool.description, name).toBeTruthy();
    expect(typeof tool.execute, name).toBe('function');
  }
});
