import { ProductDatabase, readRoutines, saveRoutines } from './db/product-store.ts';
import { randomUUID } from 'node:crypto';
import {
  matchesRoutineEvent,
  type Routine,
  type RoutineRun,
  type RoutineEvent,
  type routineInput,
} from '@wisp/protocol/routines';
import { z } from 'zod';

export class RoutineStore {
  routines: Routine[] = [];
  runs: RoutineRun[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  readonly database: ProductDatabase;
  constructor(file: string | ProductDatabase) {
    this.database = typeof file === 'string' ? new ProductDatabase(file) : file;
  }
  async load() {
    await this.transact(() => {
      this.runs = this.runs.map((run) =>
        run.status === 'running' ? { ...run, status: 'interrupted', finishedAt: Date.now() } : run,
      );
    });
  }
  list(characterKey: string) {
    return this.routines.filter((r) => r.characterKey === characterKey);
  }
  private transact<T>(change: () => T): Promise<T> {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        let before: string | undefined;
        try {
          return await this.database.transaction((db) => {
            const stored = readRoutines(db);
            this.routines = stored.routines;
            this.runs = stored.runs;
            before = JSON.stringify(stored);
            const result = change();
            const content = JSON.stringify({ routines: this.routines, runs: this.runs });
            if (content === before) {
              return result;
            }
            saveRoutines(db, { routines: this.routines, runs: this.runs });
            return result;
          });
        } catch (e) {
          if (before !== undefined) {
            const old = JSON.parse(before);
            this.routines = old.routines;
            this.runs = old.runs;
          }
          throw e;
        }
      });
    this.queue = work;
    return work;
  }
  mutate(
    characterKey: string,
    input: z.infer<typeof routineInput>,
    sourceChatId?: string,
    now = Date.now(),
  ) {
    return this.transact(() => {
      if (input.operation === 'save') {
        const old = this.list(characterKey).find((r) => r.id === input.routine.id);
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
        this.routines = this.routines.filter(
          (r) => r.characterKey !== characterKey || r.id !== next.id,
        );
        this.routines.push(next);
      } else if (['pause', 'resume', 'remove'].includes(input.operation) && 'id' in input) {
        const routine = this.list(characterKey).find((r) => r.id === input.id);
        if (!routine) {
          throw Error('Routine not found');
        }
        if (input.operation === 'remove') {
          this.routines = this.routines.filter((r) => r !== routine);
        } else {
          routine.enabled = input.operation === 'resume';
          routine.pending = undefined;
          routine.nextAt = now + this.interval(routine.triggers);
          routine.updatedAt = now;
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
    return this.transact(() => {
      for (const r of this.list(characterKey)) {
        if (r.enabled && r.triggers.some((t) => matchesRoutineEvent(t, event))) {
          // A burst replaces the pending reading, never creates a backlog of model calls.
          r.pending = { event: event.event, values: event.values, at: now };
        }
      }
    });
  }
  claim(characterKey: string, now = Date.now()) {
    return this.transact(() => {
      const eligible = this.list(characterKey).filter(
        (r) =>
          r.enabled &&
          (r.pending || r.nextAt <= now) &&
          now - (r.lastStartedAt ?? 0) >= r.cooldownSeconds * 1000,
      );
      // Strict comparison preserves saved order for ties, including never-started routines.
      const r = eligible.reduce<Routine | undefined>(
        (oldest, candidate) =>
          !oldest || (candidate.lastStartedAt ?? -Infinity) < (oldest.lastStartedAt ?? -Infinity)
            ? candidate
            : oldest,
        undefined,
      );
      if (!r) {
        return null;
      }
      const event = r.pending || { event: 'interval', values: {}, at: now };
      r.pending = undefined;
      r.lastStartedAt = now;
      r.nextAt = now + this.interval(r.triggers);
      const run: RoutineRun = {
        id: 'routine-' + randomUUID(),
        routineId: r.id,
        characterKey,
        title: r.title,
        startedAt: now,
        event: event.event,
        status: 'running',
      };
      this.runs.push(run);
      const previous = this.runs
        .filter(
          (p) => p.characterKey === characterKey && p.routineId === r.id && p.status === 'done',
        )
        .slice(-3)
        .map((p) => p.summary)
        .filter(Boolean);
      return { routine: { ...r }, run, event, previous };
    });
  }
  finish(id: string, status: RoutineRun['status'], summary: string, now = Date.now()) {
    return this.transact(() => {
      const run = this.runs.find((r) => r.id === id);
      if (run) {
        run.status = status;
        run.summary = summary.slice(0, 1500);
        run.finishedAt = now;
        const routine = this.list(run.characterKey).find((r) => r.id === run.routineId);
        if (status === 'done' && routine?.once && routine.updatedAt <= run.startedAt) {
          routine.enabled = false;
          routine.pending = undefined;
        }
      }
    });
  }
  defer(id: string, event: NonNullable<Routine['pending']>) {
    return this.transact(() => {
      const run = this.runs.find((r) => r.id === id);
      if (!run) {
        return;
      }
      const routine = this.list(run.characterKey).find((r) => r.id === run.routineId);
      if (routine && routine.updatedAt <= run.startedAt) {
        routine.pending ??= event;
        routine.lastStartedAt = undefined;
      }
      this.runs = this.runs.filter((r) => r.id !== id);
    });
  }
}
