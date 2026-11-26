import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import type { Panel } from '@wisp/agent/contract/panels';
import type { SqlExecutor } from '@wisp/db/sql-database';
import { panels } from '@wisp/db/schema';
import { syncRows } from '@wisp/db/sync-rows';

export const readPanels = (db: SqlExecutor) =>
  db
    .select()
    .from(panels)
    .orderBy(panels.sortIndex)
    .all()
    .pipe(
      Effect.map((rows) =>
        rows.map(({ sortIndex: _sortIndex, content, ...row }): Panel => ({
          ...JSON.parse(content),
          ...row,
        })),
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
