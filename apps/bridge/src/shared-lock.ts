import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ApplicationDatabase } from './db/application-database.ts';
import { metadata } from './db/schema.ts';

const held = new AsyncLocalStorage<Set<string>>();
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// Local-machine coordination: never hold a SQLite transaction across network I/O.
// A crashed process leaves a row that the next caller can reclaim by PID.
export function sharedLock(database: ApplicationDatabase) {
  return async function exclusive<T>(
    name: string,
    work: () => Promise<T>,
    timeout = 30000,
  ): Promise<T> {
    const key = 'dev-lock:' + name;
    const identity = database.file + ':' + key;
    if (held.getStore()?.has(identity)) {
      return work();
    }
    const value = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const started = Date.now();
    while (true) {
      const acquired = await database.transaction((db) => {
        const row = db.select().from(metadata).where(eq(metadata.key, key)).get();
        if (row && alive(JSON.parse(row.value).pid)) {
          return false;
        }
        db.insert(metadata)
          .values({ key, value })
          .onConflictDoUpdate({ target: metadata.key, set: { value } })
          .run();
        return true;
      });
      if (acquired) {
        break;
      }
      if (Date.now() - started >= timeout) {
        throw Error('Another development instance owns ' + name + '. Close it or try again.');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await held.run(new Set([...(held.getStore() ?? []), identity]), work);
    } finally {
      await database.transaction((db) => {
        const row = db.select().from(metadata).where(eq(metadata.key, key)).get();
        if (row?.value === value) {
          db.delete(metadata).where(eq(metadata.key, key)).run();
        }
      });
    }
  };
}
