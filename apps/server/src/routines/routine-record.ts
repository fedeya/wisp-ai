import { routineRun, savedRoutine, type Routine, type RoutineRun } from '@wisp/protocol/routines';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { decodeRecord } from '@wisp/db/repository';
import type { SqlExecutor } from '@wisp/db/sql-database';
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
export const decodeRoutine = ({ sortIndex: _sortIndex, content, ...row }: RoutineRow) =>
  decodeRecord<Routine>('routine', savedRoutine, () => ({ ...JSON.parse(content), ...row }));
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
export const decodeRun = ({ sortIndex: _sortIndex, extras, finishedAt, summary, ...row }: RunRow) =>
  decodeRecord<RoutineRun>('routine run', routineRun, () => ({
    ...JSON.parse(extras),
    ...row,
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(summary === null ? {} : { summary }),
  }));

export const importRoutines = Effect.fnUntraced(function* (
  db: SqlExecutor,
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
  yield* syncRows(
    yield* db.select().from(routines).all(),
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
  yield* syncRows(
    yield* db.select().from(routineRuns).all(),
    nextRuns,
    (r) => r.id,
    (r) =>
      db.insert(routineRuns).values(r).onConflictDoUpdate({ target: routineRuns.id, set: r }).run(),
    (r) => db.delete(routineRuns).where(eq(routineRuns.id, r.id)).run(),
  );
});
