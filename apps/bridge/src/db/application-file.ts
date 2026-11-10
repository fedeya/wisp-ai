import { randomUUID } from 'node:crypto';
import { access, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { preparePrivateDatabase } from './private-file.ts';

export const DATABASE_NAME = 'wisp.sqlite';

async function removeTemporarySnapshot(file: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      await unlink(file + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function applicationDatabaseFile(runtime: string) {
  return path.join(runtime, DATABASE_NAME);
}

export async function findApplicationDatabase(runtime: string) {
  const file = applicationDatabaseFile(runtime);
  try {
    await access(file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
export async function copyDatabaseSnapshot(source: string, destination: string) {
  const temporary = path.join(path.dirname(destination), `.wisp-import-${randomUUID()}.sqlite`);
  let database: DatabaseSync | undefined;
  try {
    await preparePrivateDatabase(temporary);
    database = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    // The backup API includes committed WAL pages; copying the main file alone
    // would silently omit recent history from an open source database.
    await backup(database, temporary);
    database.close();
    database = undefined;
    // Publish a complete file atomically without replacing a concurrent winner.
    // Both paths are in the same directory/filesystem. Keep the source intact.
    await link(temporary, destination);
  } finally {
    database?.close();
    await removeTemporarySnapshot(temporary);
  }
}
