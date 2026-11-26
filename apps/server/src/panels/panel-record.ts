import { and, eq } from 'drizzle-orm';
import type { Panel } from '@wisp/agent/contract/panels';
import type { ApplicationOrm } from '@wisp/db/database';
import { panels } from '@wisp/db/schema';
import { syncRows } from '@wisp/db/sync-rows';

export function readPanels(db: ApplicationOrm): Panel[] {
  return db
    .select()
    .from(panels)
    .orderBy(panels.sortIndex)
    .all()
    .map(({ sortIndex: _sortIndex, content, ...row }) => ({ ...JSON.parse(content), ...row }));
}

export function savePanels(db: ApplicationOrm, value: Panel[]) {
  const next = value.map(({ characterKey, id, title, updatedAt, ...content }, sortIndex) => ({
    characterKey,
    id,
    title,
    updatedAt,
    sortIndex,
    content: JSON.stringify(content),
  }));
  syncRows(
    db.select().from(panels).all(),
    next,
    (r) => JSON.stringify([r.characterKey, r.id]),
    (r) =>
      db
        .insert(panels)
        .values(r)
        .onConflictDoUpdate({ target: [panels.characterKey, panels.id], set: r })
        .run(),
    (r) =>
      db
        .delete(panels)
        .where(and(eq(panels.characterKey, r.characterKey), eq(panels.id, r.id)))
        .run(),
  );
}
