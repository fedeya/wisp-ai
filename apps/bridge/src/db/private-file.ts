import { chmod, mkdir } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';

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
