import { ApplicationDatabase } from '@wisp/bridge/db/application-database';
export function databaseScope() {
  const databases: ApplicationDatabase[] = [];
  return {
    open(file: string) {
      const database = new ApplicationDatabase(file);
      databases.push(database);
      return database;
    },
    async close() {
      for (const database of databases) {
        await database.close();
      }
    },
  };
}
