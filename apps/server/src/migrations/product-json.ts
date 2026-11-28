import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { z } from 'zod';
import { rejectUnknownKeys } from '@wisp/protocol/checks';
import { savedRoutine, routineRun } from '@wisp/protocol/routines';
import { panelContent } from '@wisp/agent/contract/panels';
import { MemorySlot } from '@wisp/agent/contract/memory';
import type { SqlOrm } from '@wisp/db/sql-database';
import { writeMigrationBackup } from '@wisp/db/private-file';
import {
  routines,
  routineRuns,
  panels,
  memoryScopes,
  memoryEntries,
  metadata,
} from '@wisp/db/schema';
import { importMemory, StoredMemoryEntry } from '../memory/repository.ts';
import { encodePanel } from '../panels/panel-record.ts';
import { encodeRoutine, encodeRun } from '../routines/routine-record.ts';
import { errorMessage } from '../errors.ts';

const savedPanel = panelContent.safeExtend({
  characterKey: z.string().min(1),
  updatedAt: z.number(),
});
export const productImportMarker = 'product-json-import-v1';
const LegacyMemory = Schema.StructWithRest(
  Schema.Struct({
    slot: MemorySlot,
    owner: Schema.NonEmptyString,
    entries: Schema.Array(StoredMemoryEntry),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const decodeLegacyMemory = Schema.decodeUnknownSync(LegacyMemory);
// Saved routines are strict and runs are not, so each list decodes on its own.
const decodeLegacyRoutines = Schema.decodeUnknownSync(
  Schema.Struct({ routines: Schema.Array(Schema.Unknown), runs: Schema.Array(Schema.Unknown) }),
);
const decodeSavedRoutines = Schema.decodeUnknownSync(Schema.Array(savedRoutine), rejectUnknownKeys);
const decodeRuns = Schema.decodeUnknownSync(Schema.Array(routineRun));

class ProductImportError extends Schema.TaggedError<ProductImportError>()('ProductImportError', {
  message: Schema.String,
}) {}

async function readProductFiles(file: string) {
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
  const legacyRoutines = decodeLegacyRoutines(
    rawRoutines === undefined ? { routines: [], runs: [] } : rawRoutines,
  );
  const routineData = {
    routines: decodeSavedRoutines(legacyRoutines.routines),
    runs: decodeRuns(legacyRoutines.runs).map((run, i) => ({ ...rawRoutines?.runs[i], ...run })),
  };
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
  const memories: (typeof LegacyMemory.Type)[] = [];
  for (const name of names.sort().filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const parsed = decodeLegacyMemory(await read(path.join(root, 'memory', name)));
    const expected =
      createHash('sha256')
        .update(JSON.stringify([parsed.slot, parsed.owner]))
        .digest('hex') + '.json';
    if (expected !== name) {
      throw Error('Memory source identity does not match its filename');
    }
    memories.push(parsed);
  }
  for (const { file, original } of sources) {
    const digest = createHash('sha256').update(original).digest('hex');
    const backup = file.replace(/\.json$/, `.pre-sqlite-${digest}.json`);
    await writeMigrationBackup(backup, original);
  }
  const { routines: _routines, runs: _runs, ...routineExtensions } = rawRoutines ?? {};
  return {
    routineRows: routineData.routines.map(encodeRoutine),
    runRows: routineData.runs.map(encodeRun),
    panelRows: importedPanels.map(encodePanel),
    memories,
    markerValue: JSON.stringify({
      sources: sources.map(({ file, original }) => ({
        file: path.relative(root, file),
        sha256: createHash('sha256').update(original).digest('hex'),
      })),
      routineExtensions,
    }),
  };
}

const hasDuplicates = (keys: readonly string[]) => new Set(keys).size !== keys.length;

/** Imports all product domains and their completion marker in one SQLite write transaction. */
export const importProductData = Effect.fn('ProductImport.run')(function* (
  file: string,
  db: SqlOrm,
) {
  const hasMarker = () =>
    db.select().from(metadata).where(eq(metadata.key, productImportMarker)).get();
  if (yield* hasMarker()) return;

  const { routineRows, runRows, panelRows, memories, markerValue } = yield* Effect.tryPromise({
    try: () => readProductFiles(file),
    catch: (cause) => new ProductImportError({ message: errorMessage(cause) }),
  });
  yield* db.$client.withTransaction(
    Effect.gen(function* () {
      if (yield* hasMarker()) return;
      for (const table of [routines, routineRuns, panels, memoryScopes, memoryEntries]) {
        if (yield* db.select().from(table).get()) {
          return yield* new ProductImportError({
            message: 'Uninitialized product database already contains data',
          });
        }
      }
      if (
        hasDuplicates(
          routineRows.map(({ characterKey, id }) => JSON.stringify([characterKey, id])),
        ) ||
        hasDuplicates(runRows.map(({ id }) => id)) ||
        hasDuplicates(
          panelRows.map(({ characterKey, id }) => JSON.stringify([characterKey, id])),
        ) ||
        memories.some(({ entries }) => hasDuplicates(entries.map(({ key }) => key)))
      ) {
        return yield* new ProductImportError({ message: 'Duplicate persisted record identity' });
      }
      for (const row of routineRows) yield* db.insert(routines).values(row);
      for (const row of runRows) yield* db.insert(routineRuns).values(row);
      for (const row of panelRows) yield* db.insert(panels).values(row);
      for (const { slot, owner, entries, ...extras } of memories) {
        yield* importMemory(db, { slot, owner }, entries, JSON.stringify(extras));
      }
      yield* db.insert(metadata).values({ key: productImportMarker, value: markerValue });
    }),
  );
});
