// Prints the Effect migration patterns each given file still contains:
// `pnpm --filter @wisp/tests effect:audit <files...>`, with paths relative to
// the repository root.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { countFile, presentPatterns, repositoryRoot } from './effect-migration.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('Usage: pnpm --filter @wisp/tests effect:audit <files...>\n');
  process.exitCode = 1;
}

for (const file of files) {
  const source = path.resolve(repositoryRoot, file);
  if (!existsSync(source)) {
    process.stdout.write(`${file}: not found\n`);
    process.exitCode = 1;
    continue;
  }
  const present = presentPatterns(countFile(source));
  const summary =
    present.length === 0
      ? 'clean'
      : present.map(({ pattern, count }) => `${pattern} ${count}`).join(', ');
  process.stdout.write(`${file}: ${summary}\n`);
}
