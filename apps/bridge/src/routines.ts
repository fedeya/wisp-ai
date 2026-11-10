import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lte, ne, or, sql } from 'drizzle-orm';
import {
  matchesRoutineEvent,
  type Routine,
  type RoutineRun,
  type RoutineEvent,
  type routineInput,
} from '@wisp/protocol/routines';
import type { z } from 'zod';
import { ApplicationDatabase, type ApplicationOrm } from './db/application-database.ts';
import { routines, routineRuns } from './db/schema.ts';
import {
  decodeRoutine,
  decodeRun,
  encodeRoutine,
  encodeRun,
  type RoutineRow,
} from './db/routine-record.ts';

interface HistoryOptions {
  characterKey?: string;
  routineId?: string;
  includeSilent?: boolean;
  limit?: number;
}
export class RoutineStore {
  readonly database: ApplicationDatabase;
  constructor(database: ApplicationDatabase) {
    this.database = database;
  }
  async load() {
    await this.database.initializeProducts();
    await this.database.transaction((db) =>
      db
        .update(routineRuns)
        .set({ status: 'interrupted', finishedAt: Date.now() })
        .where(eq(routineRuns.status, 'running'))
        .run(),
    );
  }
  list(characterKey?: string): Routine[] {
    return this.database.orm
      .select()
      .from(routines)
      .where(characterKey === undefined ? undefined : eq(routines.characterKey, characterKey))
      .orderBy(routines.sortIndex)
      .all()
      .map(decodeRoutine);
  }
  history({
    characterKey,
    routineId,
    includeSilent = true,
    limit = 200,
  }: HistoryOptions = {}): RoutineRun[] {
    return this.database.orm
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
      .all()
      .reverse()
      .map(decodeRun);
  }
  getRun(id: string, characterKey?: string): RoutineRun | undefined {
    const row = this.database.orm
      .select()
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.id, id),
          characterKey === undefined ? undefined : eq(routineRuns.characterKey, characterKey),
        ),
      )
      .get();
    return row && decodeRun(row);
  }
  private row(db: ApplicationOrm, characterKey: string, id: string) {
    return db
      .select()
      .from(routines)
      .where(and(eq(routines.characterKey, characterKey), eq(routines.id, id)))
      .get();
  }
  private update(db: ApplicationOrm, row: RoutineRow, value: Routine) {
    db.update(routines)
      .set(encodeRoutine(value, row.sortIndex))
      .where(and(eq(routines.characterKey, row.characterKey), eq(routines.id, row.id)))
      .run();
  }
  private async transact<T>(work: (db: ApplicationOrm) => T) {
    await this.database.initializeProducts();
    return this.database.transaction(work);
  }
  mutate(
    characterKey: string,
    input: z.infer<typeof routineInput>,
    sourceChatId?: string,
    now = Date.now(),
  ) {
    return this.transact((db) => {
      if (input.operation === 'save') {
        const row = this.row(db, characterKey, input.routine.id);
        const old = row && decodeRoutine(row);
        if (!old && this.list(characterKey).length >= 20) {
          throw Error('Keep at most 20 routines per character');
        }
        const next: Routine = {
          ...input.routine,
          characterKey,
          sourceChatId: old?.sourceChatId || sourceChatId,
          enabled: old?.enabled ?? true,
          updatedAt: now,
          nextAt: now + this.interval(input.routine.triggers),
          lastStartedAt: old?.lastStartedAt,
        };
        const position = Number(
          db
            .select({ next: sql<number>`coalesce(max(${routines.sortIndex}), -1) + 1` })
            .from(routines)
            .get()!.next,
        );
        const value = encodeRoutine(next, position);
        db.insert(routines)
          .values(value)
          .onConflictDoUpdate({ target: [routines.characterKey, routines.id], set: value })
          .run();
      } else if (['pause', 'resume', 'remove'].includes(input.operation) && 'id' in input) {
        const row = this.row(db, characterKey, input.id);
        if (!row) {
          throw Error('Routine not found');
        }
        if (input.operation === 'remove') {
          db.delete(routines)
            .where(and(eq(routines.characterKey, characterKey), eq(routines.id, input.id)))
            .run();
        } else {
          this.update(db, row, {
            ...decodeRoutine(row),
            enabled: input.operation === 'resume',
            pending: undefined,
            nextAt: now + this.interval(decodeRoutine(row).triggers),
            updatedAt: now,
          });
        }
      }
      return this.list(characterKey);
    });
  }
  private interval(triggers: Routine['triggers']) {
    return Math.min(
      ...triggers.filter((t) => t.kind === 'interval').map((t) => t.seconds * 1000),
      Number.MAX_SAFE_INTEGER / 2,
    );
  }
  observe(characterKey: string, event: RoutineEvent, now = Date.now()) {
    return this.transact((db) => {
      const rows = db
        .select()
        .from(routines)
        .where(and(eq(routines.characterKey, characterKey), eq(routines.enabled, true)))
        .all();
      for (const row of rows) {
        const r = decodeRoutine(row);
        if (r.triggers.some((t) => matchesRoutineEvent(t, event))) {
          this.update(db, row, {
            ...r,
            pending: { event: event.event, values: event.values, at: now },
          });
        }
      }
    });
  }
  claim(characterKey: string, now = Date.now()) {
    return this.transact((db) => {
      const row = db
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
        .orderBy(asc(sql`json_extract(${routines.content}, '$.lastStartedAt')`), routines.sortIndex)
        .limit(1)
        .get();
      if (!row) {
        return null;
      }
      const r = decodeRoutine(row);
      const event = r.pending || { event: 'interval', values: {}, at: now };
      const next = {
        ...r,
        pending: undefined,
        lastStartedAt: now,
        nextAt: now + this.interval(r.triggers),
      };
      this.update(db, row, next);
      const run: RoutineRun = {
        id: 'routine-' + randomUUID(),
        routineId: r.id,
        characterKey,
        title: r.title,
        startedAt: now,
        event: event.event,
        status: 'running',
      };
      const position = Number(
        db
          .select({ next: sql<number>`coalesce(max(${routineRuns.sortIndex}), -1) + 1` })
          .from(routineRuns)
          .get()!.next,
      );
      db.insert(routineRuns).values(encodeRun(run, position)).run();
      const previous = db
        .select({ summary: routineRuns.summary })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.characterKey, characterKey),
            eq(routineRuns.routineId, r.id),
            eq(routineRuns.status, 'done'),
          ),
        )
        .orderBy(desc(routineRuns.sortIndex))
        .limit(3)
        .all()
        .reverse()
        .map((p) => p.summary)
        .filter(Boolean);
      return { routine: next, run, event, previous };
    });
  }
  finish(id: string, status: RoutineRun['status'], summary: string, now = Date.now()) {
    return this.transact((db) => {
      const run = this.getRun(id);
      if (!run) {
        return;
      }
      db.update(routineRuns)
        .set({ status, summary: summary.slice(0, 1500), finishedAt: now })
        .where(eq(routineRuns.id, id))
        .run();
      const row = this.row(db, run.characterKey, run.routineId);
      const routine = row && decodeRoutine(row);
      if (status === 'done' && row && routine?.once && routine.updatedAt <= run.startedAt) {
        this.update(db, row, { ...routine, enabled: false, pending: undefined });
      }
    });
  }
  defer(id: string, event: NonNullable<Routine['pending']>) {
    return this.transact((db) => {
      const run = this.getRun(id);
      if (!run) {
        return;
      }
      const row = this.row(db, run.characterKey, run.routineId);
      const routine = row && decodeRoutine(row);
      if (row && routine && routine.updatedAt <= run.startedAt) {
        this.update(db, row, {
          ...routine,
          pending: routine.pending ?? event,
          lastStartedAt: undefined,
        });
      }
      db.delete(routineRuns).where(eq(routineRuns.id, id)).run();
    });
  }
}
