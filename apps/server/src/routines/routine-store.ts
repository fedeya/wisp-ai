import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte, ne, or, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';
import {
  matchesRoutineEvent,
  type Routine,
  type RoutineRun,
  type RoutineEvent,
  type routineInput,
} from '@wisp/protocol/routines';
import type { z } from 'zod';
import { CorruptRecord, DatabaseFailure, sqlFailures, type SqlFailure } from '@wisp/db/repository';
import { SqlDatabase, type SqlExecutor } from '@wisp/db/sql-database';
import { routines, routineRuns } from '@wisp/db/schema';
import {
  decodeRoutine,
  decodeRun,
  encodeRoutine,
  encodeRun,
  type RoutineRow,
} from './routine-record.ts';

/** A change the store refuses, with the reason shown to the player. */
export class RoutineRejected extends Schema.TaggedError<RoutineRejected>()('RoutineRejected', {
  message: Schema.String,
}) {}

/** A routine operation failed; `reason` says whether the player or the database caused it. */
export class RoutineStoreError extends Schema.TaggedError<RoutineStoreError>()(
  'RoutineStoreError',
  { reason: Schema.Union([RoutineRejected, DatabaseFailure, CorruptRecord]) },
) {
  override get message() {
    return this.reason.message;
  }
}

export interface HistoryOptions {
  characterKey?: string;
  routineId?: string;
  includeSilent?: boolean;
  limit?: number;
}

export interface ClaimedRoutine {
  routine: Routine;
  run: RoutineRun;
  event: NonNullable<Routine['pending']>;
  /** Summaries of the routine's last useful runs, oldest first. */
  previous: string[];
}

type RoutineInput = z.infer<typeof routineInput>;
type Operation<Args extends unknown[], A> = (...args: Args) => Effect.Effect<A, RoutineStoreError>;

/** Each character's routines and their run history. */
export class RoutineStore extends Context.Service<
  RoutineStore,
  {
    /** Marks runs the previous bridge left running as interrupted. */
    readonly recover: Operation<[], void>;
    readonly list: Operation<[characterKey?: string], Routine[]>;
    readonly history: Operation<[options?: HistoryOptions], RoutineRun[]>;
    readonly getRun: Operation<[id: string, characterKey?: string], RoutineRun | undefined>;
    readonly mutate: Operation<
      [characterKey: string, input: RoutineInput, sourceChatId?: string, now?: number],
      Routine[]
    >;
    /** Records a game event on every enabled routine it triggers. */
    readonly observe: Operation<[characterKey: string, event: RoutineEvent, now?: number], void>;
    /** Starts the routine that is due first, if any, as a running run. */
    readonly claim: Operation<[characterKey: string, now?: number], ClaimedRoutine | null>;
    readonly finish: Operation<
      [id: string, status: RoutineRun['status'], summary: string, now?: number],
      void
    >;
    /** Drops a claimed run that was not started; the routine keeps its next time. */
    readonly skip: Operation<[id: string], void>;
    /** Drops a claimed run and puts its event back, so the routine runs again soon. */
    readonly defer: Operation<[id: string, event: NonNullable<Routine['pending']>], void>;
  }
>()('@wisp/server/RoutineStore') {}

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
    .pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeRoutine)));

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
    .pipe(Effect.flatMap((row) => (row ? decodeRun(row) : Effect.succeed(undefined))));

const updateRoutine = (db: SqlExecutor, row: RoutineRow, value: Routine) =>
  db
    .update(routines)
    .set(encodeRoutine(value, row.sortIndex))
    .where(and(eq(routines.characterKey, row.characterKey), eq(routines.id, row.id)))
    .run();

const nextPosition = (db: SqlExecutor, table: typeof routines | typeof routineRuns) =>
  db
    .select({ next: sql<number>`coalesce(max(${table.sortIndex}), -1) + 1` })
    .from(table)
    .get()
    .pipe(Effect.map((row) => Number(row?.next ?? 0)));

/** Keeps SQLite's errors inside the store and reports every failure as a RoutineStoreError. */
const routineErrors = <A, R>(self: Effect.Effect<A, RoutineStoreError['reason'] | SqlFailure, R>) =>
  sqlFailures(self).pipe(Effect.mapError((reason) => new RoutineStoreError({ reason })));

const reject = (message: string) => Effect.fail(new RoutineRejected({ message }));

export const layer = Layer.effect(
  RoutineStore,
  Effect.gen(function* () {
    const { db } = yield* SqlDatabase;

    const save = Effect.fnUntraced(function* (
      tx: SqlExecutor,
      characterKey: string,
      routine: Extract<RoutineInput, { operation: 'save' }>['routine'],
      sourceChatId: string | undefined,
      now: number,
    ) {
      const row = yield* findRoutine(tx, characterKey, routine.id);
      const old = row ? yield* decodeRoutine(row) : undefined;
      if (!old && (yield* listRoutines(tx, characterKey)).length >= 20) {
        return yield* reject('Keep at most 20 routines per character');
      }
      const next: Routine = {
        ...routine,
        characterKey,
        sourceChatId: old?.sourceChatId || sourceChatId,
        enabled: old?.enabled ?? true,
        updatedAt: now,
        nextAt: now + interval(routine.triggers),
        lastStartedAt: old?.lastStartedAt,
      };
      const value = encodeRoutine(next, yield* nextPosition(tx, routines));
      yield* tx
        .insert(routines)
        .values(value)
        .onConflictDoUpdate({ target: [routines.characterKey, routines.id], set: value })
        .run();
    });

    const change = Effect.fnUntraced(function* (
      tx: SqlExecutor,
      characterKey: string,
      operation: 'pause' | 'resume' | 'remove',
      id: string,
      now: number,
    ) {
      const row = yield* findRoutine(tx, characterKey, id);
      if (!row) {
        return yield* reject('Routine not found');
      }
      if (operation === 'remove') {
        yield* tx
          .delete(routines)
          .where(and(eq(routines.characterKey, characterKey), eq(routines.id, id)))
          .run();
        return;
      }
      const routine = yield* decodeRoutine(row);
      yield* updateRoutine(tx, row, {
        ...routine,
        enabled: operation === 'resume',
        pending: undefined,
        nextAt: now + interval(routine.triggers),
        updatedAt: now,
      });
    });

    return RoutineStore.of({
      recover: Effect.fn('RoutineStore.recover')(function* () {
        yield* db
          .update(routineRuns)
          .set({ status: 'interrupted', finishedAt: Date.now() })
          .where(eq(routineRuns.status, 'running'))
          .run();
      }, routineErrors),

      list: Effect.fn('RoutineStore.list')(function* (characterKey?: string) {
        return yield* listRoutines(db, characterKey);
      }, routineErrors),

      history: Effect.fn('RoutineStore.history')(function* ({
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
        return yield* Effect.forEach(rows.reverse(), decodeRun);
      }, routineErrors),

      getRun: Effect.fn('RoutineStore.getRun')(function* (id: string, characterKey?: string) {
        return yield* findRun(db, id, characterKey);
      }, routineErrors),

      mutate: Effect.fn('RoutineStore.mutate')(function* (
        characterKey: string,
        input: RoutineInput,
        sourceChatId?: string,
        now = Date.now(),
      ) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            switch (input.operation) {
              case 'save':
                yield* save(tx, characterKey, input.routine, sourceChatId, now);
                break;
              case 'pause':
              case 'resume':
              case 'remove':
                yield* change(tx, characterKey, input.operation, input.id, now);
                break;
              case 'catalog':
              case 'list':
              case 'get':
                break;
              default: {
                const _exhaustive: never = input;
                return _exhaustive;
              }
            }
            return yield* listRoutines(tx, characterKey);
          }),
        );
      }, routineErrors),

      observe: Effect.fn('RoutineStore.observe')(function* (
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
              const routine = yield* decodeRoutine(row);
              if (routine.triggers.some((trigger) => matchesRoutineEvent(trigger, event))) {
                yield* updateRoutine(tx, row, {
                  ...routine,
                  pending: { event: event.event, values: event.values, at: now },
                });
              }
            }
          }),
        );
      }, routineErrors),

      claim: Effect.fn('RoutineStore.claim')(function* (characterKey: string, now = Date.now()) {
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
            const routine = yield* decodeRoutine(row);
            const event: ClaimedRoutine['event'] = routine.pending ?? {
              event: 'interval',
              values: {},
              at: now,
            };
            const next: Routine = {
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
            yield* tx
              .insert(routineRuns)
              .values(encodeRun(run, yield* nextPosition(tx, routineRuns)))
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
            const claimed: ClaimedRoutine = {
              routine: next,
              run,
              event,
              previous: previous.reverse().flatMap(({ summary }) => (summary ? [summary] : [])),
            };
            return claimed;
          }),
        );
      }, routineErrors),

      finish: Effect.fn('RoutineStore.finish')(function* (
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
            const routine = row ? yield* decodeRoutine(row) : undefined;
            // A one-off routine is done once a run of its current version was useful.
            if (status === 'done' && row && routine?.once && routine.updatedAt <= run.startedAt) {
              yield* updateRoutine(tx, row, { ...routine, enabled: false, pending: undefined });
            }
          }),
        );
      }, routineErrors),

      skip: Effect.fn('RoutineStore.skip')(function* (id: string) {
        yield* db.delete(routineRuns).where(eq(routineRuns.id, id)).run();
      }, routineErrors),

      defer: Effect.fn('RoutineStore.defer')(function* (
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
            const routine = row ? yield* decodeRoutine(row) : undefined;
            // An edit since the claim already reset the routine; keep that version.
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
      }, routineErrors),
    });
  }),
);
