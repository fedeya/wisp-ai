import { randomUUID } from 'node:crypto';
import { access, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { preparePrivateDatabase, protectDatabasePermissions } from './private-file.ts';

export const DATABASE_NAME = 'wisp.sqlite';
const LEGACY_DATABASE_NAME = 'chats.sqlite';

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

// Read-only selection for installation imports. A canonical database always
// wins, including when its history is empty or its schema cannot be opened.
export async function findApplicationDatabase(runtime: string) {
  for (const name of [DATABASE_NAME, LEGACY_DATABASE_NAME]) {
    const file = path.join(runtime, name);
    try {
      await access(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
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

export async function applicationDatabaseFile(runtime: string) {
  const destination = path.join(runtime, DATABASE_NAME);
  const source = await findApplicationDatabase(runtime);
  if (source && source !== destination) {
    // The retained legacy file belongs to this same runtime. Keep its backup
    // private too; external installation imports remain read-only.
    await protectDatabasePermissions(source);
    try {
      await copyDatabaseSnapshot(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  return destination;
}
