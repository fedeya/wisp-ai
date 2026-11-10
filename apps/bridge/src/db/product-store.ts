import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { savedRoutine, routineRun, type Routine, type RoutineRun } from '@wisp/protocol/routines';
import { panelContent, type Panel } from '@wisp/protocol/panels';
import { memoryEntry } from '@wisp/protocol/agent-rpc';
import type { ApplicationOrm } from './application-database.ts';
import { routines, routineRuns, panels, memoryScopes, memoryEntries, metadata } from './schema.ts';

type Orm = ApplicationOrm;
export type MemorySlot = 'preferences' | 'character';
export type MemoryEntry = z.infer<typeof memoryEntry>;
const savedPanel = panelContent.safeExtend({
  characterKey: z.string().min(1),
  updatedAt: z.number(),
});
const marker = 'product-json-import-v1';

function syncRows<T>(
  before: T[],
  after: T[],
  key: (row: T) => string,
  save: (row: T) => void,
  remove: (row: T) => void,
) {
  const old = new Map(before.map((row) => [key(row), row]));
  const next = new Map(after.map((row) => [key(row), row]));
  if (next.size !== after.length) {
    throw Error('Duplicate persisted record identity');
  }
  for (const row of before) {
    if (!next.has(key(row))) {
      remove(row);
    }
  }
  for (const row of after) {
    if (!isDeepStrictEqual(old.get(key(row)), row)) {
      save(row);
    }
  }
}

export function importRoutines(db: Orm, value: { routines: Routine[]; runs: RoutineRun[] }) {
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
      instanceId: null,
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

export function readPanels(db: Orm): Panel[] {
  return db
    .select()
    .from(panels)
    .orderBy(panels.sortIndex)
    .all()
    .map(({ sortIndex: _sortIndex, content, ...row }) => ({ ...JSON.parse(content), ...row }));
}

export function savePanels(db: Orm, value: Panel[]) {
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

export function readMemory(db: Orm, slot: MemorySlot, owner: string): MemoryEntry[] {
  return db
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.slot, slot), eq(memoryEntries.owner, owner)))
    .orderBy(memoryEntries.sortIndex)
    .all()
    .map(({ slot: _slot, owner: _owner, sortIndex: _sortIndex, extras, ...row }) => ({
      ...JSON.parse(extras),
      ...row,
    }));
}

export function saveMemory(
  db: Orm,
  slot: MemorySlot,
  owner: string,
  entries: MemoryEntry[],
  extras = '{}',
) {
  db.insert(memoryScopes).values({ slot, owner, extras }).onConflictDoNothing().run();
  const next = entries.map(({ key, text, updatedAt, ...extra }, sortIndex) => ({
    slot,
    owner,
    key,
    text,
    updatedAt,
    sortIndex,
    extras: JSON.stringify(extra),
  }));
  syncRows(
    db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.slot, slot), eq(memoryEntries.owner, owner)))
      .all(),
    next,
    (r) => r.key,
    (r) =>
      db
        .insert(memoryEntries)
        .values(r)
        .onConflictDoUpdate({
          target: [memoryEntries.slot, memoryEntries.owner, memoryEntries.key],
          set: r,
        })
        .run(),
    (r) =>
      db
        .delete(memoryEntries)
        .where(
          and(
            eq(memoryEntries.slot, slot),
            eq(memoryEntries.owner, owner),
            eq(memoryEntries.key, r.key),
          ),
        )
        .run(),
  );
}

export async function importProductData(file: string, db: Orm) {
  if (db.select().from(metadata).where(eq(metadata.key, marker)).get()) {
    return;
  }
  const sources: { file: string; original: Buffer }[] = [];
  const read = async (file: string) => {
    try {
      const original = await readFile(file);
      sources.push({ file, original });
      return JSON.parse(original.toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  };
  const root = path.dirname(file);
  const rawRoutines = await read(path.join(root, 'routines.json'));
  const routineData = z
    .object({ routines: z.array(savedRoutine), runs: z.array(routineRun) })
    .parse(rawRoutines === undefined ? { routines: [], runs: [] } : rawRoutines);
  if (rawRoutines) {
    routineData.runs = routineData.runs.map((run, i) => ({ ...rawRoutines.runs[i], ...run }));
  }
  const rawPanels = await read(path.join(root, 'panels.json'));
  const panelData = rawPanels === undefined ? [] : rawPanels;
  const validatedPanels = z.array(savedPanel).parse(panelData);
  const importedPanels = validatedPanels.map((panel, i) => ({
    ...panelData[i],
    bindings: panel.bindings,
    references: panel.references,
  }));
  let names: string[] = [];
  try {
    names = await readdir(path.join(root, 'memory'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const memories: {
    slot: MemorySlot;
    owner: string;
    entries: MemoryEntry[];
    extras: string;
  }[] = [];
  for (const name of names.sort().filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const raw = await read(path.join(root, 'memory', name));
    const parsed = z
      .object({
        slot: z.enum(['preferences', 'character']),
        owner: z.string().min(1),
        entries: z.array(memoryEntry),
      })
      .parse(raw);
    const expected =
      createHash('sha256')
        .update(JSON.stringify([parsed.slot, parsed.owner]))
        .digest('hex') + '.json';
    if (expected !== name) {
      throw Error('Memory source identity does not match its filename');
    }
    const { slot, owner, entries, ...extras } = raw;
    memories.push({ slot, owner, entries, extras: JSON.stringify(extras) });
  }
  for (const { file, original } of sources) {
    const digest = createHash('sha256').update(original).digest('hex');
    const backup = file.replace(/\.json$/, `.pre-sqlite-${digest}.json`);
    try {
      await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        !(await readFile(backup)).equals(original)
      ) {
        throw error;
      }
    }
  }
  db.transaction(
    () => {
      if (db.select().from(metadata).where(eq(metadata.key, marker)).get()) {
        return;
      }
      if (
        [routines, routineRuns, panels, memoryScopes, memoryEntries].some((table) =>
          db.select().from(table).get(),
        )
      ) {
        throw Error('Uninitialized product database already contains data');
      }
      importRoutines(db, routineData);
      savePanels(db, importedPanels);
      for (const memory of memories) {
        saveMemory(db, memory.slot, memory.owner, memory.entries, memory.extras);
      }
      const { routines: _routines, runs: _runs, ...routineExtensions } = rawRoutines ?? {};
      db.insert(metadata)
        .values({
          key: marker,
          value: JSON.stringify({
            sources: sources.map(({ file, original }) => ({
              file: path.relative(root, file),
              sha256: createHash('sha256').update(original).digest('hex'),
            })),
            routineExtensions,
          }),
        })
        .run();
    },
    { behavior: 'immediate' },
  );
}
