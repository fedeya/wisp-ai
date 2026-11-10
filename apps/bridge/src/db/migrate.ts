import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { validateLegacyChats } from './legacy-schema.ts';

const journal = sqliteTable('wisp_migrations', {
  name: text().primaryKey(),
  hash: text().notNull(),
  appliedAt: integer('applied_at').notNull(),
});

export const migrationsFolder = fileURLToPath(new URL('./migrations/', import.meta.url));

// Drizzle Kit owns the SQL and snapshots. Apply them under one immediate lock:
// worktrees can start together, and divergent migration histories must not mix.
export function migrateChats(client: DatabaseSync, folder = migrationsFolder) {
  const db = drizzle({ client });
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  db.transaction(
    (tx) => {
      const version = Number(client.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 4) {
        throw Error(`Unsupported conversation database version: ${version}`);
      }
      tx.run(sql`CREATE TABLE IF NOT EXISTS wisp_migrations (
      name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL
    ) STRICT`);
      const applied = tx.select().from(journal).orderBy(journal.name).all();
      for (const [index, entry] of applied.entries()) {
        const expected = migrations[index];
        if (!expected || expected.name !== entry.name || expected.hash !== entry.hash) {
          throw Error('Conversation migrations differ from this version of Wisp.');
        }
      }
      for (const migration of migrations.slice(applied.length)) {
        if (migration.name === '20261110001924_normalize-conversations') {
          validateLegacyChats(client);
        }
        for (const statement of migration.sql) {
          if (statement.trim()) {
            tx.run(sql.raw(statement));
          }
        }
        tx.insert(journal)
          .values({ name: migration.name, hash: migration.hash, appliedAt: Date.now() })
          .run();
      }
      if (client.prepare('PRAGMA foreign_key_check').all().length) {
        throw Error('Conversation migration violated foreign key constraints.');
      }
      tx.run(sql`PRAGMA user_version = 4`);
    },
    { behavior: 'immediate' },
  );
  return db;
}
