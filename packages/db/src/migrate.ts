import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

export const migrationsFolder = fileURLToPath(new URL('./migrations/', import.meta.url));

export function migrateDatabase(client: DatabaseSync, folder = migrationsFolder) {
  const db = drizzle({ client });
  for (let attempt = 0; ; attempt++) {
    try {
      migrate(db, { migrationsFolder: folder });
      return db;
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const code =
        cause instanceof Error && 'errcode' in cause && typeof cause.errcode === 'number'
          ? cause.errcode & 0xff
          : 0;
      // Drizzle reads its journal before BEGIN, so a concurrent startup can win
      // the migration race. Retry contention; Drizzle still owns SQL and history.
      const contention =
        code === 5 ||
        code === 6 ||
        (cause instanceof Error && code === 1 && /^table .+ already exists$/.test(cause.message));
      if (attempt >= 2 || !contention) {
        throw error;
      }
    }
  }
}
