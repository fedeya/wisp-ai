import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { migrateDatabase } from './migrate.ts';
import { preparePrivateDatabase } from './private-file.ts';

export type ApplicationOrm = Omit<ReturnType<typeof migrateDatabase>, '$client'>;

const busyTimeoutMs = 5000;
const sqliteBusy = 5;

/** Wisp's SQLite file: opened privately in WAL mode and migrated before first use. */
export class Database {
  readonly file: string;
  private client: DatabaseSync | undefined;
  private db: ApplicationOrm | undefined;
  private opening: Promise<void> | undefined;
  private closed = false;
  constructor(file: string) {
    this.file = file;
  }
  get connection() {
    if (!this.client || this.closed) {
      throw Error('Application database is not open');
    }
    return this.client;
  }
  get orm() {
    if (!this.db || this.closed) {
      throw Error('Application database is not open');
    }
    return this.db;
  }
  async initialize() {
    if (this.closed) {
      throw Error('Application database is closed');
    }
    await (this.opening ??= this.open().catch((error) => {
      this.client?.close();
      this.client = undefined;
      this.db = undefined;
      this.opening = undefined;
      throw error;
    }));
  }
  private async open() {
    await preparePrivateDatabase(this.file);
    this.client = new DatabaseSync(this.file, { timeout: 0 });
    const deadline = performance.now() + busyTimeoutMs;
    for (;;) {
      try {
        this.client.exec('PRAGMA journal_mode=WAL;');
        break;
      } catch (error) {
        // WAL activation needs an exclusive lock. Yield between attempts so
        // another connection can release its lock, including in this process.
        if (
          !(error instanceof Error) ||
          !('errcode' in error) ||
          typeof error.errcode !== 'number' ||
          (error.errcode & 0xff) !== sqliteBusy ||
          performance.now() >= deadline
        ) {
          throw error;
        }
        await delay(25);
      }
    }
    this.client.exec(
      `PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`,
    );
    this.db = migrateDatabase(this.client);
  }
  async transaction<T>(work: (db: ApplicationOrm) => T): Promise<T> {
    await this.initialize();
    return this.transactionSync(work);
  }
  /** A transaction on an already initialized database, for callers that must not yield. */
  transactionSync<T>(work: (db: ApplicationOrm) => T): T {
    let result!: T;
    this.orm.transaction(
      (tx) => {
        result = work(tx);
        if (result instanceof Promise) {
          throw Error('SQLite transaction callbacks must be synchronous');
        }
      },
      { behavior: 'immediate' },
    );
    return result;
  }
  /** Waits for work a subclass started on the open database before the connection closes. */
  protected async settle() {}
  async close() {
    this.closed = true;
    await this.opening?.catch(() => {});
    await this.settle();
    this.client?.close();
    this.client = undefined;
    this.db = undefined;
  }
}
