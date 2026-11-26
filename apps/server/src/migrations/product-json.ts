import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { savedRoutine, routineRun } from '@wisp/protocol/routines';
import { memoryEntry } from '@wisp/agent/contract/agent-rpc';
import { Effect, Schema } from 'effect';
import { SqlDatabase, type SqlExecutor } from '@wisp/db/sql-database';
import { writeMigrationBackup } from '@wisp/db/private-file';
import {
  routines,
  routineRuns,
  panels,
  memoryScopes,
  memoryEntries,
  metadata,
} from '@wisp/db/schema';
import { saveMemory, type MemoryEntry, type MemorySlot } from '../agent/memory-record.ts';
import { savePanels, savedPanel } from '../panels/panel-record.ts';
import { importRoutines } from '../routines/routine-record.ts';

const marker = 'product-json-import-v1';

/** The JSON product files could not be read or do not match what the database expects. */
export class ProductImportFailed extends Schema.TaggedError<ProductImportFailed>()(
  'ProductImportFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const imported = (db: SqlExecutor) =>
  db.select().from(metadata).where(eq(metadata.key, marker)).get().pipe(Effect.map(Boolean));

/** Reads and validates the pre-SQLite JSON files, and writes a backup of each one. */
async function readProductFiles(root: string) {
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
    await writeMigrationBackup(backup, original);
  }
  const { routines: _routines, runs: _runs, ...routineExtensions } = rawRoutines ?? {};
  return { sources, routineData, importedPanels, memories, routineExtensions };
}

/** Imports routines, panels and memory from their pre-SQLite JSON files once, keeping backups. */
export const importProductData = Effect.fn('ProductJson.import')(function* () {
  const { file, db } = yield* SqlDatabase;
  if (yield* imported(db)) {
    return;
  }
  const root = path.dirname(file);
  const data = yield* Effect.tryPromise({
    try: () => readProductFiles(root),
    catch: (cause) =>
      new ProductImportFailed({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      if (yield* imported(tx)) {
        return;
      }
      for (const table of [routines, routineRuns, panels, memoryScopes, memoryEntries]) {
        if (yield* tx.select().from(table).get()) {
          const message = 'Uninitialized product database already contains data';
          return yield* new ProductImportFailed({ message, cause: Error(message) });
        }
      }
      yield* importRoutines(tx, data.routineData);
      yield* savePanels(tx, data.importedPanels);
      for (const memory of data.memories) {
        yield* saveMemory(tx, memory.slot, memory.owner, memory.entries, memory.extras);
      }
      yield* tx
        .insert(metadata)
        .values({
          key: marker,
          value: JSON.stringify({
            sources: data.sources.map(({ file, original }) => ({
              file: path.relative(root, file),
              sha256: createHash('sha256').update(original).digest('hex'),
            })),
            routineExtensions: data.routineExtensions,
          }),
        })
        .run();
    }),
  );
});
