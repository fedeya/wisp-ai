import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv, type Row } from './csv.ts';

export interface TableSource {
  read(name: string): Promise<Row[]>;
}

// Reads DB2 tables for one game build from wago.tools, keeping each CSV in
// cacheDir so a regeneration can be repeated offline with identical input.
export function wagoTables(build: string, cacheDir: string, refresh = false): TableSource {
  return {
    async read(name) {
      const file = path.join(cacheDir, build, `${name}.csv`);
      if (!refresh) {
        const cached = await readFile(file, 'utf8').catch(() => null);
        if (cached !== null) {
          return parseCsv(cached);
        }
      }
      const response = await fetch(
        `https://wago.tools/db2/${encodeURIComponent(name)}/csv?build=${encodeURIComponent(build)}`,
        { headers: { 'user-agent': 'wisp-game-data' } },
      );
      if (!response.ok) {
        throw new Error(`wago.tools ${name} for build ${build}: HTTP ${response.status}`);
      }
      const text = await response.text();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      return parseCsv(text);
    },
  };
}

// Tables given inline, for tests.
export function memoryTables(tables: Record<string, Row[]>): TableSource {
  return {
    async read(name) {
      const rows = tables[name];
      if (!rows) {
        throw new Error(`Missing table ${name}`);
      }
      return rows;
    },
  };
}
