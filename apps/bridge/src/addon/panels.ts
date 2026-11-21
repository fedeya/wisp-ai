import { z } from 'zod';
import { readPanels, savePanels } from '../db/product-store.ts';
import { ApplicationDatabase } from '../db/application-database.ts';
import { panelContent, panelInput, type Panel } from '@wisp/protocol/panels';
export class PanelStore {
  readonly database: ApplicationDatabase;
  panels: Panel[] = [];
  queue: Promise<unknown> = Promise.resolve();
  constructor(database: ApplicationDatabase) {
    this.database = database;
  }
  async load() {
    await this.database.initializeProducts();
    this.panels = readPanels(this.database.orm);
  }
  /**
   * Re-read after another writer changed panel rows: now, and again after any
   * mutation already in flight, which would otherwise restore its own copy.
   */
  refresh() {
    this.panels = readPanels(this.database.orm);
    const reload = this.queue.catch(() => {}).then(() => this.load());
    // Nobody awaits this reload; a failure only leaves the cache from just now.
    reload.catch(() => {});
    this.queue = reload;
  }
  list(characterKey: string) {
    return this.panels.filter((p) => p.characterKey === characterKey);
  }
  async mutate(characterKey: string, input: z.infer<typeof panelInput>) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        await this.database.initializeProducts();
        this.panels = await this.database.transaction((db) => {
          const id = input.operation === 'save' ? input.panel.id : 'id' in input ? input.id : '';
          const all = readPanels(db);
          const previous = all.find((p) => p.characterKey === characterKey && p.id === id);
          const next = all.filter((p) => p !== previous);
          if (input.operation === 'save') {
            // Only new panels count against the limit, so panels merged past it
            // can still be edited.
            if (!previous && next.filter((p) => p.characterKey === characterKey).length >= 12) {
              throw Error('Keep at most 12 panels per character');
            }
            // Edits keep the key an adopted panel came from, so the addon can
            // still move its saved layout if it has not applied the move yet.
            const formerKey = previous?.formerKey;
            next.push({
              ...panelContent.parse(input.panel),
              characterKey,
              updatedAt: Date.now(),
              ...(formerKey ? { formerKey } : {}),
            });
          } else if (input.operation !== 'remove') {
            return readPanels(db);
          }
          savePanels(db, next);
          return next;
        });
      });
    this.queue = work;
    await work;
    return this.list(characterKey);
  }
}
