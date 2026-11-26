import type { Routine, RoutineRun } from '@wisp/protocol/routines';
import { and, eq } from 'drizzle-orm';
import type { ApplicationOrm } from '@wisp/db/database';
import { routines, routineRuns } from '@wisp/db/schema';
import { syncRows } from '@wisp/db/sync-rows';
export type RoutineRow = typeof routines.$inferSelect;
export type RunRow = typeof routineRuns.$inferSelect;
export function encodeRoutine(
  { id, characterKey, title, enabled, nextAt, updatedAt, ...content }: Routine,
  sortIndex: number,
): RoutineRow {
  return {
    id,
    characterKey,
    title,
    enabled,
    nextAt,
    updatedAt,
    sortIndex,
    content: JSON.stringify(content),
  };
}
export function decodeRoutine({ sortIndex: _sortIndex, content, ...row }: RoutineRow): Routine {
  return { ...JSON.parse(content), ...row };
}
export function encodeRun(
  {
    id,
    characterKey,
    routineId,
    title,
    startedAt,
    finishedAt,
    event,
    status,
    summary,
    ...extras
  }: RoutineRun,
  sortIndex: number,
): RunRow {
  return {
    id,
    characterKey,
    routineId,
    title,
    startedAt,
    finishedAt: finishedAt ?? null,
    event,
    status,
    summary: summary ?? null,
    sortIndex,
    extras: JSON.stringify(extras),
  };
}
export function decodeRun({
  sortIndex: _sortIndex,
  extras,
  finishedAt,
  summary,
  ...row
}: RunRow): RoutineRun {
  return {
    ...JSON.parse(extras),
    ...row,
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(summary === null ? {} : { summary }),
  };
}

export function importRoutines(
  db: ApplicationOrm,
  value: { routines: Routine[]; runs: RoutineRun[] },
) {
  const nextRoutines = value.routines.map(
    ({ id, characterKey, title, enabled, nextAt, updatedAt, ...content }, sortIndex) => ({
      id,
      characterKey,
      title,
      enabled,
      nextAt,
      updatedAt,
      sortIndex,
      content: JSON.stringify(content),
    }),
  );
  syncRows(
    db.select().from(routines).all(),
    nextRoutines,
    (r) => JSON.stringify([r.characterKey, r.id]),
    (r) =>
      db
        .insert(routines)
        .values(r)
        .onConflictDoUpdate({ target: [routines.characterKey, routines.id], set: r })
        .run(),
    (r) =>
      db
        .delete(routines)
        .where(and(eq(routines.characterKey, r.characterKey), eq(routines.id, r.id)))
        .run(),
  );
  const nextRuns = value.runs.map(
    (
      {
        id,
        characterKey,
        routineId,
        title,
        startedAt,
        finishedAt,
        event,
        status,
        summary,
        ...extras
      },
      sortIndex,
    ) => ({
      id,
      characterKey,
      routineId,
      title,
      startedAt,
      finishedAt: finishedAt ?? null,
      event,
      status,
      summary: summary ?? null,
      sortIndex,
      extras: JSON.stringify(extras),
    }),
  );
  syncRows(
    db.select().from(routineRuns).all(),
    nextRuns,
    (r) => r.id,
    (r) =>
      db.insert(routineRuns).values(r).onConflictDoUpdate({ target: routineRuns.id, set: r }).run(),
    (r) => db.delete(routineRuns).where(eq(routineRuns.id, r.id)).run(),
  );
}
