import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte, ne, or, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import {
  matchesRoutineEvent,
  type Routine,
  type RoutineRun,
  type RoutineEvent,
  type routineInput,
} from '@wisp/protocol/routines';
import type { z } from 'zod';
import type { SqlDatabase, SqlExecutor } from '@wisp/db/sql-database';
import { routines, routineRuns } from '@wisp/db/schema';
import {
  decodeRoutine,
  decodeRun,
  encodeRoutine,
  encodeRun,
  type RoutineRow,
} from './routine-record.ts';

/** A routine change the store refuses, with the reason shown to the player. */
export class RoutineRejected extends Schema.TaggedError<RoutineRejected>()('RoutineRejected', {
  message: Schema.String,
}) {}

export interface HistoryOptions {
  characterKey?: string;
  routineId?: string;
  includeSilent?: boolean;
  limit?: number;
}

const interval = (triggers: Routine['triggers']) =>
  Math.min(
    ...triggers.filter((t) => t.kind === 'interval').map((t) => t.seconds * 1000),
    Number.MAX_SAFE_INTEGER / 2,
  );

const listRoutines = (db: SqlExecutor, characterKey?: string) =>
  db
    .select()
    .from(routines)
    .where(characterKey === undefined ? undefined : eq(routines.characterKey, characterKey))
    .orderBy(routines.sortIndex)
    .all()
    .pipe(Effect.map((rows) => rows.map(decodeRoutine)));

const findRoutine = (db: SqlExecutor, characterKey: string, id: string) =>
  db
    .select()
    .from(routines)
    .where(and(eq(routines.characterKey, characterKey), eq(routines.id, id)))
    .get();

const findRun = (db: SqlExecutor, id: string, characterKey?: string) =>
  db
    .select()
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.id, id),
        characterKey === undefined ? undefined : eq(routineRuns.characterKey, characterKey),
      ),
    )
    .get()
    .pipe(Effect.map((row) => row && decodeRun(row)));

const updateRoutine = (db: SqlExecutor, row: RoutineRow, value: Routine) =>
  db
    .update(routines)
    .set(encodeRoutine(value, row.sortIndex))
    .where(and(eq(routines.characterKey, row.characterKey), eq(routines.id, row.id)))
    .run();

/** Each character's routines and their run history. */
export function makeRoutineStore({ db }: SqlDatabase['Service']) {
  /** Marks runs the previous bridge left running as interrupted. */
  const recover = Effect.fn('RoutineStore.recover')(function* () {
    yield* db
      .update(routineRuns)
      .set({ status: 'interrupted', finishedAt: Date.now() })
      .where(eq(routineRuns.status, 'running'))
      .run();
  });

  const list = Effect.fn('RoutineStore.list')(function* (characterKey?: string) {
    return yield* listRoutines(db, characterKey);
  });

  const history = Effect.fn('RoutineStore.history')(function* ({
    characterKey,
    routineId,
    includeSilent = true,
    limit = 200,
  }: HistoryOptions = {}) {
    const rows = yield* db
      .select()
      .from(routineRuns)
      .where(
        and(
          characterKey === undefined ? undefined : eq(routineRuns.characterKey, characterKey),
          routineId === undefined ? undefined : eq(routineRuns.routineId, routineId),
          includeSilent ? undefined : ne(routineRuns.status, 'no_tip'),
        ),
      )
      .orderBy(desc(routineRuns.sortIndex))
      .limit(Math.max(1, Math.min(200, Math.floor(limit))))
      .all();
    return rows.reverse().map(decodeRun);
  });

  const getRun = Effect.fn('RoutineStore.getRun')(function* (id: string, characterKey?: string) {
    return yield* findRun(db, id, characterKey);
  });

  const mutate = Effect.fn('RoutineStore.mutate')(function* (
    characterKey: string,
    input: z.infer<typeof routineInput>,
    sourceChatId?: string,
    now = Date.now(),
  ) {
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        if (input.operation === 'save') {
          const row = yield* findRoutine(tx, characterKey, input.routine.id);
          const old = row && decodeRoutine(row);
          if (!old && (yield* listRoutines(tx, characterKey)).length >= 20) {
            return yield* new RoutineRejected({
              message: 'Keep at most 20 routines per character',
            });
          }
          const next: Routine = {
            ...input.routine,
            characterKey,
            sourceChatId: old?.sourceChatId || sourceChatId,
            enabled: old?.enabled ?? true,
            updatedAt: now,
            nextAt: now + interval(input.routine.triggers),
            lastStartedAt: old?.lastStartedAt,
          };
          const position = yield* tx
            .select({ next: sql<number>`coalesce(max(${routines.sortIndex}), -1) + 1` })
            .from(routines)
            .get();
          const value = encodeRoutine(next, Number(position?.next ?? 0));
          yield* tx
            .insert(routines)
            .values(value)
            .onConflictDoUpdate({ target: [routines.characterKey, routines.id], set: value })
            .run();
        } else if (['pause', 'resume', 'remove'].includes(input.operation) && 'id' in input) {
          const row = yield* findRoutine(tx, characterKey, input.id);
          if (!row) {
            return yield* new RoutineRejected({ message: 'Routine not found' });
          }
          if (input.operation === 'remove') {
            yield* tx
              .delete(routines)
              .where(and(eq(routines.characterKey, characterKey), eq(routines.id, input.id)))
              .run();
          } else {
            const routine = decodeRoutine(row);
            yield* updateRoutine(tx, row, {
              ...routine,
              enabled: input.operation === 'resume',
              pending: undefined,
              nextAt: now + interval(routine.triggers),
              updatedAt: now,
            });
          }
        }
        return yield* listRoutines(tx, characterKey);
      }),
    );
  });

  const observe = Effect.fn('RoutineStore.observe')(function* (
    characterKey: string,
    event: RoutineEvent,
    now = Date.now(),
  ) {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .select()
          .from(routines)
          .where(and(eq(routines.characterKey, characterKey), eq(routines.enabled, true)))
          .all();
        for (const row of rows) {
          const routine = decodeRoutine(row);
          if (routine.triggers.some((t) => matchesRoutineEvent(t, event))) {
            yield* updateRoutine(tx, row, {
              ...routine,
              pending: { event: event.event, values: event.values, at: now },
            });
          }
        }
      }),
    );
  });

  const claim = Effect.fn('RoutineStore.claim')(function* (characterKey: string, now = Date.now()) {
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.characterKey, characterKey),
              eq(routines.enabled, true),
              or(
                lte(routines.nextAt, now),
                sql`json_type(${routines.content}, '$.pending') = 'object'`,
              ),
              sql`${now} - coalesce(json_extract(${routines.content}, '$.lastStartedAt'), 0) >= json_extract(${routines.content}, '$.cooldownSeconds') * 1000`,
            ),
          )
          .orderBy(
            asc(sql`json_extract(${routines.content}, '$.lastStartedAt')`),
            routines.sortIndex,
          )
          .limit(1)
          .get();
        if (!row) {
          return null;
        }
        const routine = decodeRoutine(row);
        const event: NonNullable<Routine['pending']> = routine.pending || {
          event: 'interval',
          values: {},
          at: now,
        };
        const next = {
          ...routine,
          pending: undefined,
          lastStartedAt: now,
          nextAt: now + interval(routine.triggers),
        };
        yield* updateRoutine(tx, row, next);
        const run: RoutineRun = {
          id: 'routine-' + randomUUID(),
          routineId: routine.id,
          characterKey,
          title: routine.title,
          startedAt: now,
          event: event.event,
          status: 'running',
        };
        const position = yield* tx
          .select({ next: sql<number>`coalesce(max(${routineRuns.sortIndex}), -1) + 1` })
          .from(routineRuns)
          .get();
        yield* tx
          .insert(routineRuns)
          .values(encodeRun(run, Number(position?.next ?? 0)))
          .run();
        const previous = yield* tx
          .select({ summary: routineRuns.summary })
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.characterKey, characterKey),
              eq(routineRuns.routineId, routine.id),
              eq(routineRuns.status, 'done'),
            ),
          )
          .orderBy(desc(routineRuns.sortIndex))
          .limit(3)
          .all();
        return {
          routine: next,
          run,
          event,
          previous: previous
            .reverse()
            .map((p) => p.summary)
            .filter(Boolean),
        };
      }),
    );
  });

  const finish = Effect.fn('RoutineStore.finish')(function* (
    id: string,
    status: RoutineRun['status'],
    summary: string,
    now = Date.now(),
  ) {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const run = yield* findRun(tx, id);
        if (!run) {
          return;
        }
        yield* tx
          .update(routineRuns)
          .set({ status, summary: summary.slice(0, 1500), finishedAt: now })
          .where(eq(routineRuns.id, id))
          .run();
        const row = yield* findRoutine(tx, run.characterKey, run.routineId);
        const routine = row && decodeRoutine(row);
        if (status === 'done' && row && routine?.once && routine.updatedAt <= run.startedAt) {
          yield* updateRoutine(tx, row, { ...routine, enabled: false, pending: undefined });
        }
      }),
    );
  });

  /** Drops a claimed run that was not started; the routine keeps its next time. */
  const skip = Effect.fn('RoutineStore.skip')(function* (id: string) {
    yield* db.delete(routineRuns).where(eq(routineRuns.id, id)).run();
  });

  const defer = Effect.fn('RoutineStore.defer')(function* (
    id: string,
    event: NonNullable<Routine['pending']>,
  ) {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const run = yield* findRun(tx, id);
        if (!run) {
          return;
        }
        const row = yield* findRoutine(tx, run.characterKey, run.routineId);
        const routine = row && decodeRoutine(row);
        if (row && routine && routine.updatedAt <= run.startedAt) {
          yield* updateRoutine(tx, row, {
            ...routine,
            pending: routine.pending ?? event,
            lastStartedAt: undefined,
          });
        }
        yield* tx.delete(routineRuns).where(eq(routineRuns.id, id)).run();
      }),
    );
  });

  return { recover, list, history, getRun, mutate, observe, claim, finish, skip, defer };
}

export type RoutineStore = ReturnType<typeof makeRoutineStore>;
