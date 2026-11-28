import { Effect, Layer, ManagedRuntime } from 'effect';
import { layer as sqlLayer } from '@wisp/db/sql-database';
import { ApplicationDatabase } from '../src/application-database.ts';
import { layer as memoryLayer, MemoryRepository } from '../src/memory/repository.ts';

type MemorySlot = Parameters<MemoryRepository['Service']['read']>[0]['slot'];

function openMemory(database: ApplicationDatabase) {
  const runtime = ManagedRuntime.make(memoryLayer.pipe(Layer.provide(sqlLayer(database.file))));
  return {
    async read(slot: MemorySlot, owner: string) {
      await database.initializeProducts();
      return runtime.runPromise(
        Effect.flatMap(MemoryRepository, (memory) => memory.read({ slot, owner })),
      );
    },
    async update(slot: MemorySlot, owner: string, key: string, text?: string) {
      await database.initializeProducts();
      return runtime.runPromise(
        Effect.flatMap(MemoryRepository, (memory) =>
          memory.update(
            { slot, owner },
            text === undefined ? { operation: 'remove', key } : { operation: 'save', key, text },
          ),
        ),
      );
    },
    close: () => runtime.dispose(),
  };
}

export function databaseScope() {
  const databases: ApplicationDatabase[] = [];
  const repositories: ReturnType<typeof openMemory>[] = [];
  return {
    open(this: void, file: string) {
      const database = new ApplicationDatabase(file);
      databases.push(database);
      return database;
    },
    memory(this: void, database: ApplicationDatabase) {
      const repository = openMemory(database);
      repositories.push(repository);
      return repository;
    },
    async close() {
      for (const repository of repositories) {
        await repository.close();
      }
      for (const database of databases) {
        await database.close();
      }
    },
  };
}
