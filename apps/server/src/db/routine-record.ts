import type { Routine, RoutineRun } from '@wisp/protocol/routines';
import type { routines, routineRuns } from './schema.ts';
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
