import { Database } from '@wisp/db/database';
import { importProductData } from './product-store.ts';

/** The application database, plus the one-time import of routines, panels and memory from JSON. */
export class ApplicationDatabase extends Database {
  private importing?: Promise<void>;
  async initializeProducts() {
    await this.initialize();
    await (this.importing ??= importProductData(this.file, this.orm).catch((error) => {
      this.importing = undefined;
      throw error;
    }));
  }
  protected override async settle() {
    await this.importing?.catch(() => {});
  }
}
