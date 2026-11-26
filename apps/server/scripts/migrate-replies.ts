import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { Effect, Layer } from 'effect';
import * as Sql from '@wisp/db/sql-database';
import * as Chats from '../src/chat/chat-store.ts';
import { preparePrivateDatabase } from '@wisp/db/private-file';
import { applicationDatabaseFile } from '@wisp/db/application-file';
import { migrateReplies } from '../src/migrations/replies.ts';

// Run with Wisp stopped. The legacy JSON is imported by ChatStore if needed.
const root = process.env.WISP_DATA_DIR || fileURLToPath(new URL('../../..', import.meta.url));
const file = applicationDatabaseFile(path.join(root, 'runtime'));
const storage = Chats.layer({ onError: () => {} }).pipe(Layer.provideMerge(Sql.layer(file)));
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* Chats.ChatStore;
      const chats = yield* store.load();
      const destination = yield* Effect.promise(() => backupBeforeMigrating());
      const result = migrateReplies(chats);
      yield* store.flush(chats);
      console.log(JSON.stringify({ ...result, backup: destination }));
    }),
  ).pipe(Effect.provide(storage)),
);

async function backupBeforeMigrating() {
  const snapshot = new DatabaseSync(file, { readOnly: true });
  const destination = path.join(root, `runtime/wisp.before-rich-stream-${Date.now()}.sqlite`);
  try {
    if (snapshot.prepare("SELECT id FROM chats WHERE status = 'working' LIMIT 1").get()) {
      throw Error('Wait for active turns and stop Wisp before migrating.');
    }
    await preparePrivateDatabase(destination);
    await backup(snapshot, destination);
  } finally {
    snapshot.close();
  }
  return destination;
}
