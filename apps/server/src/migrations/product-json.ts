import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { savedRoutine, routineRun } from '@wisp/protocol/routines';
import { panelContent } from '@wisp/agent/contract/panels';
import { memoryEntry } from '@wisp/agent/contract/agent-rpc';
import type { ApplicationOrm } from '@wisp/db/database';
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
import { savePanels } from '../panels/panel-record.ts';
import { importRoutines } from '../routines/routine-record.ts';

const savedPanel = panelContent.safeExtend({
  characterKey: z.string().min(1),
  updatedAt: z.number(),
});
const marker = 'product-json-import-v1';

/** Imports routines, panels and memory from their pre-SQLite JSON files once, keeping backups. */
export async function importProductData(file: string, db: ApplicationOrm) {
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
    await writeMigrationBackup(backup, original);
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
