import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv, type Row } from './csv.ts';

// Client languages wago.tools serves; enUS is the default.
export type Locale =
  | 'enUS'
  | 'esMX'
  | 'esES'
  | 'deDE'
  | 'frFR'
  | 'itIT'
  | 'ptBR'
  | 'ruRU'
  | 'koKR'
  | 'zhCN'
  | 'zhTW';

export interface TableSource {
  read(name: string, locale?: Locale): Promise<Row[]>;
}

const BASE = 'https://wago.tools';
const HEADERS = { 'user-agent': 'wisp-game-data' };

// Reads DB2 tables for one game build from wago.tools, keeping each CSV in
// cacheDir/<build>/<locale>/ so a regeneration can be repeated offline.
export function wagoTables(build: string, cacheDir: string, refresh = false): TableSource {
  return {
    async read(name, locale = 'enUS') {
      const file = path.join(cacheDir, build, locale, `${name}.csv`);
      if (!refresh) {
        const cached = await readFile(file, 'utf8').catch(() => null);
        if (cached !== null) {
          return parseCsv(cached);
        }
      }
      const query = new URLSearchParams({ build });
      if (locale !== 'enUS') {
        query.set('locale', locale);
      }
      const response = await fetch(`${BASE}/db2/${encodeURIComponent(name)}/csv?${query}`, {
        headers: HEADERS,
      });
      if (!response.ok) {
        throw new Error(
          `wago.tools ${name} (${locale}) for build ${build}: HTTP ${response.status}`,
        );
      }
      const text = await response.text();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      return parseCsv(text);
    },
  };
}

// The newest build wago.tools lists for a product, e.g. "wowf" for Forever.
export async function latestBuild(product: string): Promise<{ version: string; created: string }> {
  const response = await fetch(`${BASE}/api/builds`, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`wago.tools builds: HTTP ${response.status}`);
  }
  const builds = (await response.json()) as Record<
    string,
    Array<{ version: string; created_at: string }>
  >;
  const latest = builds[product]?.[0];
  if (!latest) {
    throw new Error(`wago.tools lists no builds for ${product}`);
  }
  return { version: latest.version, created: latest.created_at };
}

// Tables given inline, for tests; a locale other than enUS reads "<name>:<locale>".
export function memoryTables(tables: Record<string, Row[]>): TableSource {
  return {
    async read(name, locale = 'enUS') {
      const key = locale === 'enUS' ? name : `${name}:${locale}`;
      const rows = tables[key];
      if (!rows) {
        throw new Error(`Missing table ${key}`);
      }
      return rows;
    },
  };
}
