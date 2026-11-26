import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { z } from 'zod';
import { panelContent, type Panel } from '@wisp/agent/contract/panels';
import { decodeRecord } from '@wisp/db/repository';
import type { SqlExecutor } from '@wisp/db/sql-database';
import { panels } from '@wisp/db/schema';
import { syncRows } from '@wisp/db/sync-rows';

/** A panel as it is saved: its content plus who owns it and when it changed. */
export const savedPanel = panelContent.safeExtend({
  characterKey: z.string().min(1),
  updatedAt: z.number(),
  formerKey: z.string().optional(),
});

export const readPanels = (db: SqlExecutor) =>
  db
    .select()
    .from(panels)
    .orderBy(panels.sortIndex)
    .all()
    .pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, ({ sortIndex: _sortIndex, content, ...row }) =>
          decodeRecord<Panel>('panel', savedPanel, () => ({ ...JSON.parse(content), ...row })),
        ),
      ),
    );

export const savePanels = Effect.fnUntraced(function* (db: SqlExecutor, value: Panel[]) {
  const next = value.map(({ characterKey, id, title, updatedAt, ...content }, sortIndex) => ({
    characterKey,
    id,
    title,
    updatedAt,
    sortIndex,
    content: JSON.stringify(content),
  }));
  yield* syncRows(
    yield* db.select().from(panels).all(),
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
});
