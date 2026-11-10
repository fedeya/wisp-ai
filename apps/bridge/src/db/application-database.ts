import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './migrate.ts';
import { preparePrivateDatabase } from './private-file.ts';

export type ApplicationOrm = Omit<ReturnType<typeof migrateDatabase>, '$client'>;

export class ApplicationDatabase {
  readonly file: string;
  private client?: DatabaseSync;
  private db?: ApplicationOrm;
  private opening?: Promise<void>;
  private importing?: Promise<void>;
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
    this.client = new DatabaseSync(this.file, { timeout: 5000 });
    this.client.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    // Changing a new database's journal mode can report BUSY immediately,
    // despite busy_timeout, when simultaneous first launches compete for it.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        this.client.exec('PRAGMA journal_mode=WAL;');
        break;
      } catch (error) {
        const code =
          error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
            ? error.errcode & 0xff
            : 0;
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    this.db = migrateDatabase(this.client);
  }
  async initializeProducts() {
    await this.initialize();
    await (this.importing ??= import('./product-store.ts')
      .then(({ importProductData }) => importProductData(this.file, this.orm))
      .catch((error) => {
        this.importing = undefined;
        throw error;
      }));
  }
  async transaction<T>(work: (db: ApplicationOrm) => T): Promise<T> {
    await this.initialize();
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
  async close() {
    this.closed = true;
    await this.opening?.catch(() => {});
    await this.importing?.catch(() => {});
    this.client?.close();
    this.client = undefined;
    this.db = undefined;
  }
}
