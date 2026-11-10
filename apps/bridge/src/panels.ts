import { z } from 'zod';
import { readPanels, savePanels } from './db/product-store.ts';
import { ApplicationDatabase } from './db/application-database.ts';
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
  list(characterKey: string) {
    return this.panels.filter((p) => p.characterKey === characterKey);
  }
  async mutate(characterKey: string, input: z.infer<typeof panelInput>) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        await this.database.initializeProducts();
        this.panels = await this.database.transaction((db) => {
          const next = readPanels(db).filter(
            (p) =>
              !(
                p.characterKey === characterKey &&
                p.id ===
                  (input.operation === 'save' ? input.panel.id : 'id' in input ? input.id : '')
              ),
          );
          if (input.operation === 'save') {
            if (next.filter((p) => p.characterKey === characterKey).length >= 12) {
              throw Error('Keep at most 12 panels per character');
            }
            next.push({ ...panelContent.parse(input.panel), characterKey, updatedAt: Date.now() });
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
