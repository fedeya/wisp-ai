import { Database } from '@wisp/db/database';
import * as Sql from '@wisp/db/sql-database';
import { metadata } from '@wisp/db/schema';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { importProductData, productImportMarker } from './migrations/product-json.ts';

/** The application database, plus the one-time import of routines, panels and memory from JSON. */
export class ApplicationDatabase extends Database {
  private importing?: Promise<void>;
  async initializeProducts() {
    await this.initialize();
    if (this.orm.select().from(metadata).where(eq(metadata.key, productImportMarker)).get()) return;
    const migrate = Effect.flatMap(Sql.SqlDatabase, ({ db }) => importProductData(this.file, db));
    await (this.importing ??= Effect.runPromise(
      migrate.pipe(Effect.provide(Sql.layer(this.file))),
    ).catch((error: unknown) => {
      this.importing = undefined;
      throw error;
    }));
  }
  protected override async settle() {
    await this.importing?.catch(() => {});
  }
}
