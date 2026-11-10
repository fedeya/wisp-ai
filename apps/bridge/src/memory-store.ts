import { readMemory, saveMemory, type MemorySlot, type MemoryEntry } from './db/product-store.ts';
import { ApplicationDatabase } from './db/application-database.ts';
export type { MemorySlot, MemoryEntry } from './db/product-store.ts';

export class MemoryStore {
  readonly database: ApplicationDatabase;
  constructor(database: ApplicationDatabase) {
    this.database = database;
  }
  async read(slot: MemorySlot, owner: string): Promise<MemoryEntry[]> {
    await this.database.initializeProducts();
    return readMemory(this.database.orm, slot, owner);
  }
  async update(
    slot: MemorySlot,
    owner: string,
    key: string,
    text?: string,
  ): Promise<MemoryEntry[]> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
      throw Error('Memory keys must be short identifiers');
    }
    if (text !== undefined && (!text.trim() || text.length > 1000)) {
      throw Error('Memory entries require 1–1000 characters');
    }
    await this.database.initializeProducts();
    return this.database.transaction((db) => {
      const entries = readMemory(db, slot, owner).filter((entry) => entry.key !== key);
      if (text !== undefined) {
        entries.push({ key, text: text.trim(), updatedAt: new Date().toISOString() });
      }
      if (
        entries.length > 40 ||
        entries.reduce((size, entry) => size + entry.text.length, 0) > 6000
      ) {
        throw Error('Memory is full; remove or shorten outdated entries first');
      }
      saveMemory(db, slot, owner, entries);
      return entries;
    });
  }
}
