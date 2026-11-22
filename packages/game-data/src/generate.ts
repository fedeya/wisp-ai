// Regenerates Wisp's game data files from Forever's game tables.
//   pnpm data:generate [--refresh] [dataset ...]
// --refresh downloads the tables again instead of using the cache.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { datasets, pinned, wagoTables } from './index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const names = args.filter((arg) => !arg.startsWith('--'));
const selected = datasets().filter((dataset) => !names.length || names.includes(dataset.name));
if (names.length && selected.length !== names.length) {
  throw new Error(
    `Unknown dataset; known: ${datasets()
      .map((dataset) => dataset.name)
      .join(', ')}`,
  );
}
const tables = wagoTables(pinned.build, path.resolve(here, '../.cache'), refresh);
for (const dataset of selected) {
  const file = path.join(root, dataset.output);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await dataset.generate(tables, pinned.build));
  console.log(`${dataset.name}: wrote ${dataset.output} for build ${pinned.build}`);
}
