import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';

export async function writeMigrationBackup(file: string, contents: Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Publish only complete backups and preserve any backup already in place.
      await link(temporary, file);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        !(await readFile(file)).equals(contents)
      ) {
        throw error;
      }
    }
  } finally {
    await unlink(temporary);
  }
}

// SQLite inherits the database mode for new WAL/SHM files on POSIX. Create the
// database before SQLite opens it, and tighten any already-existing sidecars.
export async function preparePrivateDatabase(file: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // Do not open/close an existing DB outside SQLite: closing an unrelated
    // descriptor can release another connection's POSIX advisory locks.
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  await protectDatabasePermissions(file);
}

export async function protectDatabasePermissions(file: string) {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      try {
        await chmod(file + suffix, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
}
